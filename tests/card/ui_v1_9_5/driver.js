// REAL Chromium review of the v1.9.5 changes (Iñaki, 2026-09-25 afternoon): "REC and the
// bell must look the same [as in the apps]", "the modes should also be a dropdown
// chip" and the new Recordings button (same admin criterion as REC, no Settings).
// Loads the real dist/ig-doorbell-card.js; harness.js (a literal copy of test/ui_v1_9_2's)
// only doubles the network layer, same criterion as the rest of this directory's harnesses.
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the worktree root): python -m http.server 8795, then node ui_v1_9_5/driver.js
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8795/tests/card/ui_v1_9_5/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser) {
  const page = await browser.newPage();
  // Advanced mode (2026-09-29): default is simple, which hides REC/mode-chip/Recordings - force
  // Advanced ON, this suite is about the advanced feature set. See ui_v1_9_2/driver.js.
  await page.addInitScript(() => { try { localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ } });
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.startsWith('TESTLOG')) console.log(t.replace(/^TESTLOG /, ''));
    else if (msg.type() === 'error') console.log('[console.error] ' + t);
  });
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  return page;
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await newPage(browser);

  console.log('\n########## 1. REC: pill in the header, fixed "REC" (not translated), not in .actions-row ##########');
  await page.evaluate(() => {
    window.tSetAdmin(false); // same as the "Kiosko" tablet: the HA user isn't an admin
    window.tSetRole('admin'); // but the integration IS the doorbell's administrator
    window.tSetHassState('switch.rec_test', 'off', {});
    window.tCreateCard('a', { rec_entity: 'switch.rec_test' });
    window.tAttach('a');
    window.tRefreshHass('a');
  });
  await sleep(150);
  let recInfo = await page.evaluate(() => {
    const c = window.__cards['a'];
    return {
      inTopRow: !!c.querySelector('#top-row #rec-button'),
      inActionsRow: !!c.querySelector('.actions-row #rec-button'),
      label: c.recLabel ? c.recLabel.textContent : null,
      recording: c.recButton.classList.contains('recording'),
    };
  });
  check('#rec-button lives in the header (#top-row)', recInfo.inTopRow === true);
  check('#rec-button no longer lives in .actions-row', recInfo.inActionsRow === false);
  check('the label is a fixed "REC", universal like in the apps (not "Grabar"/"Grabando")', recInfo.label === 'REC');
  check('not recording: class "recording" absent', recInfo.recording === false);

  await page.evaluate(() => { window.tSetHassState('switch.rec_test', 'on', {}); window.tRefreshHass('a'); });
  await sleep(50);
  let recOn = await page.evaluate(() => {
    const c = window.__cards['a'];
    return { recording: c.recButton.classList.contains('recording'), label: c.recLabel.textContent };
  });
  check('recording: class "recording" present (red, via CSS)', recOn.recording === true);
  check('the label stays a fixed "REC" while recording too', recOn.label === 'REC');

  console.log('\n########## 2. Mode: dropdown chip (not a row of 4 chips) ##########');
  await page.evaluate(() => {
    window.tSetHassState('select.modo_test', 'away', { options: ['normal', 'away', 'do_not_disturb', 'custom'] });
    window.tCreateCard('b', { mode_entity: 'select.modo_test' });
    window.tAttach('b');
    window.tRefreshHass('b');
  });
  await sleep(150);
  let modeShape = await page.evaluate(() => {
    const c = window.__cards['b'];
    return {
      pillCount: c.querySelectorAll('#mode-row .mode-pill').length,
      chipCount: c.querySelectorAll('#mode-row .chip').length, // the old row must no longer exist
      menuClosedAtStart: c.querySelector('#mode-menu').style.display === 'none',
      pillText: c.querySelector('.mode-pill-label').textContent,
    };
  });
  check('there is exactly ONE dropdown chip (not a row of chips)', modeShape.pillCount === 1);
  check('the old row of segmented chips no longer exists', modeShape.chipCount === 0);
  check('the dropdown starts closed', modeShape.menuClosedAtStart === true);
  check('the chip shows the CURRENT mode\'s label with nothing expanded ("away")', modeShape.pillText === 'away');

  await page.evaluate(() => window.tClick('b', '#mode-pill'));
  await sleep(30);
  let menuOpen = await page.evaluate(() => window.__cards['b'].querySelector('#mode-menu').style.display !== 'none');
  check('a click on the chip opens the dropdown', menuOpen === true);

  // A click outside (on <body>, outside the card) closes it -- same criterion as the rest of this
  // card's menus (fullscreen/quality).
  await page.evaluate(() => document.body.click());
  await sleep(30);
  let menuClosedAfterOutsideClick = await page.evaluate(() => window.__cards['b'].querySelector('#mode-menu').style.display === 'none');
  check('a click outside closes the dropdown', menuClosedAfterOutsideClick === true);

  console.log('\n########## 3. Recordings: same gating as REC (the doorbell\'s role, not hass.user.is_admin), no Settings ##########');
  await page.evaluate(() => {
    window.tSetAdmin(false);
    window.tSetRole('user'); // the doorbell did NOT pair this integration as its administrator
    window.tCreateCard('c', {});
    window.tAttach('c');
    window.tRefreshHass('c');
  });
  await sleep(150);
  // v1.9.8: the row (`recordingsAction`/#bottom-row) is NO LONGER entirely hidden for a regular user -- now
  // it shares a spot with "Quick Replies", which IS visible for any role (see
  // _updateQuickReplyButton() in dist/). What still gates by role is specifically the Recordings
  // BUTTON (`recordingsButton`), not the row that contains it.
  let recNoAdmin = await page.evaluate(() => window.__cards['c'].recordingsButton.style.display);
  check('the Recordings button hides for a non-admin pairing of the doorbell', recNoAdmin === 'none');
  let noSettingsButton = await page.evaluate(() => !window.__cards['c'].querySelector('#settings-button, .quick-btn[data-target="settings"]'));
  check('no Settings button exists in the card (it lives in the integration)', noSettingsButton === true);

  await page.evaluate(() => { window.tSetRole('admin'); window.tCreateCard('d', {}); window.tAttach('d'); window.tRefreshHass('d'); });
  await sleep(150);
  let recAdmin = await page.evaluate(() => {
    const c = window.__cards['d'];
    return { display: c.recordingsAction.style.display, label: c.querySelector('.quick-btn-label').textContent };
  });
  check('visible with an admin pairing of the doorbell', recAdmin.display !== 'none');
  check('the label is "Grabaciones" (es-ES, the harness\'s default)', recAdmin.label === 'Grabaciones');

  console.log('\n########## 4. Recordings: navigates to THIS doorbell\'s media_source, with no player of its own ##########');
  const beforePath = await page.evaluate(() => location.pathname);
  await page.evaluate(() => window.tClick('d', '#recordings-button'));
  await sleep(30);
  const afterPath = await page.evaluate(() => decodeURIComponent(location.pathname));
  check('the URL changed (SPA navigation, no reload)', afterPath !== beforePath);
  check(
    'the URL points at the native media-browser, with no media_player entity, with THIS doorbell\'s media_content_id',
    afterPath === '/media-browser/browser/video,media-source://ig_doorbell/test-device-d',
  );

  await browser.close();
  console.log(`\n${fails === 0 ? 'ALL OK' : `${fails} FAILURE(S)`}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
