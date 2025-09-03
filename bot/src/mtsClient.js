// bot/src/mtsClient.js
import { SEL } from './selectors.js';
import { snapshot } from './browser.js';

export class MtsClient {
  constructor(page) {
    this.page = page;
    this.base = process.env.MTS_BASE_URL || 'https://vpbx.mts.ru';
  }

  // ————————————————————— Вспомогательное
  async sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  // ————————————————————— Авторизация
  async login(login, password) {
    const { page, base } = this;

    const user = login ?? process.env.MTS_LOGIN;
    const pass = password ?? process.env.MTS_PASSWORD;

    if (!user || !pass) {
      throw new Error('Не заданы логин/пароль (передайте в login() или укажите в .env)');
    }

    await page.goto(base, {
      waitUntil: 'domcontentloaded',
      timeout: Number(process.env.LOGIN_TIMEOUT_MS || 60000),
    });
    await snapshot(page, 'login-page-opened');

    try {
      await page.waitForSelector(SEL.login.user, { timeout: 20000 });
      await page.waitForSelector(SEL.login.pass, { timeout: 20000 });
    } catch (e) {
      await snapshot(page, 'login-fields-missing');
      throw new Error(`Поле логина/пароля не найдено: ${e.message}`);
    }

    await page.type(SEL.login.user, user, { delay: 20 });
    await page.type(SEL.login.pass, pass, { delay: 20 });
    await snapshot(page, 'login-filled');

    const submit = await page.$(SEL.login.submit);
    if (!submit) {
      await snapshot(page, 'login-submit-missing');
      throw new Error('Кнопка входа не найдена');
    }
    await submit.click();

    try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 45000 }); } catch {}
    if (page.waitForNetworkIdle) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
    }
    await snapshot(page, 'after-login');
  }

  // ————————————————————— Навигация
  async openRingGroups() {
    const { page } = this;
    try { await this.clickByText('a, span, div, li, button', 'Услуги', { optional: true }); } catch {}
    if (!(await this.clickByText('a, span, div, li, button', 'Группы обзвона', { optional: true }))) {
      await this.clickByText('a, span, div, li, button', 'Группы', { optional: true });
    }
    if (page.waitForNetworkIdle) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
    }
    await snapshot(page, 'ring-groups-opened');
  }

  async openGroupByName(name) {
    const { page } = this;
    await this.clickByText('a, button, td, div, li', name);
    if (page.waitForNetworkIdle) {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }).catch(() => {});
    }
    await snapshot(page, `group-opened-${name}`);
  }

  async openGroupUrl(url) {
    const target = url ?? process.env.GROUP_URL;
    if (!target) throw new Error('GROUP_URL не задан (передайте в openGroupUrl(url) или .env)');
    await this.page.goto(target, { waitUntil: 'networkidle2', timeout: 45000 });
    await snapshot(this.page, 'group-url-opened');
  }

  // ————————————————————— Чтение списков
  async getMembers() {
    const { page } = this;
    return await page.evaluate(() => {
      const lists = Array.from(document.querySelectorAll('div.grp-list-content ul.grp-list'));
      const read = ul => ul ? Array.from(ul.querySelectorAll('li')).map(li => li.textContent.trim()) : [];
      return { available: read(lists[0]), members: read(lists[1]) };
    });
  }

  // ————————————————————— Универсальный сценарий (Удалить справа → Добавить слева → Сохранить)
  async applyFlow(removePrefixes = [], addPrefixes = []) {
    // удалить справа
    for (const pref of removePrefixes) {
      const ok = await this.selectOneByPrefix('right', pref);
      await snapshot(this.page, `right-selected-${pref}`);
      if (ok) {
        await this.clickRemoveRight();
        await snapshot(this.page, `right-removed-${pref}`);
      } else {
        await snapshot(this.page, `right-not-found-${pref}`);
      }
    }

    // добавить слева
    for (const pref of addPrefixes) {
      const ok = await this.selectOneByPrefix('left', pref);
      await snapshot(this.page, `left-selected-${pref}`);
      if (ok) {
        await this.clickAddLeft();
        await snapshot(this.page, `left-added-${pref}`);
      } else {
        await snapshot(this.page, `left-not-found-${pref}`);
      }
    }

    // сохранить
    await this.sleep(250);
    await this.clickSave();
    await snapshot(this.page, 'flow-saved');
  }

  // ————————————————————— Выбор элементов
  async selectOneByPrefix(side /* 'left'|'right' */, prefix) {
    const which = side === 'right' ? 1 : 0;
    return await this.page.evaluate(({ which, prefix }) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const lists = Array.from(document.querySelectorAll('div.grp-list-content ul.grp-list'));
      const ul = lists[which]; if (!ul) return false;
      const li = Array.from(ul.querySelectorAll('li')).find(li => norm(li.textContent).startsWith(prefix + ' '));
      if (!li) return false;
      li.scrollIntoView({ block: 'center' });
      li.click();
      return true;
    }, { which, prefix });
  }

  async selectByText(side /* 'left'|'right' */, exactText) {
    const which = side === 'right' ? 1 : 0;
    return await this.page.evaluate(({ which, exactText }) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const lists = Array.from(document.querySelectorAll('div.grp-list-content ul.grp-list'));
      const ul = lists[which]; if (!ul) return false;
      const li = Array.from(ul.querySelectorAll('li')).find(li => norm(li.textContent) === norm(exactText));
      if (!li) return false;
      li.scrollIntoView({ block: 'center' });
      li.click();
      return true;
    }, { which, exactText });
  }

  // ————————————————————— Кнопки формы
  async clickAddLeft() {
    const ok = await this.page.evaluate(() => {
      const table = document.querySelector('table.table.table-condensed');
      const td = table?.querySelectorAll('td')?.[0];
      const btn = td?.querySelector('button.btn'); // «Добавить»
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });
    if (!ok) { await snapshot(this.page, 'add-button-not-found'); throw new Error('Кнопка "Добавить" не найдена'); }
    await this.sleep(250);
  }

  async clickRemoveRight() {
    const ok = await this.page.evaluate(() => {
      const table = document.querySelector('table.table.table-condensed');
      const td = table?.querySelectorAll('td')?.[1];
      const btn = td?.querySelector('button.btn'); // «Удалить»
      if (!btn) return false;
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });
    if (!ok) { await snapshot(this.page, 'remove-button-not-found'); throw new Error('Кнопка "Удалить" не найдена'); }
    await this.sleep(250);
  }

  async clickSave() {
    const ok = await this.page.evaluate(() => {
      // На форме — <button class="btn" type="submit">Сохранить</button>
      const btn = document.querySelector('button.btn[type="submit"]');
      if (!btn) return false;
      // насильно сделаем кликабельной
      btn.disabled = false;
      btn.removeAttribute('disabled');
      btn.style.pointerEvents = 'auto';
      btn.style.opacity = '1';
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    });

    if (!ok) {
      await snapshot(this.page, 'save-button-not-found-or-disabled');
      throw new Error('Кнопка "Сохранить" не найдена/неактивна');
    }

    if (this.page.waitForNetworkIdle) {
      try { await this.page.waitForNetworkIdle({ idleTime: 800, timeout: 30000 }); } catch {}
    }
  }

  // ————————————————————— Поиск в левом списке (опционально, оставлено)
  async applyLeftFilter(q) {
    await this.page.evaluate((q) => {
      const holder = document.querySelectorAll('div.grp-box')[0];
      if (!holder) return;
      const inp = holder.querySelector('input[type="text"]');
      if (!inp) return;
      inp.value = q;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('keyup',  { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, q);
    await this.sleep(200);
  }

  async findAndSelectInLeft(label) {
    const norm = s => (s || '').replace(/\s+/g, ' ').trim();
    const ext   = (norm(label).match(/\b\d{3}\b/) || [])[0] || '';
    const phone = norm(label).replace(/\D/g, '').slice(-10) || '';

    const tryOnce = async () => {
      return await this.page.evaluate((label) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const leftUl = document.querySelectorAll('div.grp-list-content ul.grp-list')[0];
        if (!leftUl) return false;
        const items = Array.from(leftUl.querySelectorAll('li'));
        let item = items.find(li => norm(li.textContent) === norm(label));
        if (!item) {
          const ext = (norm(label).match(/\b\d{3}\b/) || [])[0];
          const num = norm(label).replace(/\D/g, '');
          item = items.find(li => {
            const t = norm(li.textContent); const d = t.replace(/\D/g,'');
            const byStart = ext ? t.startsWith(ext+' ') : false;
            const byExt   = ext ? t.includes(ext) : false;
            const byNum   = num ? d.includes(num) : false;
            return byStart || byExt || byNum;
          });
        }
        if (!item) return false;
        item.scrollIntoView({ block: 'center' });
        item.click();
        return true;
      }, label);
    };

    if (await tryOnce()) return true;

    if (ext) {
      await this.applyLeftFilter(ext);
      const ok = await tryOnce();
      await this.applyLeftFilter('');
      if (ok) return true;
    }

    if (phone) {
      const short = phone.slice(-4);
      if (short) {
        await this.applyLeftFilter(short);
        const ok = await tryOnce();
        await this.applyLeftFilter('');
        if (ok) return true;
      }
    }
    return false;
  }

  // ————————————————————— Клики по тексту/селектору (для меню)
  async clickByText(selectorList, text, opts = {}) {
    const { page } = this;
    const parts = selectorList.split(',').map(s => s.trim());
    const xpath = '//' + parts.join('|//') + `[contains(normalize-space(.), ${JSON.stringify(text)})]`;
    try {
      const el = await page.waitForXPath(xpath, { timeout: 5000 });
      await el.click();
      return true;
    } catch {
      if (opts.optional) return false;
      await snapshot(page, `clickByText-not-found-${text.replace(/\W+/g,'_')}`);
      throw new Error('Не найден элемент по тексту: ' + text);
    }
  }

  async safeClick(selector, optional = false) {
    const el = await this.page.$(selector);
    if (el) { await el.click(); return true; }
    if (optional) return false;
    await snapshot(this.page, `safeClick-not-found-${selector.replace(/\W+/g,'_')}`);
    throw new Error('Не найдена кнопка: ' + selector);
  }
}