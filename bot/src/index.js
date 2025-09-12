// src/index.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { launchBrowser, snapshot } from './browser.js';
import { MtsClient } from './mtsClient.js';
import fs from 'fs';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

// ────────────────────────────────────────────────────────────
// Настройки/утилиты
const INTERESTING = new Set(['registered', 'unavailable']);
const COOLDOWN_SEC = Number(process.env.SWITCH_COOLDOWN_SEC || 60);
const GRACE_SEC = Number(process.env.UNAVAILABLE_GRACE_SEC || 60);

// Последний известный режим по организации
const CURRENT_MODE = new Map(); // orgId -> 'SIP' | 'Mob'
// Гвард от параллельных переключений
const INFLIGHT_SWITCH = new Set(); // `${orgId}:${mode}`

function parseList(val) {
  return (val || '').split(',').map(s => s.trim()).filter(Boolean);
}

function normStatus(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (v === 'registered') return 'registered';
  if (v === 'unavailable' || v === 'unregistered' || v === 'not registered') return 'unavailable';
  return v;
}

// ────────────────────────────────────────────────────────────
// Загрузка ORG из .env
function loadOrgsFromEnv(max = 100) {
  const byChatId = {};
  for (let i = 1; i <= max; i++) {
    const chatId = process.env[`ORG${i}_CHAT_ID`];
    const login = process.env[`ORG${i}_LOGIN`];
    const password = process.env[`ORG${i}_PASSWORD`];
    const groupUrl = process.env[`ORG${i}_GROUP_URL`];
    if (!chatId || !login || !password || !groupUrl) continue;

    byChatId[String(chatId)] = {
      id: i,
      chatId: String(chatId),
      login,
      password,
      group_url: groupUrl,
      sip: {
        remove: parseList(process.env[`ORG${i}_SIP_REMOVE`]),
        add: parseList(process.env[`ORG${i}_SIP_ADD`]),
      },
      mob: {
        remove: parseList(process.env[`ORG${i}_MOB_REMOVE`]),
        add: parseList(process.env[`ORG${i}_MOB_ADD`]),
      },
    };
  }
  return byChatId;
}

const ORGS = loadOrgsFromEnv();
const ORGS_BY_ID = Object.values(ORGS).reduce((acc, org) => {
  acc[org.id] = org;
  return acc;
}, {});
console.log('Loaded org chat IDs:', Object.keys(ORGS));
console.log('Loaded org IDs:', Object.keys(ORGS_BY_ID));

// ────────────────────────────────────────────────────────────
// STATE
const STATE_PATH = '/app/data/last-ext-status.json';
let state = { ext: {} };

try {
  const raw = fs.existsSync(STATE_PATH) ? await fs.promises.readFile(STATE_PATH, 'utf8') : '{}';
  const parsed = JSON.parse(raw || '{}');
  if (parsed && typeof parsed === 'object' && parsed.ext) state = parsed;
  console.log('[STATE] loaded:', Object.keys(state.ext));
} catch (e) {
  console.warn('[STATE] load error:', e.message);
}

let saveTimer = null;
function saveStateDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fs.promises.mkdir(path.dirname(STATE_PATH), { recursive: true });
      await fs.promises.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
      console.log('[STATE] saved');
    } catch (e) {
      console.warn('[STATE] save error:', e.message);
    }
  }, 200);
}

// ────────────────────────────────────────────────────────────
// SQLite
const DB_PATH = '/app/data/bot.db';
await fs.promises.mkdir(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS ext_status (
    ext     TEXT PRIMARY KEY,
    org_id  INTEGER NOT NULL,
    status  TEXT,
    ts      INTEGER
  );
  CREATE TABLE IF NOT EXISTS status_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ext     TEXT NOT NULL,
    org_id  INTEGER NOT NULL,
    status  TEXT NOT NULL,
    ts      INTEGER NOT NULL
  );
`);

const stmtUpsertExt = db.prepare(`
  INSERT INTO ext_status (ext, org_id, status, ts)
  VALUES (@ext, @org_id, @status, @ts)
  ON CONFLICT(ext) DO UPDATE SET
    org_id=excluded.org_id,
    status=excluded.status,
    ts=excluded.ts
`);
const stmtInsertLog = db.prepare(`INSERT INTO status_log (ext, org_id, status, ts) VALUES (@ext, @org_id, @status, @ts)`);
const stmtAnyRegistered = db.prepare(`SELECT 1 FROM ext_status WHERE org_id=? AND status='registered' LIMIT 1`);
// ────────────────────────────────────────────────────────────
// EXT config
const ALLOWED_EXT = new Set();
const ORG_EXTS = new Map();

for (const [key, val] of Object.entries(process.env)) {
  const m = key.match(/^ORG(\d+)_EXTS$/);
  if (!m) continue;
  const orgId = m[1];
  const exts = String(val || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!ORG_EXTS.has(orgId)) ORG_EXTS.set(orgId, new Set());
  for (const ext of exts) {
    ORG_EXTS.get(orgId).add(ext);
    ALLOWED_EXT.add(ext);
  }
}

if (ALLOWED_EXT.size === 0) {
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^EXT(\d+)_ORG$/);
    if (!m) continue;
    const ext = m[1];
    const orgId = String(v);
    if (!ORG_EXTS.has(orgId)) ORG_EXTS.set(orgId, new Set());
    ORG_EXTS.get(orgId).add(ext);
    ALLOWED_EXT.add(ext);
  }
}

console.log('[CFG] ORG_EXTS:', [...ORG_EXTS.entries()].map(([org, set]) => [org, [...set]]));
console.log('[CFG] allowed EXT:', [...ALLOWED_EXT]);

function resolveOrgByExtension(ext) {
  for (const [orgId, set] of ORG_EXTS.entries()) {
    if (set.has(ext)) {
      const org = ORGS_BY_ID[String(orgId)];
      if (!org) return null;
      return { orgId: Number(orgId), chatId: org.chatId, org };
    }
  }
  return null;
}

db.transaction(() => {
  const now = Date.now();
  for (const [orgId, set] of ORG_EXTS.entries()) {
    for (const ext of set) {
      stmtUpsertExt.run({ ext, org_id: Number(orgId), status: null, ts: now });
    }
  }
  const allowed = [...ALLOWED_EXT];
  if (allowed.length > 0) {
    const placeholders = allowed.map(() => '?').join(',');
    db.prepare(`DELETE FROM ext_status WHERE ext NOT IN (${placeholders})`).run(...allowed);
  }
})();

// ────────────────────────────────────────────────────────────
// Helpers
function anyExtRegisteredInOrg(orgId) {
  return !!stmtAnyRegistered.get(orgId);
}

// Таймер Mob
const PENDING_MOB = new Map();
function cancelMobTimer(orgId, reason = '') {
  const p = PENDING_MOB.get(orgId);
  if (p?.t) clearTimeout(p.t);
  if (p) console.log(`[TIMER] ORG${orgId}: canceled${reason ? ' — ' + reason : ''}`);
  PENDING_MOB.delete(orgId);
}
function scheduleMobTimer({ orgId, chatId, org }) {
  cancelMobTimer(orgId);
  const until = Date.now() + GRACE_SEC * 1000;
  const t = setTimeout(async () => {
    try {
      if (anyExtRegisteredInOrg(orgId)) {
        console.log(`[TIMER] ORG${orgId}: есть registered — Mob не делаю`);
        return;
      }
      if (!canSwitch(orgId, 'Mob')) {
        console.log(`[TIMER] ORG${orgId}: cooldown — Mob не делаю`);
        return;
      }
      await triggerModeForOrg('Mob', { chatId, org });
      CURRENT_MODE.set(orgId, 'Mob');
    } catch (e) {
      console.error(`[TIMER] ORG${orgId}: ошибка Mob по таймеру:`, e.message);
    } finally {
      PENDING_MOB.delete(orgId);
    }
  }, GRACE_SEC * 1000);
  PENDING_MOB.set(orgId, { t, untilTs: until });
  console.log(`[TIMER] ORG${orgId}: scheduled Mob in ${GRACE_SEC}s`);
}

const lastSwitch = new Map();
function canSwitch(orgId, mode) {
  const now = Date.now();
  if (!lastSwitch.has(orgId)) lastSwitch.set(orgId, {});
  const bucket = lastSwitch.get(orgId);
  const prev = bucket[mode] || 0;
  const ok = (now - prev) / 1000 >= COOLDOWN_SEC;
  if (ok) bucket[mode] = now;
  return ok;
}

// ────────────────────────────────────────────────────────────
// Telegram
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const ADMIN = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// ────────────────────────────────────────────────────────────
// Trigger
async function triggerModeForOrg(mode, { chatId, org }) {
  const tag = `auto-${mode.toLowerCase()}`;
  const key = `${org.id}:${mode}`;
  if (INFLIGHT_SWITCH.has(key)) {
    console.log(`[AUTO] ORG${org.id}: переключение ${mode} уже выполняется — пропускаю`);
    return;
  }
  INFLIGHT_SWITCH.add(key);

  const { browser, page } = await launchBrowser();
  const client = new MtsClient(page);
  try {
    await client.login(org.login, org.password);
    await client.openGroupUrl(org.group_url);
    const data = await client.getMembers();
    const members = data?.members || [];
    if (isModeActiveOnMembers(org, members, mode)) {
      console.log(`[AUTO] ORG${org.id}: режим ${mode} уже активен — пропускаю`);
      return;
    }
    console.log(`[AUTO] APPLY ${mode} for ORG${org.id}`);
    await bot.sendMessage(chatId, `🔄 Auto: применяю режим ${mode}…`).catch(()=>{});
    if (mode === 'SIP') {
      await client.applyFlow(org.sip.remove, org.sip.add);
    } else {
      await client.applyFlow(org.mob.remove, org.mob.add);
    }
    await bot.sendMessage(chatId, `✅ ${mode} применён`).catch(()=>{});
    CURRENT_MODE.set(org.id, mode);
  } catch (e) {
    const file = await snapshot(page, `${tag}-error`);
    if (ADMIN) {
      await bot.sendMessage(ADMIN, `❌ Ошибка ${mode} для ORG${org.id}: ${e.message}`).catch(()=>{});
      if (file) await bot.sendPhoto(ADMIN, file, { caption: `${mode} ORG${org.id}` }).catch(()=>{});
    }
    throw e;
  } finally {
    try { await browser.close(); } catch {}
    INFLIGHT_SWITCH.delete(key);
  }
}

// ────────────────────────────────────────────────────────────
// HTTP webhook
const app = express();
app.use(express.json());

app.post('/extension-status', async (req, res) => {
  res.json({ ok: true });
  const { event, extension, status } = req.body || {};
  const ext = String(extension || '').trim();
  const st = normStatus(status);
  console.log('📩 Webhook body:', req.body);
  if ((event && event !== 'ExtensionStatus') || !ext || !st) return;
  if (!ALLOWED_EXT.has(ext)) {
    console.log(`[DEBUG] skip ext ${ext}: not in config`);
    return;
  }
  if (!INTERESTING.has(st)) {
    console.log(`ℹ️ ext ${ext}: status "${st}" — игнорируем`);
    return;
  }
  const match = resolveOrgByExtension(ext);
  if (!match) return;
  const { orgId, chatId, org } = match;
  const prev = state.ext[ext]?.status || null;
  if (prev === st) {
    console.log(`[STATE] ext ${ext}: status "${st}" not changed`);
    return;
  }
  const ts = Date.now();
  state.ext[ext] = { status: st, ts };
  saveStateDebounced();
  stmtUpsertExt.run({ ext, org_id: orgId, status: st, ts });
  stmtInsertLog.run({ ext, org_id: orgId, status: st, ts });

  try {
    if (st === 'registered') {
      cancelMobTimer(orgId, 'registered');
      if (CURRENT_MODE.get(orgId) === 'SIP') {
        console.log(`[AUTO] ORG${orgId}: уже в SIP — пропускаю`);
        return;
      }
      if (!canSwitch(orgId, 'SIP')) {
        console.log(`⏱️ Cooldown SIP ORG${orgId}`);
        return;
      }
      await triggerModeForOrg('SIP', { chatId, org });
      CURRENT_MODE.set(orgId, 'SIP');
      return;
    }
    if (st === 'unavailable') {
      if (anyExtRegisteredInOrg(orgId)) {
        console.log(`[AUTO] ORG${orgId}: есть registered — Mob не ставлю`);
        return;
      }
      if (CURRENT_MODE.get(orgId) === 'Mob' || PENDING_MOB.has(orgId)) {
        console.log(`[AUTO] ORG${orgId}: Mob уже активен/запланирован`);
        return;
      }
      scheduleMobTimer({ orgId, chatId, org });
    }
  } catch (err) {
    console.error('❌ Ошибка автопереключения:', err);
  }
});

app.listen(4000, () => console.log('Webhook listening on port 4000'));
console.log('Bot started');