// Real-browser check of the 1.9.7 changes (Iñaki, 2026-09-25): the card fits the space it has,
// Recordings is actually visible, the mode chip is optimistic and reverts on error, the bell
// (notices) with type + time filters, no "System idle", the door button is a padlock.
// Loads the REAL dist/ file; harness.js only doubles the network and hass (same rule as the other
// harnesses in this directory).
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the repo root): python -m http.server 8797, then node ui_v1_9_7/driver.js
// POSITIVE CONTROL: CARD_FILE=<path to an older dist> node ui_v1_9_7/driver.js serves that
// file instead - with 1.9.6 this suite must go red (it did: see CLAUDE.md, v1.9.7).
const fs = require('fs');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/ui_v1_9_7/index.html';
const CARD_FILE = process.env.CARD_FILE || null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  // Advanced mode (2026-09-29): default is simple, which hides Recordings/mode-chip/REC - force
  // Advanced ON, this suite is about the advanced feature set. See ui_v1_9_2/driver.js. Harmless
  // against an older CARD_FILE control build: it predates the key and just ignores it.
  await page.addInitScript(() => { try { localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ } });
  if (CARD_FILE) {
    await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(CARD_FILE, 'utf8') }));
  }
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  console.log('\n########## 1. Phone portrait (393x852): stack layout, everything inside the screen ##########');
  let page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate(() => {
    window.tSetRole('admin');
    window.tSetHassState('select.modo_test', 'normal', { options: ['normal', 'away', 'do_not_disturb', 'custom'] });
    window.tSetHassState('switch.rec_test', 'off', {});
    window.tCreateCard('a', { mode_entity: 'select.modo_test', rec_entity: 'switch.rec_test', height: '650px' });
    window.tAttach('a');
    window.tRefreshHass('a');
  });
  await sleep(400);
  let r = await page.evaluate(() => {
    const c = window.__cards['a'];
    const rect = (s) => { const e = c.querySelector(s); const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
    return {
      stack: !!(c.content && c.content.classList.contains('ig-stack')),
      recordingsComputed: getComputedStyle(c.querySelector('#bottom-row')).display,
      cardBottom: c.getBoundingClientRect().bottom, vh: innerHeight,
      feed: rect('.feed-wrap'), top: rect('#top-row'), actions: rect('.actions-row'), rec: rect('#bottom-row'),
      actionsOutsideVideo: !c.querySelector('.feed-wrap .actions-row'),
      status: (c._resetStatusLine(), c.querySelector('#status-line').textContent.trim()),
      doorIcon: c.querySelector('#unlock-button ha-icon').getAttribute('icon'),
      mic: c.querySelector('#mic-button').getBoundingClientRect().width,
      door: c.querySelector('#unlock-button').getBoundingClientRect().width,
      snd: c.querySelector('#snd-btn').getBoundingClientRect().width,
    };
  });
  check('Recordings is visible for real (COMPUTED display, not the inline style)', r.recordingsComputed !== 'none');
  check('stack layout on a phone in portrait', r.stack);
  check('video first, then chips, then buttons, then Recordings', r.feed.bottom <= r.top.top && r.top.bottom <= r.actions.top && r.actions.bottom <= r.rec.top);
  check('buttons are outside the video in stack layout', r.actionsOutsideVideo);
  check(`the whole card fits the screen (bottom ${Math.round(r.cardBottom)} <= ${r.vh})`, r.cardBottom <= r.vh);
  check('height: 650px is a cap, not a fixed height (frame is shorter, no black band)', r.feed.h < 650);
  check('no "System idle" text at rest', r.status === '');
  check('door button is a padlock like the apps', r.doorIcon === 'mdi:lock-open-variant');
  check(`size hierarchy of the apps: mic ${r.mic} > door ${r.door} > sound ${r.snd}`, r.mic > r.door && r.door > r.snd);
  await page.close();

  console.log('\n########## 2. Short landscape (1280x600): overlay layout, still fits ##########');
  page = await newPage(browser, { width: 1280, height: 600 });
  await page.evaluate(() => {
    window.tSetRole('admin');
    window.tSetHassState('select.modo_test', 'normal', { options: ['normal', 'away'] });
    window.tCreateCard('b', { mode_entity: 'select.modo_test' });
    window.tAttach('b');
    window.tRefreshHass('b');
  });
  await sleep(400);
  r = await page.evaluate(() => {
    const c = window.__cards['b'];
    return { stack: c.content.classList.contains('ig-stack'), cardBottom: c.getBoundingClientRect().bottom, vh: innerHeight,
      recBottom: c.querySelector('#bottom-row').getBoundingClientRect().bottom };
  });
  check('overlay (not stack) layout on a short wide screen', !r.stack);
  check(`Recordings shown and inside the screen (${Math.round(r.recBottom)} <= ${r.vh})`, r.recBottom > 0 && r.recBottom <= r.vh);

  console.log('\n########## 3. Mode chip: optimistic, pending, confirmed / reverted ##########');
  await page.evaluate(() => { window.__serviceMode = 'hang'; window.tClick('b', '#mode-pill'); window.tClick('b', '.mode-opt[data-option="away"]'); });
  await sleep(50);
  r = await page.evaluate(() => { const p = window.__cards['b'].querySelector('#mode-pill'); return { label: p.querySelector('.mode-pill-label').textContent, pending: p.classList.contains('pending') }; });
  check('the chip shows the picked mode AT ONCE', r.label === 'away');
  check('...marked as pending while the doorbell has not confirmed', r.pending);
  await page.evaluate(() => { window.tSetHassState('select.modo_test', 'away', { options: ['normal', 'away'] }); window.tRefreshHass('b'); window.__releaseService(); });
  await sleep(50);
  r = await page.evaluate(() => window.__cards['b'].querySelector('#mode-pill').classList.contains('pending'));
  check('pending disappears once the entity confirms', r === false);
  await page.evaluate(() => { window.__serviceMode = 'reject'; window.tClick('b', '#mode-pill'); window.tClick('b', '.mode-opt[data-option="normal"]'); });
  await sleep(80);
  r = await page.evaluate(() => { const c = window.__cards['b']; return { label: c.querySelector('.mode-pill-label').textContent, pending: c.querySelector('#mode-pill').classList.contains('pending'), status: c.querySelector('#status-line').textContent }; });
  check('a refused change goes back to the real mode', r.label === 'away' && !r.pending);
  check(`...and says why ("${r.status}")`, /did not apply/.test(r.status));
  await page.close();

  console.log('\n########## 4. Bell: red dot, type filter, time filter like the recordings ##########');
  page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate(() => {
    const now = Date.now();
    window.__eventsEntity = 'event.test_eventos';
    window.__history = [
      { ev: 'ring', ts: now - 10 * 60000 },
      { ev: 'viewer_joined', ts: now - 8 * 60000 },            // not a notice by default: never listed
      { ev: 'door_opened', ts: now - 90 * 60000, a: { by: 'Ana' } },
      { ev: 'mode_changed', ts: now - 2 * 60000, a: { mode: 2 } },
    ];
    window.tSetHassState('event.test_eventos', new Date(now - 2 * 60000).toISOString(), { event_type: 'mode_changed' });
    window.tSetRole('admin');
    window.tCreateCard('c', {});
    window.tAttach('c');
    window.tRefreshHass('c');
  });
  await sleep(600);
  r = await page.evaluate(() => { const b = window.__cards['c'].querySelector('#bell-btn'); return { shown: getComputedStyle(b).display !== 'none', unread: b.classList.contains('unread') }; });
  check('bell shown when the integration exposes an events entity', r.shown);
  check('red dot: there are notices newer than the last look', r.unread);
  await page.evaluate(() => window.tClick('c', '#bell-btn'));
  await sleep(300);
  r = await page.evaluate(() => {
    const c = window.__cards['c'];
    return { rows: [...c.querySelectorAll('.ev-row .ev-t')].map((e) => e.textContent), unread: c.querySelector('#bell-btn').classList.contains('unread'),
      opts: [...c.querySelectorAll('#ev-range option')].map((o) => o.value), sel: c.querySelector('#ev-range').value, period: c.querySelector('.ev-period').textContent };
  });
  check(`day filter by default ("${r.period}"), same four ranges as the recordings`, r.sel === 'day' && r.opts.join() === 'lastHour,last6Hours,day,week');
  check(`lists the notices, newest first, without viewer_joined (${r.rows.join(' | ')})`, r.rows.length === 3 && r.rows[0] === 'Modo: No molestar' && !r.rows.some((t) => /viendo/.test(t)));
  check('opening the bell clears the red dot', r.unread === false);
  await page.evaluate(() => { const c = window.__cards['c']; [...c.querySelectorAll('.ev-chip')].find((b) => b.getAttribute('data-g') === 'lock').click(); });
  await sleep(100);
  r = await page.evaluate(() => [...window.__cards['c'].querySelectorAll('.ev-row .ev-t')].map((e) => e.textContent));
  check(`type filter "La puerta" keeps only the opening (${r.join(' | ')})`, r.length === 1 && /Puerta abierta/.test(r[0]));
  await page.evaluate(() => { const c = window.__cards['c']; [...c.querySelectorAll('.ev-chip')].find((b) => !b.getAttribute('data-g')).click(); });
  await page.evaluate(() => { const s = window.__cards['c'].querySelector('#ev-range'); s.value = 'lastHour'; s.dispatchEvent(new Event('change')); });
  await sleep(300);
  r = await page.evaluate(() => ({ rows: [...window.__cards['c'].querySelectorAll('.ev-row .ev-t')].map((e) => e.textContent), last: window.__historyCalls[window.__historyCalls.length - 1] }));
  const span = Date.parse(r.last.end_time) - Date.parse(r.last.start_time);
  check(`"last hour" asks Home Assistant for one hour (${Math.round(span / 60000)} min) and drops the 90 min old opening`, Math.abs(span - 3600000) < 5000 && r.rows.length === 2);

  await browser.close();
  console.log(`\n${fails === 0 ? 'ALL OK' : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
