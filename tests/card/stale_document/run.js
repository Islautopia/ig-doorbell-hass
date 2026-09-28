// "Custom element doesn't exist: ig-doorbell-card" from a STALE PAGE served by Home Assistant's
// service worker (1.2.1). Runs against a REAL Home Assistant (https, so the service worker is on) and
// its real frontend; it never opens a doorbell: the page used is a dashboard without the card, and
// what is measured is whether the card's element is in the registry Home Assistant asks.
//
//   HASS_URL=https://... HASS_TOKEN=... [STALE_PAGE=/some-dashboard] node tests/card/stale_document/run.js
//
// THE MECHANISM (measured 2026-09-28 in a real desktop Chrome's cache, docs/card.md): the service
// worker serves pages stale-while-revalidate, and the root route with `ignoreSearch` from a cache
// with no expiry. A page saved before the integration added its module (before 1.0.0, or during
// the seconds of a Home Assistant start before `async_setup` runs) imports no card at all.
//
// CASES (each seeds the service worker's cache with the CURRENT page minus the card's import line):
//   S0 control: the card is NOT a Lovelace resource -> the element must be missing. If S0 is not
//      red the bench is not reproducing the stale page and nothing else it says counts.
//   S1 the card IS a Lovelace resource -> defined anyway (the 1.2.1 fix).
//   S2 fresh page + resource at the same URL -> defined, and the card fetched once (module map).
//   S3 the root route: with `/` stale and `/?homescreen=1` fresh, the service worker's own match
//      returns the stale `/` (why an installed app never recovers by itself).
// The resource list is edited on the websocket (the server's `lovelace/resources` reply): S0 strips
// the card from it, S1/S2 make sure it is there. Home Assistant's storage is never written, so the
// bench gives the same answer before and after 1.2.1 is installed.
//
// PROFILE PATH: a short one on purpose. Under a long path (a scratch dir) Chromium's CacheStorage
// fails with "Unexpected internal error", the service worker never installs, and every case runs
// without it - a bench that would say "fixed" for a bug it cannot produce.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const U = (process.env.HASS_URL || '').replace(/\/$/, '');
const TOKEN = process.env.HASS_TOKEN || '';
const PAGE = process.env.STALE_PAGE || '/dashboard-clima';
const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
if (!U.startsWith('https://') || !TOKEN) { console.error('HASS_URL (https) and HASS_TOKEN are required'); process.exit(2); }

const CARD_PATH = '/ig_doorbell/ig-doorbell-card.js';
// The card's import line in Home Assistant's page template (no backslashes through a shell here: the
// regex lives in this file).
const IMPORT_RE = /import\("(\/ig_doorbell\/ig-doorbell-card\.js\?v=[0-9a-f]+)"\)\.catch\(function \(err\) \{[\s\S]*?\}\);/g;

let fails = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fails++; };

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'igsd-'));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: EXE, headless: true });
  await ctx.addInitScript(([url, tok]) => {
    try { localStorage.setItem('hassTokens', JSON.stringify({ access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url, clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '' })); } catch (e) { /* the thumbnail of a closed page */ }
  }, [U, TOKEN]);
  let mode = 'as-is'; let cardUrl = null; let edited = 0;
  await ctx.routeWebSocket(/\/api\/websocket/, (ws) => {
    const server = ws.connectToServer();
    const ids = new Set();
    ws.onMessage((m) => {
      try { for (const x of [].concat(JSON.parse(m))) if (x && x.type === 'lovelace/resources') ids.add(x.id); } catch (e) { /* not JSON */ }
      server.send(m);
    });
    server.onMessage((m) => {
      if (mode !== 'as-is' && ids.size) {
        try {
          const j = JSON.parse(m); let hit = false;
          for (const x of [].concat(j)) {
            if (!(x && ids.has(x.id) && x.type === 'result' && Array.isArray(x.result))) continue;
            x.result = x.result.filter((r) => String(r.url).split('?')[0] !== CARD_PATH);
            if (mode === 'with') x.result.push({ id: 'ig-bench', type: 'module', url: cardUrl });
            hit = true;
          }
          if (hit) { edited++; ws.send(JSON.stringify(j)); return; }
        } catch (e) { /* not JSON */ }
      }
      ws.send(m);
    });
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  const measure = async () => {
    await page.waitForTimeout(6000);
    return page.evaluate(() => ({
      sw: !!navigator.serviceWorker.controller,
      htmlImportsCard: /ig-doorbell-card\.js/.test([...document.scripts].map((s) => s.textContent).join('')),
      defined: !!customElements.get('ig-doorbell-card'),
      fetches: performance.getEntriesByType('resource').filter((e) => /ig-doorbell-card\.js/.test(e.name)).length,
    }));
  };
  let sw = false;
  for (let i = 0; i < 6 && !sw; i++) { await page.goto(U + PAGE); sw = (await measure()).sw; }
  check('the service worker controls the page (else nothing below is the real path)', sw);
  const live = await (await fetch(U + PAGE)).text();
  const found = [...live.matchAll(IMPORT_RE)];
  check(`the live page imports the card exactly once (found ${found.length})`, found.length === 1);
  if (!sw || found.length !== 1) { await ctx.close(); process.exit(1); }
  cardUrl = found[0][1];
  const stale = live.replace(IMPORT_RE, '');
  const seed = () => page.evaluate(async ([p, html]) => {
    const c = await caches.open('file-cache');
    await c.put(p, new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', date: new Date().toUTCString() } }));
  }, [PAGE, stale]);

  console.log('S0 stale page, card NOT a resource (control: must be missing)');
  await seed(); mode = 'without'; edited = 0;
  await page.goto(U + PAGE); let r = await measure();
  check('the stale page was served (no card import in it)', !r.htmlImportsCard);
  check('the resource list was edited', edited > 0);
  check('element missing - the bug reproduced', !r.defined);

  console.log('S1 stale page, card IS a resource');
  await seed(); mode = 'with'; edited = 0;
  await page.goto(U + PAGE); r = await measure();
  check('the stale page was served', !r.htmlImportsCard);
  check('element defined', r.defined);

  console.log('S2 fresh page + resource at the same URL');
  await page.goto(U + PAGE); r = await measure();
  check('fresh page imports the card', r.htmlImportsCard);
  check('element defined', r.defined);
  check(`the card fetched once (${r.fetches})`, r.fetches === 1);

  console.log("S3 the root route's own cache match");
  const m = await page.evaluate(async ([html, good]) => {
    const name = (await caches.keys()).find((k) => /workbox-runtime/.test(k));
    const c = await caches.open(name);
    const before = await c.match('/', { ignoreSearch: false });
    const beforeHome = await c.match('/?homescreen=1', { ignoreSearch: false });
    await c.put('/', new Response(html, { headers: { 'content-type': 'text/html' } }));
    await c.put('/?homescreen=1', new Response(good, { headers: { 'content-type': 'text/html' } }));
    const hit = await (await c.match('/?homescreen=1', { ignoreSearch: true })).text();
    // Leave the cache as it was.
    if (before) await c.put('/', before); else await c.delete('/');
    if (beforeHome) await c.put('/?homescreen=1', beforeHome); else await c.delete('/?homescreen=1');
    return { name, staleWins: !/ig-doorbell-card\.js/.test(hit) };
  }, [stale, live]);
  check(`${m.name}: /?homescreen=1 is answered with the stale / (ignoreSearch)`, m.staleWins);

  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
