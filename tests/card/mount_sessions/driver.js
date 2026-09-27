// Real-browser check: every card mount opens EXACTLY ONE session at the doorbell, including when
// Home Assistant rebuilds the card instead of re-inserting it.
// Loads the REAL card file; ../ui_v1_10_0/harness.js only doubles the network and hass. "Open at
// the doorbell" = its SSE is still open and no `bye` arrived for its slot (harness tOpenSessions()).
//
// THE MEASURED BUG (2026-09-27, Waveshare + real Home Assistant, /api/debug/cores every 100 ms):
// leaving the dashboard and coming back within the 15 s pause grace, Home Assistant builds a NEW
// card; the old view, off the page, keeps its paused session until its grace runs out. viewers=2 for
// ~12 s, then 1. Each mount opened one EventSource and closed it with `bye`: nothing leaked, the
// grace was simply kept for an element nobody would put back.
//
// CASES
//   S1 a fresh mount opens exactly one session.
//   S2 HA rebuilds the card within the grace (the measured bug): the new mount opens exactly one
//      session, the detached one is hung up (`bye`) BEFORE the new SSE opens, one session open.
//   S3 HA re-inserts the SAME element within the grace: it resumes, no new session, no `bye`
//      (the 2026-09-25 pause rule must survive the fix).
//   S4 a card still ON the page and paused as hidden (scrolled off-screen: it resumes when scrolled
//      back within the grace) is not hung up by a second card of the same doorbell mounting.
//   S5 a detached view of ANOTHER doorbell is not hung up by a mount of a different doorbell.
//
// POSITIVE CONTROLS ARE BUILT IN: after the real run, the same checks run against MUTANTS of the
// card (served through page.route); each must turn its target case red.
//   X1 no hang-up of the detached twin (the pre-fix behaviour)            -> S2
//   X2 the twin check ignores the doorbell id                             -> S5
//   X3 the twin check ignores whether the view is still on the page       -> S4
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/mount_sessions/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUTANTS = {
  X1: { target: 'S2', a: '    this._hangUpDetachedTwins(reason);   // BEFORE our EventSource: see VIEWS_WITH_SESSION\n', b: '' },
  X2: { target: 'S5', a: 'if (v.isConnected || !v.config || v.config.device_id !== id) continue;', b: 'if (v.isConnected || !v.config) continue;' },
  X3: { target: 'S4', a: 'if (v.isConnected || !v.config || v.config.device_id !== id) continue;', b: 'if (!v.config || v.config.device_id !== id) continue;' },
};

function mutate(src, name) {
  // The working copy may be CRLF (git autocrlf on Windows); anchors are written with LF.
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const m = MUTANTS[name];
  const n = src.split(m.a).length - 1;
  if (n !== 1) throw new Error(`mutant ${name}: anchor found ${n} times: ${m.a.slice(0, 60)}`);
  return src.replace(m.a, m.b);
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
  const opened = (dev) => ev((d) => window.__sessions.filter((s) => s.dev === d).length, dev);
  const open = () => ev(() => window.tOpenSessions());
  // The harness numbers slots per doorbell across the whole page; name the i-th session of this case.
  const nth = (i) => ev((k) => { const s = window.__sessions[k]; return s ? `${s.dev}#${s.slot}` : null; }, i);
  // Mount a card the way Home Assistant does, optionally on a given doorbell (the selector's memory).
  const mount = (dev) => ev((d) => {
    if (d) localStorage.setItem('ig-doorbell-card-selected', d);
    window.tCreate();
    const c = window.tCard;
    (window.__cards = window.__cards || []).push(c);
    return window.__cards.length - 1;
  }, dev || null);
  const cardAt = (i, fn) => ev(([k, f]) => (new Function('c', f))(window.__cards[k]), [i, fn]);
  const reset = () => ev(() => {
    // Hang up everything, including cards off the page (tReset only sees the page).
    (window.__cards || []).forEach((c) => c.querySelectorAll('ig-doorbell-view').forEach((v) => { try { v._destroy('test reset'); } catch (e) { /* */ } }));
    window.__cards = [];
    window.tReset();
    window.TESTLOG.length = 0;
  });

  // ---- S1 one mount, one session -----------------------------------------------------------------
  await mount();
  await sleep(600);
  check('S1', `fresh mount: sessions opened = 1 (got ${await opened('aaaa1111')})`, (await opened('aaaa1111')) === 1);
  check('S1', `fresh mount: open at the doorbell = 1 (${(await open()).join(',')})`, (await open()).length === 1);
  await reset();

  // ---- S2 HA rebuilds the card within the grace (the measured bug) --------------------------------
  await mount();
  await sleep(600);
  await cardAt(0, 'c.remove();');                 // leaving the dashboard: the old view pauses (grace)
  await sleep(300);
  const pausedOld = await cardAt(0, "const v = c.querySelector('ig-doorbell-view'); return v && v._pauseState ? v._pauseState.phase : null;");
  check('S2', `precondition: the detached view is in its grace (phase=${pausedOld})`, pausedOld === 'grace');
  await mount();                                   // coming back: Home Assistant builds a NEW card
  await sleep(600);
  const o2 = await open();
  check('S2', `rebuilt card: sessions opened by the new mount = 1 (total ${await opened('aaaa1111')})`, (await opened('aaaa1111')) === 2);
  const s2old = await nth(0); const s2new = await nth(1);
  check('S2', `rebuilt card: open at the doorbell = 1, the new one (${o2.join(',')}; new=${s2new})`, o2.length === 1 && o2[0] === s2new);
  const order = await ev(([a, b]) => {
    const L = window.TESTLOG;
    const bye = L.findIndex((l) => l.includes(`POST bye ${a.replace('#', ' slot=')}`));
    const sse = L.findIndex((l) => l.includes(`SSE open ${b.replace('#', ' slot=')}`));
    return { bye, sse };
  }, [s2old, s2new]);
  check('S2', `the old slot's bye goes out BEFORE the new SSE opens (bye@${order.bye}, sse@${order.sse})`, order.bye >= 0 && order.sse >= 0 && order.bye < order.sse);
  await reset();

  // ---- S3 the SAME element re-inserted within the grace: resume, no new session ---------------------
  await mount();
  await sleep(600);
  await cardAt(0, 'c.remove();');
  await sleep(300);
  await cardAt(0, "document.getElementById('host').appendChild(c);");
  await sleep(600);
  const o3 = await open();
  check('S3', `re-inserted element: no new session (opened ${await opened('aaaa1111')})`, (await opened('aaaa1111')) === 1);
  check('S3', `re-inserted element: still open, no bye (${o3.join(',')})`, o3.length === 1 && o3[0] === (await nth(0)));
  const phase3 = await cardAt(0, "const v = c.querySelector('ig-doorbell-view'); return v._pauseState;");
  check('S3', 'and it is no longer paused (resumed)', phase3 === null);
  await reset();

  // ---- S4 a card ON the page, paused (off-screen), is not hung up by a second card -----------------
  // (Not the idle pause: that one is stored per doorbell and a new card would not start at all.)
  await mount();
  await sleep(600);
  const idle = await cardAt(0, "const v = c.querySelector('ig-doorbell-view'); v._pause('hidden'); return v._pauseState && v._pauseState.phase;");
  await mount();
  await sleep(600);
  const o4 = await open();
  check('S4', `precondition: the on-page card is in its grace (${idle})`, idle === 'grace');
  check('S4', `on-page paused card keeps its session next to the new card (${o4.join(',')})`, o4.length === 2 && o4.includes(await nth(0)) && o4.includes(await nth(1)));
  await reset();

  // ---- S5 a detached view of ANOTHER doorbell is left alone ----------------------------------------
  await mount('aaaa1111');
  await sleep(600);
  await cardAt(0, 'c.remove();');
  await sleep(300);
  await mount('bbbb2222');
  await sleep(600);
  const o5 = await open();
  check('S5', `other doorbell: its detached view keeps its grace (${o5.join(',')})`, o5.length === 2 && o5.includes(await nth(0)) && o5.includes(await nth(1)));
  check('S5', `other doorbell: the new mount opened exactly one session (${await opened('bbbb2222')})`, (await opened('bbbb2222')) === 1);
  await reset();

  if (errors.length) check('E', `page errors: ${errors.slice(0, 2).join(' | ')}`, false);
  await page.close();
  return results;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  let allOk = true;
  const real = await run(browser, 'real');
  for (const r of real) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} [${r.id}] ${r.label}`);
  const bad = real.filter((r) => !r.ok);
  console.log(`\nREAL: ${real.length - bad.length}/${real.length} OK`);
  if (bad.length) allOk = false;
  if (!process.env.SKIP_MUTANTS) {
    for (const name of Object.keys(MUTANTS)) {
      const r = await run(browser, name);
      const red = [...new Set(r.filter((x) => !x.ok).map((x) => x.id))];
      const caught = red.includes(MUTANTS[name].target);
      console.log(`=== MUTANT ${name} (must turn ${MUTANTS[name].target} red) -> red: [${red.join(', ')}] ${caught ? 'OK' : 'NOT CAUGHT'}`);
      if (!caught) allOk = false;
    }
  }
  await browser.close();
  console.log(allOk ? '\nALL OK (real green, every mutant caught)' : '\nFAILED');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
