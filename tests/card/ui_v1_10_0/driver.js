// Real-browser check of v1.10.0: the card has NO configuration and switches doorbells live.
// Loads the REAL dist/ file; harness.js only doubles the network and hass (see its header).
//
// RUN (from the repo root):
//   1. python -m http.server 8797
//   2. node test/ui_v1_10_0/driver.js
//
// POSITIVE CONTROLS ARE BUILT IN: after the real run, the same checks run against three MUTANTS of
// dist/ (served through page.route), each re-introducing one known failure. The run only passes if
// the real file is all green AND every mutant turns its target check red. A check that cannot fail
// is not a check (CLAUDE.md of the firmware repo).
//   M1 "apps' dot bug": the header dot keeps the last green across doorbells (a dot held outside
//      the per-doorbell instance, like Android's fixed green / iOS's stale dot).
//   M2 "no teardown on switch": the old doorbell's instance is removed without hanging up.
//   M3 "mic race": getUserMedia resolving after a switch is not checked against the session.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/ui_v1_10_0/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mutate(src, name) {
  // The working copy may be CRLF (git autocrlf on Windows); anchors are written with LF.
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const swap = (a, b) => {
    const n = src.split(a).length - 1;
    if (n !== 1) throw new Error(`mutant ${name}: anchor found ${n} times: ${a.slice(0, 60)}`);
    return src.replace(a, b);
  };
  if (name === 'M1') {
    return swap('if (this._dbDot) this._dbDot.dataset.state = dataState;',
      "if (this._dbDot) { if (dataState === 'live' || dataState === 'open') window.__stickyDot = dataState; this._dbDot.dataset.state = window.__stickyDot || dataState; }");
  }
  if (name === 'M2') {
    return swap('      oldView._destroy(`doorbell change: ${reason}`);\n', '');
  }
  if (name === 'M3') {
    // (1.2.2) Since then four things each release a mic granted after a switch: the generation, the
    // request token and the allowed-state checks after the permission resolves, and the release in
    // the catch (replaceTrack() on the closed peer rejects). The mutant removes all four (the
    // watchdog behind them acts only after 2 s; T6 looks at 200 ms).
    src = swap('if (this._destroyed || genMic !== this._connGen) {', 'if (false) {');
    src = swap('if (micReq !== this._micReq) {', 'if (false) {');
    src = swap('if (!this._micAllowed()) {\n          // Paused', 'if (false) {\n          // Paused');
    // (The pre-check at the top of _startTalk stays: T6 starts the talk BEFORE the switch.)
    return swap('a track already obtained is stopped.\n        this._closeMicHardware();', 'a track already obtained is stopped.');
  }
  return src;
}

async function run(browser, variant) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  if (variant !== 'real') {
    const body = mutate(fs.readFileSync(DIST, 'utf8'), variant);
    await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  }
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // ---- T1 zero config ----------------------------------------------------------------------
  let err = await ev(() => window.tCreate({ type: 'custom:ig-doorbell-card' }));
  await sleep(300);
  let p = await ev(() => window.tPicker());
  check('T1', 'type-only YAML: no error, one view', !err && (await ev(() => window.tViews())) === 1);
  check('T1', 'default = first by name (Ermita 10), name shown, never the id', p && p.device === 'aaaa1111' && p.name === 'Ermita 10');
  check('T1', 'two doorbells: chevron shown, translated title', p && p.chevron && p.title === 'Cambiar de portero');
  check('T1', 'new session starts NOT green', p && p.dot === 'connecting');
  const vid = await ev(() => { const v = window.tView(); return { rec: v._entityFor('rec'), mode: v._entityFor('mode'), motion: v._entityFor('motion'), ring: v._entityFor('ring') }; });
  check('T1', 'entities derived from registries (rec/mode/motion/ring)', vid.rec === 'switch.ermita_10_rec' && vid.mode === 'select.ermita_10_mode' && vid.motion === 'binary_sensor.ermita_10_visitor' && vid.ring === 'event.ermita_10_events');
  await ev(() => window.tReset());

  // legacy YAML is ignored silently
  err = await ev(() => window.tCreate({ type: 'custom:ig-doorbell-card', device_id: 'bbbb2222', unlock_entity: 'switch.x', rec_entity: 'switch.y', height: '650px', idle_release_seconds: 5, unlock_duration: 9 }));
  await sleep(200);
  p = await ev(() => window.tPicker());
  const legacyRec = await ev(() => window.tView()._entityFor('rec'));
  check('T1b', 'legacy keys: no config error, card mounts', !err && p !== null);
  check('T1b', 'legacy rec_entity ignored (entity comes from the registry)', legacyRec === 'switch.ermita_10_rec');
  await ev(() => window.tReset());

  // ---- T2 default memory -------------------------------------------------------------------
  await ev(() => { localStorage.setItem('ig-doorbell-card-selected', 'bbbb2222'); window.tCreate(); });
  await sleep(150);
  p = await ev(() => window.tPicker());
  check('T2', 'last chosen in this browser wins', p && p.device === 'bbbb2222' && p.name === 'Waveshare');
  await ev(() => window.tReset());
  await ev(() => { localStorage.setItem('ig-doorbell-card-selected', 'deadbeef'); window.tCreate(); });
  await sleep(150);
  p = await ev(() => window.tPicker());
  check('T2', 'stored id no longer present -> first', p && p.device === 'aaaa1111');
  await ev(() => window.tReset());
  await ev(() => { window.__origGet = Storage.prototype.getItem; Storage.prototype.getItem = () => { throw new Error('blocked'); }; window.tCreate(); });
  await sleep(150);
  p = await ev(() => window.tPicker());
  check('T2', 'localStorage throwing -> still works (first)', p && p.device === 'aaaa1111');
  await ev(() => { Storage.prototype.getItem = window.__origGet; window.tReset(); });

  // ---- T3 the apps' bug: name changes, dot must not stay green --------------------------------
  await ev(() => { window.tDb('bbbb2222', { sse: 'hang' }); window.tCreate(); });
  await sleep(400);
  const oldView = await ev(() => { const v = window.tView(); v._setLiveState('live'); window.__old = v; return v.querySelector('#db-dot').dataset.state; });
  check('T3', 'precondition: doorbell A streaming, dot green', oldView === 'live');
  const aSessionsBefore = await ev(() => window.tOpenSessions().filter((s) => s.startsWith('aaaa')).length);
  await ev(() => window.tPick('bbbb2222'));
  await sleep(250);
  p = await ev(() => window.tPicker());
  check('T3', 'header shows the new doorbell name', p && p.name === 'Waveshare' && p.device === 'bbbb2222');
  check('T3', 'dot is NOT green for a doorbell without a session', p && p.dot !== 'live' && p.dot !== 'open');
  check('T3', 'live tag agrees (connecting)', p && p.live === 'connecting');
  const old = await ev(() => ({ inDom: document.contains(window.__old), destroyed: !!window.__old._destroyed, pc: !!window.__old.pc }));
  check('T3', 'old instance removed, destroyed, no peer connection', !old.inDom && old.destroyed && !old.pc);
  const aAfter = await ev(() => window.tOpenSessions().filter((s) => s.startsWith('aaaa')));
  check('T3', `old doorbell hung up (bye/closed): open A sessions ${aSessionsBefore} -> ${aAfter.length}`, aSessionsBefore === 1 && aAfter.length === 0);
  await ev(() => { window.tDb('bbbb2222', { sse: 'offer' }); window.tReset(); });

  // ---- T4 rapid A->B->A->B->A: one session, one pc, one view ----------------------------------
  await ev(() => window.tCreate());
  await sleep(300);
  await ev(async () => {
    const seq = ['bbbb2222', 'aaaa1111', 'bbbb2222', 'aaaa1111', 'bbbb2222', 'aaaa1111'];
    for (let i = 0; i < seq.length; i++) {
      window.tPick(seq[i]);
      await new Promise((r) => setTimeout(r, i % 2 ? 0 : 40));   // mixed: back-to-back and 40 ms gaps
    }
  });
  await sleep(1500);
  const open4 = await ev(() => window.tOpenSessions());
  const pcs4 = await ev(() => window.tOpenPcs());
  p = await ev(() => window.tPicker());
  check('T4', `after 6 rapid switches: exactly one open session, on A (${open4.join(',')})`, open4.length === 1 && open4[0].startsWith('aaaa'));
  check('T4', `exactly one RTCPeerConnection open (${pcs4})`, pcs4 === 1);
  check('T4', 'exactly one view in the DOM, on A', (await ev(() => window.tViews())) === 1 && p.device === 'aaaa1111');
  await ev(() => window.tReset());

  // ---- T5 a LATE answer from the old doorbell cannot write into the new one --------------------
  await ev(() => { window.tDb('aaaa1111', { connDelay: 500 }); window.tCreate(); });
  await sleep(60);
  await ev(() => window.tPick('bbbb2222'));
  await sleep(900);   // A's get_connection_info (admin) resolves ~440 ms after the switch
  const t5 = await ev(() => { const v = window.tView(); return { dev: v.config.device_id, role: v._connInfo && v._connInfo.role, rec: v.querySelector('#rec-action').style.display }; });
  check('T5', 'late admin answer from A does not reach B (role user, REC hidden)', t5.dev === 'bbbb2222' && t5.role === 'user' && t5.rec === 'none');
  await ev(() => { window.tDb('aaaa1111', { connDelay: 20 }); window.tReset(); });

  // ---- T6 microphone permission resolving after the switch -----------------------------------
  await ev(() => window.tCreate());
  await sleep(400);
  await ev(() => {
    window.__micTrack = null;
    navigator.mediaDevices.getUserMedia = () => new Promise((res) => { window.__releaseMic = res; });
    window.tView()._startTalk();
  });
  await sleep(50);
  await ev(() => window.tPick('bbbb2222'));
  await sleep(100);
  await ev(() => {
    const ctx = new AudioContext();
    const dst = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator(); osc.connect(dst); osc.start();
    window.__micTrack = dst.stream.getAudioTracks()[0];
    window.__releaseMic(dst.stream);
  });
  await sleep(200);
  const t6 = await ev(() => ({ state: window.__micTrack.readyState, active: window.tView().talkActive }));
  check('T6', `mic granted after the switch is released unused (track ${t6.state})`, t6.state === 'ended' && !t6.active);
  await ev(() => window.tReset());

  // ---- T7 open panels / armed door do not travel ----------------------------------------------
  await ev(() => window.tCreate());
  await sleep(400);
  await ev(() => { const v = window.tView(); v._openQuickReplies(); v._armDoorConfirm(); });
  await sleep(100);
  await ev(() => window.tPick('bbbb2222'));
  await sleep(300);
  const t7 = await ev(() => { const v = window.tView(); return { qr: !!v._qrOpen, panel: v.querySelector('#qr-panel').style.display, armed: !!v._doorArmedAt, list: JSON.stringify(v._quickReplies || null) }; });
  check('T7', 'quick-reply panel of A is not open on B, B has no A list', !t7.qr && t7.panel !== 'flex' && !/Ahora bajo/.test(t7.list));
  check('T7', 'armed door confirmation of A does not carry over', !t7.armed);
  await ev(() => window.tReset());

  // ---- T8 menu rows: current = session dot; others = HA availability ---------------------------
  await ev(() => { window.tDb('bbbb2222', { available: false }); window.tCreate(); });
  await sleep(300);
  const t8 = await ev(() => {
    const v = window.tView(); v.querySelector('#db-pill').click();
    const row = (id) => v.querySelector(`.db-opt[data-id="${id}"] .db-dot`).dataset.state;
    const r = { a: row('aaaa1111'), b: row('bbbb2222'), open: v.querySelector('#db-menu').style.display };
    document.body.click();
    r.closed = v.querySelector('#db-menu').style.display;
    return r;
  });
  check('T8', `menu: current row = session state (${t8.a}), unavailable doorbell = down (${t8.b})`, t8.a === 'connecting' && t8.b === 'down');
  check('T8', 'menu opens on tap and closes on an outside click', t8.open === 'flex' && t8.closed === 'none');
  await ev(() => { window.tDb('bbbb2222', { available: true }); window.tReset(); });

  // ---- T9 a single doorbell: capsule is a title, not a dropdown -------------------------------
  await ev(() => { window.__dbBackup = JSON.parse(JSON.stringify(window.__db)); window.tOnlyOne(); window.tCreate(); });
  await sleep(200);
  const t9 = await ev(() => { const v = window.tView(); v.querySelector('#db-pill').click(); return { chev: v.querySelector('#db-chev').style.display, menu: v.querySelector('#db-menu').style.display, name: v.querySelector('#db-name').textContent }; });
  check('T9', 'one doorbell: name shown, no chevron, tap opens nothing', t9.chev === 'none' && t9.menu === 'none' && t9.name === 'Ermita 10');
  await ev(() => { window.__db = window.__dbBackup; window.tRebuild(); window.tReset(); });

  // ---- T10 language + editor ------------------------------------------------------------------
  await ev(() => { window.__lang = 'de'; window.tCreate(); });
  await sleep(200);
  p = await ev(() => { window.tTick(); return window.tPicker(); });
  check('T10', 'German title', p && p.title === 'Klingel wechseln');
  const ed = await ev(async () => {
    const El = customElements.get('ig-doorbell-card');
    const e = await El.getConfigElement();
    e.hass = window.__hass; e.setConfig({ type: 'custom:ig-doorbell-card' });
    return { inputs: e.querySelectorAll('input, ha-selector').length, text: e.textContent.trim() };
  });
  check('T10', 'editor: no inputs, translated note pointing to the integration', ed.inputs === 0 && /Islautopia Garage Doorbell/.test(ed.text) && /Konfigurieren/.test(ed.text));
  check('T10', 'stub config is empty', (await ev(() => JSON.stringify(customElements.get('ig-doorbell-card').getStubConfig()))) === '{}');
  await ev(() => { window.__lang = 'es'; window.tReset(); });

  check('T0', `no page errors (${errors.slice(0, 2).join(' | ')})`, errors.length === 0);
  await page.close();
  return results;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  let fails = 0;
  const real = await run(browser, 'real');
  console.log('\n=== REAL dist/ ===');
  for (const r of real) { console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} [${r.id}] ${r.label}`); if (!r.ok) fails++; }
  const expect = { M1: 'T3', M2: 'T3', M3: 'T6' };
  for (const m of Object.keys(expect)) {
    const res = await run(browser, m);
    const red = res.filter((r) => !r.ok).map((r) => r.id);
    const hit = red.includes(expect[m]);
    console.log(`\n=== MUTANT ${m} (must turn ${expect[m]} red) -> red: [${[...new Set(red)].join(', ')}] ${hit ? 'OK' : 'FAIL: the check did not see the bug'}`);
    for (const r of res.filter((x) => !x.ok)) console.log(`    red: [${r.id}] ${r.label}`);
    if (!hit) fails++;
  }
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL OK (real green, every mutant caught)');
  process.exit(fails ? 1 : 0);
})();
