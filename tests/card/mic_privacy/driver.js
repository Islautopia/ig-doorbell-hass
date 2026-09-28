// Real-browser check of 1.2.2: the microphone lives ONLY inside an active talk turn, and the call
// page never shows a doorbell other than the one it was asked for.
//
// Loads the REAL card file; ../ui_v1_10_0/harness.js doubles only the network and hass. Chromium's
// fake microphone (--use-fake-device-for-media-stream) gives REAL MediaStreamTracks, and index.html
// records every audio track getUserMedia() returns: "live mic" is the browser's own readyState, not
// what the card believes.
//
// THE MEASURED BUG (2026-09-28, salon wall tablet, Android HA app WebView): a HIDDEN page held the
// microphone capture for over an hour until reloaded; the night before, two captures at once.
//
// CASES (L = live microphone tracks on the page)
//   P0 the instrument: a getUserMedia() made by the bench itself counts 1, and 0 once stopped
//      (positive and negative control of the counter).
//   P1 talk on -> L=1 (positive control of the path); talk off -> L=0.
//   P2 hang-up (session torn down) -> L=0.       P3 the card leaves the DOM -> L=0.
//   P4 visibilitychange to hidden -> L=0; visible again -> the turn is requested again (same state).
//   P5 pagehide -> L=0.                          P6 doorbell switch -> L=0.
//   P7 the session drops (reconnect) -> L=0, and the reconnection does not reopen it.
//   P8 hidden while the turn is still REQUESTED: neither the 3 s legacy timer nor a late talk_granted
//      opens the mic on the hidden page (leak 1).
//   P9 getUserMedia resolving AFTER the talk was stopped -> released unused (leak 2).
//   P10 a second _startTalk() while one is open -> never two live tracks (leak 3).
//   P11 no audio sender -> the obtained track is stopped, not kept (leak 4).
//   P12 a view removed from the DOM WITHOUT its cleanup (disconnectedCallback neutered) -> the
//       watchdog stops the track within ~2.5 s and logs it.
//   P13 a DUPLICATE copy of the card module loaded on the page: one shared registry, no page errors,
//       and hiding still leaves L=0.
//   P14 watchdog: a live track whose talk turn vanished without its stop (state corrupted by hand)
//       is stopped within ~2.5 s.
//   D1 forced unknown doorbell -> no view, no session, the translated error.
//   D2 forced by Home Assistant's device id -> exactly that doorbell.
//   D3 the requested doorbell changes to an unknown one while showing another -> hung up, error.
//   D4 the call page /ig-doorbell?device=<unknown> -> no card view, no session, the error.
//   D5 the call page without `device` and two doorbells -> "no doorbell chosen", no session.
//
// POSITIVE CONTROLS BUILT IN: the same cases against MUTANTS of the card (page.route); each must turn
// its target red.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/mic_privacy/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUTANTS = {
  // _stopTalk no longer cancels a turn still requested (the pre-1.2.2 behaviour), and _startTalk no
  // longer refuses to ask on a hidden view (the two layers that keep getUserMedia from being called)
  MA: { target: 'P8', also: 'MA2', a: "    if (this._talkTimer) { clearTimeout(this._talkTimer); this._talkTimer = null; }\n    this._talkPending = false;\n    this._talkHeld = false;\n    this._listenOnly = false;\n    this.talkActive = false;\n    this._setAudioOn(this._audioOnBeforeMic, 'mic-closed');", b: "    this._talkHeld = false;\n    this._listenOnly = false;\n    this.talkActive = false;\n    this._setAudioOn(this._audioOnBeforeMic, 'mic-closed');" },
  // no check after the permission resolves (the token AND the allowed-state check): kept after the stop
  MB: { target: 'P9', a: "        if (micReq !== this._micReq) {\n", b: "        if (false) {\n", also: 'MB2' },
  MB2: { helper: true, a: "        if (!this._micAllowed()) {\n          // Paused", b: "        if (false) {\n          // Paused" },
  // the pre-check at the top of _startTalk (not even ASK on a hidden view) - goes with MA
  MA2: { helper: true, a: "    if (!this._micAllowed()) {\n      this.talkActive = false;", b: "    if (false) {\n      this.talkActive = false;" },
  // no watchdog timer
  MC: { target: 'P12', a: "  if (!IG_MIC.timer) IG_MIC.timer = setInterval(() => igMicSweep('watchdog', false), IG_MIC_TICK_MS);\n", b: '' },
  // a second stream overwrites the first without stopping it
  MD: { target: 'P10', a: "        if (this.localAudioStream && this.localAudioStream !== probeStream) {\n", b: "        if (false) {\n" },
  // no sender: the track is kept (the pre-1.2.2 behaviour) - and the watchdog is off so it is not rescued
  ME: { target: 'P11', a: "          throw new Error('no audio sender at this moment: the microphone is not opened');\n", b: '', also: 'MC' },
  // the requested doorbell falls back to the first one
  MG: { target: 'D1', a: 'const target = this._resolveForced(list);', b: 'const target = this._resolveForced(list) || list[0].id;' },
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

// ---- page helpers ----------------------------------------------------------------------------------
async function openPage(browser, body) {
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  const errors = [];
  const logs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => logs.push(m.text()));
  await page.goto(BASE);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  page.__errors = errors;
  page.__logs = logs;
  return page;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);
const live = (page) => ev(page, () => window.tLiveMic());

// A card on the page with its session up (the fake doorbell's offer answered: pc + slot).
async function mountLive(page, { one = true, lang = 'en' } = {}) {
  await ev(page, ({ one, lang }) => { window.__lang = lang; if (one) window.tOnlyOne(); window.tCreate(); }, { one, lang });
  await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v._slot !== null && v._slot !== undefined; }, null, { timeout: 8000 });
}

// The user taps the mic and the doorbell grants the turn.
async function talkOn(page) {
  await ev(page, () => { const v = window.tView(); v.toggleTalk(); v._handleTalkGranted({ slot: v._slot }); });
  await page.waitForFunction(() => { const v = window.tView(); return v && v.localAudioStream && window.tLiveMic() === 1; }, null, { timeout: 5000 }).catch(() => {});
}

const CASES = {
  P0: async (page, check) => {
    const a = await ev(page, async () => { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); return { n: window.tLiveMic(), s: !!s }; });
    check('P0', `instrument sees a track the bench opened (L=${a.n})`, a.n === 1);
    await ev(page, () => window.tStopAllMic());
    check('P0', `instrument sees it stopped (L=${await live(page)})`, (await live(page)) === 0);
  },
  P1: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    check('P1', `talk on: L=1 (got ${await live(page)})`, (await live(page)) === 1);
    await ev(page, () => window.tView().toggleTalk());
    await sleep(50);
    check('P1', `talk off: L=0 (got ${await live(page)})`, (await live(page)) === 0);
  },
  P2: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => { const v = window.tView(); v._pause('idle'); v._hangUpPaused(); });
    await sleep(50);
    check('P2', `hang-up: L ${before} -> ${await live(page)}`, before === 1 && (await live(page)) === 0);
  },
  P3: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => window.tCard.remove());
    await sleep(50);
    check('P3', `card left the DOM: L ${before} -> ${await live(page)}`, before === 1 && (await live(page)) === 0);
  },
  P4: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => window.tSetVisible(false));
    await sleep(50);
    const hidden = await live(page);
    await sleep(3500);   // neither a timer nor anything else reopens it while hidden
    const later = await live(page);
    check('P4', `hidden: L ${before} -> ${hidden}, still ${later} after 3.5 s`, before === 1 && hidden === 0 && later === 0);
    const sent = await ev(page, () => {
      const v = window.tView(); window.__sent = [];
      const o = v.sendNativeSignal.bind(v); v.sendNativeSignal = (m) => { window.__sent.push(m.type); return o(m); };
      window.tSetVisible(true); return window.__sent;
    });
    check('P4', `visible again: the turn is requested again, same state (${sent.join(',')})`, sent.includes('talk_request'));
  },
  P5: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })));
    await sleep(50);
    check('P5', `pagehide: L ${before} -> ${await live(page)}`, before === 1 && (await live(page)) === 0);
  },
  P6: async (page, check) => {
    await mountLive(page, { one: false });
    await talkOn(page);
    const before = await live(page);
    const from = await ev(page, () => window.tView().config.device_id);
    const to = from === 'aaaa1111' ? 'bbbb2222' : 'aaaa1111';
    await ev(page, (id) => window.tPick(id), to);
    await sleep(100);
    check('P6', `doorbell switch ${from} -> ${to}: L ${before} -> ${await live(page)}`, before === 1 && (await live(page)) === 0);
  },
  P7: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => window.tView()._scheduleReconnect('bench: session dropped'));
    await sleep(50);
    const dropped = await live(page);
    await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && !v._reconnecting; }, null, { timeout: 8000 }).catch(() => {});
    await sleep(500);
    check('P7', `session dropped: L ${before} -> ${dropped}; after the reconnection ${await live(page)}`, before === 1 && dropped === 0 && (await live(page)) === 0);
  },
  P8: async (page, check) => {
    await mountLive(page);
    await ev(page, () => window.tView().toggleTalk());   // requested, not granted yet
    await sleep(200);
    await ev(page, () => window.tSetVisible(false));
    await sleep(3500);                                     // the 3 s legacy timer
    const afterTimer = await live(page);
    await ev(page, () => { const v = window.tView(); v._handleTalkGranted({ slot: v._slot }); });   // a late grant
    await sleep(500);
    // Not even a momentary capture: the mic must not be REQUESTED on a hidden page (the system's
    // "microphone in use" indicator would light up), not just released afterwards.
    const asked = await ev(page, () => window.__micTracks.length);
    check('P8', `hidden with the turn requested: legacy timer -> L=${afterTimer}, late talk_granted -> L=${await live(page)}`, afterTimer === 0 && (await live(page)) === 0);
    check('P8', `and getUserMedia was never even called while hidden (calls=${asked})`, asked === 0);
  },
  P9: async (page, check) => {
    await mountLive(page);
    await ev(page, () => { window.__gumDelay = 800; const v = window.tView(); v.toggleTalk(); v._handleTalkGranted({ slot: v._slot }); });
    await sleep(200);
    await ev(page, () => window.tView().toggleTalk());   // the user stops while the permission is pending
    await sleep(1100);                                     // resolved ~600 ms ago: before the watchdog's 2 s
    check('P9', `getUserMedia resolved after the stop: L=${await live(page)}`, (await live(page)) === 0);
  },
  P10: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    await ev(page, () => window.tView()._startTalk());
    await sleep(400);
    const n = await live(page);
    await ev(page, () => window.tView().toggleTalk());
    await sleep(50);
    check('P10', `second _startTalk while open: L=${n} (never 2), after stop ${await live(page)}`, n === 1 && (await live(page)) === 0);
  },
  P11: async (page, check) => {
    await mountLive(page);
    await ev(page, () => { const v = window.tView(); v.audioTransceiver = null; v.toggleTalk(); v._handleTalkGranted({ slot: v._slot }); });
    await sleep(3000);
    check('P11', `no audio sender: L=${await live(page)} (the track obtained is stopped)`, (await live(page)) === 0);
  },
  P12: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    // Custom-element reactions call the CLASS's disconnectedCallback, so the cleanup it calls is
    // neutered on the instance instead: the view leaves the DOM with its talk still "on".
    await ev(page, () => { const v = window.tView(); v._pause = () => {}; v._releaseListeners = () => {}; window.tCard.remove(); });
    await sleep(300);
    const soon = await live(page);
    await sleep(2700);
    const later = await live(page);
    const logged = page.__logs.some((l) => /PRIVACY: stopped a live microphone track/.test(l));
    check('P12', `removed without cleanup: L=${soon} at 0.3 s -> ${later} at 3 s, logged=${logged}`, soon <= 1 && later === 0 && logged);
  },
  P13: async (page, check) => {
    // As Home Assistant loads it: a MODULE (a second copy at another URL, e.g. HACS + the integration).
    await page.addScriptTag({ type: 'module', url: '../../../custom_components/ig_doorbell/frontend/ig-doorbell-card.js?dup=1' });
    await sleep(200);
    const shared = await ev(page, () => !!window.__igDoorbellMic && window.__igDoorbellMic.tracks instanceof Map);
    await mountLive(page);
    await talkOn(page);
    const before = await live(page);
    await ev(page, () => window.tSetVisible(false));
    await sleep(50);
    check('P13', `duplicate module: shared registry=${shared}, L ${before} -> ${await live(page)}, page errors=${page.__errors.length}`, shared && before === 1 && (await live(page)) === 0 && page.__errors.length === 0);
  },
  P14: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    await ev(page, () => { const v = window.tView(); v.talkActive = false; v.localAudioStream = null; });   // turn gone, no stop
    await sleep(3000);
    check('P14', `watchdog: orphan track with no talk turn -> L=${await live(page)} after 3 s`, (await live(page)) === 0);
  },
  D1: async (page, check) => {
    const r = await ev(page, async () => {
      window.__lang = 'en';
      const card = document.createElement('ig-doorbell-card');
      card.forcedDoorbell = 'zzzz9999';
      card.setConfig({ type: 'custom:ig-doorbell-card' });
      card.hass = window.__hass;
      document.getElementById('host').appendChild(card);
      window.tCard = card;
      await new Promise((res) => setTimeout(res, 800));
      const e = card.querySelector('.ig-empty');
      return { views: window.tViews(), sessions: window.__sessions.length, text: e ? e.textContent : null };
    });
    check('D1', `unknown doorbell: views=${r.views}, sessions=${r.sessions}`, r.views === 0 && r.sessions === 0);
    check('D1', `unknown doorbell: the error says so ("${r.text}")`, r.text === "This doorbell isn't set up in Home Assistant.");
  },
  D2: async (page, check) => {
    const r = await ev(page, async () => {
      const card = document.createElement('ig-doorbell-card');
      card.forcedDoorbell = 'ha-bbbb2222';
      card.setConfig({ type: 'custom:ig-doorbell-card' });
      card.hass = window.__hass;
      document.getElementById('host').appendChild(card);
      window.tCard = card;
      await new Promise((res) => setTimeout(res, 800));
      return { dev: window.tView() && window.tView().config.device_id, sessions: window.__sessions.map((s) => s.dev) };
    });
    check('D2', `HA device id maps to its doorbell: ${r.dev}, sessions ${r.sessions.join(',')}`, r.dev === 'bbbb2222' && r.sessions.every((d) => d === 'bbbb2222'));
  },
  D3: async (page, check) => {
    const r = await ev(page, async () => {
      window.__lang = 'es';
      const card = document.createElement('ig-doorbell-card');
      card.forcedDoorbell = 'aaaa1111';
      card.setConfig({ type: 'custom:ig-doorbell-card' });
      card.hass = window.__hass;
      document.getElementById('host').appendChild(card);
      window.tCard = card;
      await new Promise((res) => setTimeout(res, 800));
      const first = window.tView() && window.tView().config.device_id;
      card.forcedDoorbell = 'nope';
      await new Promise((res) => setTimeout(res, 300));
      const e = card.querySelector('.ig-empty');
      return { first, views: window.tViews(), open: window.tOpenSessions(), text: e ? e.textContent : null };
    });
    check('D3', `showing ${r.first}, then unknown: views=${r.views}, open sessions=${r.open.join(',') || 'none'}`, r.first === 'aaaa1111' && r.views === 0 && r.open.length === 0);
    check('D3', `translated error ("${r.text}")`, r.text === 'Este portero no está configurado en Home Assistant.');
  },
  D4: async (page, check) => {
    const r = await callPage(page, '?device=zzzz9999');
    check('D4', `call page, unknown device: views=${r.views}, sessions=${r.sessions}`, r.cardThere && r.views === 0 && r.sessions === 0);
    check('D4', `call page shows the error ("${r.text}")`, r.text === "This doorbell isn't set up in Home Assistant.");
  },
  D5: async (page, check) => {
    const r = await callPage(page, '');
    check('D5', `call page, no device, two doorbells: no card, sessions=${r.sessions}, "${r.none}"`, !r.cardThere && r.sessions === 0 && /No doorbell chosen/.test(r.none || ''));
  },
};

async function callPage(page, search) {
  await ev(page, (s) => { window.__lang = 'en'; history.replaceState(null, '', location.pathname + s); }, search);
  await page.addScriptTag({ url: '../../../custom_components/ig_doorbell/frontend/ig-doorbell-panel.js' });
  return ev(page, async () => {
    const p = document.createElement('ig-doorbell-panel');
    p.panel = { config: { devices: ['aaaa1111', 'bbbb2222'], card_url: null } };
    document.getElementById('host').appendChild(p);
    p.hass = window.__hass;
    await new Promise((res) => setTimeout(res, 900));
    const card = p.shadowRoot.querySelector('ig-doorbell-card');
    const e = card && card.querySelector('.ig-empty');
    const none = p.shadowRoot.querySelector('.none');
    return {
      cardThere: !!card,
      views: card ? card.querySelectorAll('ig-doorbell-view').length : 0,
      sessions: window.__sessions.length,
      text: e ? e.textContent : null,
      none: none ? none.textContent : null,
    };
  });
}

async function runCase(browser, name, body) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const page = await openPage(browser, body);
  try {
    await CASES[name](page, check);
  } catch (e) {
    check(name, `crashed: ${e && e.message}`, false);
  }
  if (page.__errors.length) check(name, `page errors: ${page.__errors.slice(0, 2).join(' | ')}`, false);
  await page.close();
  return results;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let allOk = true;
  const only = process.env.ONLY_CASES ? process.env.ONLY_CASES.split(',') : Object.keys(CASES);
  const real = [];
  // CARD_FILE: run the cases against another build (e.g. the 1.2.1 card, to see the bug itself).
  const override = process.env.CARD_FILE ? fs.readFileSync(process.env.CARD_FILE, 'utf8') : null;
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
