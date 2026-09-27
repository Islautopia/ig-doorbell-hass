// Real-browser check of 1.1.0: tapping the microphone on a page that is NOT a secure context.
//
// The same card is opened twice from the runner's server:
//   - as http://insecure.test:<port>/...  (Chromium maps the name to 127.0.0.1): NOT a secure
//     context, so the browser has no navigator.mediaDevices at all - what a user on
//     http://<ha-ip>:8123 gets;
//   - as http://127.0.0.1:<port>/...      : loopback IS a secure context (the CONTROL).
//
// CHECKS
//   H0 the instrument: insecure.test really is not a secure context and 127.0.0.1 really is.
//   H1 insecure + HTTPS running: the notice opens, explains, links to the install page (new tab),
//      shows the QR on a desktop pointer, and the talk turn is NOT requested.
//   H2 insecure + HTTPS off: the notice points to the integration's options instead.
//   H3 insecure + HTTPS on but not running: says so, no install link.
//   H4 language: the notice follows Home Assistant's language (es / en / unknown -> en).
//   H5 control, secure context: no notice, the turn IS requested (the normal path is untouched).
//
// POSITIVE CONTROL built in: the same checks against a MUTANT of the card with the guard in
// toggleTalk() removed must go red (H1).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/mic_https_1_1_0/index.html';
const INSECURE = BASE.replace('//127.0.0.1:', '//insecure.test:');
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUTANTS = {
  M1: { target: 'H1', a: '    if (!igMicPossible()) {\n      this._showMicNeedsHttps();\n      return;\n    }\n', b: '' },
};

function mutate(src, name) {
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const m = MUTANTS[name];
  const n = src.split(m.a).length - 1;
  if (n !== 1) throw new Error(`mutant ${name}: anchor found ${n} times`);
  return src.replace(m.a, m.b);
}

const RUNNING = { enabled: true, running: true, port: 8443, install_path: '/ig_doorbell/https', install_url: 'http://192.168.1.10:8123/ig_doorbell/https', public_url: null };

async function scenario(browser, url, { status, lang, body }) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  await page.evaluate(({ status, lang }) => {
    window.__httpsStatus = status;
    window.__lang = lang;
    window.tOnlyOne();
    window.tCreate();
  }, { status, lang });
  // The shell may rebuild its view once the registries settle: wait until the SAME view has been
  // in place for a while, so the tap goes to the view that stays.
  await page.waitForFunction(() => { const v = window.tView(); return v && v.micButton && v.config && v.config.device_id; });
  let stable = 0;
  let last = null;
  for (let i = 0; i < 60 && stable < 5; i += 1) {
    const id = await page.evaluate(() => { const v = window.tView(); if (!v.__tid) v.__tid = Math.random(); return v.__tid; });
    stable = id === last ? stable + 1 : 0;
    last = id;
    await sleep(100);
  }
  const out = await page.evaluate(async () => {
    const v = window.tView();
    const sent = [];
    const orig = v.sendNativeSignal.bind(v);
    v.sendNativeSignal = (m) => { sent.push(m && m.type); try { return orig(m); } catch (e) { return undefined; } };
    v.micButton.click();
    // Wait for an OUTCOME (the notice, or the turn requested), up to 4 s: a fixed sleep made the
    // first case flaky on a cold browser.
    const t0 = performance.now();
    const shownNow = () => { const q = v.querySelector('.ig-https-panel'); return !!q && getComputedStyle(q).display !== 'none'; };
    while (performance.now() - t0 < 4000 && !shownNow() && !sent.includes('talk_request')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));  // let a wrong second outcome show up too
    const p = v.querySelector('.ig-https-panel');
    const shown = !!p && getComputedStyle(p).display !== 'none';
    return {
      secure: window.isSecureContext,
      hasMediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
      shown,
      title: shown ? (p.querySelector('.ev-title') || {}).textContent : null,
      text: shown ? p.textContent : '',
      links: shown ? [...p.querySelectorAll('a')].map((a) => ({ href: a.getAttribute('href'), target: a.getAttribute('target') })) : [],
      qr: shown ? [...p.querySelectorAll('img')].map((i) => i.getAttribute('src')) : [],
      sent,
      asked: window.__httpsAsked,
    };
  });
  await ctx.close();
  return { ...out, errors };
}

async function run(browser, variant) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const body = variant === 'real' ? null : mutate(fs.readFileSync(DIST, 'utf8'), variant);

  const a = await scenario(browser, INSECURE, { status: RUNNING, lang: 'es', body });
  check('H0', 'insecure.test is not a secure context and has no microphone API', !a.secure && !a.hasMediaDevices);
  check('H1', 'notice shown', a.shown);
  check('H1', 'links to the install page in a new tab', a.links.some((l) => l.href === '/ig_doorbell/https' && l.target === '_blank'));
  check('H1', 'QR of the install page on a desktop pointer', a.qr.includes('/ig_doorbell/https/qr.svg'));
  check('H1', 'the talk turn is NOT requested', !a.sent.includes('talk_request'));
  check('H4', 'Spanish title', a.title === 'El micrófono necesita una conexión segura');
  check('H1', 'no page errors', a.errors.length === 0);

  const b = await scenario(browser, INSECURE, { status: { ...RUNNING, running: false, enabled: false }, lang: 'en', body });
  check('H2', 'HTTPS off: points to the integration options', b.shown && b.links.some((l) => l.href === '/config/integrations/integration/ig_doorbell'));
  check('H2', 'HTTPS off: no install link', !b.links.some((l) => l.href === '/ig_doorbell/https'));
  check('H4', 'English title', b.title === 'Microphone needs a secure connection');

  const c = await scenario(browser, INSECURE, { status: { ...RUNNING, running: false }, lang: 'xx', body });
  check('H3', 'on but not running: says so', c.shown && /not running/.test(c.text));
  check('H3', 'on but not running: no install link', !c.links.some((l) => l.href === '/ig_doorbell/https'));
  check('H4', 'unknown language falls back to English', c.title === 'Microphone needs a secure connection');

  const d = await scenario(browser, BASE, { status: RUNNING, lang: 'es', body });
  check('H0', '127.0.0.1 is a secure context with a microphone API', d.secure && d.hasMediaDevices);
  check('H5', 'secure context: no notice', !d.shown);
  check('H5', 'secure context: the turn is requested as always', d.sent.includes('talk_request'));
  check('H5', 'secure context: https_status never asked', d.asked === 0);
  return results;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, args: ['--host-resolver-rules=MAP insecure.test 127.0.0.1', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  let failed = false;
  try {
    const real = await run(browser, 'real');
    for (const r of real) console.log(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.label}`);
    if (real.some((r) => !r.ok)) failed = true;
    for (const [name, m] of Object.entries(MUTANTS)) {
      const res = await run(browser, name);
      const red = res.some((r) => !r.ok && r.id === m.target);
      console.log(`  ${red ? 'PASS' : 'FAIL'} mutant ${name} turns ${m.target} red`);
      if (!red) failed = true;
    }
  } finally {
    await browser.close();
  }
  console.log(failed ? 'RESULT: FAIL' : 'RESULT: ALL OK');
  process.exit(failed ? 1 : 0);
})();
