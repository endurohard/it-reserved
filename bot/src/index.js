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

const COOLDOWN_SEC = Number(process.env.SWITCH_COOLDOWN_SEC || 60);
const GRACE_SEC    = Number(process.env.UNAVAILABLE_GRACE_SEC || 60); // ожидание после Unavailable

function parseList(val) {
  return (val || '').split(',').map(s => s.trim()).filter(Boolean);
}

function loadOrgsFromEnv(max = 100) {
  const byChatId = {};
  for (let i = 1; i <= max; i++) {
    const chatId   = process.env[`ORG${i}_CHAT_ID`];
    const login    = process.env[`ORG${i}_LOGIN`];
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
        add:    parseList(process.env[`ORG${i}_SIP_ADD`]),
      },
      mob: {
        remove: parseList(process.env[`ORG${i}_MOB_REMOVE`]),
        add:    parseList(process.env[`ORG${i}_MOB_ADD`]),
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

// ────────────────────────────────────────────────────────────
// STATE-файл (как раньше) — для обратной совместимости / быстрой проверки

const STATE_PATH = '/app/data/last-ext-status.json';
let state = { ext: {} }; // { "<ext>": { status, ts } }

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
/** База данных SQLite: /app/data/bot.db
 * Таблицы:
 *   ext_status(ext TEXT PK, org_id INTEGER, status TEXT, ts INTEGER)
 *   status_log(id INTEGER PK, ext TEXT, org_id INTEGER, status TEXT, ts INTEGER)
 */
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
const stmtInsertLog = db.prepare(`
  INSERT INTO status_log (ext, org_id, status, ts)
  VALUES (@ext, @org_id, @status, @ts)
`);
const stmtAnyRegistered = db.prepare(`
  SELECT 1 FROM ext_status WHERE org_id=? AND status='registered' LIMIT 1
`);
const stmtAllExts = db.prepare(`SELECT ext, org_id, status, ts FROM ext_status ORDER BY org_id, ext`);
const stmtOrgExts = db.prepare(`SELECT ext, org_id, status, ts FROM ext_status WHERE org_id=? ORDER BY ext`);

// список допустимых экстеншенов из .env (только EXT{ext}_ORG)
const ALLOWED_EXT = new Set();
const ORG_EXTS = new Map();

for (const [key, val] of Object.entries(process.env)) {
  const m = key.match(/^ORG(\d+)_EXTS$/);
  if (!m) continue;
  const orgId = m[1];
  const exts = val.split(',').map(s => s.trim()).filter(Boolean);
  if (!ORG_EXTS.has(orgId)) ORG_EXTS.set(orgId, new Set());
  for (const ext of exts) {
    ORG_EXTS.get(orgId).add(ext);
    ALLOWED_EXT.add(ext);
  }
}

console.log('[STATE] allowed EXT:', [...ALLOWED_EXT]);


// Инициализируем ext_status из .env (если строк нет)
db.transaction(() => {
  for (const [orgId, set] of ORG_EXTS.entries()) {
    for (const ext of set) {
      stmtUpsertExt.run({ ext, org_id: Number(orgId), status: null, ts: Date.now() });
    }
  }
})();

function anyExtRegisteredInOrg(orgId) {
  const row = stmtAnyRegistered.get(orgId);
  return !!row;
}

function normStatus(s) {
  const v = String(s || '').trim().toLowerCase();
  if (v === 'registered') return 'registered';
  if (v === 'unavailable' || v === 'unregistered' || v === 'not registered') return 'unavailable';
  return v; // ringing, busy, etc.
}

// ────────────────────────────────────────────────────────────
// Проверка: активен ли уже нужный режим по наборам экстеншенов

function isModeActiveOnMembers(org, members, mode) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const extractExt = (s) => {
    const m = norm(s).match(/\b(\d{3})\b/);
    return m ? m[1] : null;
  };

  const present = new Set((members || []).map(extractExt).filter(Boolean));

  const plan = mode === 'SIP' ? org.sip : org.mob;
  const adds = (plan.add || []).map(String);
  const removes = (plan.remove || []).map(String);

  const allAddPresent = adds.every(p => present.has(p));
  const allRemoveAbsent = removes.every(p => !present.has(p));

  console.log(`[CHK] mode=${mode} present=${JSON.stringify([...present])} needAdd=${JSON.stringify(adds)} needRm=${JSON.stringify(removes)} -> addOK=${allAddPresent} rmOK=${allRemoveAbsent}`);

  return allAddPresent && allRemoveAbsent;
}

const lastSwitch = new Map(); // {orgId: { SIP: ts, Mob: ts }}
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
// Таймеры "отложить Mob"

const PENDING_MOB = new Map(); // orgId -> { t: Timeout, untilTs: number }

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
    } catch (e) {
      console.error(`[TIMER] ORG${orgId}: ошибка Mob по таймеру:`, e.message);
    } finally {
      PENDING_MOB.delete(orgId);
    }
  }, GRACE_SEC * 1000);

  PENDING_MOB.set(orgId, { t, untilTs: until });
  console.log(`[TIMER] ORG${orgId}: scheduled Mob in ${GRACE_SEC}s (until ${new Date(until).toISOString()})`);
}

// ────────────────────────────────────────────────────────────
// Telegram bot

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const ADMIN = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// авто-рассылка скринов администратору (если включено)
globalThis.__sendShot = async (file, name) => {
  try {
    if (process.env.SEND_ALL_SHOTS === 'true' && ADMIN) {
      await bot.sendPhoto(ADMIN, file, { caption: `[auto] ${name}` });
    }
  } catch {}
};

// Клавиатура и проверки доступа
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: 'SIP' }, { text: 'Mob' }],
      [{ text: '/status' }, { text: '/screens 5' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

function onlyAdminOrGroup(msg) {
  const isAdmin = ADMIN && msg.chat.id === ADMIN;
  const isOrgChat = !!ORGS[String(msg.chat.id)];
  if (isAdmin || isOrgChat) return true;
  bot.sendMessage(msg.chat.id, '⛔️ Нет доступа');
  return false;
}

// ────────────────────────────────────────────────────────────
// Выполнение режима для конкретной организации

async function triggerModeForOrg(mode, { chatId, org }) {
  const { login, password, group_url } = org;
  const tag = `auto-${mode.toLowerCase()}`;

  const { browser, page } = await launchBrowser();
  const client = new MtsClient(page);

  try {
    await client.login(login, password);
    await client.openGroupUrl(group_url);

    const data = await client.getMembers();
    const members = data?.members || [];

    if (isModeActiveOnMembers(org, members, mode)) {
      console.log(`[AUTO] ORG${org.id}: режим ${mode} уже активен — пропускаю`);
      return;
    }

    console.log(`[AUTO] APPLY ${mode} for ORG${org.id} chat=${chatId}`);
    await bot.sendMessage(chatId, `🔄 Auto: применяю режим ${mode}…`).catch(()=>{});

    if (mode === 'SIP') {
      await client.applyFlow(org.sip.remove, org.sip.add);
    } else {
      await client.applyFlow(org.mob.remove, org.mob.add);
    }

    await bot.sendMessage(chatId, `✅ ${mode} применён`).catch(()=>{});
    if (ADMIN && Number(chatId) !== ADMIN) {
      await bot.sendMessage(ADMIN, `✅ ${mode} применён для ORG${org.id} (${chatId})`).catch(()=>{});
    }
  } catch (e) {
    const file = await snapshot(page, `${tag}-error`);
    if (ADMIN) {
      await bot.sendMessage(ADMIN, `❌ Ошибка ${mode} для ORG${org.id}: ${e.message}`).catch(()=>{});
      if (file) await bot.sendPhoto(ADMIN, file, { caption: `${mode} ORG${org.id}` }).catch(()=>{});
    }
    throw e;
  } finally {
    await browser.close();
  }
}

// Обёртка по chat.id (для кнопок/команд из групп)
async function withClientForOrg(msg, fn, { tag = 'op' } = {}) {
  const org = ORGS[String(msg.chat.id)];
  if (!org) throw new Error('Эта группа не настроена в .env (ORG{N}_...)');

  const { browser, page } = await launchBrowser();
  const client = new MtsClient(page);
  try {
    await client.login(org.login, org.password);
    await client.openGroupUrl(org.group_url);
    return await fn(client, org);
  } catch (e) {
    try {
      const file = await snapshot(page, `error-${tag}`);
      await bot.sendPhoto(ADMIN || msg.chat.id, file, { caption: `❌ Ошибка (${tag}): ${e.message}` });
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────
// HTTP Webhook (единственный маршрут)

const app = express();
app.use(express.json());

app.post('/extension-status', async (req, res) => {
  res.json({ ok: true });

  const { event, extension, status } = req.body || {};
  const ext = String(extension || '').trim();
  const st  = normStatus(status);
  console.log('📩 Webhook body:', req.body);

  if ((event && event !== 'ExtensionStatus') || !ext || !st) return;

  // игнорируем номера, которых нет в .env
  if (!ALLOWED_EXT.has(ext)) {
    console.log(`[DEBUG] skip ext ${ext}: not in .env EXT{ext}_ORG`);
    return;
  }

  const match = resolveOrgByExtension(ext);
  if (!match) {
    console.log(`[DEBUG] No match for extension ${ext}.`);
    return;
  }
  const { orgId, chatId, org } = match;

  // сравнение с предыдущим статусом (in-memory JSON)
  const prev = state.ext[ext]?.status || null;
  if (prev === st) {
    console.log(`[STATE] ext ${ext}: status "${st}" not changed — skip`);
    // даже если не менялось — обновим БД ts для мониторинга "последнего пинга"
    const tsNow = Date.now();
    stmtUpsertExt.run({ ext, org_id: orgId, status: st, ts: tsNow });
    return;
  }

  // сохраняем новый статус в память + файл
  const ts = Date.now();
  state.ext[ext] = { status: st, ts };
  saveStateDebounced();

  // и обязательно — в БД (и в лог)
  stmtUpsertExt.run({ ext, org_id: orgId, status: st, ts });
  stmtInsertLog.run({ ext, org_id: orgId, status: st, ts });

  // обработка статусов с таймерной логикой
  try {
    if (st === 'registered') {
      // Любая регистрация в ORG отменяет отложенный Mob
      cancelMobTimer(orgId, 'registered received');

      if (!canSwitch(orgId, 'SIP')) {
        console.log(`⏱️ Cooldown SIP ORG${orgId}`);
        return;
      }
      await triggerModeForOrg('SIP', { chatId, org });
      return;
    }

    if (st === 'unavailable') {
      // Если хоть один ext зарегистрирован — не ставим таймер
      if (anyExtRegisteredInOrg(orgId)) {
        console.log(`[AUTO] ORG${orgId}: минимум один ext registered — таймер Mob не ставлю`);
        return;
      }
      // Ставим/перезапускаем таймер — через GRACE_SEC сделаем Mob, если никто не "поднимется"
      scheduleMobTimer({ orgId, chatId, org });
      return;
    }

    console.log(`ℹ️ ext ${ext}: status "${st}" — действий нет`);
  } catch (err) {
    console.error('❌ Ошибка автопереключения:', err);
    if (ADMIN) {
      await bot.sendMessage(
          ADMIN,
          `❌ Ошибка авто-режима ORG${orgId} (ext ${ext}, status ${status}): ${err.message}`
      ).catch(()=>{});
    }
  }
});

app.listen(4000, () => console.log('Webhook listening on port 4000'));

// ────────────────────────────────────────────────────────────
/** Команды/кнопки для групп */

async function handleSip(msg) {
  if (!onlyAdminOrGroup(msg)) return;
  try {
    await bot.sendMessage(msg.chat.id, '🔄 SIP: Перевожу на компьютеры');
    await withClientForOrg(msg, async (c, org) => {
      await c.applyFlow(org.sip.remove, org.sip.add);
    }, { tag: 'sip' });
    await bot.sendMessage(msg.chat.id, '✅ SIP применён');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка SIP: ' + e.message);
  }
}

async function handleMob(msg) {
  if (!onlyAdminOrGroup(msg)) return;
  try {
    await bot.sendMessage(msg.chat.id, '🔄 Mob: Перевожу на GSM');
    await withClientForOrg(msg, async (c, org) => {
      await c.applyFlow(org.mob.remove, org.mob.add);
    }, { tag: 'mob' });
    await bot.sendMessage(msg.chat.id, '✅ Mob применён');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '❌ Ошибка Mob: ' + e.message);
  }
}

bot.onText(/^SIP$/, handleSip);
bot.onText(/^Mob$/i, handleMob);
bot.onText(/\/sip\b/i, handleSip);
bot.onText(/\/mob\b/i, handleMob);

bot.onText(/\/start/, (msg) => {
  if (!onlyAdminOrGroup(msg)) return;
  bot.sendMessage(msg.chat.id, 'Выберите режим или используйте команды:', mainKeyboard);
});

bot.onText(/\/status/, async (msg) => {
  if (!onlyAdminOrGroup(msg)) return;
  try {
    const data = await withClientForOrg(msg, async (c) => c.getMembers(), { tag: 'status' });
    const txt = `Доступные (слева):
- ${data.available.join('\n- ')}

Участники группы (справа):
- ${data.members.join('\n- ')}`;
    await bot.sendMessage(msg.chat.id, txt);
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка /status: ' + e.message);
  }
});

bot.onText(/\/screens(?:\s+(\d+))?/, async (msg, m) => {
  if (!onlyAdminOrGroup(msg)) return;
  const limit = Math.min(Number(m?.[1] || 5), 20);
  const dir = '/app/data/snapshots';
  try {
    const files = (await fs.promises.readdir(dir))
        .filter(f => f.endsWith('.png'))
        .sort()
        .slice(-limit);

    if (!files.length) return bot.sendMessage(msg.chat.id, 'Скриншотов пока нет.');
    for (const f of files) {
      await bot.sendPhoto(msg.chat.id, path.join(dir, f), { caption: f });
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка чтения скринов: ' + e.message);
  }
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `chat.id: ${msg.chat.id}\nchat.title: ${msg.chat.title || '(нет)'}`);
});

// админ: текущее in-memory состояние
bot.onText(/\/state(?:\s+(\d+))?/, (msg) => {
  if (!ADMIN || msg.chat.id !== ADMIN) return;
  const lines = Object.entries(state.ext)
      .map(([k, v]) => `${k}: ${v.status} @ ${new Date(v.ts).toLocaleString()}`);
  bot.sendMessage(msg.chat.id, lines.length ? lines.join('\n') : 'пусто');
});

// админ: просмотр таймеров
bot.onText(/\/timers/, (msg) => {
  if (!ADMIN || msg.chat.id !== ADMIN) return;
  const rows = [...PENDING_MOB.entries()].map(([orgId, v]) =>
      `ORG${orgId} → до ${new Date(v.untilTs).toLocaleString()}`
  );
  bot.sendMessage(msg.chat.id, rows.length ? rows.join('\n') : 'Таймеров нет');
});

// админ: статус из БД (по всем или по конкретной ORG)
/**
 * /dbstate            — показать все ext из БД
 * /dbstate 5          — показать только ORG5
 */
bot.onText(/\/dbstate(?:\s+(\d+))?/, (msg, m) => {
  if (!ADMIN || msg.chat.id !== ADMIN) return;
  const orgId = m?.[1] ? Number(m[1]) : null;
  let rows;
  if (orgId) {
    rows = stmtOrgExts.all(orgId);
  } else {
    rows = stmtAllExts.all();
  }
  if (!rows.length) {
    bot.sendMessage(msg.chat.id, 'БД пуста');
    return;
  }
  const out = rows.map(r =>
      `ORG${r.org_id} EXT ${r.ext}: ${r.status ?? '(нет данных)'} @ ${r.ts ? new Date(r.ts).toLocaleString() : '-'}`
  ).join('\n');
  bot.sendMessage(msg.chat.id, out);
});

console.log('Bot started');