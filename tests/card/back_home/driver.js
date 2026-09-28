// Real-browser check of 1.2.3: "back to the home page" re-arms on every visit, applies ONLY to a
// configured wall panel, never acts against a page that is not the card's, and there is one timer
// per window.
//
// Loads the REAL card file; ../ui_v1_10_0/harness.js doubles only the network and hass. index.html
// adds the deadline entity (number.bench_back_home, set per case) and counts the navigations to the
// default page (/lovelace: the harness has no default-panel data, so the card falls back to it).
// The card's own view lives at CARD_PATH, which is NOT under the default page.
//
// THE MEASURED BUGS (Iñaki, 2026-09-28, 1.2.2):
//   - salon wall tablet: once the deadline had fired, EVERY later visit to the card bounced straight
//     back to the default page (Home Assistant builds a NEW card on the way back, and the module-wide
//     "last touch" mark was already older than the deadline);
//   - his desktop PC was sent to the default page too, at the same moment as the panel (the same
//     ring re-armed every open card with the same integration-wide value).
//
// CASES
//   H1 panel: the deadline fires -> leave -> come back (a NEW card, as Home Assistant does): the card
//      stays for the full deadline again, then goes home again.
//   H2 panel: after coming back, a touch at 1.5 s restarts the deadline: still on the card at 3 s,
//      home by 4.5 s.
//   H3 panel: the user navigates elsewhere by hand while the card is still on screen (the off-screen
//      pause takes 1.5 s): the deadline never navigates that other page.
//   H4 two windows, the same "ring" at the same moment: the panel window (companion user agent) goes
//      home; the desktop window never does. (1.2.4) The panel is recognised only through the
//      `igd_panel` nonce of its URL, which the card passes as `panel_nonce` (the iPad case).
//   H5 two cards on one panel page: exactly one back-home timer in the window, one navigation.
//   H6 panel with the deadline at 0: never.
//
// POSITIVE CONTROLS BUILT IN: the same cases against MUTANTS of the card (page.route); each must turn
// its target red on a check.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/back_home/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_PATH = '/dashboard-doorbell/0';
const PANEL_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X200 Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/153.0.0.0 Safari/537.36 Home Assistant/2026.6.5-full';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const MUTANTS = {
  // the 1.2.2 behaviour: becoming visible after a navigation does not restart the deadline
  MR: { target: 'H1', a: '    if (navigated || expired) IG_IDLE.last = Date.now();\n', b: '' },
  // a touch does not restart the deadline
  MT: { target: 'H2', a: '      this._armIdleWakeLockTimer(true);\n      if (!this._wakeLock) this._acquireWakeLock();', b: '      this._armIdleWakeLockTimer();\n      if (!this._wakeLock) this._acquireWakeLock();' },
  // the deadline acts wherever the page is
  MV: { target: 'H3', a: "      if (!this._idleOnOwnView()) {\n        console.info('[ig-doorbell-card] idle deadline reached but the card is not on screen in its view: not navigating');", b: "      if (false) {\n        console.info('[ig-doorbell-card] idle deadline reached but the card is not on screen in its view: not navigating');", also: 'MV2' },
  MV2: { helper: true, a: '    if (window.location.pathname !== from || !this._idleOnOwnView()) return;\n', b: '' },
  // the 1.2.2 behaviour: the deadline applies to every page, panel or not
  MP: { target: 'H4', a: '    if (!this._connInfo || this._connInfo.back_home !== true) return 0;\n', b: '' },
  // (1.2.4) the card does not hand over the panel nonce of its URL: an iPad panel is never recognised
  MU: { target: 'H4', a: "        ...(igPanelNonce() ? { panel_nonce: igPanelNonce() } : {}),\n", b: '' },
  // every view keeps its own timer (no single window timer)
  MS: { target: 'H5', a: '    if (IG_IDLE.timer) {\n      clearTimeout(IG_IDLE.timer);\n      if (IG_IDLE.owner && IG_IDLE.owner !== this) IG_IDLE.owner._idleWakeLockTimer = null;\n    }\n', b: '' },
};

function mutate(src, name) {
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const names = [name].concat(MUTANTS[name].also ? [MUTANTS[name].also] : []);
  for (const n of names) {
    const m = MUTANTS[n];
    const k = src.split(m.a).length - 1;
    if (k !== 1) throw new Error(`mutant ${n}: anchor found ${k} times: ${m.a.slice(0, 60)}`);
    src = src.replace(m.a, m.b);
  }
  return src;
}

const NONCE = 'bench-nonce-0001';

async function openPage(browser, body, ua, search) {
  const ctx = await browser.newContext({ userAgent: ua || PANEL_UA, viewport: { width: 700, height: 900 } });
  const page = await ctx.newPage();
  if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  page.__errors = errors;
  // The integration's answer: the panel's login (here: the window's companion user agent) is a
  // picked panel. H4 passes `search` to model the iPad instead: identified ONLY by the nonce.
  await page.evaluate(([p, s, n]) => {
    window.__lang = 'en';
    window.__backHomeFor = s ? (login, msg) => msg.panel_nonce === n : (login) => /SM-X200/.test(login);
    history.replaceState(null, '', p + (s || ''));
  }, [CARD_PATH, search || '', NONCE]);
  return page;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const where = (page) => ev(page, () => location.pathname);

// A card on the page with its session up, the deadline at `s` seconds.
async function mountLive(page, s, { one = true } = {}) {
  await ev(page, ({ s, one }) => { if (one) window.tOnlyOne(); window.tDeadline(s); window.tCreate(); }, { s, one });
  await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v._slot !== null && v._slot !== undefined; }, null, { timeout: 8000 });
}

// Leave the card's view and come back the way Home Assistant does it: the old card leaves the DOM,
// the router navigates, and a NEW card is built for the view.
async function leaveAndComeBack(page) {
  await ev(page, (p) => { window.tCard.remove(); window.tNavigate('/other-dashboard'); window.tNavigate(p); window.tCreate(); }, CARD_PATH);
  await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v._slot !== null && v._slot !== undefined; }, null, { timeout: 8000 });
}

const CASES = {
  H1: async (page, check) => {
    await mountLive(page, 2);
    await sleep(3200);
    const first = await where(page);
    check('H1', `the deadline fired on the panel (at ${first})`, first === '/lovelace');
    await leaveAndComeBack(page);
    const t0 = Date.now();
    await sleep(1500);
    const soon = await where(page);
    check('H1', `back on the card: still there ${Date.now() - t0} ms later (${soon})`, soon === CARD_PATH);
    await sleep(1800);
    const later = await where(page);
    check('H1', `and after the full deadline it goes home again (${later})`, later === '/lovelace');
  },
  H2: async (page, check) => {
    await mountLive(page, 2);
    await sleep(3200);
    await leaveAndComeBack(page);
    await sleep(1500);
    await ev(page, () => window.tView().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await sleep(1500);   // 3 s after coming back: past the deadline counted from the return
    const touched = await where(page);
    check('H2', `a touch at 1.5 s restarts the deadline: still on the card at 3 s (${touched})`, touched === CARD_PATH);
    await sleep(1500);
    const later = await where(page);
    check('H2', `and home 2 s after the touch (${later})`, later === '/lovelace');
  },
  H3: async (page, check) => {
    await mountLive(page, 2);
    await sleep(1000);
    await ev(page, () => window.tNavigate('/energy'));   // by hand, the card still on screen
    await sleep(2500);
    const r = await ev(page, () => ({ at: location.pathname, navs: window.__homeNavs }));
    check('H3', `the user went to /energy: the deadline did not navigate it (at ${r.at}, home navigations ${r.navs})`, r.at === '/energy' && r.navs === 0);
  },
  H5: async (page, check) => {
    await mountLive(page, 2, { one: false });
    await ev(page, () => { window.tCreate(); });   // a second card on the same page
    await page.waitForFunction(() => Array.from(document.querySelectorAll('ig-doorbell-view')).filter((v) => v.pc).length === 2, null, { timeout: 8000 });
    const timers = await ev(page, () => {
      document.querySelectorAll('ig-doorbell-view').forEach((v) => v._armIdleWakeLockTimer(true));   // a ring re-arms every card
      return Array.from(document.querySelectorAll('ig-doorbell-view')).filter((v) => v._idleWakeLockTimer).length;
    });
    check('H5', `two cards on one page: back-home timers in the window = ${timers}`, timers === 1);
    await sleep(3000);
    const r = await ev(page, () => ({ at: location.pathname, navs: window.__homeNavs }));
    check('H5', `one navigation home (${r.navs}, at ${r.at})`, r.navs === 1 && r.at === '/lovelace');
  },
  H6: async (page, check) => {
    await mountLive(page, 0);
    await sleep(3000);
    check('H6', `deadline 0 on a panel: never (at ${await where(page)})`, (await where(page)) === CARD_PATH);
  },
};

// H4 needs two windows: its own runner.
async function runH4(browser, body) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  // (1.2.4) The iPad case: the panel window was opened from its ring notification (the nonce in
  // its URL) and the integration knows it by nothing else; the desktop has the same mock.
  const panel = await openPage(browser, body, PANEL_UA, `?igd_panel=${NONCE}`);
  const desk = await openPage(browser, body, DESKTOP_UA, '?other=1');
  try {
    await Promise.all([mountLive(panel, 2), mountLive(desk, 2)]);
    const said = await Promise.all([panel, desk].map((p) => ev(p, () => window.tView()._connInfo.back_home)));
    check('H4', `the integration's answer: panel back_home=${said[0]}, desktop back_home=${said[1]}`, said[0] === true && said[1] === false);
    // The same ring, at the same moment, in both windows.
    await Promise.all([panel, desk].map((p) => ev(p, () => window.tView()._armIdleWakeLockTimer(true))));
    await sleep(3200);
    const [pa, de] = [await where(panel), await where(desk)];
    check('H4', `after the deadline: panel at ${pa}, desktop at ${de}`, pa === '/lovelace' && de === CARD_PATH);
    await ev(desk, () => window.tView().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await sleep(3000);
    check('H4', `the desktop never goes home (at ${await where(desk)} 6 s later)`, (await where(desk)) === CARD_PATH);
  } catch (e) {
    check('H4', `crashed: ${e && e.message}`, false);
  }
  for (const p of [panel, desk]) {
    if (p.__errors.length) check('H4', `page errors: ${p.__errors.slice(0, 2).join(' | ')}`, false);
    await p.context().close();
  }
  return results;
}

async function runCase(browser, name, body) {
  if (name === 'H4') return runH4(browser, body);
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const page = await openPage(browser, body, PANEL_UA);
  try {
    await CASES[name](page, check);
  } catch (e) {
    check(name, `crashed: ${e && e.message}`, false);
  }
  if (page.__errors.length) check(name, `page errors: ${page.__errors.slice(0, 2).join(' | ')}`, false);
  await page.context().close();
  return results;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  let allOk = true;
  const all = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
  const only = process.env.ONLY_CASES ? process.env.ONLY_CASES.split(',') : all;
  const override = process.env.CARD_FILE ? fs.readFileSync(process.env.CARD_FILE, 'utf8') : null;
  const real = [];
  for (const name of only) real.push(...await runCase(browser, name, override));
  for (const r of real) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} [${r.id}] ${r.label}`);
  const bad = real.filter((r) => !r.ok);
  console.log(`\nREAL: ${real.length - bad.length}/${real.length} OK`);
  if (bad.length) allOk = false;
  if (!process.env.SKIP_MUTANTS) {
    const src = fs.readFileSync(DIST, 'utf8');
    for (const name of Object.keys(MUTANTS)) {
      const m = MUTANTS[name];
      if (m.helper) continue;   // applied only together with the mutant that names it in `also`
      const r = await runCase(browser, m.target, mutate(src, name));
      const caught = r.some((x) => !x.ok && x.id === m.target && !/crashed/.test(x.label));
      console.log(`=== MUTANT ${name} (must turn ${m.target} red on a check) -> ${caught ? 'OK' : 'NOT CAUGHT'}`);
      if (!caught) { allOk = false; r.forEach((x) => console.log(`      ${x.ok ? 'ok' : 'FAIL'} ${x.label}`)); }
    }
  }
  await browser.close();
  console.log(allOk ? '\nALL OK (real green, every mutant caught)' : '\nFAILED');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
