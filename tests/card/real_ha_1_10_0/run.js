// v1.10.0 against the REAL Home Assistant and the REAL doorbells, without touching any dashboard.
//
// Same trick as the 2026-08-03 note in CLAUDE.md: open a page of HA that has no card (the profile
// page), inject THIS repo's dist/ into it and mount the card by hand with the frontend's real
// `hass`. The HACS 1.9.8 copy is already registered under the real tag names, so the injected copy
// is registered under `-dev` tag names (the only change; CARD_TAG/VIEW_TAG/EDITOR_TAG constants).
//
// Doorbells: the Waveshare is the free test bench; Ermita 10 is a real family doorbell -- it is
// only opened BRIEFLY to see the switch, after checking /api/debug/cores says busy:false, and the
// card never rings, talks, opens or records. Session counts are read from each doorbell's
// /api/debug/cores (sessions/viewers), i.e. measured at the doorbell, not inferred by the card.
//
// Usage: HASS_URL=... HASS_TOKEN=... node test/real_ha_1_10_0/run.js
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';
const CHROME = 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const IP = { Waveshare: '192.168.1.10', 'Ermita 10': '192.168.1.11' };
const OUT = __dirname;
if (!HASS_URL || !HASS_TOKEN) { console.error('HASS_URL / HASS_TOKEN missing'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fails++; };
async function cores(name) {
  const r = await fetch(`http://${IP[name]}/api/debug/cores`);
  return r.json();
}
async function waitCores(name, pred, ms) {
  const t0 = Date.now(); let c;
  while (Date.now() - t0 < ms) { c = await cores(name); if (pred(c)) return c; await sleep(250); }
  return c;
}

(async () => {
  for (const n of Object.keys(IP)) {
    const c = await cores(n);
    console.log(`${n}: busy=${c.busy} sessions=${c.sessions} viewers=${c.viewers} ring=${c.ring} call=${c.call}`);
    if (c.busy || c.call || c.ring) { console.log(`ABORT: ${n} is in use`); process.exit(3); }
  }
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('ig-doorbell')) logs.push(t); });
  await page.goto(HASS_URL + '/manifest.json');
  await page.evaluate(([url, tok]) => {
    localStorage.setItem('hassTokens', JSON.stringify({ access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url, clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '' }));
    localStorage.setItem('selectedLanguage', '"es"');
  }, [HASS_URL, HASS_TOKEN]);
  await page.goto(HASS_URL + '/profile/general', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const h = document.querySelector('home-assistant'); return h && h.hass && h.hass.connected && h.hass.devices; }, null, { timeout: 30000 });

  const ids = await page.evaluate(() => {
    const out = {};
    const devs = document.querySelector('home-assistant').hass.devices;
    for (const k of Object.keys(devs)) {
      const p = (devs[k].identifiers || []).find((x) => x[0] === 'ig_doorbell');
      if (p) out[devs[k].name_by_user || devs[k].name] = p[1];
    }
    return out;
  });
  console.log('doorbells in HA:', JSON.stringify(ids));
  const nameOf = (re) => Object.keys(ids).find((n) => re.test(n));
  const WN = nameOf(/waveshare/i); const EN = nameOf(/ermita/i);
  const W = ids[WN]; const E = ids[EN];
  check('both doorbells listed by the registry', !!W && !!E);

  let src = fs.readFileSync(path.join(OUT, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js'), 'utf8');
  for (const [a, b] of [["const CARD_TAG = 'ig-doorbell-card';", "const CARD_TAG = 'ig-doorbell-card-dev';"],
    ["const VIEW_TAG = 'ig-doorbell-view';", "const VIEW_TAG = 'ig-doorbell-view-dev';"],
    ["const EDITOR_TAG = 'ig-doorbell-card-editor';", "const EDITOR_TAG = 'ig-doorbell-card-editor-dev';"]]) {
    if (src.split(a).length !== 2) throw new Error('anchor ' + a);
    src = src.replace(a, b);
  }
  await page.evaluate((w) => { localStorage.setItem('ig-doorbell-card-selected', w); }, W);
  await page.addScriptTag({ content: src });
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'ig-test-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:430px;z-index:99999;background:#111;';
    document.body.appendChild(host);
    const card = document.createElement('ig-doorbell-card-dev');
    card.setConfig({ type: 'custom:ig-doorbell-card', device_id: 'legacy-ignored', height: '650px' });
    const ha = document.querySelector('home-assistant');
    card.hass = ha.hass;
    host.appendChild(card);
    window.__card = card;
    window.__hassPump = setInterval(() => { if (card.hass !== ha.hass) card.hass = ha.hass; }, 300);
    window.__pick = (id) => { const v = card.querySelector('ig-doorbell-view-dev'); v.querySelector('#db-pill').click(); const o = v.querySelector(`.db-opt[data-id="${id}"]`); if (!o) throw new Error('no option ' + id); o.click(); };
    window.__pk = () => { const v = card.querySelector('ig-doorbell-view-dev'); return v ? { dev: v.config.device_id, name: v.querySelector('#db-name').textContent, dot: v.querySelector('#db-dot').dataset.state, live: v.querySelector('#live-tag').dataset.state, chev: v.querySelector('#db-chev').style.display !== 'none', views: document.querySelectorAll('ig-doorbell-view-dev').length, vw: v.videoEl.videoWidth, t: v.videoEl.currentTime } : null; };
    // sampler: every 40 ms, remember (name, dot) pairs
    // Every change of the header dot, with the doorbell it belongs to and whether the <video>
    // had decoded a frame at that instant. A MutationObserver, not a timer: a 40 ms setInterval
    // got throttled to a handful of samples in the first run, which made the check vacuous.
    window.__dots = [];
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.target.id !== 'db-dot') continue;
        const v = m.target.closest('ig-doorbell-view-dev');
        if (!v || !v.config) continue;
        window.__dots.push([Date.now(), v.config.device_id, m.target.dataset.state, v.videoEl.videoWidth, v.videoEl.currentTime]);
      }
    }).observe(card, { attributes: true, attributeFilter: ['data-state'], subtree: true });
  });
  const waitLive = async (dev, ms) => page.waitForFunction((d) => { const p = window.__pk(); return p && p.dev === d && p.dot === 'live' && p.vw > 0; }, dev, { timeout: ms }).then(() => true).catch(() => false);

  console.log('\n1) default = last chosen in this browser (Waveshare); legacy YAML keys ignored');
  let p = await page.evaluate(() => window.__pk());
  check(`mounted on Waveshare, name shown, chevron (2 doorbells): ${JSON.stringify(p)}`, p && p.dev === W && p.name === WN && p.chev);
  const liveW = await waitLive(W, 25000);
  check('Waveshare: dot green only once real video plays', liveW);
  let cw = await cores('Waveshare');
  check(`Waveshare has exactly 1 session (sessions=${cw.sessions} viewers=${cw.viewers})`, cw.sessions === 1);
  await page.screenshot({ path: path.join(OUT, '1_waveshare_live.png'), clip: { x: 0, y: 0, width: 430, height: 900 } });

  console.log('\n2) switch to Ermita 10 (brief, after busy:false)');
  let ce = await cores('Ermita 10');
  if (ce.busy || ce.call || ce.ring) { console.log('ABORT: Ermita in use'); process.exit(3); }
  const tSwitch = await page.evaluate((e) => { window.__dots = []; const t = Date.now(); window.__pick(e); return t; }, E);
  await sleep(120);
  p = await page.evaluate(() => window.__pk());
  check(`right after the switch: header Ermita 10, dot NOT green (${p.dot})`, p.dev === E && p.name === EN && p.dot !== 'live' && p.dot !== 'open');
  cw = await waitCores('Waveshare', (c) => c.sessions === 0, 5000);
  check(`Waveshare released at the doorbell (sessions=${cw.sessions})`, cw.sessions === 0);
  const liveE = await waitLive(E, 25000);
  check('Ermita 10: live video, dot green', liveE);
  const dots = await page.evaluate(() => window.__dots);
  console.log(`  dot changes after the switch: ${JSON.stringify(dots.map((d) => [d[0] - tSwitch, d[1].slice(0, 4), d[2], d[3]]))}`);
  const greens = dots.filter((d) => d[2] === 'live' || d[2] === 'open');
  // positive control: the observer DID see Ermita's dot go green (else "no bad green" is vacuous)
  check(`observer saw Ermita's dot turn green (${greens.length} green changes)`, greens.some((d) => d[1] === E));
  check('every green change had a decoded frame (videoWidth > 0), none for Waveshare after the switch',
    greens.every((d) => d[3] > 0 && d[1] === E));
  ce = await cores('Ermita 10');
  check(`Ermita 10 has exactly 1 session (sessions=${ce.sessions})`, ce.sessions === 1);
  await page.screenshot({ path: path.join(OUT, '2_ermita_live.png'), clip: { x: 0, y: 0, width: 430, height: 900 } });

  console.log('\n3) back to Waveshare');
  await page.evaluate((w) => window.__pick(w), W);
  ce = await waitCores('Ermita 10', (c) => c.sessions === 0, 5000);
  check(`Ermita 10 released (sessions=${ce.sessions})`, ce.sessions === 0);
  check('Waveshare live again', await waitLive(W, 25000));

  console.log('\n4) rapid W->E->W (back-to-back, then 100 ms)');
  ce = await cores('Ermita 10');
  if (ce.busy || ce.call || ce.ring) { console.log('ABORT: Ermita in use'); process.exit(3); }
  await page.evaluate(async ([w, e]) => { window.__pick(e); window.__pick(w); await new Promise((r) => setTimeout(r, 100)); window.__pick(e); await new Promise((r) => setTimeout(r, 100)); window.__pick(w); }, [W, E]);
  check('Waveshare live after the burst', await waitLive(W, 25000));
  await sleep(3000);
  ce = await cores('Ermita 10'); cw = await cores('Waveshare');
  check(`after the burst: Ermita sessions=${ce.sessions}, Waveshare sessions=${cw.sessions} (want 0 / 1)`, ce.sessions === 0 && cw.sessions === 1);
  p = await page.evaluate(() => window.__pk());
  check(`one view in the DOM (${p.views})`, p.views === 1);

  console.log('\n5) teardown');
  await page.evaluate(() => { clearInterval(window.__hassPump); document.querySelectorAll('ig-doorbell-view-dev').forEach((v) => v._destroy('test end')); document.getElementById('ig-test-host').remove(); localStorage.removeItem('ig-doorbell-card-selected'); });
  cw = await waitCores('Waveshare', (c) => c.sessions === 0, 5000);
  ce = await cores('Ermita 10');
  check(`both doorbells back to 0 sessions (W=${cw.sessions} E=${ce.sessions})`, cw.sessions === 0 && ce.sessions === 0);
  fs.writeFileSync(path.join(OUT, 'console.log.txt'), logs.join('\n'));
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
