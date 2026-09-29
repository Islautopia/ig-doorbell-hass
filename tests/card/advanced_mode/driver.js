// Real-browser check of the 2026-09-29 "simple/advanced live view, no fixed quality chip" change
// (spec shared with the iOS/Android apps), UPDATED the same day for the coordinator's "canonical
// layout" addendum (spec §4, written after comparing the first screenshots): simple mode's main
// row must be EXACTLY the three round buttons (sound/mic/door), Quick replies moves to a wide row
// below them (same #bottom-row advanced mode uses, Recordings force-hidden), and REC never has a
// compact copy anywhere any more (not in simple mode, not in fullscreen - it never had one there
// before this feature existed either). The ORIGINAL 5-buttons-in-one-row layout (sound/mic/door +
// compact REC + compact Quick-replies) overflowed at phone width - see card_simple.png before this
// fix: "Escuchar"/"Respuestas rápidas" clipped at the edges.
//
// Loads the REAL dist/ file; harness.js only doubles the network layer, same criterion as
// tests/card/ui_v1_9_2.
//
// RUN: cd tests/card && npm install && node run_all.js       (serves the repo itself)
// Standalone (from the worktree root): python -m http.server 8799, then node advanced_mode/driver.js
//
// CHECKS:
//   A1-A7  default is simple with no localStorage: header hidden, viewers pill hidden, the three
//          main buttons only (no compact anything) shown, a wide Quick-replies row below them
//          (Recordings force-hidden even for an admin), REC absent everywhere (no header pill, no
//          compact copy - the element itself no longer exists), Advanced button shown, no
//          permanent quality indicator survives anywhere (#hud-quality never existed).
//   P1-P2  the Advanced choice persists in localStorage across a rebuild of the element (the
//          card's own model of "restart" - see ui_v1_10_0, which reuses this same idea).
//   AD1-AD2 Advanced mode shows the header/#bottom-row (Recordings back too) and hides the
//          compact Quick-replies copy (no duplicate controls).
//   F1-F3  fullscreen is unaffected by the toggle (Advanced button hidden, header/#bottom-row
//          stay hidden) but gains the compact Quick-replies action regardless of simple/advanced -
//          fullscreen never had another way to reach it. REC never appears there either (no
//          compact copy exists, same rule as simple mode).
//   Q1-Q6  the temporary quality chip: silent on the session's first quality_state, shows on a
//          real tier change with the right translated text, fades after ~4s, debounces a second
//          transition inside 5s, and shows the next real one once the cooldown has passed. A
//          same-tier change (auto while already full) shows nothing.
//   L1-L2  layout dimension: the same stream/viewport is measured in both modes at two sizes
//          (wide -> side/overlay, narrow -> stack); at most one layout class applies in both, and
//          simple mode's video is never smaller (removing the header can only give it more room).
//   O1-O3  no overflow/clipping at 320px width, both as the real viewport AND as a narrow
//          Sections/Masonry column on an otherwise wide screen (spec §4, last line) - in simple,
//          advanced and fullscreen. Validated as a real instrument, not just written and trusted:
//          run once against the pre-fix 1.4.1 card (fixtures would need a CARD_FILE hook this
//          bench doesn't have; verified instead with an ad-hoc copy during development) with the
//          same check and it correctly reported clipping with all 5 old buttons visible - see
//          tRowClipped()'s own comment in harness.js for why scrollWidth was rejected as the
//          measurement.
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
  check('A2: viewers pill (.clients-pill) hidden while no session_info has arrived yet (unrelated to mode - see V1/V2 below for the actual §5 check)',
    !(await ev(() => window.tVisible('a', '.clients-pill'))));
  check('A3: main row shows exactly sound/mic/door - never a 4th or 5th round button',
    await ev(() => {
      const row = window.tView('a').querySelector('.actions-row');
      const visible = Array.from(row.children).filter((el) => getComputedStyle(el).display !== 'none');
      return visible.length === 3 && window.tVisible('a', '#snd-btn') && window.tVisible('a', '#mic-button') && window.tVisible('a', '#unlock-button');
    }));
  check('A4: wide "Quick replies" row (#bottom-row) shown, filling the width', await ev(() => window.tVisible('a', '#bottom-row') && window.tVisible('a', '#qr-button')));
  check('A4: Recordings hidden inside it even for an admin pairing (canonical layout §4: "no Recordings" in simple mode)',
    !(await ev(() => window.tVisible('a', '#recordings-button'))));
  check('A5: no REC anywhere in simple mode, even for an admin pairing ("menos es más" - Iñaki, 2026-09-29)',
    !(await ev(() => window.tVisible('a', '#rec-action'))));
  check('A5: no compact REC element exists in the DOM at all (removed entirely, not just hidden)',
    await ev(() => !window.tView('a').querySelector('#rec-action-compact')));
  check('A6: Advanced button shown, not highlighted', await ev(() => window.tVisible('a', '#adv-btn') && !window.tView('a').advBtn.classList.contains('on')));
  check('A7: no permanent quality indicator exists anywhere (#hud-quality/#q-btn/#q-menu)', await ev(() =>
    !window.tView('a').querySelector('#hud-quality') && !window.tView('a').querySelector('#q-btn') && !window.tView('a').querySelector('#q-menu')));

  console.log('\n########## 1b. §5 (2026-09-29, overrides §4 on this one point): viewers pill stays visible in simple mode ##########');
  // §4's "no viewers pill" in simple mode was overridden the same day by §5 ("SIMPLE mode KEEPS
  // the viewers indicator, exactly where it already is, on the video") - this section is the
  // regression check for that reversal. Note there is no WebRTC-diagnostics icon/overlay in this
  // card to check the opposite of (§5's other clause) - this card never had one, unlike the apps.
  await ev(() => window.tClients('a', 1));
  await sleep(30);
  check('V1: with a real client count, the viewers pill is visible in simple mode', await ev(() => window.tVisible('a', '.clients-pill')));
  check('V1: it renders inside .hud-top, in the same spot as always (not moved)', await ev(() => {
    const pill = window.tView('a').querySelector('.clients-pill');
    return !!(pill && pill.closest('.hud-top'));
  }));
  await ev(() => window.tClick('a', '#adv-btn')); // simple -> advanced
  await sleep(30);
  check('V2: still visible in advanced mode too (unchanged there)', await ev(() => window.tVisible('a', '.clients-pill')));
  await ev(() => window.tClick('a', '#adv-btn')); // back to simple for the rest of section 1's flow
  await sleep(30);

  console.log('\n########## 2. Advanced ON: header/#bottom-row (with Recordings) back, compact Quick replies hides ##########');
  await ev(() => window.tClick('a', '#adv-btn'));
  await sleep(50);
  check('AD1: header shown', await ev(() => window.tVisible('a', '#top-row')));
  check('AD1: #bottom-row shown, Recordings back now that role is admin', await ev(() => window.tVisible('a', '#bottom-row') && window.tVisible('a', '#recordings-button')));
  check('AD1: Advanced button highlighted', await ev(() => window.tView('a').advBtn.classList.contains('on')));
  check('AD2: compact Quick replies hidden (#bottom-row already covers it)', !(await ev(() => window.tVisible('a', '#qr-action-compact'))));
  check('AD2: no duplicate Quick-replies visible at once (REC has no compact copy to duplicate any more)', await ev(() => {
    const v = window.tView('a');
    const qrCount = [v.querySelector('#bottom-row'), v.querySelector('#qr-action-compact')].filter((el) => el && window.tVisible('a', '#' + el.id)).length;
    return qrCount === 1;
  }));

  console.log('\n########## 3. Fullscreen: unaffected by the toggle, gains compact Quick replies only (never REC) ##########');
  await ev(() => window.tSetFullscreen('a', true));
  check('F1: Advanced button hidden in fullscreen', !(await ev(() => window.tVisible('a', '#adv-btn'))));
  check('F1: header/#bottom-row still hidden in fullscreen (pre-existing .ig-fs rule)', !(await ev(() => window.tVisible('a', '#top-row') || window.tVisible('a', '#bottom-row'))));
  check('F2: compact Quick replies shown in fullscreen even though Advanced is ON', await ev(() => window.tVisible('a', '#qr-action-compact')));
  check('F2: REC never appears in fullscreen - no compact copy exists, and the header pill stays hidden',
    await ev(() => !window.tView('a').querySelector('#rec-action-compact') && !window.tVisible('a', '#rec-action')));
  await ev(() => window.tSetFullscreen('a', false));
  check('F3: leaving fullscreen restores Advanced-mode visibility (Advanced button back, compact Quick replies hidden again)',
    await ev(() => window.tVisible('a', '#adv-btn') && !window.tVisible('a', '#qr-action-compact')));
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

  console.log('\n########## 7. No overflow/clipping at 320px - real viewport AND a narrow column ##########');
  // Reproduces the fixed bug directly: at card_simple.png's width the OLD 5-button row rendered
  // sound/mic/door + compact REC + compact Quick-replies with "Escuchar"/"Respuestas rápidas"
  // clipped at the edges (tRowClipped() against a pre-fix copy of the card confirms this check
  // goes RED there - see this file's header comment). Runs fresh, in simple mode.
  await ev(() => { window.tCreateCard('o', {}); window.tAttach('o'); });
  await sleep(200);
  const scenarios = [
    ['320px viewport', async () => page.setViewportSize({ width: 320, height: 640 })],
    ['320px column inside a wide viewport (Sections/Masonry)', async () => {
      await page.setViewportSize({ width: 900, height: 700 });
      await ev(() => window.tSetHostWidth(320));
    }],
  ];
  for (const [label, setup] of scenarios) {
    await setup();
    await sleep(100);
    check(`O1: ${label}: simple mode's main row (sound/mic/door) is not clipped`, !(await ev(() => window.tRowClipped('o', '.actions-row', '.feed-wrap'))));
    check(`O1: ${label}: simple mode's wide Quick-replies row is not clipped`, !(await ev(() => window.tRowClipped('o', '#bottom-row', '.ig-container'))));
    await ev(() => window.tClick('o', '#adv-btn'));
    await sleep(50);
    check(`O2: ${label}: advanced mode's main row is not clipped`, !(await ev(() => window.tRowClipped('o', '.actions-row', '.feed-wrap'))));
    check(`O2: ${label}: advanced mode's #bottom-row (Recordings + Quick replies) is not clipped`, !(await ev(() => window.tRowClipped('o', '#bottom-row', '.ig-container'))));
    await ev(() => window.tSetFullscreen('o', true));
    await sleep(50);
    check(`O3: ${label}: fullscreen's main row (sound/mic/door + compact Quick replies) is not clipped`, !(await ev(() => window.tRowClipped('o', '.actions-row', '.feed-wrap'))));
    await ev(() => window.tSetFullscreen('o', false));
    await ev(() => window.tClick('o', '#adv-btn')); // back to simple for the next scenario
    await ev(() => window.tSetHostWidth(null)); // undo the narrow-column constraint if it was set
  }

  await browser.close();
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
