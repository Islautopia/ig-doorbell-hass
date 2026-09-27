// Real-browser check: the card's elements end up in the registry Home Assistant ASKS, whatever the
// order in which the card module and Home Assistant's registry polyfill run.
//
// THE MEASURED BUG (2026-09-27, integration 1.1.1, Home Assistant 2026.9.3, desktop Chrome): the
// dashboard's panel card showed Home Assistant's red "Configuration error" (message: "Custom element
// doesn't exist: ig-doorbell-card") on 5 of 6 loads over https, and on none over plain http. The
// card never threw. Home Assistant's app bundle ships @webcomponents/scoped-custom-element-registry,
// which REPLACES window.customElements when the bundle runs; the page imports the card (an extra
// module) in parallel with that bundle. Over https the service worker serves the card from cache in
// ~30 ms, the card wins the race, its `define` lands in the NATIVE registry, and the polyfill's
// `get()`/`whenDefined()` - the ones Home Assistant uses - never learn about it. Ctrl+F5 bypasses the
// service worker, which is why it "fixed" it.
//
// This bench loads the REAL polyfill (npm, the package Home Assistant bundles) and the REAL card,
// in each order, and mounts the card the way Home Assistant's create-element code does: `get(tag)`
// on window.customElements; if missing, show an error and rebuild on `whenDefined(tag)`.
//
// CASES
//   R1 card first, then the polyfill, then Home Assistant defines <home-assistant> (the measured
//      race): the card is defined in the polyfill's registry within 1 s and an HA-style mount
//      shows a doorbell view.
//   R2 card first, then a polyfill installed by something that is NOT Home Assistant (no
//      <home-assistant>): same outcome, through the card's own watch of the registry.
//   R3 polyfill first, then the card (the order that always worked): defined at once, mount OK.
//   R4 no polyfill at all (older Home Assistant): defined at once, mount OK.
//   R5 two copies of the card loaded in the race: no uncaught error, mount OK.
// Every case also fails on any uncaught page error.
//
// POSITIVE CONTROLS ARE BUILT IN (served through page.route; each must turn its target red):
//   Z1 no re-registration at all (the watch returns at once)            -> R1, R2
//   Z2 only the <home-assistant> trigger, no registry watch               -> R2
//   Z3 "already registered" remembered as a flag, not per registry        -> R1, R2
//   and run_all.js runs this bench against the 1.1.1 build (fixtures/legacy/card_1.1.1.js),
//   which must go red on R1.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/registry_race/index.html';
const DIST = process.env.CARD_FILE
  || path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const CARD_URL = '../../../custom_components/ig_doorbell/frontend/ig-doorbell-card.js';
const POLYFILL_URL = '../node_modules/@webcomponents/scoped-custom-element-registry/scoped-custom-element-registry.min.js';

const MUTANTS = {
  Z1: { targets: ['R1', 'R2'], a: '(function igWatchRegistrySwap() {\n', b: '(function igWatchRegistrySwap() {\n  return;\n' },
  Z2: { targets: ['R2'], a: '    if (swapped) igRegisterElements();\n', b: '' },
  Z3: { targets: ['R1', 'R2'], a: 'if (!reg || IG_REGISTRIES_DONE.includes(reg)) return;', b: 'if (!reg || IG_REGISTRIES_DONE.length) return;' },
};

function normalize(src) {
  // The working copy may be CRLF (git autocrlf on Windows); anchors are written with LF.
  return src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
}

function mutate(src, name) {
  const m = MUTANTS[name];
  const n = src.split(m.a).length - 1;
  if (n !== 1) throw new Error(`mutant ${name}: anchor found ${n} times: ${m.a.slice(0, 60)}`);
  return src.replace(m.a, m.b);
}

const CASES = {
  R1: { order: ['card', 'polyfill', 'ha'] },
  R2: { order: ['card', 'polyfill'] },
  R3: { order: ['polyfill', 'ha', 'card'] },
  R4: { order: ['card'] },
  R5: { order: ['card', 'card2', 'polyfill', 'ha'] },
};

async function runCase(browser, id, body) {
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (body !== null) {
    await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  }
  await page.goto(BASE);
  for (const step of CASES[id].order) {
    if (step === 'card') await page.addScriptTag({ url: `${CARD_URL}?copy=1`, type: 'module' });
    else if (step === 'card2') await page.addScriptTag({ url: `${CARD_URL}?copy=2`, type: 'module' });
    else if (step === 'polyfill') await page.addScriptTag({ url: POLYFILL_URL });
    else if (step === 'ha') {
      // What Home Assistant's app bundle does right after the polyfill: define its root element
      // through the (now polyfilled) registry.
      await page.evaluate(() => { customElements.define('home-assistant', class extends HTMLElement {}); });
    }
  }
  // Home Assistant's card creation (create-element-base.ts, _customCreate): get() on the registry
  // it sees; missing -> an error card now and a rebuild when whenDefined() resolves.
  const r = await page.evaluate(() => new Promise((resolve) => {
    const tag = 'ig-doorbell-card';
    const t0 = performance.now();
    const polyfilled = !/\[native code\]/.test(String(customElements.get));
    const mount = (how) => {
      const el = document.createElement(tag);
      el.setConfig({ type: `custom:${tag}` });
      el.hass = window.__hass;
      document.getElementById('host').appendChild(el);
      setTimeout(() => resolve({
        how, polyfilled, ms: Math.round(performance.now() - t0),
        views: el.querySelectorAll('ig-doorbell-view').length,
        errorShown: how !== 'immediate',
      }), 300);
    };
    if (customElements.get(tag)) { mount('immediate'); return; }
    customElements.whenDefined(tag).then(() => mount('rebuilt'));
    setTimeout(() => resolve({ how: 'never', polyfilled, ms: null, views: 0 }), 3000);
  }));
  await page.close();
  return { r, errors };
}

function judge(id, { r, errors }) {
  const fails = [];
  if (errors.length) fails.push(`uncaught: ${errors[0].slice(0, 160)}`);
  if (r.how === 'never') fails.push('Home Assistant would show "Custom element doesn\'t exist" forever');
  else if (r.ms > 1000) fails.push(`defined only after ${r.ms} ms`);
  if (r.how !== 'never' && r.views !== 1) fails.push(`${r.views} doorbell views after the mount`);
  if ((id === 'R1' || id === 'R2' || id === 'R3' || id === 'R5') && !r.polyfilled) fails.push('the polyfill did not install (the case measures nothing)');
  if ((id === 'R3' || id === 'R4') && r.how !== 'immediate') fails.push(`expected defined at once, got ${r.how}`);
  return fails;
}

async function runAll(browser, variant, body) {
  const out = {};
  for (const id of Object.keys(CASES)) out[id] = judge(id, await runCase(browser, id, body));
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  let bad = 0;
  const real = await runAll(browser, 'real', process.env.CARD_FILE ? normalize(fs.readFileSync(DIST, 'utf8')) : null);
  for (const [id, fails] of Object.entries(real)) {
    if (fails.length) { bad++; console.log(`  FAIL [${id}] ${fails.join('; ')}`); }
    else console.log(`  ok   [${id}]`);
  }
  if (!process.env.CARD_FILE && !process.env.SKIP_MUTANTS) {
    const src = normalize(fs.readFileSync(DIST, 'utf8'));
    for (const name of Object.keys(MUTANTS)) {
      const res = await runAll(browser, name, mutate(src, name));
      const missed = MUTANTS[name].targets.filter((t) => !res[t].length);
      if (missed.length) { bad++; console.log(`  FAIL mutant ${name} survived on ${missed.join(', ')}`); }
      else console.log(`  ok   mutant ${name} killed (${MUTANTS[name].targets.join(', ')})`);
    }
  }
  await browser.close();
  console.log(bad ? `${bad} FAILED` : 'ALL OK');
  process.exit(bad ? 1 : 0);
})();
