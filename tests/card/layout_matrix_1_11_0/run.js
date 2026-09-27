// Layout matrix for ig-doorbell-card (1.11.0 adaptive layout) against a REAL Home Assistant.
//
// Usage (from the repo root; HASS_URL / HASS_TOKEN come from the team secrets file, never written to disk):
//   LABEL=after  node test/layout_matrix_1_11_0/run.js all            # setup + capture + teardown
//   LABEL=before CARD_REF=6753e72 node test/layout_matrix_1_11_0/run.js all   # the 1.10.0 card, same matrix
//   node test/layout_matrix_1_11_0/run.js capture _pc_                # filter by name
//   node test/layout_matrix_1_11_0/run.js teardown                    # always run if a capture aborts
//
// What it does: creates a temporary storage dashboard (`igd-card-layout-1110`, "IGD card layout test
// 1.11.0 (temporary)") with the card in Sections, Masonry, Sidebar (main column), Sidebar (side column)
// and Panel. The card under test is NOT the HACS copy: dist/ (or `git show CARD_REF:dist/...`) is
// injected into every page under `-dev` tag names (the only change: the CARD_TAG/VIEW_TAG/EDITOR_TAG
// constants), and the dashboard uses `custom:ig-doorbell-card-dev`. So the installed card is
// never touched, and before/after run in exactly the same pages.
//
// Doorbell: the card has no configuration (1.10.0); the one it shows is the browser's remembered
// choice, so localStorage is set to the Waveshare (the free test bench) before the page loads. The
// run refuses to start if the Waveshare is busy, and never presses ring/mic/door/REC.
//
// Orientation is simulated page-side, as in layout_matrix_1_9_8 (see its README): _contentSize() is
// overridden to 720x1280 (portrait) / 1280x720 (landscape) and the real frame is stretched into that
// rect. Judge geometry, not the picture.
//
// Screenshots are frames of a real camera: they stay local (gitignored), this repo is public.
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';
const TARGET = process.env.TARGET_NAME || 'Waveshare';
const WAVESHARE_IP = '192.168.1.10';
const URL_PATH = 'igd-card-layout-1110';
const LABEL = process.env.LABEL || 'after';
const CARD_REF = process.env.CARD_REF || '';
const CHROME = process.env.CHROME || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const OUT = path.join(__dirname, LABEL);
if (!HASS_URL || !HASS_TOKEN) { console.error('HASS_URL / HASS_TOKEN missing'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

const SIZES = {
  phone_port: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  phone_land: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  tablet_port: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true },
  tablet_land: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5, isMobile: true, hasTouch: true },
  pc: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};
const VIEWS = ['sections', 'masonry', 'sidebar', 'sidebarside', 'panel'];
const ORIENTS = ['portrait', 'landscape'];

function cardSource() {
  let src = CARD_REF
    ? execFileSync('git', ['show', `${CARD_REF}:dist/ig-doorbell-card.js`], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8', maxBuffer: 64 << 20 })
    : fs.readFileSync(path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js'), 'utf8');
  for (const [a, b] of [["const CARD_TAG = 'ig-doorbell-card';", "const CARD_TAG = 'ig-doorbell-card-dev';"],
    ["const VIEW_TAG = 'ig-doorbell-view';", "const VIEW_TAG = 'ig-doorbell-view-dev';"],
    ["const EDITOR_TAG = 'ig-doorbell-card-editor';", "const EDITOR_TAG = 'ig-doorbell-card-editor-dev';"]]) {
    if (src.split(a).length !== 2) throw new Error('anchor not found exactly once: ' + a);
    src = src.replace(a, b);
  }
  return src;
}

async function login(ctx) {
  const page = await ctx.newPage();
  await page.goto(HASS_URL + '/manifest.json');
  await page.evaluate(([url, tok]) => {
    localStorage.setItem('hassTokens', JSON.stringify({
      access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url,
      clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '',
    }));
    localStorage.setItem('selectedLanguage', '"es"');
  }, [HASS_URL, HASS_TOKEN]);
  return page;
}
async function hassReady(page) {
  await page.waitForFunction(() => { const h = document.querySelector('home-assistant'); return h && h.hass && h.hass.connected && h.hass.devices; }, null, { timeout: 30000 });
}
const ws = (page, msg) => page.evaluate((m) => document.querySelector('home-assistant').hass.callWS(m), msg);

async function targetId(page) {
  const ids = await page.evaluate(() => {
    const out = {}; const devs = document.querySelector('home-assistant').hass.devices;
    for (const k of Object.keys(devs)) {
      const p = (devs[k].identifiers || []).find((x) => x[0] === 'ig_doorbell');
      if (p) out[devs[k].name_by_user || devs[k].name] = p[1];
    }
    return out;
  });
  const name = Object.keys(ids).find((n) => n.toLowerCase().includes(TARGET.toLowerCase()));
  if (!name || /ermita/i.test(name)) throw new Error('target doorbell not found / refused');
  return ids[name];
}

async function setup(page) {
  const card = { type: 'custom:ig-doorbell-card-dev' };
  const md = { type: 'markdown', content: 'Filler card (layout test)' };
  const config = {
    title: 'IGD card layout test 1.11.0 (temporary)',
    views: [
      { title: 'Sections', path: 'sections', type: 'sections', max_columns: 4, sections: [{ type: 'grid', cards: [card] }] },
      { title: 'Masonry', path: 'masonry', cards: [card] },
      { title: 'Sidebar', path: 'sidebar', type: 'sidebar', cards: [card, { ...md, view_layout: { position: 'sidebar' } }] },
      { title: 'Sidebar side', path: 'sidebarside', type: 'sidebar', cards: [md, { ...card, view_layout: { position: 'sidebar' } }] },
      { title: 'Panel', path: 'panel', type: 'panel', cards: [card] },
    ],
  };
  const list = await ws(page, { type: 'lovelace/dashboards/list' });
  if (!list.some((d) => d.url_path === URL_PATH)) {
    await ws(page, { type: 'lovelace/dashboards/create', url_path: URL_PATH, title: 'IGD card layout test 1.11.0 (temporary)', mode: 'storage', require_admin: false, show_in_sidebar: false });
  }
  await ws(page, { type: 'lovelace/config/save', url_path: URL_PATH, config });
  console.log('setup ok');
}

async function teardown(page) {
  const list = await ws(page, { type: 'lovelace/dashboards/list' });
  const d = list.find((x) => x.url_path === URL_PATH);
  if (d) await ws(page, { type: 'lovelace/dashboards/delete', dashboard_id: d.id });
  const after = await ws(page, { type: 'lovelace/dashboards/list' });
  console.log('teardown: dashboard present after delete =', after.some((x) => x.url_path === URL_PATH));
}

// Geometry, measured in the page. The card element is the SHELL (-dev), the view holds the layout.
const MEASURE = () => {
  const find = (root, tag) => {
    const q = [root];
    while (q.length) {
      const n = q.shift();
      if (n.tagName && n.tagName.toLowerCase() === tag) return n;
      if (n.shadowRoot) q.push(n.shadowRoot);
      for (const c of (n.children || [])) q.push(c);
    }
    return null;
  };
  const card = find(document, 'ig-doorbell-card-dev');
  const view = card && card.querySelector('ig-doorbell-view-dev');
  if (!view) return { error: 'no card' };
  const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
  const v = view.videoEl; const fw = view.feedWrap;
  let img = null;
  if (v && fw && v.videoWidth) {
    const c = view._contentSize(); const f = fw.getBoundingClientRect();
    const s = Math.min(f.width / c.w, f.height / c.h);
    const w = c.w * s; const h = c.h * s;
    img = { x: Math.round(f.x + (f.width - w) / 2), y: Math.round(f.y + (f.height - h) / 2), w: Math.round(w), h: Math.round(h) };
  }
  const deepAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  };
  const ids = ['db-pill', 'mode-pill', 'rec-button', 'bell-btn', 'snd-btn', 'mic-button', 'unlock-button', 'recordings-button', 'qr-button', 'fs-btn'];
  const controls = [];
  for (const id of ids) {
    const el = view.querySelector('#' + id);
    if (!el) continue;
    let shown = true;
    for (let p = el; p && p !== view; p = p.parentElement) { if (getComputedStyle(p).display === 'none') { shown = false; break; } }
    if (!shown) continue;
    const r = R(el);
    const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
    const inVp = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    const hit = inVp ? deepAt(cx, cy) : null;
    // Composed ancestry: the hit is often inside <ha-icon>'s own shadow root, which contains() can't see.
    let reach = false;
    for (let n = hit; n; n = n.parentNode || n.host) { if (n === el) { reach = true; break; } }
    controls.push({ id, ...r, reachable: reach });
  }
  const cls = view.content.className.replace('ig-container', '').trim();
  const layout = /ig-side/.test(cls) ? 'side' : /ig-stack/.test(cls) ? 'stack' : 'overlay';
  return {
    cls, layout, t: v ? v.currentTime : 0, raw: v ? [v.videoWidth, v.videoHeight] : null,
    card: R(card), feed: R(fw), img, controls, vw: innerWidth, vh: innerHeight,
    scrollW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight,
    cardSize: typeof card.getCardSize === 'function' ? card.getCardSize() : null,
    grid: typeof card.getGridOptions === 'function' ? card.getGridOptions() : null,
  };
};

function summarize(m) {
  const vpA = m.vw * m.vh;
  const imgPct = m.img ? Math.round(100 * m.img.w * m.img.h / vpA) : 0;
  const cardPct = m.img ? Math.round(100 * m.img.w * m.img.h / (m.card.w * m.card.h)) : 0;
  const unreachable = m.controls.filter((c) => !c.reachable).map((c) => c.id);
  const touch = m.controls.filter((c) => c.id !== 'fs-btn' || true).map((c) => Math.min(c.w, c.h));
  return {
    layout: m.layout, cls: m.cls, imgPct, cardPct,
    overflowCard: m.card.y + m.card.h - m.vh, overflowDoc: m.docH - m.vh, hscroll: m.scrollW - m.vw,
    unreachable, minTarget: touch.length ? Math.min(...touch) : null, cardSize: m.cardSize, grid: m.grid,
  };
}

async function capture(browser, filter, deviceId, src) {
  const results = {};
  const resFile = path.join(OUT, 'metrics.json');
  if (fs.existsSync(resFile)) Object.assign(results, JSON.parse(fs.readFileSync(resFile, 'utf8')));
  for (const [sizeName, opts] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ ...opts, locale: 'es-ES', ignoreHTTPSErrors: true });
    // Only the remembered doorbell goes in at page start. The card itself is injected AFTER the
    // frontend is up: HA installs a scoped custom-element registry polyfill while booting, and an
    // element defined before that is lost (measured: defined at init -> "Configuration error").
    // Defined later, Lovelace rebuilds the error card on customElements.whenDefined.
    await ctx.addInitScript((id) => {
      try { localStorage.setItem('ig-doorbell-card-selected', id); } catch (e) { /* manifest page */ }
    }, deviceId);
    const lp = await login(ctx); await lp.close();
    for (const view of VIEWS) {
      for (const o of ORIENTS) {
        const name = `${view}_${sizeName}_${o}`;
        if (filter && !name.includes(filter)) continue;
        const c0 = await (await fetch(`http://${WAVESHARE_IP}/api/debug/cores`)).json();
        if (c0.call || c0.ring) throw new Error('Waveshare in a call/ring: abort');
        const page = await ctx.newPage();
        try {
          await page.goto(`${HASS_URL}/${URL_PATH}/${view}`, { waitUntil: 'domcontentloaded' });
          await hassReady(page);
          await page.evaluate((s) => { if (!customElements.get('ig-doorbell-card-dev')) (0, eval)(`(function(){${s}\n})()`); }, src);
          await page.waitForFunction(`(${MEASURE.toString()})().t > 1.5`, null, { timeout: 45000 });
          const sim = o === 'portrait' ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
          const apply = (s) => {
            const find = (root) => { const q = [root]; while (q.length) { const n = q.shift(); if (n.tagName && n.tagName.toLowerCase() === 'ig-doorbell-view-dev') return n; if (n.shadowRoot) q.push(n.shadowRoot); for (const c of (n.children || [])) q.push(c); } return null; };
            const card = find(document);
            if (!card.__sim) {
              card.__sim = true; card._rot = 0; card._rotConfirmed = true;
              card._applyRotation = () => {};
              card._contentSize = () => ({ w: s.w, h: s.h });
              if (card.feedWrap) card.feedWrap.setAttribute('data-rot', '0');
            }
            card._fitToSpace(); card._layoutRotation();
            const v = card.videoEl; const fw = card.feedWrap.clientWidth; const fh = card.feedWrap.clientHeight;
            const k = Math.min(fw / s.w, fh / s.h); const iw = s.w * k; const ih = s.h * k;
            v.style.objectFit = 'fill';
            v.style.clipPath = `inset(${Math.max(0, (fh - ih) / 2)}px ${Math.max(0, (fw - iw) / 2)}px)`;
          };
          await page.evaluate(apply, sim);
          await page.waitForTimeout(600);
          await page.evaluate(apply, sim);
          await page.waitForTimeout(1200);
          await page.evaluate(apply, sim);
          await page.waitForTimeout(300);
          const m = await page.evaluate(MEASURE);
          const file = `${name}.png`;
          await page.screenshot({ path: path.join(OUT, file) });
          results[name] = { ...m, summary: summarize(m) };
          console.log(name, JSON.stringify(results[name].summary));
        } catch (e) {
          console.log(name, 'ERROR', e.message.split('\n')[0]);
          await page.screenshot({ path: path.join(OUT, `${name}_ERROR.png`) }).catch(() => {});
        } finally {
          await page.close();
          await new Promise((res) => setTimeout(res, 1500)); // let the doorbell free the video slot
        }
      }
    }
    await ctx.close();
  }
  fs.writeFileSync(resFile, JSON.stringify(results, null, 1));
}

(async () => {
  const mode = process.argv[2] || 'all';
  const c = await (await fetch(`http://${WAVESHARE_IP}/api/debug/cores`)).json();
  if (c.busy || c.call || c.ring) { console.error('Waveshare busy: abort'); process.exit(3); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await login(ctx);
    await page.goto(HASS_URL + '/profile/general', { waitUntil: 'domcontentloaded' });
    await hassReady(page);
    const id = await targetId(page);
    if (mode === 'setup' || mode === 'all') await setup(page);
    if (mode === 'capture' || mode === 'all') await capture(browser, process.argv[3], id, cardSource());
    if (mode === 'teardown' || mode === 'all') await teardown(page);
    await ctx.close();
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
