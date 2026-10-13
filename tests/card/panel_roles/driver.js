// Real-browser check of 1.6.0 (docs/design/panel-roles.md): with several wall panels, ONE loads the
// live video on a ring and the others show the visitor's still picture and "View".
//
// Loads the REAL card file; ../ui_v1_10_0/harness.js doubles only the network and hass. index.html
// adds what the INTEGRATION answers for this page (`panel_call` / `panel_sub` in
// get_connection_info, and the `subscribe_panel_call` pushes): the card decides nothing, so every
// case is "the integration says X -> the card does exactly X".
//
// "A session at the doorbell" is counted on the fake doorbell itself (its SSE opened, no bye yet):
// a panel that must not load must never have OPENED one, not merely hidden it.
//
// CASES
//   R1 the primary ('auto'): it loads by itself; no still-picture layer.
//   R2 a secondary ('standby'): NO session was ever opened; the still picture (the integration's one
//      image, never a request to the doorbell), the notice and "View" are shown; it listens.
//   R3 someone taps "View" on the secondary: it loads - and keeps loading when Home Assistant
//      re-creates the card while the integration still says 'standby' (the person's choice holds).
//   R4 the main panel did not show up: the integration pushes 'auto' to a waiting panel -> it loads.
//   R5 answered elsewhere ('release') on a panel holding the video: the session is hung up (bye),
//      "Answered on another device", and the panel goes home.
//   R6 the same push on the panel that is TALKING: it keeps its stream, also on a second push.
//   R7 a page that is not a panel (no panel_call): loads as always and never subscribes.
//   R8 a waiting secondary when the call is missed ('keep'): "Missed call", then home.
//   R9 a panel woken AFTER the call was answered: the notice, never a live video by itself.
//   R10 an iPad wall panel (the iOS companion: WKWebView message handlers, no Android bridge) showing
//      Home Assistant: its page offers itself and, asked on a ring, goes to the call page IN PLACE
//      and says so - the same path an Android panel has had since 1.2.2.
//   R11 a desktop browser never offers itself.
//
// POSITIVE CONTROLS BUILT IN: each mutant of the card must turn its target red on a check.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/panel_roles/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CARD_PATH = '/ig-doorbell';
const CALL = 'call-0001';
const pc = (stream, phase) => ({ call_id: CALL, phase: phase || 'ringing', stream, still_entity: 'image.bench_visitor' });

const MUTANTS = {
  // the card ignores the integration's answer and loads anyway
  MG: { target: 'R2', a: "      if (this._panelMustWait(info.panel_call)) {\n", b: "      if (false) {\n" },
  // the card never listens: the role can never pass to it
  MS: { target: 'R2', a: "    if (!info || info.panel_sub !== true || this._panelUnsub || this._panelSubPending) return;\n", b: "    return;\n" },
  // the still picture is not shown
  MI: { target: 'R2', a: "      if (src) { img.style.display = ''; img.src = src; } else {", b: "      if (false) { img.style.display = ''; img.src = src; } else {" },
  // a tap on "View" is forgotten at the next start
  MA: { target: 'R3', a: "      if (reason === 'tap' && this._panelCall) IG_PANEL_ALLOWED[this.config.device_id] = this._panelCall.call_id;\n", b: '' },
  // the push that hands the video over is ignored
  MP: { target: 'R4', a: "        this._resume('the integration gave this panel the live video');\n", b: '' },
  // a panel holding the video does not give it back when the call is answered elsewhere
  MR: { target: 'R5', a: "      this._enterPanelStandby(pc, 'answered on another device');\n", b: '' },
  // ...or "gives it back" on screen only, keeping the session at the doorbell
  MB: { target: 'R5', a: "      this._teardownConnectionObjects();    // with its `bye` if there was a session: the slot is free NOW\n", b: '' },
  // the panel that is talking is cut off too
  MT: { target: 'R6', a: "      if (this._callActive() || IG_PANEL_TALKED[dev] === pc.call_id) { IG_PANEL_TALKED[dev] = pc.call_id; return; }\n", b: '' },
  // a waiting panel never goes home
  MH: { target: 'R8', a: "    const deadline = this._idleTimeoutMs();\n    if (!deadline) return;\n    const ringing", b: "    const deadline = this._idleTimeoutMs();\n    if (deadline >= 0) return;\n    const ringing" },
  // the 1.5.4 behaviour: only the Android companion is taken to the call page in place
  MC: { target: 'R10', a: "  return !!(handlers && (handlers.getExternalAuth || handlers.externalBus));\n", b: "  return false;\n" },
  // every page offers itself, a desktop browser too
  MD: { target: 'R11', a: "  if (!igInCompanionApp()) return;\n", b: '' },
  // a panel woken after the call was answered loads the live video by itself
  ML: { target: 'R9', a: "    if (!pc || !pc.call_id || pc.stream === 'auto') return false;\n", b: "    if (!pc || !pc.call_id || pc.stream !== 'standby') return false;\n" },
};

function mutate(src, name) {
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const m = MUTANTS[name];
  const k = src.split(m.a).length - 1;
  if (k !== 1) throw new Error(`mutant ${name}: anchor found ${k} times: ${m.a.slice(0, 70)}`);
  return src.replace(m.a, m.b);
}

const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Home Assistant/2026.9.1 (io.robbie.HomeAssistant; build:2026.1500; iPadOS 18.6.2)';

async function openPage(browser, body, { ios = false } = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 700, height: 900 } }, ios ? { userAgent: IPAD_UA } : {}));
  const page = await ctx.newPage();
  // The iOS companion's bridge, there before any script of the page runs (as in the real app).
  if (ios) await page.addInitScript(() => { window.webkit = { messageHandlers: { getExternalAuth: { postMessage() {} }, externalBus: { postMessage() {} } } }; });
  if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  // The integration's picture: any request for it is answered here and COUNTED; a request to
  // anything that looks like the doorbell would be a second snapshot and is counted apart.
  const pic = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  page.__stillRequests = 0;
  await page.route(/\/api\/image_proxy\//, (r) => { page.__stillRequests += 1; r.fulfill({ contentType: 'image/png', body: pic }); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  page.__errors = errors;
  await page.evaluate((p) => { window.__lang = 'en'; history.replaceState(null, '', p + '?device=aaaa1111'); }, CARD_PATH);
  return page;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const where = (page) => ev(page, () => location.pathname);
const snap = (page) => ev(page, () => {
  const v = window.tView();
  const layer = v && v.querySelector('#panel-standby');
  const img = v && v.querySelector('#panel-still');
  return {
    opened: window.__sessions.length,
    open: window.tOpenSessions().length,
    pcs: window.tOpenPcs(),
    live: !!(v && v.pc),
    layer: !!layer && layer.style.display !== 'none',
    text: layer ? layer.querySelector('#panel-standby-text').textContent : '',
    view: layer ? layer.querySelector('#panel-view-lbl').textContent : '',
    still: img ? (img.getAttribute('src') || '') : '',
    stillShown: !!img && img.style.display !== 'none' && img.naturalWidth > 0,
    subs: window.__panelSubs.filter((s) => s.open).map((s) => `${s.msg.type}:${s.msg.device_id}`),
    status: v && v.statusLine ? v.statusLine.textContent : '',
  };
});

// A card on the page, told `panelCall` by the integration at its start.
async function mount(page, panelCall, { panel = true, deadline = 60 } = {}) {
  await ev(page, ({ panelCall, panel, deadline }) => {
    window.tOnlyOne(); window.tStill(); window.tDeadline(deadline);
    window.__panelCall = panelCall; window.__panelSub = panel;
    window.tCreate();
  }, { panelCall, panel, deadline });
}
const waitLive = (page) => page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v._slot !== null && v._slot !== undefined; }, null, { timeout: 8000 });
const waitLayer = (page) => page.waitForFunction(() => { const v = window.tView(); const l = v && v.querySelector('#panel-standby'); return l && l.style.display !== 'none'; }, null, { timeout: 8000 });

const CASES = {
  R1: async (page, check) => {
    await mount(page, pc('auto'));
    await waitLive(page);
    const s = await snap(page);
    check('R1', `the primary loads by itself (sessions opened ${s.opened}, open ${s.open})`, s.opened === 1 && s.open === 1 && s.live);
    check('R1', `no still-picture layer on it (shown=${s.layer})`, !s.layer);
  },
  R2: async (page, check) => {
    await mount(page, pc('standby'));
    await waitLayer(page).catch(() => {});
    await sleep(1500);   // long enough for a session to have been opened if the card were going to
    const s = await snap(page);
    check('R2', `a secondary never opens a session (opened ${s.opened}, peer connections ${s.pcs})`, s.opened === 0 && s.pcs === 0 && !s.live);
    check('R2', `it shows the call: "${s.text}" and a "${s.view}" button`, s.layer && s.text === 'Someone is at the door' && s.view === 'View');
    check('R2', `the still is the integration's picture (${s.still.slice(0, 60)}..., drawn=${s.stillShown}, requests ${page.__stillRequests})`,
      s.still.indexOf('/api/image_proxy/image.bench_visitor?token=benchtoken') === 0 && s.stillShown && page.__stillRequests === 1);
    check('R2', `it listens for its turn (${JSON.stringify(s.subs)})`, s.subs.length === 1 && s.subs[0] === 'ig_doorbell/subscribe_panel_call:aaaa1111');
  },
  R3: async (page, check) => {
    await mount(page, pc('standby'));
    await waitLayer(page);
    await ev(page, () => window.tView().querySelector('#panel-view-btn').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    await waitLive(page).catch(() => {});
    let s = await snap(page);
    check('R3', `a tap on "View" loads the live video (open ${s.open}, layer=${s.layer})`, s.open === 1 && s.live && !s.layer);
    // Home Assistant re-creates the card; the integration still says 'standby' for this call.
    await ev(page, () => { window.tView()._destroy('bench: re-created'); window.tCard.remove(); window.tCreate(); });
    await waitLive(page).catch(() => {});
    s = await snap(page);
    check('R3', `the re-created card keeps the video the person asked for (live=${s.live}, layer=${s.layer})`, s.live && !s.layer);
  },
  R4: async (page, check) => {
    await mount(page, pc('standby'));
    await waitLayer(page);
    await sleep(300);    // the subscription is made
    await ev(page, (p) => { window.__panelCall = p; window.tPush(p); }, pc('auto'));
    await waitLive(page).catch(() => {});
    const s = await snap(page);
    check('R4', `handed the video by the integration, the waiting panel loads (open ${s.open}, layer=${s.layer})`, s.open === 1 && s.live && !s.layer);
  },
  R5: async (page, check) => {
    await mount(page, pc('auto'), { deadline: 60 });
    await waitLive(page);
    await sleep(300);
    await ev(page, (p) => { window.__panelCall = p; window.tPush(p); }, pc('release', 'answered'));
    await sleep(400);
    const s = await snap(page);
    check('R5', `answered elsewhere: the session is hung up at the doorbell (open ${s.open}, live=${s.live})`, s.open === 0 && !s.live);
    check('R5', `and the panel says so: "${s.text}"`, s.layer && s.text === 'Answered on another device');
    await sleep(1400);
    check('R5', `then it goes home (at ${await where(page)})`, (await where(page)) === '/lovelace');
  },
  R6: async (page, check) => {
    await mount(page, pc('auto'));
    await waitLive(page);
    await sleep(300);
    await ev(page, (p) => { window.tView().talkActive = true; window.__panelCall = p; window.tPush(p); }, pc('release', 'answered'));
    await sleep(400);
    let s = await snap(page);
    check('R6', `the panel that is talking keeps its stream (open ${s.open}, layer=${s.layer})`, s.open === 1 && s.live && !s.layer);
    // the microphone closes for a moment (a reconnection) and the same instruction arrives again
    await ev(page, (p) => { window.tView().talkActive = false; window.tPush(p); }, pc('release', 'answered'));
    await sleep(400);
    s = await snap(page);
    check('R6', `and keeps it for the rest of that call (open ${s.open}, layer=${s.layer})`, s.open === 1 && s.live && !s.layer);
    await sleep(1500);
    check('R6', `never sent home while it talks (at ${await where(page)})`, (await where(page)) === CARD_PATH);
  },
  R7: async (page, check) => {
    await mount(page, null, { panel: false });
    await waitLive(page);
    const s = await snap(page);
    check('R7', `a page that is not a panel loads as always (open ${s.open}, layer=${s.layer})`, s.open === 1 && s.live && !s.layer);
    check('R7', `and never subscribes (${JSON.stringify(s.subs)})`, s.subs.length === 0);
  },
  R8: async (page, check) => {
    await mount(page, pc('standby'), { deadline: 60 });
    await waitLayer(page);
    await sleep(1200);
    check('R8', `while it rings the waiting panel stays on the call (at ${await where(page)})`, (await where(page)) === CARD_PATH);
    await ev(page, (p) => { window.__panelCall = p; window.tPush(p); }, pc('keep', 'missed'));
    await sleep(300);
    const s = await snap(page);
    check('R8', `missed: "${s.text}", still no session (opened ${s.opened})`, s.layer && s.text === 'Missed call' && s.opened === 0);
    await sleep(1400);
    check('R8', `then it goes home (at ${await where(page)})`, (await where(page)) === '/lovelace');
  },
  R9: async (page, check) => {
    await mount(page, pc('release', 'answered'));
    await waitLayer(page).catch(() => {});
    await sleep(1200);
    const s = await snap(page);
    check('R9', `woken after the call was answered: no live video by itself (opened ${s.opened})`, s.opened === 0 && !s.live);
    check('R9', `it says what happened: "${s.text}"`, s.layer && s.text === 'Answered on another device');
  },
};

// R10 / R11: the module-level listener (no card on the page: a dashboard without the doorbell).
async function callPageInPlace(page, check, id, expectOffer) {
  await ev(page, () => { history.replaceState(null, '', '/lovelace/0'); window.tHomeAssistant(); });
  await sleep(1600);   // the listener looks for <home-assistant> once a second
  const offered = await ev(page, () => window.__panelSubs.filter((s) => s.msg.type === 'ig_doorbell/subscribe_call_page').length);
  if (!expectOffer) {
    check(id, `a desktop browser does not offer itself for the call page (subscriptions ${offered})`, offered === 0);
    return;
  }
  check(id, `the iPad's page offers itself for the call page (subscriptions ${offered})`, offered === 1);
  await ev(page, () => window.tPushCallPage({ token: 'bench-token', url: '/ig-doorbell?device=aaaa1111' }));
  await sleep(300);
  const r = await ev(page, () => ({ at: location.pathname + location.search, ack: window.__sent.filter((t) => t === 'ig_doorbell/call_page_ack').length }));
  check(id, `asked on a ring, it goes to the call page in this window (at ${r.at}) and says so (acks ${r.ack})`, r.at === '/ig-doorbell?device=aaaa1111' && r.ack === 1);
}
CASES.R10 = (page, check) => callPageInPlace(page, check, 'R10', true);
CASES.R11 = (page, check) => callPageInPlace(page, check, 'R11', false);

async function runCase(browser, name, body) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const page = await openPage(browser, body, { ios: name === 'R10' });
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
  const all = Object.keys(CASES);
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
