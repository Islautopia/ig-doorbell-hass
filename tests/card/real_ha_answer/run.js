// Mic opened in the card during a ring: WHICH ringing stops, measured on the real Waveshare through
// the real Home Assistant (bench only -- this script refuses any doorbell but the Waveshare).
//
// It rings the Waveshare (GET /ring, admin session), mounts THIS repo's card with the frontend's real
// `hass` (same trick as real_ha_1_10_0), opens the microphone from the card's own button, and then
// measures three things independently:
//   A. the doorbell: GET /api/call_status?call_id=<the ring's> -- did the doorbell resolve the call?
//   B. the card: every `ring` / `call_ended` its signalling channel carried, and what it sent.
//   C. the relay: the rendezvous journal on the VPS for that call_id -- when and WHY the relay closed
//      the call. The relay's close is what sends the cancel pushes that stop the phones' CallKit /
//      ConnectionService ring: a close with reason=timeout means the phones rang to the end.
//
// Usage (from tests/card):
//   HASS_URL=... HASS_TOKEN=... DOORBELL_ADMIN_USER=... DOORBELL_ADMIN_PASS=... node real_ha_answer/run.js
//   CARD_FILE=<path> selects another build (e.g. fixtures/legacy/card_1_0_0.js for the negative control).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';
const CHROME = process.env.PLAYWRIGHT_CHROMIUM_PATH || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const WS_IP = '192.168.41.155';            // the Waveshare -- the ONLY doorbell this bench may ring
const CARD_FILE = process.env.CARD_FILE || path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const MIC_AFTER_MS = 4000;
const RELAY = process.env.NO_RELAY ? null : 'hetzner-doorbell';
if (!HASS_URL || !HASS_TOKEN || !process.env.DOORBELL_ADMIN_USER) { console.error('env missing'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

let cookie = '';
async function ws(pathq, body) {
  const o = { redirect: 'manual', headers: { Cookie: cookie } };
  if (body) { o.method = 'POST'; o.body = JSON.stringify(body); o.headers['Content-Type'] = 'application/json'; }
  return fetch(`http://${WS_IP}${pathq}`, o);
}
async function login() {
  const body = new URLSearchParams({ email: process.env.DOORBELL_ADMIN_USER, password: process.env.DOORBELL_ADMIN_PASS });
  const r = await fetch(`http://${WS_IP}/api/login`, { method: 'POST', body, redirect: 'manual' });
  cookie = (r.headers.get('set-cookie') || '').split(';')[0];
  return !!cookie;
}
const cores = async () => (await ws('/api/debug/cores')).json();
const callStatus = async (cid) => (await ws('/api/call_status' + (cid ? '?call_id=' + cid : ''))).json();
function relayLines(cid) {
  if (!RELAY) return [];
  try {
    return execFileSync('ssh', ['-o', 'BatchMode=yes', RELAY,
      `journalctl -u rendezvous --since "-10min" --no-pager | grep ${cid}`],
    { encoding: 'utf8', timeout: 30000 }).trim().split('\n').filter(Boolean);
  } catch (e) { return []; }
}

(async () => {
  if (!(await login())) { console.error('login failed'); process.exit(2); }
  const fw = await (await ws('/api/firmware_info')).json();
  let c = await cores();
  console.log(`card=${path.basename(CARD_FILE)} Waveshare fw=${fw.fw_version} busy=${c.busy} sessions=${c.sessions} ring=${c.ring} call=${c.call} talker=${c.talker}`);
  if (c.busy || c.ring || c.call || c.sessions) { console.log('ABORT: the Waveshare is in use (another bench?)'); process.exit(3); }

  // THE RING MUST BE A REAL ONE. A doorbell whose current mode has no sequence rings through the
  // fallback path, where the "ring in progress" flag (seq_engine_ring_active) is never raised -- and
  // opening the mic resolves a call only while that flag is up (seq_engine_on_mic_opened). The
  // Waveshare's catalogue is empty, so without this the bench would measure a ring no real doorbell
  // has (Ermita 10 has its mode sequences). A temporary sequence: notify the phones, chime, then a
  // 30 s wait standing for the street announcement; removed again at the end.
  const states = await (await ws('/api/get_states')).json();
  const mode = states.m;
  const seqBefore = await (await ws('/api/sequences')).json();
  const modeBefore = seqBefore.modes.find((x) => x.m === mode);
  const cr = await (await ws('/api/sequences', { op: 'create', name: 'BENCH-answer-by-mic',
    steps: [{ type: 'notify' }, { type: 'chime', chime: 1 }, { type: 'wait', ms: 30000 }] })).json();
  if (!cr.id) { console.log('ABORT: could not create the bench sequence ' + JSON.stringify(cr)); process.exit(3); }
  const sm = await ws('/api/sequences', { op: 'set_mode', m: mode, seq: cr.id, no_answer: 0 });
  console.log(`bench sequence ${cr.id} on mode ${mode} (was ${JSON.stringify(modeBefore)}): set_mode ${sm.status}`);
  const restore = async () => {
    const a = await ws('/api/sequences', { op: 'set_mode', m: mode, seq: modeBefore.seq, no_answer: modeBefore.no_answer });
    const b = await ws('/api/sequences', { op: 'delete', id: cr.id });
    const after = await (await ws('/api/sequences')).json();
    console.log(`restored: set_mode ${a.status}, delete ${b.status}, modes as before: ${JSON.stringify(after.modes) === JSON.stringify(seqBefore.modes)}`);
  };
  process.on('exit', () => {});
  try {

  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', `--unsafely-treat-insecure-origin-as-secure=${HASS_URL}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['microphone', 'camera'] });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('ig-doorbell') && !t.includes('DIAG')) logs.push(ts() + ' ' + t); });
  // B. what the card's signalling channel carries (EventSource spy, installed before any page script).
  await page.addInitScript(() => {
    window.__sig = [];
    const ES = window.EventSource;
    function Spy(url, o) {
      const es = new ES(url, o);
      es.addEventListener('message', (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type !== 'heartbeat' && m.type !== 'candidate') window.__sig.push(['in', Date.now(), m.type, m.call_id || '', m.reason || '', m.by || '']);
        } catch (e) { /* not JSON */ }
      });
      return es;
    }
    Spy.prototype = ES.prototype;
    window.EventSource = Spy;
  });
  await page.goto(HASS_URL + '/manifest.json');
  await page.evaluate(([url, tok]) => {
    localStorage.setItem('hassTokens', JSON.stringify({ access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url, clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '' }));
  }, [HASS_URL, HASS_TOKEN]);
  await page.goto(HASS_URL + '/profile/general', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const h = document.querySelector('home-assistant'); return h && h.hass && h.hass.connected && h.hass.devices; }, null, { timeout: 30000 });
  const W = await page.evaluate(() => {
    const devs = document.querySelector('home-assistant').hass.devices;
    for (const k of Object.keys(devs)) {
      const p = (devs[k].identifiers || []).find((x) => x[0] === 'ig_doorbell');
      if (p && /waveshare/i.test(devs[k].name_by_user || devs[k].name)) return p[1];
    }
    return null;
  });
  if (!W) { console.log('ABORT: no Waveshare in HA'); process.exit(3); }
  let src = fs.readFileSync(CARD_FILE, 'utf8');
  for (const [a, b] of [["const CARD_TAG = 'ig-doorbell-card';", "const CARD_TAG = 'ig-doorbell-card-dev';"],
    ["const VIEW_TAG = 'ig-doorbell-view';", "const VIEW_TAG = 'ig-doorbell-view-dev';"],
    ["const EDITOR_TAG = 'ig-doorbell-card-editor';", "const EDITOR_TAG = 'ig-doorbell-card-editor-dev';"]]) {
    if (src.split(a).length !== 2) throw new Error('anchor ' + a);
    src = src.replace(a, b);
  }
  await page.evaluate((w) => { localStorage.setItem('ig-doorbell-card-selected', w); }, W);
  // ... and what the card SENDS (the HA proxy POST), wrapped on every hass object it is handed.
  await page.evaluate(() => {
    window.__wrap = (h) => {
      if (h.__spied) return h;
      const o = h.callApi.bind(h);
      h.callApi = (m, p, b) => {
        if (/\/signal\//.test(p) && b && b.type !== 'candidate') window.__sig.push(['out', Date.now(), b.type, b.call_id || '', b.reason || '', '']);
        return o(m, p, b);
      };
      h.__spied = true;
      return h;
    };
  });
  await page.addScriptTag({ content: src });
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:430px;z-index:99999;background:#111;';
    document.body.appendChild(host);
    const card = document.createElement('ig-doorbell-card-dev');
    card.setConfig({ type: 'custom:ig-doorbell-card', height: '650px' });
    const ha = document.querySelector('home-assistant');
    card.hass = window.__wrap(ha.hass);
    host.appendChild(card);
    setInterval(() => { if (card.hass !== ha.hass) card.hass = window.__wrap(ha.hass); }, 300);
    window.__view = () => card.querySelector('ig-doorbell-view-dev');
  });
  const live = await page.waitForFunction(() => { const v = window.__view(); return v && v.videoEl && v.videoEl.videoWidth > 0; }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  console.log(`${ts()} card live on the Waveshare: ${live}`);
  if (!live) { console.log(logs.slice(-15).join('\n')); await browser.close(); process.exit(4); }

  // RING.
  const tRing = Date.now();
  const rr = await ws('/ring');
  console.log(`${ts()} GET /ring -> ${rr.status}`);
  let st;
  for (let i = 0; i < 20; i++) { st = await callStatus(); if (st.state === 'ringing') break; await sleep(250); }
  const cid = st.call_id;
  console.log(`${ts()} doorbell: ${JSON.stringify(st)}`);
  await sleep(MIC_AFTER_MS);
  // ANSWER = open the mic from the card's own button.
  const tMic = Date.now();
  await page.evaluate(() => window.__view().micButton.click());
  console.log(`${ts()} mic button clicked in the card`);
  let ended = null;
  for (let i = 0; i < 40; i++) {
    const s = await callStatus(cid);
    if (s.state === 'ended') { ended = [Date.now() - tMic, s]; break; }
    await sleep(250);
  }
  console.log(`${ts()} A. doorbell call_status: ${ended ? `ENDED ${ended[0]} ms after the click: ${JSON.stringify(ended[1])}` : 'still ringing 10 s after the click'}`);
  await sleep(1500);
  const talkOn = await page.evaluate(() => !!window.__view().talkActive);
  console.log(`${ts()}    card talkActive=${talkOn}`);
  await page.evaluate(() => { const v = window.__view(); if (v.talkActive) v.micButton.click(); });
  let rl = [];
  for (let i = 0; i < 16; i++) { await sleep(5000); rl = relayLines(cid); if (!RELAY || rl.some((l) => /cerrada/.test(l))) break; }
  const sig = await page.evaluate(() => window.__sig);
  console.log('B. card signalling (dir, ms from the mic click, type, call_id, reason, by):');
  for (const s of sig) if (s[1] >= tRing - 500) console.log(`   ${s[0]} ${s[1] - tMic} ${s[2]} ${s[3] ? s[3].slice(0, 8) : ''} ${s[4]} ${s[5]}`);
  console.log('C. relay journal for this call:');
  for (const l of rl) console.log('   ' + l.replace(/^.*python3\[\d+\]: /, '').slice(0, 230));
  const close = rl.find((l) => /cerrada/.test(l)) || '';
  console.log(`\nSUMMARY call=${cid.slice(0, 8)} doorbell_ended_ms=${ended ? ended[0] : 'none'} doorbell_reason=${ended ? ended[1].reason : '-'} relay_close=${close ? close.replace(/^.*cerrada /, '') : 'none'}`);
  await browser.close();
  } finally { await restore(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
