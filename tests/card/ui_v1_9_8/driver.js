// Real-browser check of the v1.9.8 change: the wide Recordings row from 1.9.7 splits into two
// half-width buttons ("Grabaciones" / "Respuestas rápidas") in the SAME row, and the new one opens
// a panel that lists the doorbell's quick replies (mocked here) and plays one via the EXISTING
// play_sequence service. Loads the REAL dist/ file; harness.js only doubles the network and hass
// (same rule as every other harness in this directory).
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the repo root): python -m http.server 8797, then node ui_v1_9_8/driver.js
// POSITIVE CONTROL: CARD_FILE=<path to dist/ as of v1.9.7> node ui_v1_9_8/driver.js must go
// red (no #qr-button/#qr-panel existed yet) - see the bottom of this file for how that was run.
const fs = require('fs');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/ui_v1_9_8/index.html';
const CARD_FILE = process.env.CARD_FILE || null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({ viewport });
  // Advanced mode (2026-09-29): default is simple, which hides Quick replies/Recordings/REC -
  // force Advanced ON, this suite is about the advanced feature set. See ui_v1_9_2/driver.js.
  // Harmless against the older CARD_FILE control build: it predates the key and ignores it.
  await page.addInitScript(() => { try { localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ } });
  if (CARD_FILE) {
    await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(CARD_FILE, 'utf8') }));
  }
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

const QR_ITEMS = [
  { id: 7, label: 'Un momento, por favor', steps: 1 },
  { id: 9, label: 'Deje el paquete en la puerta', steps: 2 },
];

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });

  console.log('\n########## 1. Phone portrait (375x812), admin: two half-buttons, nothing clipped ##########');
  let page = await newPage(browser, { width: 375, height: 812 });
  await page.evaluate((items) => {
    window.tSetRole('admin');
    window.tSetQuickReplies(items);
    window.tCreateCard('a', { height: '650px' });
    window.tAttach('a');
    window.tRefreshHass('a');
  }, QR_ITEMS);
  await sleep(400);
  // Checked on its own first: against the 1.9.7 build (the positive control) the button does not
  // exist, and the probe below would crash on it - a control has to go red on a CHECK, and this
  // is the check that names what is missing.
  check('the Quick reply button exists (#qr-button)',
    await page.evaluate(() => !!window.__cards['a'].querySelector('#qr-button')));
  let r = await page.evaluate(() => {
    const c = window.__cards['a'];
    const rowDisp = getComputedStyle(c.querySelector('#bottom-row')).display;
    const rec = c.querySelector('#recordings-button');
    const qr = c.querySelector('#qr-button');
    const noClip = (btn) => {
      const lbl = btn.querySelector('.quick-btn-label');
      // 1px tolerance for sub-pixel rounding
      return lbl.scrollWidth <= lbl.clientWidth + 1 && btn.scrollWidth <= btn.clientWidth + 1;
    };
    return {
      rowDisp, rowFlex: rowDisp === 'flex',
      recVisible: getComputedStyle(rec).display !== 'none',
      qrVisible: getComputedStyle(qr).display !== 'none',
      recNoClip: noClip(rec), qrNoClip: noClip(qr),
      recLabel: rec.querySelector('.quick-btn-label').textContent.trim(),
      qrLabel: qr.querySelector('.quick-btn-label').textContent.trim(),
      rowH: c.querySelector('#bottom-row').getBoundingClientRect().height,
    };
  });
  check('#bottom-row is now a flex row (two buttons side by side)', r.rowFlex);
  check('Recordings visible for an admin pairing', r.recVisible);
  check('Quick replies visible for an admin pairing', r.qrVisible);
  check(`Recordings label not clipped ("${r.recLabel}")`, r.recNoClip);
  check(`Quick-reply label not clipped ("${r.qrLabel}")`, r.qrNoClip);
  check(`row does not balloon in height (${Math.round(r.rowH)}px, expected < 70px)`, r.rowH > 0 && r.rowH < 70);

  console.log('\n########## 2. Same width, German (longest label in the catalogue: "Schnellantworten") ##########');
  page = await newPage(browser, { width: 375, height: 812 });
  await page.evaluate((items) => {
    window.tSetRole('admin');
    window.tSetLang('de');
    window.tSetQuickReplies(items);
    window.tCreateCard('b', { height: '650px' });
    window.tAttach('b');
    window.tRefreshHass('b');
  }, QR_ITEMS);
  await sleep(400);
  r = await page.evaluate(() => {
    const c = window.__cards['b'];
    const qr = c.querySelector('#qr-button');
    const lbl = qr.querySelector('.quick-btn-label');
    return { text: lbl.textContent.trim(), noClip: lbl.scrollWidth <= lbl.clientWidth + 1 && qr.scrollWidth <= qr.clientWidth + 1 };
  });
  check(`German label ("${r.text}") not clipped at 375px either`, r.noClip);

  console.log('\n########## 3. Non-admin pairing: Recordings hidden, quick replies alone fills the row ##########');
  page = await newPage(browser, { width: 390, height: 844 });
  await page.evaluate((items) => {
    window.tSetRole('user');
    window.tSetQuickReplies(items);
    window.tCreateCard('c', { height: '650px' });
    window.tAttach('c');
    window.tRefreshHass('c');
  }, QR_ITEMS);
  await sleep(400);
  r = await page.evaluate(() => {
    const c = window.__cards['c'];
    const row = c.querySelector('#bottom-row');
    const rec = c.querySelector('#recordings-button');
    const qr = c.querySelector('#qr-button');
    return {
      rowVisible: getComputedStyle(row).display !== 'none',
      recHidden: getComputedStyle(rec).display === 'none',
      qrVisible: getComputedStyle(qr).display !== 'none',
      qrWidth: qr.getBoundingClientRect().width, rowWidth: row.getBoundingClientRect().width,
    };
  });
  check('the row itself stays visible (quick replies alone keeps it up)', r.rowVisible);
  check('Recordings hidden for a non-admin pairing', r.recHidden);
  check('Quick replies still visible for a non-admin pairing', r.qrVisible);
  check(`quick-reply button grows to (almost) the full row width (${Math.round(r.qrWidth)} of ${Math.round(r.rowWidth)})`, r.qrWidth >= r.rowWidth - 4);

  console.log('\n########## 4. Opens the list, plays one, panel closes on the doorbell\'s own confirmation ##########');
  page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate((items) => {
    window.tSetRole('admin');
    window.tSetQuickReplies(items);
    window.tCreateCard('d', { height: '650px' });
    window.tAttach('d');
    window.tRefreshHass('d');
  }, QR_ITEMS);
  await sleep(400);
  page.evaluate(() => window.tClick('d', '#qr-button'));
  await sleep(50);
  r = await page.evaluate(() => {
    const c = window.__cards['d'];
    const rows = [...c.querySelector('#qr-panel').querySelectorAll('.qr-row')];
    return { panelOpen: c.querySelector('#qr-panel').style.display === 'flex', n: rows.length, firstLabel: rows[0] && rows[0].querySelector('.ev-t').textContent.trim() };
  });
  check('panel opens on click', r.panelOpen);
  check(`lists both mocked quick replies (${r.n})`, r.n === 2);
  check(`first row shows the doorbell's label ("${r.firstLabel}")`, r.firstLabel === QR_ITEMS[0].label);

  await page.evaluate(() => window.tClick('d', '.qr-row'));
  await sleep(50);
  r = await page.evaluate(() => ({
    called: window.__calledServices[window.__calledServices.length - 1],
    panelOpen: window.__cards['d'].querySelector('#qr-panel').style.display === 'flex',
  }));
  check(`play_sequence called with the right seq_id (${JSON.stringify(r.called)})`,
    r.called && r.called.domain === 'ig_doorbell' && r.called.service === 'play_sequence'
    && r.called.data.seq_id === QR_ITEMS[0].id && r.called.data.device_id === 'test-device-d');
  check('panel closes once the doorbell confirmed it is playing', !r.panelOpen);

  console.log('\n########## 5. A refusal from the doorbell keeps the panel open with its own message ##########');
  page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate((items) => {
    window.tSetRole('admin');
    window.tSetQuickReplies(items);
    window.__serviceMode = 'reject';
    window.tCreateCard('e', { height: '650px' });
    window.tAttach('e');
    window.tRefreshHass('e');
  }, QR_ITEMS);
  await sleep(400);
  await page.evaluate(() => window.tClick('e', '#qr-button'));
  await sleep(50);
  await page.evaluate(() => window.tClick('e', '.qr-row'));
  await sleep(50);
  r = await page.evaluate(() => {
    const c = window.__cards['e'];
    const notice = c.querySelector('#qr-panel .qr-notice');
    return { panelOpen: c.querySelector('#qr-panel').style.display === 'flex', notice: notice && notice.textContent.trim() };
  });
  check('a failed play_sequence does NOT close the panel (so the user can retry)', r.panelOpen);
  check(`the doorbell's own refusal text is shown ("${r.notice}")`, r.notice === 'That sequence does not exist on the doorbell.');

  console.log('\n########## 6. Empty catalogue and a load failure each get their own message, never a blank list ##########');
  page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate(() => {
    window.tSetRole('admin');
    window.tSetQuickReplies([]);
    window.tCreateCard('f', { height: '650px' });
    window.tAttach('f');
    window.tRefreshHass('f');
  });
  await sleep(400);
  await page.evaluate(() => window.tClick('f', '#qr-button'));
  await sleep(50);
  r = await page.evaluate(() => {
    const t = window.__cards['f'].querySelector('#qr-panel .ev-empty-t');
    return { text: t && t.textContent.trim() };
  });
  check(`empty catalogue shows "no quick replies" (not blank) ("${r.text}")`, !!r.text);

  page = await newPage(browser, { width: 393, height: 852 });
  await page.evaluate(() => {
    window.tSetRole('admin');
    window.__qrMode = 'reject';
    window.tCreateCard('g', { height: '650px' });
    window.tAttach('g');
    window.tRefreshHass('g');
  });
  await sleep(400);
  await page.evaluate(() => window.tClick('g', '#qr-button'));
  await sleep(50);
  r = await page.evaluate(() => {
    const p = window.__cards['g'].querySelector('#qr-panel');
    return { text: p.textContent.trim(), hasRow: !!p.querySelector('.qr-row') };
  });
  check(`a load failure shows an error message, not an empty/blank panel ("${r.text.slice(0, 60)}")`, r.text.length > 0 && !r.hasRow);

  await browser.close();
  console.log(fails === 0 ? '\nALL OK' : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
