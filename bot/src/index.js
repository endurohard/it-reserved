import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { launchBrowser, snapshot } from './browser.js';
import { MtsClient } from './mtsClient.js';
//import PRESETS from './presets.js';
import fs from 'fs';
import path from 'node:path';
import express from 'express';

// ────────────────────────────────────────────────────────────
// Веб-хук/технический эндпоинт — оставляю как у тебя
const app = express();
app.use(express.json());
app.post('/extension-status', (req, res) => {
  console.log('body', req.body);
  res.json({ ok: true });
});
app.listen(4000);

// ────────────────────────────────────────────────────────────
// Загрузка организаций из .env (ORG{N}_CHAT_ID и т.д.)

function parseList(val) {
  return (val || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
}

function loadOrgsFromEnv(max = 100) {
  const byChatId = {};
  for (let i = 1; i <= max; i++) {
    const chatId = process.env[`ORG${i}_CHAT_ID`]; // если хочешь — можно не указывать и маппить по-другому
    const login = process.env[`ORG${i}_LOGIN`];
    const password = process.env[`ORG${i}_PASSWORD`];
    const groupUrl = process.env[`ORG${i}_GROUP_URL`];

    // пропускаем пустые блоки
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

// ────────────────────────────────────────────────────────────
// Telegram bot
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const ADMIN = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

// клавиатура для групп
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

// доступ: админ или настроенная орг-группа
function onlyAdminOrGroup(msg) {
  const isAdmin = ADMIN && msg.chat.id === ADMIN;
  const isOrgChat = !!ORGS[String(msg.chat.id)];
  if (isAdmin || isOrgChat) return true;
  bot.sendMessage(msg.chat.id, '⛔️ Нет доступа');
  return false;
}

// специализированная обёртка под конкретную организацию (по chat.id)
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
      await bot.sendPhoto(msg.chat.id, file, { caption: `❌ Ошибка (${tag}): ${e.message}` });
    } catch {}
    throw e;
  } finally {
    await browser.close();
  }
}

// старая админская обёртка — оставляю для /set, /clear и т.п.
async function withClient(fn, { tag = 'op' } = {}) {
  const { browser, page } = await launchBrowser();
  const client = new MtsClient(page);
  try {
    await client.login(process.env.MTS_LOGIN, process.env.MTS_PASSWORD);

    if (process.env.GROUP_URL && process.env.GROUP_URL.trim()) {
      await client.openGroupUrl(process.env.GROUP_URL);
    } else {
      await client.openRingGroups();
      await client.clickByText('a, span, div, li', 'Группы', { optional: true });
      if (process.env.GROUP_NAME) {
        await client.openGroupByName(process.env.GROUP_NAME);
      }
    }

    return await fn(client);
  } catch (e) {
    try {
      const file = await snapshot(page, `error-${tag}`);
      if (file && ADMIN) {
        await bot.sendPhoto(ADMIN, file, { caption: `❌ Ошибка (${tag}): ${e.message}` });
      }
    } catch (snapErr) {
      console.error('Ошибка при отправке скрина в Telegram:', snapErr.message);
    }
    throw e;
  } finally {
    await browser.close();
  }
}

// ────────────────────────────────────────────────────────────
// Команды для орг-групп: SIP и Mob (кнопки и /команды)

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

// кнопки
bot.onText(/^SIP$/, handleSip);
bot.onText(/^Mob$/i, handleMob);

// слэш-команды (на случай, если кнопки скрыли)
bot.onText(/\/sip\b/i, handleSip);
bot.onText(/\/mob\b/i, handleMob);

// старт — показать клавиатуру
bot.onText(/\/start/, (msg) => {
  if (!onlyAdminOrGroup(msg)) return;
  bot.sendMessage(msg.chat.id, 'Выберите режим или используйте команды:', mainKeyboard);
});

// ────────────────────────────────────────────────────────────
// Админские/общие команды (оставлены как были)

bot.onText(/\/help/, (msg) => {
  if (!onlyAdminOrGroup(msg)) return;
  bot.sendMessage(msg.chat.id, `Команды:
/sip — режим SIP (для текущей группы)
/mob — режим Mob (reserved) (для текущей группы)
/status — показать состав группы (для текущей группы)
/screens [N] — последние N скриншотов (по-умолчанию 5)

Админ (личка):
/set preset <day|night|full|reserve>
/set members <имя;имя;...>
/clear`);
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

    if (files.length === 0) {
      return bot.sendMessage(msg.chat.id, 'Скриншотов пока нет.');
    }
    for (const f of files) {
      await bot.sendPhoto(msg.chat.id, path.join(dir, f), { caption: f });
    }
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка чтения скринов: ' + e.message);
  }
});

// ——— Ниже команды, оставшиеся для админа (опционально)
function onlyAdmin(msg) {
  if (ADMIN && msg.chat.id === ADMIN) return true;
  bot.sendMessage(msg.chat.id, '⛔️ Нет доступа (только для ADMIN_CHAT_ID)');
  return false;
}

bot.onText(/\/set\s+preset\s+(\w+)/, async (msg, match) => {
  if (!onlyAdmin(msg)) return;
  const name = (match?.[1] || '').toLowerCase();
  const list = PRESETS[name];
  if (!list) return bot.sendMessage(msg.chat.id, 'Нет такого пресета');
  await bot.sendMessage(msg.chat.id, `Применяю пресет: ${name}\n${list.join(', ')}`);
  try {
    await withClient(async (c) => c.setMembers(list), { tag: `preset-${name}` });
    await bot.sendMessage(msg.chat.id, 'Готово ✅');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
  }
});

bot.onText(/\/id/, (msg) => {
  bot.sendMessage(msg.chat.id, `chat.id: ${msg.chat.id}\nchat.title: ${msg.chat.title || '(нет)'}`);
});

bot.onText(/\/set\s+members\s+(.+)/, async (msg, match) => {
  if (!onlyAdmin(msg)) return;
  const raw = match?.[1] || '';
  const list = raw.split(';').map(s => s.trim()).filter(Boolean);
  if (!list.length) return bot.sendMessage(msg.chat.id, 'Список пуст');
  await bot.sendMessage(msg.chat.id, 'Применяю состав...');
  try {
    await withClient(async (c) => {
      if (process.env.GROUP_URL) await c.openGroupUrl(process.env.GROUP_URL);
      await c.applyReserveFlow();
    }, { tag: 'reserve' });
    await bot.sendMessage(msg.chat.id, 'Готово ✅');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
  }
});

bot.onText(/\/clear/, async (msg) => {
  if (!onlyAdmin(msg)) return;
  try {
    await withClient(async (c) => c.setMembers([]), { tag: 'clear' });
    await bot.sendMessage(msg.chat.id, 'Группа очищена ✅');
  } catch (e) {
    await bot.sendMessage(msg.chat.id, 'Ошибка: ' + e.message);
  }
});

console.log('Bot started');
console.log('Loaded org chat IDs:', Object.keys(ORGS));
