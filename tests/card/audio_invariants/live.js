// The audio invariants of the card against a REAL doorbell. Not part of run_all.js (it needs one):
//
//   cd tests/card && IGD_SECRETS_FILE=<file> node audio_invariants/live.js https://<doorbell-ip>:8443
//
// The REAL card in a real Chrome (H.264, fake microphone playing a voice-like file) with Home
// Assistant doubled by ../ui_v1_10_0/harness.js. This process stands where Home Assistant's
// signalling proxy stands: it serves the repo and forwards /api/ig_doorbell/signal/<id> (the SSE and
// the POSTs) to the doorbell, with an admin session it opens (the integration uses its pairing
// credential there; the doorbell treats both alike). The media goes straight from the browser to
// the doorbell, as at home. Nothing is installed anywhere and Home Assistant is not involved.
//
// What only a real doorbell answers: the turn really granted and voice really leaving (K3), the
// street's RTP really stopping while the card is hidden (K5), the real turn asked and granted again
// on return (K6). And two failures made on purpose IN THIS PROXY, which a doorbell cannot be asked
// to produce: K7 the signalling cut under an open microphone, K8 a talk_request that never gets
// an answer (dropped here).
//
// SAFETY: refuses to start if the doorbell is in a call or has any WebRTC client; the fake
// microphone DOES sound on the doorbell's loudspeaker for a few seconds per mic check; never rings.
// Credentials: DOORBELL_ADMIN_USER / DOORBELL_ADMIN_PASS by exact name, from the environment or from
// the KEY=value file IGD_SECRETS_FILE points to (outside every repository); kept in memory, never
// printed, never written.
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const DEVICE = new URL(process.argv[2] || '');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SECRETS = process.env.IGD_SECRETS_FILE || '';   // a KEY=value file outside every repository
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agent = new https.Agent({ rejectUnauthorized: false });   // the certificate names the public host, not the IP

function secret(name) {
  if (process.env[name]) return process.env[name];
  if (!SECRETS) throw new Error('set ' + name + ' or IGD_SECRETS_FILE');
  for (const line of fs.readFileSync(SECRETS, 'utf8').split(/\r?\n/)) {
    if (line.startsWith(name + '=')) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  throw new Error('missing ' + name);
}

function dev(method, p, body, headers) {
  return new Promise((resolve, reject) => {
    // Content-Length always: without it Node sends the body chunked, and the doorbell's server hangs up.
    const h = Object.assign({}, headers || {}, body ? { 'Content-Length': Buffer.byteLength(body) } : {});
    const req = https.request({ host: DEVICE.hostname, port: DEVICE.port || 8443, path: p, method, agent, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// A voice-like signal for Chrome's fake microphone (a steady tone is "noise" to a noise suppressor).
function micWav(file) {
  const rate = 48000, n = rate * 8, pcm = Buffer.alloc(n * 2);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ph = new Array(24).fill(0);
  let i = 0;
  while (i < n) {
    const syl = Math.floor(rate * (0.14 + 0.1 * rnd())), gap = Math.floor(rate * (0.04 + 0.06 * rnd()));
    const f0a = 105 + 85 * rnd(), f0b = 105 + 85 * rnd();
    const F = [350 + 450 * rnd(), 1000 + 1200 * rnd(), 2400 + 700 * rnd()];
    for (let k = 0; k < syl && i < n; k++, i++) {
      const x = k / syl, f0 = f0a + (f0b - f0a) * x, env = Math.pow(Math.sin(Math.PI * x), 0.6);
      let v = 0;
      for (let h = 0; h < 24; h++) {
        const fh = f0 * (h + 1); ph[h] += 2 * Math.PI * fh / rate;
        let w = 0.03; for (const f of F) w += Math.exp(-Math.pow((fh - f) / 160, 2));
        v += w * Math.sin(ph[h]);
      }
      pcm.writeInt16LE(Math.max(-32000, Math.min(32000, Math.round(9000 * env * v))), i * 2);
    }
    i += gap;
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

(async () => {
  const login = await dev('POST', '/api/login', `email=${encodeURIComponent(secret('DOORBELL_ADMIN_USER'))}&password=${encodeURIComponent(secret('DOORBELL_ADMIN_PASS'))}`,
    { 'Content-Type': 'application/x-www-form-urlencoded' });
  const m = /session=([0-9a-fA-F]+)/.exec(String(login.headers['set-cookie'] || ''));
  if (!m) { console.error('login refused by the doorbell (status ' + login.status + ')'); process.exit(2); }
  const cookie = 'session=' + m[1];
  const api = async (p) => JSON.parse((await dev('GET', p, null, { Cookie: cookie })).body);
  const st0 = await api('/api/get_states');
  const id = (await api('/api/device_id')).device_id;
  console.log(`doorbell "${st0.dname}" ${id} fw ${(await api('/api/firmware_info')).fw_version} | in_call=${JSON.stringify(st0.in_call)} webrtc_clients=${st0.webrtc_clients}`);
  if ((st0.in_call && st0.in_call.active) || st0.webrtc_clients) { console.log('ABORT: the doorbell is in use. Nothing was opened, nothing measured.'); process.exit(2); }

  // ---- the stand-in for Home Assistant's signalling proxy -----------------------------------------
  const knobs = { dropTalkRequest: false };
  const sseOpen = new Set();
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url.startsWith('/api/ig_doorbell/signal/')) {
      if (req.method === 'GET') {
        const up = https.request({ host: DEVICE.hostname, port: DEVICE.port || 8443, path: '/webrtc/signal', method: 'GET', agent, headers: { Cookie: cookie, Accept: 'text/event-stream' } }, (r) => {
          res.writeHead(r.statusCode, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
          r.pipe(res);
        });
        const pair = { up, res };
        sseOpen.add(pair);
        const end = () => { sseOpen.delete(pair); up.destroy(); };
        req.on('close', end); up.on('error', () => { try { res.destroy(); } catch (e) { /* */ } });
        up.end();
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        let type = null; try { type = JSON.parse(body).type; } catch (e) { /* */ }
        if (knobs.dropTalkRequest && type === 'talk_request') { res.writeHead(200); res.end('{}'); return; }   // K8: lost on the way
        try { const r = await dev('POST', '/webrtc/signal/post', body, { Cookie: cookie, 'Content-Type': 'application/json' }); res.writeHead(r.status); res.end(r.body); }
        catch (e) { res.writeHead(502); res.end(); }
      });
      return;
    }
    const file = path.join(REPO, url);
    if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const wav = path.join(os.tmpdir(), `igd-card-mic-${process.pid}.wav`);
  micWav(wav);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + wav, '--autoplay-policy=no-user-gesture-required'] });
  const results = [];
  const ck = (cid, text, ok) => { results.push([cid, !!ok]); console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${cid}] ${text}`); };
  let code = 1;
  try {
    const page = await (await browser.newContext({ viewport: { width: 700, height: 900 } })).newPage();
    const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
    // CARD_FILE: the same checks against another build (the 1.5.1 fixture is red on K7 and K8).
    if (process.env.CARD_FILE) {
      const body = fs.readFileSync(process.env.CARD_FILE, 'utf8');
      await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
      console.log('card under test: ' + process.env.CARD_FILE);
    }
    await page.goto(`${base}/tests/card/audio_invariants/live.html?dev=${id}&name=${encodeURIComponent(st0.dname || 'Bench')}`);
    await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
    const S = () => page.evaluate(async () => {
      const v = window.tView(), e = v.videoEl, mic = v.querySelector('#mic-button'), sl = v.querySelector('#status-line');
      const o = { slot: v._slot, pc: v.pc && v.pc.connectionState, L: window.tLiveMic(), G: window.__gumCalls, muted: e.muted, paused: e.paused,
        micShown: mic.classList.contains('active-talk'), sndOn: v.querySelector('#snd-btn').classList.contains('on'),
        status: sl.textContent, posts: window.__posts.map((p) => p.payload && p.payload.type), rx: window.__rx.slice(), aPk: 0, vPk: 0, oPk: 0, oBy: 0 };
      if (v.pc) (await v.pc.getStats()).forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') o.aPk = r.packetsReceived;
        if (r.type === 'inbound-rtp' && r.kind === 'video') o.vPk = r.packetsReceived;
        if (r.type === 'outbound-rtp' && r.kind === 'audio') { o.oPk = r.packetsSent; o.oBy = r.bytesSent; } });
      return o;
    });
    const delta = async (ms) => { const a = await S(); await sleep(ms); const b = await S(); const d = {}; for (const k of ['aPk', 'vPk', 'oPk', 'oBy']) d[k] = b[k] - a[k]; d.bpp = d.oPk ? Math.round(d.oBy / d.oPk * 10) / 10 : 0; return d; };
    const tap = (sel) => page.evaluate((s) => window.tView().querySelector(s).click(), sel);
    const T = (k) => page.evaluate((key) => getLocalText(window.__hass, key), k);
    const count = (a, t) => a.filter((x) => x === t).length;

    console.log('K1 open');
    await page.evaluate(() => { window.__lang = 'en'; window.tCreate(); });
    await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v.pc.connectionState === 'connected'; }, null, { timeout: 25000 });
    await sleep(2500);
    let s = await S(), d = await delta(2000); const slot0 = s.slot;
    ck('K1', `session up on slot ${s.slot} (${s.pc}): +${d.vPk} video, +${d.aPk} audio packets in 2 s; street MUTED (${s.muted}); mic never asked (G=${s.G}); nothing audible up (+${d.oBy} B, ${d.bpp} B/packet)`,
      s.pc === 'connected' && d.vPk > 0 && d.aPk > 0 && s.muted && s.G === 0 && d.bpp < 15);
    await tap('#snd-btn'); await sleep(800);
    s = await S(); d = await delta(1500);
    ck('K2', `speaker tapped: unmuted (${!s.muted}), playing (${!s.paused}), street arriving (+${d.aPk})`, !s.muted && !s.paused && d.aPk > 0);
    await tap('#snd-btn'); await sleep(300);

    console.log('K3 microphone');
    await tap('#mic-button'); await sleep(2500);
    s = await S(); d = await delta(2000);
    ck('K3', `mic tapped: talk_request sent (${s.posts.includes('talk_request')}), the REAL doorbell granted (${s.rx.includes('talk_granted')}), L=${s.L}, shown open (${s.micShown}), speaker on with it (${s.sndOn})`,
      s.posts.includes('talk_request') && s.rx.includes('talk_granted') && s.L === 1 && s.micShown && s.sndOn && !s.muted);
    ck('K3', `voice goes up: +${d.oPk} packets at ${d.bpp} B/packet in 2 s`, d.oPk > 50 && d.bpp > 30);
    await tap('#mic-button'); await sleep(900);
    s = await S(); d = await delta(1500);
    ck('K4', `mic closed: L=${s.L}, talk_release sent (${s.posts.includes('talk_release')}), nothing audible up (${d.bpp} B/packet), SPEAKER OFF with it (on=${s.sndOn}, muted=${s.muted}), no notice ("${s.status}")`,
      s.L === 0 && s.posts.includes('talk_release') && d.bpp < 15 && !s.sndOn && s.muted);

    console.log('K5 hidden while listening, and back');
    await tap('#snd-btn'); await sleep(500);
    let n = (await S()).rx.length;
    await page.evaluate(() => window.tSetVisible(false)); await sleep(2000);
    s = await S(); d = await delta(3000);
    ck('K5', `hidden: live_pause sent (${s.posts.includes('live_pause')}) and answered (${s.rx.slice(n).includes('live_state')}), picture paused here (${s.paused}); the street REALLY stops (+${d.aPk} audio, +${d.vPk} video packets in 3 s)`,
      s.posts.includes('live_pause') && s.rx.slice(n).includes('live_state') && s.paused && d.aPk === 0 && d.vPk === 0);
    await page.evaluate(() => window.tSetVisible(true)); await sleep(2500);
    s = await S(); d = await delta(2000);
    ck('K5', `back: live_resume (${s.posts.includes('live_resume')}), SAME slot (${s.slot}), street arriving (+${d.aPk}, +${d.vPk}), sounding as it was (on=${s.sndOn}, muted=${s.muted}, paused=${s.paused})`,
      s.posts.includes('live_resume') && s.slot === slot0 && d.aPk > 0 && d.vPk > 0 && s.sndOn && !s.muted && !s.paused);

    console.log('K6 hidden with the mic open, and back');
    await tap('#mic-button'); await sleep(2500);
    const before = await S();
    await page.evaluate(() => window.tSetVisible(false)); await sleep(1200);
    s = await S(); d = await delta(1500);
    ck('K6', `hidden with the mic open (control L=${before.L}): L=${s.L}, nothing audible up (${d.bpp} B/packet), nothing down (+${d.aPk})`, before.L === 1 && s.L === 0 && d.bpp < 15 && d.aPk === 0);
    await page.evaluate(() => window.tSetVisible(true)); await sleep(3500);
    s = await S(); d = await delta(2000);
    ck('K6', `back: turn asked again (${count(s.posts, 'talk_request')} > ${count(before.posts, 'talk_request')}) and granted again (${count(s.rx, 'talk_granted')} > ${count(before.rx, 'talk_granted')}); mic open (L=${s.L}), voice up (${d.bpp} B/packet), still hearing (${s.sndOn})`,
      count(s.posts, 'talk_request') > count(before.posts, 'talk_request') && count(s.rx, 'talk_granted') > count(before.rx, 'talk_granted') && s.L === 1 && d.bpp > 30 && s.sndOn && !s.muted);

    console.log('K7 the signalling is cut under the open microphone');
    for (const p of Array.from(sseOpen)) { p.up.destroy(); p.res.destroy(); }
    await sleep(700);
    s = await S();
    ck('K7', `700 ms after the cut: L=${s.L}, shown open=${s.micShown}`, s.L === 0 && !s.micShown);
    await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v.pc.connectionState === 'connected'; }, null, { timeout: 25000 }).catch(() => {});
    await sleep(1500);
    s = await S(); d = await delta(2000);
    ck('K7', `a new session on the real doorbell (${s.pc}, slot ${s.slot}), street arriving (+${d.aPk}); mic NOT reopened (L=${s.L}, G=${s.G} = ${before.G + 1}); said ("${s.status}"); still hearing (on=${s.sndOn}, muted=${s.muted})`,
      s.pc === 'connected' && d.aPk > 0 && s.L === 0 && s.G === before.G + 1 && !s.micShown && s.status === await T('mic_lost_conn') && s.sndOn && !s.muted);

    console.log('K8 a talk_request that gets no answer');
    await sleep(8500);                         // let the sticky notice leave
    knobs.dropTalkRequest = true;
    const g0 = (await S()).G;
    await tap('#mic-button'); await sleep(3800);
    s = await S();
    ck('K8', `no answer in 3 s: L=${s.L}, getUserMedia never called (G ${g0} -> ${s.G}), not shown open (${!s.micShown}), said ("${s.status}")`,
      s.L === 0 && s.G === g0 && !s.micShown && s.status === await T('talk_noanswer'));
    knobs.dropTalkRequest = false;

    console.log('K9 leaving');
    await page.evaluate(() => window.tReset());
    await sleep(4000);
    const st = await api('/api/get_states');
    const sentBye = (await page.evaluate(() => window.__sent)).includes('bye');
    ck('K9', `card destroyed: bye sent (${sentBye}), the doorbell has no client left (webrtc_clients=${st.webrtc_clients}), not in a call (${JSON.stringify(st.in_call)})`,
      sentBye && st.webrtc_clients === 0 && !(st.in_call && st.in_call.active));
    if (errors.length) ck('ERR', 'page errors: ' + errors.slice(0, 2).join(' | '), false);
    const red = Array.from(new Set(results.filter((r) => !r[1]).map((r) => r[0])));
    console.log(`\n${results.length} checks, ${results.filter((r) => !r[1]).length} red: ${red.join(', ') || '-'}`);
    code = red.length ? 1 : 0;
  } catch (e) {
    console.error('CRASH', e);
  } finally {
    await browser.close();
    server.close();
    try { fs.unlinkSync(wav); } catch (e) { /* */ }
  }
  process.exit(code);
})();
