// Real-browser check of the 1.5.0 light / dark / system theme of the card (Iñaki, 2026-10-02:
// "Me gusta cómo han quedado los temas claro/oscuro/sistema de la web. Lo pasamos a las apps y a
// la card."). Same tokens and palettes as the doorbell web (IG_Doorbell docs/design/theme_tokens.md).
//
// Loads the REAL card; harness.js only doubles the network (same criterion as advanced_mode).
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// POSITIVE CONTROL: CARD_FILE=<older dist> node theme_1_5_0/driver.js must go red on its checks
// (run_all.js runs it against the 1.4.5 card).
//
// CHECKS:
//   S1-S4  System (the default, nothing stored) follows HOME ASSISTANT's dark mode
//          (hass.themes.darkMode), live: a new hass with the other value repaints; the palette
//          values are the web's (computed --ig-bg / --ig-surf1 / --ig-cyan, the card background).
//   S5-S6  with no hass.themes.darkMode at all, System falls back to the OS (prefers-color-scheme),
//          and to dark when neither says anything.
//   C1-C6  the control (bottom-right corner of the picture, next to the Advanced button): absent in simple mode and fullscreen, present in Advanced; a menu with System / Light /
//          Dark; choosing Light/Dark overrides HA's mode; choosing System goes back to following it.
//   P1-P4  persistence: stored per browser under ig-doorbell-theme; "system" stores nothing; it
//          survives a rebuild of the element; unusable storage (private browsing: getItem/setItem
//          throw) neither breaks the card nor the choice for the current session.
//   V1-V2  what is drawn ON the video stays dark in the light theme (the feed-wrap re-declares the
//          dark tokens); the page chrome around it goes light.
//   M1     a second card instance in the same browser follows a change made in the first.
//   T1     the six languages translate the menu (es en fr it de pt), none falls back to English
//          by accident, and an unknown language falls back to English.
const fs = require('fs');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8799/tests/card/theme_1_5_0/index.html';
const CARD_FILE = process.env.CARD_FILE || null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser, opts) {
  const ctx = await browser.newContext(opts || {});
  const page = await ctx.newPage();
  if (CARD_FILE) {
    await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(CARD_FILE, 'utf8') }));
  }
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

// What the card is painting right now.
const PAINT = () => {
  const card = window.tView('a');
  const css = (el, p) => (el ? getComputedStyle(el).getPropertyValue(p).trim() : null);
  const hc = card.querySelector('ha-card');
  return {
    attrCard: hc && hc.getAttribute('data-ig-theme'),
    attrCont: card.content && card.content.getAttribute('data-ig-theme'),
    bg: css(card.content, '--ig-bg'),
    surf1: css(card.content, '--ig-surf1'),
    cyan: css(card.content, '--ig-cyan'),
    text: css(card.content, '--ig-text'),
    cardBackground: hc && getComputedStyle(hc).backgroundColor,
    pillBackground: getComputedStyle(card.querySelector('.db-pill')).backgroundColor,
    feedBg: css(card.feedWrap, '--ig-bg'),
    feedText: css(card.feedWrap, '--ig-text'),
  };
};
const LIGHT = { bg: '#EEF2F7', surf1: '#FFFFFF', cyan: '#00838F', text: '#0B1626', rgb: 'rgb(238, 242, 247)' };
const DARK = { bg: '#070D1A', surf1: '#0D1B2E', cyan: '#00C4D4', text: '#E8F0FE', rgb: 'rgb(7, 13, 26)' };
const isLight = (p) => p.attrCard === 'light' && p.attrCont === 'light' && p.bg === LIGHT.bg && p.surf1 === LIGHT.surf1
  && p.cyan === LIGHT.cyan && p.text === LIGHT.text && p.cardBackground === LIGHT.rgb;
const isDark = (p) => p.attrCard === 'dark' && p.attrCont === 'dark' && p.bg === DARK.bg && p.surf1 === DARK.surf1
  && p.cyan === DARK.cyan && p.text === DARK.text && p.cardBackground === DARK.rgb;

async function build(page, { advanced, darkMode, lang }) {
  await page.evaluate(({ advanced, darkMode, lang }) => {
    try { if (advanced) localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ }
    window.tSetDarkMode(darkMode);
    window.tSetLang(lang || 'en');
    window.tCreateCard('a', {});
    window.tAttach('a');
  }, { advanced, darkMode, lang });
  await sleep(250);
}

async function pickTheme(page, pref) {
  await page.evaluate(() => window.tClick('a', '#theme-btn'));
  await page.evaluate((p) => window.tClick('a', `#theme-menu [data-theme="${p}"]`), pref);
  await sleep(50);
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  console.log('\n########## 1. System follows Home Assistant\'s dark mode ##########');
  {
    const page = await newPage(browser);
    await build(page, { advanced: true, darkMode: false });
    let p = await page.evaluate(PAINT);
    check('S1: darkMode=false, nothing stored -> light, with the web\'s light palette', isLight(p));
    await page.evaluate(() => { window.tSetDarkMode(true); window.tPushHass('a'); });
    p = await page.evaluate(PAINT);
    check('S2: HA switches to dark -> the card follows on the next hass, with the dark palette', isDark(p));
    await page.evaluate(() => { window.tSetDarkMode(false); window.tPushHass('a'); });
    p = await page.evaluate(PAINT);
    check('S3: and back to light', isLight(p));
    check('S4: nothing was stored by merely following HA',
      (await page.evaluate(() => localStorage.getItem('ig-doorbell-theme'))) === null);
    await page.context().close();
  }

  console.log('\n########## 2. No hass.themes.darkMode: the OS, then dark ##########');
  {
    const page = await newPage(browser, { colorScheme: 'light' });
    await build(page, { advanced: true, darkMode: undefined });
    check('S5: HA says nothing + OS light -> light', isLight(await page.evaluate(PAINT)));
    await page.context().close();
    const page2 = await newPage(browser, { colorScheme: 'dark' });
    await build(page2, { advanced: true, darkMode: undefined });
    check('S6: HA says nothing + OS dark -> dark', isDark(await page2.evaluate(PAINT)));
    await page2.context().close();
  }

  console.log('\n########## 3. The control ##########');
  {
    const page = await newPage(browser);
    await build(page, { advanced: false, darkMode: true });
    check('C1: simple mode: no theme control on screen', !(await page.evaluate(() => window.tVisible('a', '#theme-btn'))));
    await page.evaluate(() => window.tClick('a', '#adv-btn'));
    await sleep(80);
    check('C2: Advanced mode: the theme control is there', await page.evaluate(() => window.tVisible('a', '#theme-btn')));
    await page.evaluate(() => window.tClick('a', '#theme-btn'));
    const menu = await page.evaluate(() => ({
      open: window.tVisible('a', '#theme-menu'),
      opts: Array.from(window.tView('a').querySelectorAll('#theme-menu .mode-opt')).map((b) => [b.dataset.theme, b.textContent.trim(), b.getAttribute('aria-checked')]),
    }));
    check('C3: the menu opens with System / Light / Dark, System checked',
      menu.open && JSON.stringify(menu.opts) === JSON.stringify([['system', 'System', 'true'], ['light', 'Light', 'false'], ['dark', 'Dark', 'false']]));
    await page.evaluate(() => window.tClick('a', '#theme-menu [data-theme="light"]'));
    await sleep(50);
    check('C4: Light overrides HA being dark (and the menu closes)',
      isLight(await page.evaluate(PAINT)) && !(await page.evaluate(() => window.tVisible('a', '#theme-menu'))));
    await page.evaluate(() => { window.tSetDarkMode(false); window.tPushHass('a'); });
    await pickTheme(page, 'dark');
    check('C4b: Dark overrides HA being light', isDark(await page.evaluate(PAINT)));
    await pickTheme(page, 'system');
    check('C5: System goes back to following HA (light now)', isLight(await page.evaluate(PAINT)));
    await page.evaluate(() => window.tSetFullscreen('a', true));
    check('C6: fullscreen: the theme control is not shown (Advanced view at normal size only)', !(await page.evaluate(() => window.tVisible('a', '#theme-btn'))));
    await page.context().close();
  }

  console.log('\n########## 4. Persistence ##########');
  {
    const page = await newPage(browser);
    await build(page, { advanced: true, darkMode: true });
    await pickTheme(page, 'light');
    check('P1: Light is stored under ig-doorbell-theme',
      (await page.evaluate(() => localStorage.getItem('ig-doorbell-theme'))) === 'light');
    await page.evaluate(() => { window.tDestroy('a'); window.tCreateCard('a', {}); window.tAttach('a'); });
    await sleep(250);
    check('P2: survives a rebuild of the element (HA still dark)', isLight(await page.evaluate(PAINT)));
    await pickTheme(page, 'system');
    check('P3: choosing System stores nothing (back to the default)',
      (await page.evaluate(() => localStorage.getItem('ig-doorbell-theme'))) === null && isDark(await page.evaluate(PAINT)));
    await page.context().close();

    const page2 = await newPage(browser);
    await page2.addInitScript(() => {
      Storage.prototype.getItem = function () { throw new Error('storage disabled'); };
      Storage.prototype.setItem = function () { throw new Error('storage disabled'); };
      Storage.prototype.removeItem = function () { throw new Error('storage disabled'); };
    });
    await page2.goto(BASE);
    await page2.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
    let err = null;
    page2.on('pageerror', (e) => { err = e; });
    await page2.evaluate(() => { window.tSetDarkMode(true); window.tCreateCard('a', {}); window.tAttach('a'); window.tView('a')._advanced = true; window.tView('a')._applyModeVisibility(); });
    await sleep(250);
    const before = await page2.evaluate(PAINT);
    await pickTheme(page2, 'light');
    check('P4: storage that throws: the card starts (System -> dark), the choice still works for this session, no error',
      isDark(before) && isLight(await page2.evaluate(PAINT)) && err === null);
    await page2.context().close();
  }

  console.log('\n########## 5. What is drawn on the video stays dark ##########');
  {
    const page = await newPage(browser);
    await build(page, { advanced: true, darkMode: false });
    const p = await page.evaluate(PAINT);
    check('V1: light theme: the feed (HUD, overlay buttons) keeps the DARK tokens', p.feedBg === DARK.bg && p.feedText === DARK.text);
    check('V2: light theme: the page chrome around it is light (header pill is white)', p.pillBackground === 'rgb(255, 255, 255)');
    await page.context().close();
  }

  console.log('\n########## 6. Two instances ##########');
  {
    const page = await newPage(browser);
    await build(page, { advanced: true, darkMode: true });
    await page.evaluate(() => {
      window.tCreateCard('b', {});
      const host = document.createElement('div'); host.id = 'host2'; document.body.appendChild(host);
      host.appendChild(window.__cards.b);
    });
    await sleep(250);
    await pickTheme(page, 'light');
    const b = await page.evaluate(() => window.__cards.b.querySelector('ha-card').getAttribute('data-ig-theme'));
    check('M1: a change in one card is followed by the other one in the same browser', b === 'light');
    await page.context().close();
  }

  console.log('\n########## 7. Languages ##########');
  {
    const want = {
      es: ['Tema', 'Sistema', 'Claro', 'Oscuro'], en: ['Theme', 'System', 'Light', 'Dark'], fr: ['Thème', 'Système', 'Clair', 'Sombre'],
      it: ['Tema', 'Sistema', 'Chiaro', 'Scuro'], de: ['Design', 'System', 'Hell', 'Dunkel'], pt: ['Tema', 'Sistema', 'Claro', 'Escuro'],
      ja: ['Theme', 'System', 'Light', 'Dark'],
    };
    for (const lang of Object.keys(want)) {
      const page = await newPage(browser);
      await build(page, { advanced: true, darkMode: true, lang });
      await page.evaluate(() => window.tClick('a', '#theme-btn'));
      const got = await page.evaluate(() => {
        const m = window.tView('a').querySelector('#theme-menu');
        return [m.querySelector('.db-menu-title').textContent.trim()].concat(Array.from(m.querySelectorAll('.mode-opt')).map((b) => b.textContent.trim()));
      });
      check(`T1: ${lang === 'ja' ? 'unknown language (ja) falls back to English' : lang}: ${got.join(' / ')}`, JSON.stringify(got) === JSON.stringify(want[lang]));
      await page.context().close();
    }
  }

  await browser.close();
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS OK');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
