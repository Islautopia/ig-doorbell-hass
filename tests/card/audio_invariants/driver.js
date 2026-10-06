// Real-browser check of 1.5.2: the audio invariants of docs/audio-invariants.md (firmware repo) on the
// card - the audit is docs/audio-audit-card.md.
//
// Loads the REAL card file; ../ui_v1_10_0/harness.js doubles only the network and hass. Chromium's
// fake microphone gives REAL MediaStreamTracks and index.html counts every getUserMedia() call and
// every live track: "microphone open" is the browser's own readyState, never what the card believes.
// The companion WebView's autoplay rule is EMULATED (index.html says why): Iñaki's wall tablet closes it.
//
// CASES (L = live microphone tracks on the page, G = getUserMedia() calls so far)
//   A0  the instrument: a track the bench opens counts 1 and 0 once stopped; the autoplay emulation
//       refuses an unmuted play() on an untouched page and ALLOWS it on a touched one.
//   C1  rule 8 - a ring turns the sound on in a page nobody touched: refused -> the picture keeps
//       playing muted AND one standing control says why, still there 7 s later (until 1.5.1: a 5 s
//       notice, then a mute picture with nothing). One tap on it: the street sounds, the control goes.
//   C1b the same refusal on a NEW stream that arrives while the sound was wanted.
//   C1c positive control: on a page that WAS touched the ring's sound plays and no control appears.
//   C2  rule 6 - the doorbell never answers talk_request: after the deadline L=0 and G=0 (the mic was
//       never even asked for), not shown open, said plainly, turn given back; a second tap asks again
//       (until 1.5.1: the mic opened anyway). Both with and without a session_info seen.
//   C2p positive control: with a talk_granted the mic does open (L=1).
//   C3  rules 5/6/9 - the signalling SSE errors under a live session with the mic open: L=0 within
//       300 ms, not shown open; a new session is started; the mic is NOT reopened by it; the reason
//       is on the status line when the picture returns; whoever was hearing still hears.
//       (until 1.5.1: L=1 for the 20 s of the life watchdog.)
//   C4  contract 1.10 - closing the mic closes the speaker, also when the user was listening BEFORE
//       opening it (until 1.5.1: restored to "as before").
//   C4b a pause with the mic open and back: "the same state" - the turn asked again, and once
//       granted the mic and the sound are as they were.
//   T1  the doorbell takes the turn away: L=0, said, the street still sounds (listen only).
//   T2  talk_denied: L=0 and G=0, said, the street sounds.
//   R1  a ring opens the sound and NEVER the microphone (G=0).
//   H1  hidden while only listening: the <video> is paused HERE (not just asked of the doorbell),
//       live_pause sent; back: live_resume and the sound as it was.
//   N1  rule 8, second half - closing the mic by hand shows no notice about it.
//
// POSITIVE CONTROLS: the same cases against MUTANTS of the card (each must turn its target red on a
// check), and run_all.js runs the whole bench against fixtures/legacy/card_1.5.1.js, which must go
// red on C1, C2, C3 and C4.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const EXE = process.env.PLAYWRIGHT_CHROMIUM_PATH
  || 'C:/Users/inaki/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8797/tests/card/audio_invariants/index.html';
const DIST = path.join(__dirname, '..', '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NL = String.fromCharCode(10);

// Anchors are built with NL, never with an escaped newline: those collapse through shell layers.
const MUTANTS = {
  // the refusal no longer raises the standing control
  MC1: { target: 'C1', a: '    this._soundBlocked = !!blocked;' + NL, b: '    this._soundBlocked = false;' + NL },
  // no answer opens the microphone again (the pre-1.5.2 behaviour)
  MC2: { target: 'C2', a: "      this.sendNativeSignal({ type: 'talk_release' });" + NL + '      this._paintMicState();' + NL + "      this._flashStatusLine('talk_noanswer', 7000);", b: '      this._startTalk();' },
  // the SSE dying under a live session only closes the channel (the pre-1.5.2 behaviour)
  MC3: { target: 'C3', a: "        if (wasLive) { this._scheduleReconnect('the signalling channel dropped under a live session', gen); return; }" + NL, b: '' },
  // closing the mic leaves the speaker as it is
  MC4: { target: 'C4', a: "    if (!keepSound) this._setAudioOn(false, 'mic-closed');" + NL, b: '' },
  // the reason of a mic lost with its session is never said
  MC5: { target: 'C3', a: "      if (this._micLostPending) { this._micLostPending = false; this._sayMicLost(); }" + NL, b: '' },
  // a pause forgets that the street was being heard
  MC6: { target: 'C4b', a: '    if (micOpen) this._stopTalk(true);' + NL + '    this._sendLivePause(true);', b: '    if (micOpen) this._stopTalk();' + NL + '    this._sendLivePause(true);' },
};

function mutate(src, name) {
  src = src.split(String.fromCharCode(13, 10)).join(NL);
  const m = MUTANTS[name];
  const k = src.split(m.a).length - 1;
  if (k !== 1) throw new Error(`mutant ${name}: anchor found ${k} times: ${m.a.slice(0, 60)}`);
  return src.replace(m.a, m.b);
}

async function openPage(browser, body) {
  const ctx = await browser.newContext({ viewport: { width: 700, height: 900 } });
  const page = await ctx.newPage();
  if (body) await page.route(/ig-doorbell-card\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.waitForFunction(() => !!customElements.get('ig-doorbell-card'));
  page.__errors = errors;
  return page;
}

const ev = (page, fn, arg) => page.evaluate(fn, arg);

// What the card shows and what the browser holds, read from the DOM and the tracks - not from the
// card's private fields, so that an older build is judged by the same eyes.
const state = (page) => ev(page, () => {
  const v = window.tView();
  const hear = v.querySelector('#hear-btn');
  const mic = v.querySelector('#mic-button');
  const sl = v.querySelector('#status-line');
  const e = v.videoEl;
  return {
    L: window.tLiveMic(), G: window.__gumCalls,
    micShown: !!(mic && mic.classList.contains('active-talk')),
    micAsking: !!(mic && mic.classList.contains('requesting')),
    listenOnly: !!(mic && mic.classList.contains('listen-only')),
    sndOn: v.querySelector('#snd-btn').classList.contains('on'),
    muted: e.muted, paused: e.paused,
    hear: !!hear && getComputedStyle(hear).display !== 'none',
    status: sl ? sl.textContent : '', warn: !!(sl && sl.classList.contains('warn')),
    sessions: window.__sessions.length,
    posts: window.__posts.map((p) => p.payload && p.payload.type),
  };
});
const text = (page, key) => ev(page, (k) => getLocalText(window.__hass, k), key).catch(() => null);

async function mountLive(page, { stream = true } = {}) {
  await ev(page, () => { window.__lang = 'en'; window.tOnlyOne(); window.tCreate(); });
  await page.waitForFunction(() => { const v = window.tView(); return v && v.pc && v._slot !== null && v._slot !== undefined; }, null, { timeout: 8000 });
  // A real stream with a picture and a tone, as the doorbell's would be, so that play()/muted mean something.
  if (stream) await ev(page, async () => { window.tView().setupRemoteStream(window.tLocalStream()); await new Promise((r) => setTimeout(r, 400)); });
}
// What the DOORBELL says arrives the way it really does: on the signalling SSE.
const fromDoorbell = (page, msg) => ev(page, (m) => {
  const v = window.tView();
  v.nativeSSE.onmessage({ data: JSON.stringify(Object.assign({ slot: v._slot }, m)) });
}, msg);
const tapMic = (page) => ev(page, () => { window.__touched = true; window.tView().querySelector('#mic-button').click(); });
const tapSnd = (page) => ev(page, () => { window.__touched = true; window.tView().querySelector('#snd-btn').click(); });
async function talkOn(page) {
  await tapMic(page);
  await sleep(150);
  await fromDoorbell(page, { type: 'talk_granted' });
  await fromDoorbell(page, { type: 'talk_state', talker: await ev(page, () => window.tView()._slot) });
  await page.waitForFunction(() => window.tLiveMic() === 1, null, { timeout: 5000 }).catch(() => {});
  await sleep(200);
}
const ring = (page) => ev(page, () => {
  const id = Object.keys(window.__states).find((k) => k.startsWith('event.'));
  window.__states[id] = { entity_id: id, state: new Date().toISOString(), attributes: { event_type: 'ring' } };
  window.tTick();
});

const CASES = {
  A0: async (page, check) => {
    const a = await ev(page, async () => { await navigator.mediaDevices.getUserMedia({ audio: true }); return { n: window.tLiveMic(), g: window.__gumCalls }; });
    check('A0', `instrument sees a track the bench opened (L=${a.n}, G=${a.g})`, a.n === 1 && a.g === 1);
    await ev(page, () => window.tStopAllMic());
    const n = await ev(page, () => window.tLiveMic());
    check('A0', `instrument sees it stopped (L=${n})`, n === 0);
    const r = await ev(page, async () => {
      window.__emulateWebViewAutoplay();
      const el = document.createElement('video'); el.srcObject = window.tLocalStream(); el.muted = false; document.body.appendChild(el);
      let refused = false; try { await el.play(); } catch (e) { refused = e.name === 'NotAllowedError'; }
      window.__touched = true;
      let allowed = false; try { await el.play(); allowed = !el.paused; } catch (e) { /* */ }
      window.__touched = false; el.remove();
      return { refused, allowed };
    });
    check('A0', `autoplay emulation: unmuted play() refused untouched (${r.refused}), allowed once touched (${r.allowed})`, r.refused && r.allowed);
  },
  C1: async (page, check) => {
    await ev(page, () => window.__emulateWebViewAutoplay());
    await mountLive(page);
    await ring(page);
    await sleep(900);
    let s = await state(page);
    check('C1', `a ring on an untouched page: picture playing (${!s.paused}) and muted (${s.muted}), the standing control is up (${s.hear}), no "sound on" claim ("${s.status}")`,
      !s.paused && s.muted && s.hear && s.status !== await text(page, 'snd_ring'));
    await sleep(6500);
    s = await state(page);
    check('C1', `7 s later the control is STILL there (${s.hear}); the picture still plays (${!s.paused})`, s.hear && !s.paused);
    await ev(page, () => { window.__touched = true; const b = window.tView().querySelector('#hear-btn'); if (b) b.click(); });
    await sleep(600);
    s = await state(page);
    check('C1', `one tap on it: the street sounds (muted=${s.muted} paused=${s.paused}), speaker shown on (${s.sndOn}), control gone (${!s.hear})`,
      !s.muted && !s.paused && s.sndOn && !s.hear);
    check('C1', `and none of this opened the microphone (L=${s.L} G=${s.G})`, s.L === 0 && s.G === 0);
  },
  C1b: async (page, check) => {
    await ev(page, () => window.__emulateWebViewAutoplay());
    await mountLive(page, { stream: false });
    await ev(page, async () => {
      const v = window.tView();
      v._audioOn = true;                        // the sound was wanted (a ring) when the new stream arrives
      v.setupRemoteStream(window.tLocalStream());
      await new Promise((res) => setTimeout(res, 800));
    });
    await sleep(6000);
    const s = await state(page);
    check('C1b', `a new stream refused while the sound was wanted: plays muted (${!s.paused && s.muted}), the control stands 7 s later (${s.hear})`, !s.paused && s.muted && s.hear);
  },
  C1c: async (page, check) => {
    await ev(page, () => { window.__emulateWebViewAutoplay(); window.__touched = true; });
    await mountLive(page);
    await ring(page);
    await sleep(900);
    const s = await state(page);
    check('C1c', `control: a ring on a TOUCHED page sounds (muted=${s.muted}), no control (${!s.hear}), no mic (G=${s.G})`, !s.muted && !s.paused && !s.hear && s.G === 0);
  },
  C2: async (page, check) => {
    for (const withInfo of [false, true]) {
      await ev(page, () => window.tReset());
      await mountLive(page);
      if (withInfo) await fromDoorbell(page, { type: 'session_info', clients: 1, talker: -1 });
      const tag = withInfo ? 'session_info seen' : 'no session_info ever';
      await tapMic(page);
      await sleep(600);
      let s = await state(page);
      check('C2', `${tag}: turn asked (${s.posts.includes('talk_request')}), waiting shown (${s.micAsking}), nothing captured yet (L=${s.L} G=${s.G})`,
        s.posts.includes('talk_request') && s.micAsking && s.L === 0 && s.G === 0);
      await sleep(3000);
      s = await state(page);
      check('C2', `${tag}: no answer after the deadline -> L=${s.L}, G=${s.G}, shown open=${s.micShown}, turn given back (${s.posts.includes('talk_release')}), said ("${s.status}")`,
        s.L === 0 && s.G === 0 && !s.micShown && !s.micAsking && s.posts.includes('talk_release') && s.status === await text(page, 'talk_noanswer'));
      await tapMic(page);
      await sleep(500);
      s = await state(page);
      check('C2', `${tag}: a second tap asks AGAIN (${s.posts.filter((t) => t === 'talk_request').length} requests) and still opens nothing (L=${s.L} G=${s.G})`,
        s.posts.filter((t) => t === 'talk_request').length === 2 && s.L === 0 && s.G === 0);
    }
  },
  C2p: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const s = await state(page);
    check('C2p', `control: with talk_granted the mic opens (L=${s.L}, shown=${s.micShown}) and the speaker with it (${s.sndOn})`, s.L === 1 && s.micShown && s.sndOn && !s.muted);
  },
  C3: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    const before = await state(page);
    await ev(page, () => { const v = window.tView(); v.nativeSSE.onerror(new Event('error')); });
    await sleep(300);
    let s = await state(page);
    check('C3', `the signalling dropped with the mic open (control L=${before.L}): 300 ms later L=${s.L}, shown open=${s.micShown}`, before.L === 1 && s.L === 0 && !s.micShown);
    // the reconnection's 2 s back-off, then the new offer and its stream; every status text on the way is kept
    const seen = [];
    for (let i = 0; i < 36; i++) { await sleep(100); const t = (await state(page)).status; if (seen[seen.length - 1] !== t) seen.push(t); }
    s = await state(page);
    check('C3', `a NEW session was started (${s.sessions} sessions) and its picture is back; the mic was not reopened by it (L=${s.L} G=${s.G}, shown=${s.micShown})`,
      s.sessions === before.sessions + 1 && s.L === 0 && s.G === before.G && !s.micShown);
    check('C3', `the reason is said once the picture is back, and is still up (status line went: ${JSON.stringify(seen)})`, s.status === await text(page, 'mic_lost_conn'));
    check('C3', `and whoever was in the conversation still HEARS (speaker on=${s.sndOn}, muted=${s.muted})`, s.sndOn && !s.muted);
  },
  C4: async (page, check) => {
    await mountLive(page);
    await talkOn(page);                       // from silence
    await tapMic(page); await sleep(400);
    let s = await state(page);
    check('C4', `mic opened from silence, then closed: L=${s.L}, speaker off (on=${s.sndOn}, muted=${s.muted}), turn released (${s.posts.includes('talk_release')})`,
      s.L === 0 && !s.sndOn && s.muted && s.posts.includes('talk_release'));
    await tapSnd(page); await sleep(300);     // the user listens first...
    const listening = await state(page);
    await talkOn(page);                       // ...then talks...
    await tapMic(page); await sleep(400);     // ...and closes the mic
    s = await state(page);
    check('C4', `listening first (control: on=${listening.sndOn}), mic opened and closed: the speaker closes too (on=${s.sndOn}, muted=${s.muted}), L=${s.L}`,
      listening.sndOn && !s.sndOn && s.muted && s.L === 0);
    await tapSnd(page); await sleep(300);
    s = await state(page);
    check('C4', `and the speaker button still opens it on its own (on=${s.sndOn}, muted=${s.muted}), mic untouched (L=${s.L})`, s.sndOn && !s.muted && s.L === 0);
  },
  C4b: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    await ev(page, () => window.tSetVisible(false));
    await sleep(400);
    let s = await state(page);
    check('C4b', `hidden with the mic open: L=${s.L}, picture paused here (${s.paused}), live_pause (${s.posts.includes('live_pause')}) and talk_release (${s.posts.includes('talk_release')}) sent`,
      s.L === 0 && s.paused && s.posts.includes('live_pause') && s.posts.includes('talk_release'));
    const asked = s.posts.filter((t) => t === 'talk_request').length;
    await ev(page, () => window.tSetVisible(true));
    await sleep(500);
    s = await state(page);
    check('C4b', `back: live_resume (${s.posts.includes('live_resume')}), the turn is asked again (${s.posts.filter((t) => t === 'talk_request').length} > ${asked}), the street sounds as it did (on=${s.sndOn}, muted=${s.muted})`,
      s.posts.includes('live_resume') && s.posts.filter((t) => t === 'talk_request').length === asked + 1 && s.sndOn && !s.muted && !s.paused);
    await fromDoorbell(page, { type: 'talk_granted' });
    await page.waitForFunction(() => window.tLiveMic() === 1, null, { timeout: 5000 }).catch(() => {});
    s = await state(page);
    check('C4b', `granted again: the mic is open again (L=${s.L}, shown=${s.micShown})`, s.L === 1 && s.micShown);
  },
  T1: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    await sleep(1600);                         // past the anti-race grace of a fresh grant
    await fromDoorbell(page, { type: 'talk_state', talker: 3 });
    await sleep(400);
    const s = await state(page);
    check('T1', `the doorbell gave the turn to another client: L=${s.L}, not shown open (${!s.micShown}), said ("${s.status}"), the street still sounds (on=${s.sndOn})`,
      s.L === 0 && !s.micShown && s.listenOnly && s.status === await text(page, 'talk_taken') && s.sndOn && !s.muted);
  },
  T2: async (page, check) => {
    await mountLive(page);
    await tapMic(page); await sleep(150);
    await fromDoorbell(page, { type: 'talk_denied', reason: 'channel_busy' });
    await sleep(400);
    const s = await state(page);
    check('T2', `talk_denied: L=${s.L}, G=${s.G}, not shown open (${!s.micShown}), said ("${s.status}"), listen only with the street on (${s.sndOn})`,
      s.L === 0 && s.G === 0 && !s.micShown && s.status === await text(page, 'talk_denied_msg') && s.sndOn && !s.muted);
  },
  R1: async (page, check) => {
    await mountLive(page);
    await ev(page, () => { window.__touched = true; });
    await ring(page);
    await sleep(700);
    const s = await state(page);
    check('R1', `a ring: the street sounds (on=${s.sndOn}, muted=${s.muted}) and the microphone was never asked for (L=${s.L}, G=${s.G}, shown=${s.micShown})`,
      s.sndOn && !s.muted && s.L === 0 && s.G === 0 && !s.micShown && !s.micAsking);
  },
  H1: async (page, check) => {
    await mountLive(page);
    await tapSnd(page); await sleep(300);
    const before = await state(page);
    await ev(page, () => window.tSetVisible(false));
    await sleep(400);
    let s = await state(page);
    check('H1', `hidden while listening (control: sounding=${before.sndOn && !before.paused}): the picture is paused HERE (${s.paused}), live_pause sent (${s.posts.includes('live_pause')})`,
      before.sndOn && !before.paused && s.paused && s.posts.includes('live_pause'));
    await ev(page, () => window.tSetVisible(true));
    await sleep(500);
    s = await state(page);
    check('H1', `back: live_resume (${s.posts.includes('live_resume')}), sounding as it was (on=${s.sndOn}, muted=${s.muted}, paused=${s.paused}), no mic (G=${s.G})`,
      s.posts.includes('live_resume') && s.sndOn && !s.muted && !s.paused && s.G === 0);
  },
  N1: async (page, check) => {
    await mountLive(page);
    await talkOn(page);
    await tapMic(page); await sleep(400);
    const s = await state(page);
    check('N1', `closing the mic by hand: no notice narrating it (warn=${s.warn}, status="${s.status}")`, !s.warn);
  },
};

async function runCase(browser, name, body) {
  const results = [];
  const check = (id, label, cond) => results.push({ id, label, ok: !!cond });
  const page = await openPage(browser, body);
  try {
    await CASES[name](page, check);
  } catch (e) {
    check(name, `crashed: ${e && e.message}`, false);
  }
  if (page.__errors.length) check(name, `page errors: ${page.__errors.slice(0, 2).join(' | ')}`, false);
  await page.context().close();
  return results;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EXE,
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  let allOk = true;
  const only = process.env.ONLY_CASES ? process.env.ONLY_CASES.split(',') : Object.keys(CASES);
  const override = process.env.CARD_FILE ? fs.readFileSync(process.env.CARD_FILE, 'utf8') : null;
  const real = [];
  for (const name of only) real.push(...await runCase(browser, name, override));
  for (const r of real) console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} [${r.id}] ${r.label}`);
  const bad = real.filter((r) => !r.ok);
  console.log(`\nREAL: ${real.length - bad.length}/${real.length} OK${bad.length ? ' - red: ' + Array.from(new Set(bad.map((r) => r.id))).join(', ') : ''}`);
  if (bad.length) allOk = false;
  if (!process.env.SKIP_MUTANTS && !override) {
    const src = fs.readFileSync(DIST, 'utf8');
    for (const name of Object.keys(MUTANTS)) {
      const m = MUTANTS[name];
      const r = await runCase(browser, m.target, mutate(src, name));
      const caught = r.some((x) => !x.ok && x.id === m.target && !/crashed|page errors/.test(x.label));
      console.log(`=== MUTANT ${name} (must turn ${m.target} red on a check) -> ${caught ? 'OK' : 'NOT CAUGHT'}`);
      if (!caught) { allOk = false; r.forEach((x) => console.log(`      ${x.ok ? 'ok' : 'FAIL'} ${x.label}`)); }
    }
  }
  await browser.close();
  console.log(allOk ? '\nALL OK (real green, every mutant caught)' : '\nFAILED');
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
