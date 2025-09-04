// src/index.js
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { launchBrowser, snapshot } from './browser.js';
import { MtsClient } from './mtsClient.js';
import fs from 'fs';
import path from 'node:path';
import express from 'express';

// ────────────────────────────────────────────────────────────
// Настройки/утилиты

const COOLDOWN_SEC = Number(process.env.SWITCH_COOLDOWN_SEC || 60);

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
  const orgId = process.env[`EXT${ext}_ORG`];
  if (!orgId) return null;
  const org = ORGS_BY_ID[String(orgId)];
  if (!org) return null;
  return { orgId: Number(orgId), chatId: org.chatId, org };
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

// Клавиатура и проверки доступа (одна версия!)
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

// Запуск действий для конкретной организации (без сообщения из чата)
async function triggerModeForOrg(mode, { chatId, org }) {
  const { login, password, group_url } = org;
  const tag = `auto-${mode.toLowerCase()}`;

  const { browser, page } = await launchBrowser();
  const client = new MtsClient(page);

  try {
    console.log(`[AUTO] ${mode} for ORG${org.id} chat=${chatId}`);
    await bot.sendMessage(chatId, `🔄 Auto: применяю режим ${mode}…`).catch(()=>{});

    await client.login(login, password);
    await client.openGroupUrl(group_url);

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
  console.log('📩 Webhook body:', req.body);

  if ((event && event !== 'ExtensionStatus') || !extension || !status) return;

  const st = String(status).trim().toLowerCase(); // 'registered' | 'unavailable' | ...
  const match = resolveOrgByExtension(String(extension));

  // 🚫 Если в .env нет EXTxxx_ORG → просто выходим без сообщений
  if (!match) {
    return; // 🚫 Просто игнорируем, ничего не пишем
  }

  const { orgId, chatId, org } = match;

  try {
    if (st === 'registered') {
      if (!canSwitch(orgId, 'SIP')) return console.log(`⏱️ Cooldown SIP ORG${orgId}`);
      await triggerModeForOrg('SIP', { chatId, org });
    } else if (st === 'unavailable' || st === 'unregistered' || st === 'not registered') {
      if (!canSwitch(orgId, 'Mob')) return console.log(`⏱️ Cooldown Mob ORG${orgId}`);
      await triggerModeForOrg('Mob', { chatId, org });
    } else {
      console.log(`ℹ️ Статус ${status} для ext ${extension} — действие не требуется`);
    }
  } catch (err) {
    console.error('❌ Ошибка автопереключения:', err);
    if (ADMIN) {
      await bot.sendMessage(
          ADMIN,
          `❌ Ошибка авто-режима ORG${orgId} (ext ${extension}, status ${status}): ${err.message}`
      ).catch(()=>{});
    }
  }
});

app.listen(4000, () => console.log('Webhook listening on port 4000'));

// ────────────────────────────────────────────────────────────
// Команды/кнопки для групп

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

console.log('Bot started');