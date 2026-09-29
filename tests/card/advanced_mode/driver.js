// Real-browser check of the 2026-09-29 "simple/advanced live view, no fixed quality chip" change
// (spec shared with the iOS/Android apps). Loads the REAL dist/ file; harness.js only doubles the
// network layer, same criterion as tests/card/ui_v1_9_2.
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the worktree root): python -m http.server 8799, then node advanced_mode/driver.js
//
// CHECKS:
//   A1-A4  default is simple with no localStorage: header/#bottom-row/viewers pill hidden, the
//          three main buttons + compact REC/Quick-replies + Advanced stay, no permanent quality
//          indicator survives anywhere (#hud-quality never existed).
//   P1-P2  the Advanced choice persists in localStorage across a rebuild of the element (the
//          card's own model of "restart" - see ui_v1_10_0, which reuses this same idea).
//   AD1-AD2 Advanced mode shows the header/#bottom-row and hides the compact copies (no duplicate
//          controls).
//   F1-F3  fullscreen is unaffected by the toggle (Advanced button hidden, header/#bottom-row
//          stay hidden) but gains the compact REC/Quick-replies regardless of simple/advanced -
//          fullscreen never had them before either.
//   Q1-Q6  the temporary quality chip: silent on the session's first quality_state, shows on a
//          real tier change with the right translated text, fades after ~4s, debounces a second
//          transition inside 5s, and shows the next real one once the cooldown has passed. A
//          same-tier change (auto while already full) shows nothing.
//   L1-L2  layout dimension: the same stream/viewport is measured in both modes at two sizes
//          (wide -> side/overlay, narrow -> stack); at most one layout class applies in both, and
//          simple mode's video is never smaller (removing the header can only give it more room).
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:\\Users\\inaki\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8799/tests/card/advanced_mode/index.html';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

async function newPage(browser) {
  const page = await browser.newPage();
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
  const ev = (fn, arg) => page.evaluate(fn, arg);

  console.log('\n########## 1. Default is simple, no localStorage ##########');
  await ev(() => { window.tCreateCard('a', {}); window.tAttach('a'); });
  await sleep(200); // get_connection_info resolves (doubled), _connInfo lands, buttons repaint

  const a1 = await ev(() => ({
    simpleClass: window.tView('a').content.classList.contains('ig-simple'),
    advanced: window.tView('a')._advanced,
  }));
  check('A1: starts in simple mode (no stored preference)', a1.simpleClass === true && a1.advanced === false);
  check('A2: header (#top-row) hidden', !(await ev(() => window.tVisible('a', '#top-row'))));
  check('A2: wide Recordings/Quick-replies row (#bottom-row) hidden', !(await ev(() => window.tVisible('a', '#bottom-row'))));
  check('A2: viewers pill (.clients-pill) hidden', !(await ev(() => window.tVisible('a', '.clients-pill'))));
  check('A3: sound/mic/door still shown', await ev(() => window.tVisible('a', '#snd-btn') && window.tVisible('a', '#mic-button') && window.tVisible('a', '#unlock-button')));
  check('A3: compact REC shown (admin role + rec entity present)', await ev(() => window.tVisible('a', '#rec-action-compact')));
  check('A3: compact Quick replies shown', await ev(() => window.tVisible('a', '#qr-action-compact')));
  check('A3: Advanced button shown, not highlighted', await ev(() => window.tVisible('a', '#adv-btn') && !window.tView('a').advBtn.classList.contains('on')));
  check('A4: no permanent quality indicator exists anywhere (#hud-quality/#q-btn/#q-menu)', await ev(() =>
    !window.tView('a').querySelector('#hud-quality') && !window.tView('a').querySelector('#q-btn') && !window.tView('a').querySelector('#q-menu')));

  console.log('\n########## 2. Advanced ON: header/#bottom-row back, compact actions hide ##########');
  await ev(() => window.tClick('a', '#adv-btn'));
  await sleep(50);
  check('AD1: header shown', await ev(() => window.tVisible('a', '#top-row')));
  check('AD1: #bottom-row shown', await ev(() => window.tVisible('a', '#bottom-row')));
  check('AD1: Advanced button highlighted', await ev(() => window.tView('a').advBtn.classList.contains('on')));
  check('AD2: compact REC hidden (header pill already covers it)', !(await ev(() => window.tVisible('a', '#rec-action-compact'))));
  check('AD2: compact Quick replies hidden (#bottom-row already covers it)', !(await ev(() => window.tVisible('a', '#qr-action-compact'))));
  check('AD2: no duplicate REC/Quick-replies visible at once', await ev(() => {
    const v = window.tView('a');
    const recCount = [v.querySelector('#rec-action'), v.querySelector('#rec-action-compact')].filter((el) => el && window.tVisible('a', '#' + el.id)).length;
    const qrCount = [v.querySelector('#bottom-row'), v.querySelector('#qr-action-compact')].filter((el) => el && window.tVisible('a', '#' + el.id)).length;
    return recCount === 1 && qrCount === 1;
  }));

  console.log('\n########## 3. Fullscreen: unaffected by the toggle, gains the compact actions ##########');
  await ev(() => window.tSetFullscreen('a', true));
  check('F1: Advanced button hidden in fullscreen', !(await ev(() => window.tVisible('a', '#adv-btn'))));
  check('F1: header/#bottom-row still hidden in fullscreen (pre-existing .ig-fs rule)', !(await ev(() => window.tVisible('a', '#top-row') || window.tVisible('a', '#bottom-row'))));
  check('F2: compact REC shown in fullscreen even though Advanced is ON', await ev(() => window.tVisible('a', '#rec-action-compact')));
  check('F2: compact Quick replies shown in fullscreen even though Advanced is ON', await ev(() => window.tVisible('a', '#qr-action-compact')));
  await ev(() => window.tSetFullscreen('a', false));
  check('F3: leaving fullscreen restores Advanced-mode visibility (Advanced button back, compact actions hidden again)',
    await ev(() => window.tVisible('a', '#adv-btn') && !window.tVisible('a', '#rec-action-compact')));
  await ev(() => window.tClick('a', '#adv-btn')); // back to simple, for the persistence check below

  console.log('\n########## 4. Persistence across a rebuild (the card\'s own model of "restart") ##########');
  await ev(() => window.tClick('a', '#adv-btn')); // simple -> advanced
  const stored1 = await ev(() => { try { return localStorage.getItem('ig-doorbell-advanced'); } catch (e) { return 'THROWS'; } });
  check('P1: the choice is written to localStorage', stored1 === '1');
  await ev(() => { window.tDestroy('a'); window.tCreateCard('a', {}); window.tAttach('a'); });
  await sleep(200);
  check('P2: a brand-new element reads the stored choice back (Advanced, not simple)', await ev(() => window.tView('a')._advanced === true));
  await ev(() => window.tClick('a', '#adv-btn')); // advanced -> simple
  await ev(() => { window.tDestroy('a'); window.tCreateCard('a', {}); window.tAttach('a'); });
  await sleep(200);
  check('P2: the OFF choice persists too (back to simple)', await ev(() => window.tView('a')._advanced === false && window.tView('a').content.classList.contains('ig-simple')));

  console.log('\n########## 5. Temporary quality chip: silent first, shown on real change, fades, debounced ##########');
  const chip = () => page.evaluate(() => {
    const v = window.tView('a');
    return { shown: v.qualityToast.classList.contains('show'), text: v.qualityToast.textContent };
  });
  await ev(() => window.tQuality('a', 'full')); // session's first quality_state: must stay silent
  await sleep(30);
  check('Q1: no chip on the very first quality_state of a session', !(await chip()).shown);

  await ev(() => window.tQuality('a', 'low')); // tier 2 -> 1: degrade, still video
  await sleep(30);
  let c = await chip();
  check('Q2: degrade (still video) shows chip_quality_down, translated (en)', c.shown && c.text === 'Lower quality — slow connection');

  await sleep(4300);
  check('Q3: the chip fades on its own after ~4s', !(await chip()).shown);

  await ev(() => window.tQuality('a', 'audio_only')); // tier 1 -> 0, but inside the 5s cooldown from Q2
  await sleep(30);
  check('Q4: a second transition inside the 5s cooldown is debounced (no chip)', !(await chip()).shown);

  await sleep(900); // total elapsed since Q2's chip is now just past 5s
  await ev(() => window.tQuality('a', 'full')); // tier 0 -> 2: recovery, cooldown has expired
  await sleep(30);
  c = await chip();
  check('Q5: once the cooldown passes, a real recovery from audio-only shows chip_video_back', c.shown && c.text === 'Video back');

  await sleep(4300);
  await ev(() => window.tQuality('a', 'auto')); // same tier as 'full' (2): must show nothing
  await sleep(30);
  check('Q6: a same-tier change (auto while already full) shows no chip', !(await chip()).shown);

  console.log('\n########## 6. Layout dimension: simple never smaller than advanced, at two sizes ##########');
  await ev(() => { window.tCreateCard('s', {}); window.tAttach('s'); }); // simple (fresh, no toggle)
  await ev(() => { window.tCreateCard('v', {}); window.tAttach('v'); window.tClick('v', '#adv-btn'); }); // advanced
  await sleep(200);
  for (const [label, w, h, streamW, streamH] of [['wide/landscape', 900, 700, 1920, 1080], ['narrow/portrait', 380, 800, 1080, 1920]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const id of ['s', 'v']) {
      await ev(([id, sw, sh]) => { window.tSetStream(id, sw, sh); window.tRefit(id); }, [id, streamW, streamH]);
    }
    await sleep(150);
    const infoS = await ev(() => window.tLayoutInfo('s'));
    const infoV = await ev(() => window.tLayoutInfo('v'));
    check(`L1: ${label}: at most one layout class in simple (${infoS.layouts.join(',') || 'overlay'})`, infoS.layouts.length <= 1);
    check(`L1: ${label}: at most one layout class in advanced (${infoV.layouts.join(',') || 'overlay'})`, infoV.layouts.length <= 1);
    check(`L2: ${label}: simple's video is not smaller than advanced's (${Math.round(infoS.feedH)} vs ${Math.round(infoV.feedH)})`, infoS.feedH >= infoV.feedH - 1);
  }

  await browser.close();
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
