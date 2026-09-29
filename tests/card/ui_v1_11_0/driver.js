// Real-browser check of v1.11.0: the adaptive layout (stack / overlay / side column), extended in
// integration 1.1.1 with the fourth layout, SPLIT (call buttons beside the picture, not over it).
// Loads the REAL dist/ file; ../ui_v1_10_0/harness.js only doubles the network and hass.
//
// RUN (from the repo root):
//   1. python -m http.server 8797
//   2. node test/ui_v1_11_0/driver.js
//
// The card is mounted inside a fake Home Assistant view (<hui-panel-view> / <hui-masonry-view>, the
// tag names _viewHost() looks for, under a 56 px "top bar") and the stream's shape is set by
// overriding _contentSize() on the view - the same page-side simulation the real-HA matrix uses
// (test/layout_matrix_1_11_0): every layout decision goes through _contentSize().
//
// CHECKS (each case = viewport x view kind x stream orientation):
//   L1 exactly one layout: never ig-stack + ig-side, ig-short only in overlay, no ig-rail outside
//      fullscreen, and the button row lives where its layout says (stack-controls / side-col / feed).
//   L2 no side column when it would be shorter than 350 px.
//   L3 no overflow: card bottom <= viewport bottom and the page doesn't scroll vertically.
//   L4 every visible control is reachable: its centre is on screen and hit-testing lands on it.
//   L5 touch targets >= 44 px on touch devices (pointer: coarse).
//   L6 the side column hugs the image: frame width = image width, column right next to it.
//   L7 no horizontal scroll.
//   L8 live resize and stream rotation re-layout without reload (and L1-L4 hold after each).
//   L9 getGridOptions / getCardSize (real height / 50).
//   L10 fullscreen: no layout class or inline width leaks in; the rail only with height >= 350.
//   L11 the side column's content fits its box (no internal overflow).
//   L12 the doorbell picker is never squeezed below 90 px (crowded short header).
//   L13 (1.1.1) no call button (sound / mic / door) over the PICTURE while the card has room beside
//      it for a column of buttons (>= SPLIT_ROOM px of free width next to the image). Overlay is
//      only allowed when there is genuinely no lateral room. This is the iPhone-landscape case:
//      a portrait stream using 25 % of the width with the buttons over the visitor's face.
//   (L6 and L11 also cover the split columns: frame = image, columns next to it, content fits.)
//
// CARD_FILE=<path> serves another build instead of the repo's (the 1.0.0 card must fail L13).
//
// POSITIVE CONTROLS ARE BUILT IN: after the real run, the same checks run against MUTANTS of dist/
// (served through page.route), each re-introducing one failure. The run passes only if the real
// file is all green AND every mutant turns its target check red.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/ui_v1_11_0/index.html';
const CARD_FILE = process.env.CARD_FILE || null;
// Free width beside the image that can hold the button column: 88 px column + 10 px gap.
const SPLIT_ROOM = 98;
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MUTANTS = {
  // L1: stack and side both on (the shape of the 1.9.8 rail+stack bug)
  M1: { target: 'L1', a: "c.classList.toggle('ig-stack', L === 'stack');", b: "c.classList.toggle('ig-stack', L === 'stack' || L === 'side');" },
  // L2: side column allowed at any height
  M2: { target: 'L2', a: 'if (imgH >= K.SIDE_MIN_H && imgW >= K.SIDE_MIN_IMG_W)', b: 'if (imgH >= 0 && imgW >= K.SIDE_MIN_IMG_W)' },
  // L3: what HA puts under the card ignored
  M3: { target: 'L3', a: 'return Math.min(64, Math.max(panel ? 0 : 4, Math.ceil(sum)));', b: 'return 0;' },
  // L5: no 44 px targets on touch
  M4: { target: 'L5', a: '@media (pointer: coarse) {', b: '@media (pointer: none-at-all) {' },
  // L11 (+L4): compact column never used, full column squeezed into a short one
  M5: { target: 'L11', a: "c.classList.toggle('ig-side-compact', L === 'side' && plan.feedH < IgDoorbellView.SIDE_FULL_H);", b: "c.classList.toggle('ig-side-compact', false);" },
  // L6: frame not sized to the image
  M6: { target: 'L6', a: "const w = (L === 'side' || L === 'split') ? `${plan.imgW}px` : '';", b: "const w = '';" },
  // L8: no re-layout on resize
  M7: { target: 'L8', a: '  _scheduleFit() {\n    if (this._fitRaf) return;', b: '  _scheduleFit() {\n    return;' },
  // L9: the old constant card size
  M8: { target: 'L9', a: 'return h > 0 ? Math.max(1, Math.ceil(h / 50)) : 12;', b: 'return 4;' },
  // L10: rail in fullscreen even when too short
  M9: { target: 'L10', a: '!!this._fsActive && h >= IgDoorbellView.SIDE_MIN_H;', b: '!!this._fsActive;' },
  // L7: ha-card's overflow-x clip normally makes horizontal scroll impossible by construction, so the
  // instrument's positive control needs TWO changes: no clip + a frame that ignores the image width.
  M10: { target: 'L7', a: 'overflow: hidden auto; border-radius: var(--ha-card-border-radius, 12px);', b: 'overflow: visible; border-radius: var(--ha-card-border-radius, 12px);',
    a2: "const w = (L === 'side' || L === 'split') ? `${plan.imgW}px` : '';", b2: "const w = (L === 'side' || L === 'split') ? `${plan.imgW + 900}px` : '';" },
  // L12 in a narrow short header (372 px column, phone in landscape): the 1.11.0 wrap + picker minimum both gone
  M11: { target: 'L12', a: '.ig-container.ig-short .top-row, .ig-container.ig-split > .top-row { flex-wrap: wrap; row-gap: 8px; }', b: '',
    a2: '.db-picker { min-width: min(100%, 96px); }', b2: '' },
  // L13 (1.1.1): the split layout never replaces overlay -> call buttons back over the picture
  M12: { target: 'L13', a: "if (split && best.layout === 'overlay' && split.score >= best.score) best = split;", b: '' },
  // L11 (1.1.1): the labelled (bigger) button column at any height -> buttons pile up in a short column
  M13: { target: 'L11', a: "c.classList.toggle('ig-split-lbl', L === 'split' && plan.feedH >= IgDoorbellView.SPLIT_LBL_H);", b: "c.classList.toggle('ig-split-lbl', L === 'split');" },
  // L6 (1.1.1): split frame not sized to the image (black bars back, the columns drift away from it)
  M14: { target: 'L6', a: "const w = (L === 'side' || L === 'split') ? `${plan.imgW}px` : '';", b: "const w = L === 'side' ? `${plan.imgW}px` : '';" },
};

function mutate(src, name) {
  src = src.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const m = MUTANTS[name];
  const n = src.split(m.a).length - 1;
  if (n !== 1) throw new Error(`mutant ${name}: anchor found ${n} times: ${m.a.slice(0, 60)}`);
  src = src.replace(m.a, m.b);
  if (m.a2) {
    const n2 = src.split(m.a2).length - 1;
    if (n2 !== 1) throw new Error(`mutant ${name}: anchor 2 found ${n2} times`);
    src = src.replace(m.a2, m.b2);
  }
  return src;
}

const SIZES = {
  phone_port: { w: 390, h: 844, touch: true },
  phone_land: { w: 844, h: 390, touch: true },       // iPhone 15 Pro-like in landscape (HA companion)
  phone_land_932: { w: 932, h: 430, touch: true },   // iPhone 15 Pro Max-like in landscape
  tablet_port: { w: 800, h: 1280, touch: true },
  tablet_land: { w: 1280, h: 800, touch: true },
  strip: { w: 1280, h: 520, touch: true },       // a wallpanel strip: compact column
  pc: { w: 1920, h: 1080, touch: false },
};
const KINDS = ['panel', 'column', 'wide', 'narrow'];  // narrow = a 372 px sidebar column
// Ermita 10's real stream is 1080x1200 (near-square portrait); 1080x1920 is a full portrait sensor.
const ORIENTS = { portrait: { w: 1080, h: 1920 }, near_square: { w: 1080, h: 1200 }, landscape: { w: 1280, h: 720 } };

// ---- in-page helpers --------------------------------------------------------------------------
function pageMount({ kind, sim }) {
  window.tReset();
  // (2026-09-29) tReset() clears ALL of localStorage (ui_v1_10_0/harness.js), which wipes the
  // 'advanced' choice the addInitScript in run() set for this whole matrix - re-assert it on
  // every mount. Without this the FIRST pageMount() call already drops the card back to simple
  // mode (top-row/#bottom-row hidden, only 3+compact buttons in a stack), which this matrix isn't
  // testing and isn't sized for at every breakpoint.
  try { localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ }
  // The narrow case uses a long doorbell name, like the real 'Doorbell Waveshare' that exposed the squeeze.
  window.__db.aaaa1111.name = kind === 'narrow' ? 'Doorbell Waveshare Front' : 'Ermita 10';
  window.tRebuild();
  const stage = document.getElementById('stage');
  const vw = innerWidth;
  const bar = '<div style="height:56px;background:#222"></div>';
  if (kind === 'panel') {
    stage.innerHTML = `${bar}<hui-panel-view style="display:block"><div id="host"></div></hui-panel-view>`;
  } else {
    // masonry-like: padding around, a column of a given width, 16 px under it (as HA's views)
    const colW = kind === 'column' ? Math.min(492, vw - 16) : kind === 'narrow' ? Math.min(372, vw - 16) : Math.max(300, Math.round(vw * 0.62));
    stage.innerHTML = `${bar}<hui-masonry-view style="display:block;padding:8px 8px 16px;box-sizing:border-box"><div id="host" style="width:${colW}px;max-width:100%"></div></hui-masonry-view>`;
  }
  window.tCreate();
  const v = window.tView();
  v._contentSize = () => ({ w: sim.w, h: sim.h });
  v._scheduleFit();
}

function pageMeasure() {
  const v = window.tView();
  const card = window.tCard;
  const c = v.content;
  const R = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
  const fw = R(v.feedWrap);
  const cs = v._contentSize();
  const k = Math.min(fw.w / cs.w, fw.h / cs.h);
  const img = { w: cs.w * k, h: cs.h * k };
  const deepAt = (x, y) => { let el = document.elementFromPoint(x, y); while (el && el.shadowRoot) { const i = el.shadowRoot.elementFromPoint(x, y); if (!i || i === el) break; el = i; } return el; };
  const ids = ['db-pill', 'mode-pill', 'rec-button', 'bell-btn', 'snd-btn', 'mic-button', 'unlock-button', 'recordings-button', 'qr-button', 'fs-btn'];
  const controls = [];
  for (const id of ids) {
    const el = v.querySelector('#' + id);
    if (!el) continue;
    let shown = true;
    for (let p = el; p && p !== v; p = p.parentElement) { if (getComputedStyle(p).display === 'none') { shown = false; break; } }
    if (!shown) continue;
    const r = R(el);
    const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
    const on = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
    let hit = false;
    if (on) { for (let n = deepAt(cx, cy); n; n = n.parentNode || n.host) if (n === el) { hit = true; break; } }
    controls.push({ id, w: r.w, h: r.h, x: r.x, y: r.y, r: r.r, b: r.b, inCol: !!(v.sideCol && v.sideCol.contains(el)),
      inAct: !!(v.stackControls && v.stackControls.contains(el)), reachable: hit });
  }
  const side = v.sideCol ? R(v.sideCol) : null;
  const act = v.actionsRow.parentElement;
  // The picture's real rectangle (object-fit: contain centres it in the frame).
  const imgR = { x: fw.x + (fw.w - img.w) / 2, y: fw.y + (fw.h - img.h) / 2 };
  imgR.r = imgR.x + img.w; imgR.b = imgR.y + img.h;
  const ccs = getComputedStyle(c);
  const inner = c.clientWidth - (parseFloat(ccs.paddingLeft) || 0) - (parseFloat(ccs.paddingRight) || 0);
  return {
    cls: c.className, stack: c.classList.contains('ig-stack'), side: c.classList.contains('ig-side'),
    split: c.classList.contains('ig-split'), splitHead: c.classList.contains('ig-split-head'),
    topInCol: !!(v.sideCol && v.sideCol.contains(v.topRow)), imgR, inner, actCol: R(v.stackControls),
    short: c.classList.contains('ig-short'), rail: c.classList.contains('ig-rail'), fs: c.classList.contains('ig-fs'),
    actParent: act === v.stackControls ? 'stack' : act === v.sideCol ? 'side' : act === v.feedWrap ? 'feed' : 'other',
    feed: fw, img, sideCol: side, sideScroll: v.sideCol ? [v.sideCol.scrollHeight, v.sideCol.clientHeight] : null,
    card: R(card), vw: innerWidth, vh: innerHeight,
    docH: document.documentElement.scrollHeight, docW: document.documentElement.scrollWidth,
    controls, coarse: matchMedia('(pointer: coarse)').matches,
    cardSize: card.getCardSize(), grid: card.getGridOptions ? card.getGridOptions() : null,
    feedInlineW: v.feedWrap.style.width,
  };
}

// ---- the checks on one measurement --------------------------------------------------------------
function judge(m, label, check, opts = {}) {
  const layouts = (m.stack ? 1 : 0) + (m.side ? 1 : 0) + (m.split ? 1 : 0);
  const want = (m.stack || m.split) ? 'stack' : m.side ? 'side' : 'feed';
  check('L1', `${label}: one layout, buttons where it says (${m.cls.replace('ig-container', '').trim() || 'overlay'}, row in ${m.actParent})`,
    layouts <= 1 && !(m.short && layouts) && (!m.rail || m.fs) && (m.fs || m.actParent === want)
    && (!m.splitHead || m.split) && (m.fs || m.topInCol === (m.side || m.splitHead)));
  if (m.side) check('L2', `${label}: side column >= 350 px (${Math.round(m.feed.h)})`, m.feed.h >= 350 - 0.5);
  if (!opts.noOverflow) {
    check('L3', `${label}: no overflow (card bottom ${Math.round(m.card.b)} / doc ${m.docH} vs ${m.vh})`, m.card.b <= m.vh + 0.5 && m.docH <= m.vh);
  }
  const bad = m.controls.filter((x) => !x.reachable).map((x) => x.id);
  check('L4', `${label}: all ${m.controls.length} controls reachable${bad.length ? ' (NOT: ' + bad.join(',') + ')' : ''}`, bad.length === 0 && m.controls.length >= 8);
  if (m.coarse) {
    const small = m.controls.filter((x) => Math.min(x.w, x.h) < 43.5).map((x) => `${x.id}=${Math.round(Math.min(x.w, x.h))}`);
    check('L5', `${label}: touch targets >= 44${small.length ? ' (NOT: ' + small.join(',') + ')' : ''}`, small.length === 0);
  }
  if (m.side) {
    const hug = Math.abs(m.feed.w - m.img.w) <= 2 && m.sideCol && (m.sideCol.x - m.feed.r) >= 0 && (m.sideCol.x - m.feed.r) <= 12;
    check('L6', `${label}: column hugs the image (frame ${Math.round(m.feed.w)} / img ${Math.round(m.img.w)}, gap ${m.sideCol ? Math.round(m.sideCol.x - m.feed.r) : '?'})`, hug);
    // Every control of the column inside the column's box, and no two of them overlapping (a squeezed
    // flex column doesn't overflow ITSELF: its rows shrink and the buttons pile onto each other).
    const inCol = m.controls.filter((x) => x.inCol);
    const outside = inCol.filter((x) => x.x < m.sideCol.x - 1 || x.r > m.sideCol.r + 1 || x.y < m.sideCol.y - 1 || x.b > m.sideCol.b + 1).map((x) => x.id);
    const overlaps = [];
    for (let i = 0; i < inCol.length; i++) for (let j = i + 1; j < inCol.length; j++) {
      const a = inCol[i]; const b = inCol[j];
      if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) overlaps.push(`${a.id}/${b.id}`);
    }
    check('L11', `${label}: column content fits (${inCol.length} controls${outside.length ? ', outside: ' + outside.join(',') : ''}${overlaps.length ? ', overlapping: ' + overlaps.join(',') : ''})`,
      inCol.length >= 8 && !outside.length && !overlaps.length);
  }
  if (m.split) {
    // L6 for the split layout: frame = image, the button column right of it, the header column
    // (when the header is beside the picture) left of it, both touching it.
    const gapR = m.actCol.x - m.feed.r;
    const gapL = m.splitHead ? m.feed.x - m.sideCol.r : 0;
    check('L6', `${label}: split hugs the image (frame ${Math.round(m.feed.w)} / img ${Math.round(m.img.w)}, gaps ${Math.round(gapL)}/${Math.round(gapR)})`,
      Math.abs(m.feed.w - m.img.w) <= 2 && gapR >= 0 && gapR <= 12 && gapL >= 0 && gapL <= 12);
    // L11 for the split columns: each control inside its column's box, none overlapping another.
    const boxes = [];
    for (const x of m.controls) {
      const box = x.inAct ? m.actCol : x.inCol ? m.sideCol : null;
      if (box) boxes.push({ x, box });
    }
    const outside = boxes.filter(({ x, box }) => x.x < box.x - 1 || x.r > box.r + 1 || x.y < box.y - 1 || x.b > box.b + 1).map(({ x }) => x.id);
    const overlaps = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].x; const b = boxes[j].x;
      if (a.x < b.r - 1 && b.x < a.r - 1 && a.y < b.b - 1 && b.y < a.b - 1) overlaps.push(`${a.id}/${b.id}`);
    }
    const nAct = boxes.filter(({ x }) => x.inAct).length;
    check('L11', `${label}: split columns fit (${boxes.length} controls${outside.length ? ', outside: ' + outside.join(',') : ''}${overlaps.length ? ', overlapping: ' + overlaps.join(',') : ''})`,
      nAct === 3 && (!m.splitHead || boxes.length >= 8) && !outside.length && !overlaps.length);
  }
  // L13 (1.1.1): no call button over the picture while there is room beside it for the column.
  if (!m.fs) {
    const calls = m.controls.filter((x) => ['snd-btn', 'mic-button', 'unlock-button'].includes(x.id));
    const over = calls.filter((x) => x.x < m.imgR.r - 1 && m.imgR.x < x.r - 1 && x.y < m.imgR.b - 1 && m.imgR.y < x.b - 1).map((x) => x.id);
    const room = m.inner - m.img.w;
    check('L13', `${label}: buttons over the picture only without lateral room (${over.length ? 'over: ' + over.join(',') : 'none over'}; free ${Math.round(room)} px)`,
      !over.length || room < SPLIT_ROOM);
  }
  // L12: the doorbell picker keeps a readable width (in real HA a crowded short header squeezed it to 26 px).
  const pill = m.controls.find((x) => x.id === 'db-pill');
  check('L12', `${label}: picker not squeezed (${pill ? Math.round(pill.w) : '-'} px)`, !pill || pill.w >= 90);
  check('L7', `${label}: no horizontal scroll (${m.docW} vs ${m.vw})`, m.docW <= m.vw);
}

async function run(browser, variant) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const layouts = {};
  const body = variant === 'real' ? null : mutate(fs.readFileSync(DIST, 'utf8'), variant);
  for (const touch of [true, false]) {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 800 }, isMobile: touch, hasTouch: touch, deviceScaleFactor: 1 });
    // Advanced mode (2026-09-29): default is simple, which would drop the picker/REC/Recordings/
    // Quick-replies/bell out of the `ids` whitelist pageMeasure() checks (L4 needs >= 8 visible
    // reachable controls) - force Advanced ON, this whole matrix is about the layout, not the new
    // toggle (which has its own bench). Harmless against an older CARD_FILE/mutant build.
    await ctx.addInitScript(() => { try { localStorage.setItem('ig-doorbell-advanced', '1'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage();
    if (!body && CARD_FILE) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(CARD_FILE, 'utf8') }));
    if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE);
    await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
    const ev = (fn, arg) => page.evaluate(fn, arg);
    const measure = async () => { await sleep(120); return ev(pageMeasure); };

    for (const [sname, sz] of Object.entries(SIZES)) {
      if (sz.touch !== touch) continue;
      await page.setViewportSize({ width: sz.w, height: sz.h });
      for (const kind of KINDS) {
        for (const [oname, sim] of Object.entries(ORIENTS)) {
          const label = `${sname}/${kind}/${oname}`;
          await ev(pageMount, { kind, sim });
          await sleep(350);
          const m = await measure();
          const lay = m.side ? 'side' : m.stack ? 'stack' : m.split ? (m.splitHead ? 'split-head' : 'split-top') : m.short ? 'overlay-short' : 'overlay';
          const calls = m.controls.filter((x) => ['snd-btn', 'mic-button', 'unlock-button'].includes(x.id));
          const covered = calls.some((x) => x.x < m.imgR.r - 1 && m.imgR.x < x.r - 1 && x.y < m.imgR.b - 1 && m.imgR.y < x.b - 1);
          const minCall = calls.length ? Math.round(Math.min(...calls.map((x) => Math.min(x.w, x.h)))) : 0;
          layouts[label] = `${lay.padEnd(13)} img ${Math.round(m.img.w)}x${Math.round(m.img.h)} = ${(100 * m.img.w * m.img.h / (m.vw * m.vh)).toFixed(0)}% of screen${covered ? ' COVERED' : ''}, smallest call button ${minCall}`;
          judge(m, label, check);
          if (sname === 'pc' && kind === 'panel') {
            check('L9', `${label}: getCardSize = ceil(height/50) (${m.cardSize} for ${Math.round(m.card.h)} px)`, m.cardSize === Math.ceil(m.card.h / 50));
            check('L9', `${label}: getGridOptions`, m.grid && m.grid.columns === 12 && m.grid.min_columns === 6 && m.grid.rows === 'auto' && m.grid.min_rows === 6);
          }
        }
      }
    }

    // ---- L8 live resize + rotation (touch context: a tablet turning) ----------------------------
    if (touch) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(pageMount, { kind: 'panel', sim: ORIENTS.portrait });
      await sleep(350);
      let m = await measure();
      check('L8', `tablet 1280x800 panel portrait starts in side (${m.cls})`, m.side);
      await page.setViewportSize({ width: 800, height: 1280 });
      await sleep(400);
      m = await measure();
      check('L8', `rotated to 800x1280 without reload: re-fitted (frame h ${Math.round(m.feed.h)}, card bottom ${Math.round(m.card.b)})`, m.card.b <= m.vh + 0.5 && m.feed.h > 800);
      judge(m, 'after rotate to 800x1280', check);
      await page.setViewportSize({ width: 844, height: 390 });
      await sleep(400);
      m = await measure();
      check('L8', `resized to 844x390 without reload: buttons beside the portrait picture (${m.cls})`, !m.side && !m.stack && m.split);
      judge(m, 'after resize to 844x390', check);
      await page.setViewportSize({ width: 1280, height: 800 });
      await sleep(400);
      // the stream itself changes shape (rot from session_info / quality change): landscape now
      await ev(() => { const v = window.tView(); v._contentSize = () => ({ w: 1280, h: 720 }); v.videoEl.dispatchEvent(new Event('resize')); });
      await sleep(400);
      m = await measure();
      check('L8', `stream turned landscape live: frame is landscape (${Math.round(m.img.w)}x${Math.round(m.img.h)})`, m.img.w > m.img.h && m.card.b <= m.vh + 0.5);
      judge(m, 'after stream rotation', check);
    }

    // ---- L10 fullscreen (CSS fallback level; same classes as native) ---------------------------
    if (touch) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await ev(pageMount, { kind: 'panel', sim: ORIENTS.portrait });
      await sleep(350);
      await ev(() => { const v = window.tView(); v._toggleFullscreen(); });
      await sleep(400);
      let m = await measure();
      check('L10', `fullscreen: no stack/side/short, no inline frame width (${m.cls}, w='${m.feedInlineW}')`, m.fs && !m.stack && !m.side && !m.short && m.feedInlineW === '' && m.actParent === 'feed');
      check('L10', `fullscreen 1280x800 portrait: rail on (tall enough)`, m.rail);
      await ev(() => { const v = window.tView(); v._toggleFullscreen(); });
      await sleep(400);
      m = await measure();
      check('L10', `fullscreen exit: back to side (${m.cls})`, !m.fs && m.side);
      await page.setViewportSize({ width: 844, height: 340 });
      await sleep(300);
      await ev(() => { const v = window.tView(); v._toggleFullscreen(); });
      await sleep(400);
      m = await measure();
      check('L10', `fullscreen at 340 px high: NO rail (rail needs >= 350) (${m.cls})`, m.fs && !m.rail);
      await ev(() => { const v = window.tView(); v._toggleFullscreen(); });
      await sleep(300);
    }
    if (errors.length) check('E', `page errors: ${errors.slice(0, 2).join(' | ')}`, false);
    await ctx.close();
  }
  return { results, layouts };
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  let allOk = true;
  const real = await run(browser, 'real');
  for (const r of real.results) console.log(`${r.ok ? 'OK  ' : 'FAIL'} [${r.id}] ${r.label}`);
  const bad = real.results.filter((r) => !r.ok);
  console.log(`\nREAL: ${real.results.length - bad.length}/${real.results.length} OK`);
  console.log('layouts chosen:');
  for (const [k, v] of Object.entries(real.layouts)) console.log(`  ${k.padEnd(34)} ${v}`);
  if (bad.length) allOk = false;
  if (!process.env.SKIP_MUTANTS) {
    for (const name of Object.keys(MUTANTS).filter((n) => !process.env.ONLY || process.env.ONLY.split(',').includes(n))) {
      const r = await run(browser, name);
      const red = [...new Set(r.results.filter((x) => !x.ok).map((x) => x.id))];
      const caught = red.includes(MUTANTS[name].target);
      console.log(`\n=== MUTANT ${name} (must turn ${MUTANTS[name].target} red) -> red: [${red.join(', ')}] ${caught ? 'OK' : 'NOT CAUGHT'}`);
      for (const x of r.results.filter((y) => !y.ok && y.id === MUTANTS[name].target).slice(0, 2)) console.log(`    red: [${x.id}] ${x.label}`);
      if (!caught) allOk = false;
    }
  }
  await browser.close();
  console.log(allOk ? '\nALL OK (real green, every mutant caught)' : '\nFAILED');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
