import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'node:path';

const SNAPSHOT_DIR = '/app/data/snapshots';
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 день

export async function launchBrowser() {
  const headless = (process.env.PUPPETEER_HEADLESS ?? 'true') === 'true';
  const slowMo = Number(process.env.PUPPETEER_SLOWMO_MS || 0);
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  // Чистим прокси перед запуском Puppeteer — vpbx.mts.ru ходит напрямую
  const savedProxy = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  delete process.env.http_proxy;
  delete process.env.https_proxy;

  const browser = await puppeteer.launch({
    headless,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
      '--lang=ru-RU,ru,en-US,en',
    ],
    slowMo
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' });
  await page.setDefaultTimeout(Number(process.env.NAV_TIMEOUT_MS || 60000));

  // Логи из консоли страницы в docker logs
  page.on('console', (msg) => {
    try { console.log('[page]', msg.type(), msg.text()); } catch {}
  });

  // Восстанавливаем прокси для Telegram после запуска браузера
  if (savedProxy.HTTP_PROXY) process.env.HTTP_PROXY = savedProxy.HTTP_PROXY;
  if (savedProxy.HTTPS_PROXY) process.env.HTTPS_PROXY = savedProxy.HTTPS_PROXY;

  return { browser, page };
}

export async function snapshot(page, name = 'step') {
  try {
    await fs.promises.mkdir(SNAPSHOT_DIR, { recursive: true });
    const file = path.join(SNAPSHOT_DIR, `${Date.now()}-${name}.png`);

    await page.screenshot({ path: file, fullPage: true });
    console.log('📸 Screenshot saved:', file);

    // Авто-отправка в Telegram админу
    if (process.env.SEND_ALL_SHOTS === 'true' && globalThis.__sendShot) {
      try { await globalThis.__sendShot(file, name); } catch {}
    }

    // Запускаем асинхронную очистку старых скринов
    cleanupOldScreenshots().catch(err =>
        console.error('Ошибка очистки скринов:', err.message)
    );

    return file;
  } catch (e) {
    console.error('Ошибка при скриншоте', e.message);
    return null;
  }
}

// Удаляем файлы старше 1 суток
async function cleanupOldScreenshots() {
  const files = await fs.promises.readdir(SNAPSHOT_DIR);
  const now = Date.now();

  for (const f of files) {
    const fullPath = path.join(SNAPSHOT_DIR, f);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        await fs.promises.unlink(fullPath);
        console.log(`🗑 Удалён старый скрин: ${f}`);
      }
    } catch {}
  }
}