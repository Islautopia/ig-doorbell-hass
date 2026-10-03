// Real-browser check of 1.5.1: the temporary quality chip ("Lower quality - slow connection",
// "Audio only...", "Quality restored", "Video back") is CENTRED on the video, not at the top where
// the status chips covered it (Iñaki, 2026-10-03). Loads the REAL card; harness.js doubles the network.
//
// RUN: cd tests/card && node run_all.js
// POSITIVE CONTROL: CARD_FILE=fixtures/legacy/card_1.5.0.js (chip at the top) must go red on K1.
//
// CHECKS (each in normal view, in fullscreen, and in audio-only):
//   K1  the chip's centre is the centre of the video frame (.feed-wrap), horizontally and vertically (+-2 px)
//   K2  it does not intersect any visible top chip (header status chips, viewers pill)
//   K3  its z-index is above every other positioned layer inside the frame, except the full-screen panel (z 40)
//   K4  pointer-events: none (a tap on it reaches what is under it)
//   K5  the real path (a tier change over quality_state) shows it centred too
//   K6  it still hides after ~4 s
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8799/tests/card/chip_centre_1_5_1/index.html';
const CARD_FILE = process.env.CARD_FILE || null;
const SHOTS = process.env.SHOTS_DIR || null;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
let fails = 0;
function check(label, cond) {
  if (cond) console.log(`  OK   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
}

const GEOM = () => {
  const v = window.tView('a');
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const chip = v.qualityToast;
  const frame = r(v.feedWrap);
  const c = r(chip);
  const tops = Array.from(v.feedWrap.querySelectorAll('.hud-top *, .db-pill, .live-badge, .path-pill, .motion-pill'))
    .filter((el) => { const b = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && b.y < frame.y + frame.h * 0.45; })
    .map(r);
  const zs = Array.from(v.feedWrap.children).filter((el) => el !== chip)
    .map((el) => parseInt(getComputedStyle(el).zIndex, 10)).filter((n) => !isNaN(n) && n < 40);
  return {
    dx: (c.x + c.w / 2) - (frame.x + frame.w / 2), dy: (c.y + c.h / 2) - (frame.y + frame.h / 2),
    overlap: tops.filter((t) => c.x < t.x + t.w && t.x < c.x + c.w && c.y < t.y + t.h && t.y < c.y + c.h).length,
    nTops: tops.length, z: parseInt(getComputedStyle(chip).zIndex, 10), maxOther: Math.max(0, ...zs),
    pe: getComputedStyle(chip).pointerEvents, opacity: parseFloat(getComputedStyle(chip).opacity), shown: chip.classList.contains('show'),
  };
};

async function scenario(browser, name, { fullscreen, audioOnly }) {
  console.log(`\n########## ${name} ##########`);
  const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await ctx.newPage();
  if (CARD_FILE) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(CARD_FILE, 'utf8') }));
  page.on('pageerror', (err) => console.log('[pageerror] ' + err));
  await page.goto(BASE);
  await page.waitForFunction(() => window.TESTLOG && window.TESTLOG.some((l) => l.includes('harness ready')));
  await page.evaluate(({ fullscreen }) => {
    window.tSetLang('en');
    window.tCreateCard('a', {}); window.tAttach('a');
    window.tSetStream('a', 1920, 1080);
    window.tClients('a', 2); // the viewers pill is visible, like in real use
    if (fullscreen) window.tSetFullscreen('a', true);
  }, { fullscreen });
  await sleep(300);
  // real path: first quality_state silent, then a tier change shows the chip
  await page.evaluate(() => window.tQuality('a', 'full'));
  await page.evaluate((audioOnly) => window.tQuality('a', audioOnly ? 'audio_only' : 'low'), audioOnly);
  await sleep(450);
  const g = await page.evaluate(GEOM);
  check('K5: a real tier change shows the chip', g.shown && g.opacity > 0.9);
  check(`K1: centred on the video frame (dx=${g.dx.toFixed(1)}, dy=${g.dy.toFixed(1)})`, Math.abs(g.dx) <= 2 && Math.abs(g.dy) <= 2);
  check(`K2: clear of the top chips (${g.nTops} measured)`, g.nTops > 0 && g.overlap === 0);
  check(`K3: z-index ${g.z} above every other layer (max ${g.maxOther})`, g.z > g.maxOther);
  check('K4: pointer-events none', g.pe === 'none');
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `card_${name.replace(/[^a-z0-9]+/gi, '_')}.png`) }); }
  await sleep(4300);
  check('K6: hides after ~4 s', !(await page.evaluate(GEOM)).shown);
  await ctx.close();
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  await scenario(browser, 'normal view', { fullscreen: false, audioOnly: false });
  await scenario(browser, 'fullscreen', { fullscreen: true, audioOnly: false });
  await scenario(browser, 'audio-only', { fullscreen: false, audioOnly: true });
  await browser.close();
  console.log(fails ? `\n${fails} CHECK(S) FAILED` : '\nALL CHECKS OK');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
