// 1.4.4 remote-path probe: the card, mounted in the REAL Home Assistant, watching a REAL doorbell,
// from a browser whose network is whatever the caller (bench.js) made it. It only watches: no mic,
// no door, no ring, no REC, no settings. One session, closed with the card's own teardown at the end.
//
// It measures, it does not assume:
//   - the isolation itself (NET): can this process reach the doorbell's LAN address? Home Assistant?
//     the STUN/TURN server? A block that silently did not apply would make "remote works" vacuous.
//   - the media: frames decoded advancing, the audio track live with packets advancing, and the
//     SELECTED candidate pair types from getStats (relay / srflx / host).
//   - what the card says: data-path, the "Internet" pill, the status line texts it showed.
//
// Env: HASS_URL HASS_TOKEN (never printed), CARD_FILE, DOORBELL_RE (regex on the device name),
//      DOORBELL_IP (only to validate the isolation; never printed), NET (outside|none|lan),
//      EXPECT (live-remote|live-local|fail), WAIT_MS, CHROME (optional executable).
'use strict';
const fs = require('fs');
const dgram = require('dgram');
const crypto = require('crypto');
const { chromium } = require('playwright-core');

const HASS_URL = (process.env.HASS_URL || '').replace(/\/$/, '');
const HASS_TOKEN = process.env.HASS_TOKEN || '';
const CARD_FILE = process.env.CARD_FILE;
const DOORBELL_RE = new RegExp(process.env.DOORBELL_RE || 'waveshare', 'i');
const DOORBELL_IP = process.env.DOORBELL_IP || '';
const NET = process.env.NET || 'lan';
const EXPECT = process.env.EXPECT || 'live-remote';
const WAIT_MS = Number(process.env.WAIT_MS || 45000);
if (!HASS_URL || !HASS_TOKEN || !CARD_FILE || !DOORBELL_IP) { console.error('HASS_URL/HASS_TOKEN/CARD_FILE/DOORBELL_IP missing'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (label, ok) => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) fails++; };

async function reachable(url, ms = 3000) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.status > 0; } catch (e) { return false; }
}

// A STUN Binding Request, answered or not in `ms`. The instrument for "is the VPS reachable over UDP".
function stunAnswers(host, port, ms = 2500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const msg = Buffer.alloc(20);
    msg.writeUInt16BE(0x0001, 0); msg.writeUInt16BE(0, 2); msg.writeUInt32BE(0x2112A442, 4);
    crypto.randomBytes(12).copy(msg, 8);
    const done = (v) => { try { sock.close(); } catch (e) { /* closed */ } resolve(v); };
    const t = setTimeout(() => done(false), ms);
    sock.on('message', (m) => { clearTimeout(t); done(m.length >= 20 && m.readUInt16BE(0) === 0x0101); });
    sock.on('error', () => { clearTimeout(t); done(false); });
    sock.send(msg, port, host);
  });
}

(async () => {
  console.log(`probe: NET=${NET} EXPECT=${EXPECT} card=${CARD_FILE.split(/[\\/]/).pop()}`);
  // ---- 1. the isolation, measured before anything else ----
  const dbReach = await reachable(`http://${DOORBELL_IP}/api/device_id`);
  const haReach = await reachable(`${HASS_URL}/manifest.json`);
  check(`Home Assistant reachable (${haReach})`, haReach);
  const atHome = NET.startsWith('lan');
  check(`doorbell LAN address ${atHome ? 'reachable' : 'UNREACHABLE'} (reachable=${dbReach})`, atHome ? dbReach : !dbReach);

  const browser = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  const marks = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('ig-doorbell-card timing')) marks.push(t.replace(/^\[ig-doorbell-card timing\] /, '')); });

  // Every RTCPeerConnection the page makes: kept, and its iceServers recorded WITHOUT credentials.
  await ctx.addInitScript((forceRelay) => {
    const Orig = window.RTCPeerConnection;
    window.__pcs = [];
    window.__iceCfg = [];
    window.RTCPeerConnection = function (cfg, ...rest) {
      const servers = (cfg && cfg.iceServers) || [];
      window.__iceCfg.push(servers.map((s) => ({ urls: s.urls, hasUser: !!s.username, hasCred: !!s.credential })));
      // FORCE_RELAY=1 (diagnostic only): TURN-only on a machine that COULD go direct - separates "the
      // TURN path" from "this network" when a case misbehaves.
      const pc = new Orig(forceRelay ? Object.assign({}, cfg, { iceTransportPolicy: 'relay' }) : cfg, ...rest);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Orig.prototype;
  }, process.env.FORCE_RELAY === '1');

  await page.goto(HASS_URL + '/manifest.json');
  // The doorbell sends H.264. A browser without it rejects the video m-line and gets audio only,
  // which is indistinguishable from "the path drops video" - so it is checked, not assumed.
  const h264 = await page.evaluate(() => RTCRtpReceiver.getCapabilities('video').codecs.some((c) => /h264/i.test(c.mimeType)));
  check(`this browser decodes H.264 (${h264})`, h264);
  await page.evaluate(([url, tok]) => {
    localStorage.setItem('hassTokens', JSON.stringify({ access_token: tok, token_type: 'Bearer', expires_in: 1e9, hassUrl: url, clientId: url + '/', expires: Date.now() + 1e12, refresh_token: '' }));
    localStorage.setItem('selectedLanguage', '"en"');
  }, [HASS_URL, HASS_TOKEN]);
  await page.goto(HASS_URL + '/profile/general', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => { const h = document.querySelector('home-assistant'); return h && h.hass && h.hass.connected && h.hass.devices; }, null, { timeout: 30000 });

  const target = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const devs = document.querySelector('home-assistant').hass.devices;
    for (const k of Object.keys(devs)) {
      const p = (devs[k].identifiers || []).find((x) => x[0] === 'ig_doorbell');
      if (p && re.test(devs[k].name_by_user || devs[k].name || '')) return p[1];
    }
    return null;
  }, DOORBELL_RE.source);
  check('doorbell found in Home Assistant\'s device registry', !!target);
  if (!target) { await browser.close(); process.exit(1); }

  let src = fs.readFileSync(CARD_FILE, 'utf8');
  for (const [a, b] of [["const CARD_TAG = 'ig-doorbell-card';", "const CARD_TAG = 'ig-doorbell-card-dev';"],
    ["const VIEW_TAG = 'ig-doorbell-view';", "const VIEW_TAG = 'ig-doorbell-view-dev';"],
    ["const EDITOR_TAG = 'ig-doorbell-card-editor';", "const EDITOR_TAG = 'ig-doorbell-card-editor-dev';"]]) {
    if (src.split(a).length !== 2) throw new Error('anchor ' + a);
    src = src.replace(a, b);
  }
  await page.evaluate((w) => { localStorage.setItem('ig-doorbell-card-selected', w); }, target);
  const t0 = Date.now();
  await page.addScriptTag({ content: src });
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'ig-test-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:430px;z-index:99999;background:#111;';
    document.body.appendChild(host);
    const card = document.createElement('ig-doorbell-card-dev');
    card.setConfig({ type: 'custom:ig-doorbell-card', height: '650px' });
    const ha = document.querySelector('home-assistant');
    card.hass = ha.hass;
    host.appendChild(card);
    window.__hassPump = setInterval(() => { if (card.hass !== ha.hass) card.hass = ha.hass; }, 300);
    window.__status = [];
    const watch = () => {
      const v = document.querySelector('ig-doorbell-view-dev');
      if (!v || !v.statusLine) { setTimeout(watch, 100); return; }
      new MutationObserver(() => { const t = v.statusLine.textContent; if (t && window.__status[window.__status.length - 1] !== t.replace(/\d+s$/, 'Ns')) window.__status.push(t.replace(/\d+s$/, 'Ns')); })
        .observe(v.statusLine, { childList: true, characterData: true, subtree: true });
    };
    watch();
  });

  // One sample of what the media is doing, from the pc the card is using NOW.
  const sample = () => page.evaluate(async () => {
    const v = document.querySelector('ig-doorbell-view-dev');
    const pc = v && v.pc;
    if (!pc) return { pc: false };
    const st = await pc.getStats();
    const out = { pc: true, conn: pc.connectionState, frames: 0, vBytes: 0, aPackets: 0, pair: null, audioTrack: null,
      videoW: v.videoEl ? v.videoEl.videoWidth : 0, path: v.dataset.path || '', pathDetail: v.dataset.pathDetail || '',
      pill: v.pathPill ? getComputedStyle(v.pathPill).display : 'absent', live: v._liveStateKey || '' };
    let pairId = null;
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') { out.frames = r.framesDecoded || 0; out.vBytes = r.bytesReceived || 0; }
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.aPackets = r.packetsReceived || 0;
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    const pair = pairId && st.get(pairId);
    if (pair) {
      const l = st.get(pair.localCandidateId); const r = st.get(pair.remoteCandidateId);
      out.pair = { local: l && l.candidateType, localProto: l && l.relayProtocol, remote: r && r.candidateType, rtt: pair.currentRoundTripTime };
    }
    const at = pc.getReceivers().map((x) => x.track).find((t) => t && t.kind === 'audio');
    out.audioTrack = at ? at.readyState : null;
    return out;
  });

  let first = null; let s;
  while (Date.now() - t0 < WAIT_MS) {
    s = await sample();
    if (s.pc && s.frames > 0 && s.conn === 'connected') { first = Date.now() - t0; break; }
    await sleep(500);
  }
  const iceCfg = await page.evaluate(() => window.__iceCfg);
  const lastCfg = iceCfg[iceCfg.length - 1] || [];
  console.log(`iceServers of the last RTCPeerConnection: ${JSON.stringify(lastCfg)}  (${iceCfg.length} pc created)`);

  // ---- the UDP side of the isolation: does the STUN server answer this network? ----
  const stunUrl = (lastCfg.find((x) => /^stun:/.test(x.urls)) || {}).urls;
  if (stunUrl) {
    const m = /^stun:([^:?]+):?(\d+)?/.exec(stunUrl);
    const stunOk = await stunAnswers(m[1], Number(m[2] || 3478));
    console.log(`STUN answers this network over UDP: ${stunOk}`);
    if (NET === 'none') check('negative control isolation: STUN/TURN unreachable over UDP', !stunOk);
    if (NET === 'outside') check('outside isolation: STUN/TURN reachable over UDP', stunOk);
    if (NET === 'lan-no-vps') check('principle-1 isolation: STUN/TURN unreachable over UDP', !stunOk);
  } else {
    console.log('no STUN server in the card\'s iceServers (card or integration older than 1.4.4)');
  }

  let s2 = null;
  if (first !== null) { await sleep(4000); s2 = await sample(); }
  const status = await page.evaluate(() => window.__status);
  const result = { NET, EXPECT, firstFrameMs: first, first: s, after4s: s2, statusTexts: status };
  console.log('RESULT ' + JSON.stringify(result));

  if (EXPECT === 'fail') {
    check(`no video within ${WAIT_MS} ms (firstFrameMs=${first})`, first === null);
    // Language-agnostic: the retry countdown ends in "<n>s" in every language (normalised to "Ns").
    check(`not left on a bare spinner: a retry countdown was shown (${JSON.stringify(status)})`, status.some((t) => / Ns$/.test(t)));
    if (process.env.SAYS_NO_PATH === '1') {
      const said = status.some((t) => /No video path to the doorbell|No hay camino de vídeo hasta el portero/.test(t));
      check('the card SAID there is no video path from this network (retry_no_path)', said);
      check(`the badge does not claim live video (${s && s.live})`, !s || s.live !== 'live');
    }
  } else {
    check(`video: first frame decoded (${first} ms)`, first !== null);
    if (s2) {
      check(`video frames advance (${s.frames} -> ${s2.frames})`, s2.frames > s.frames);
      check(`audio track live and packets advance (${s2.audioTrack}, ${s.aPackets} -> ${s2.aPackets})`, s2.audioTrack === 'live' && s2.aPackets > s.aPackets);
      const p = s2.pair || {};
      if (EXPECT === 'live-remote') {
        check(`selected pair is NOT host->host: ${JSON.stringify(p)}`, !(p.local !== 'relay' && p.remote === 'host'));
        check(`card says path=remote (${s2.path}, ${s2.pathDetail}) and shows the Internet pill (${s2.pill})`, s2.path === 'remote' && s2.pill === 'flex');
      } else {
        check(`selected pair is host-side on the doorbell and not relayed: ${JSON.stringify(p)}`, p.remote === 'host' && p.local !== 'relay');
        check(`card says path=local (${s2.path}) and hides the Internet pill (${s2.pill})`, s2.path === 'local' && s2.pill === 'none');
      }
    }
  }

  // ---- close the ONE session with the card's own teardown (sends bye) ----
  await page.evaluate(() => { clearInterval(window.__hassPump); document.querySelectorAll('ig-doorbell-view-dev').forEach((v) => v._destroy('bench end')); document.getElementById('ig-test-host').remove(); localStorage.removeItem('ig-doorbell-card-selected'); });
  await sleep(1500);
  await browser.close();
  console.log('timing marks (card):');
  for (const m of marks.filter((x) => /get_ice_servers|media path|connectionState|_scheduleReconnect|tryLocalSignaling: finished/.test(x)).slice(0, 25)) console.log('   ' + m);
  console.log(fails ? `PROBE FAIL (${fails})` : 'PROBE OK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(3); });
