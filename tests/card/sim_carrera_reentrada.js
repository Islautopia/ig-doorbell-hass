// Isolated simulation of startWebRTC()'s REENTRANCY RACE and the idle clock,
// with no browser, no Home Assistant, no doorbell.
//
//   cd tests/card && npm install && node run_all.js            <- runs this bench and every other one
//   node sim_carrera_reentrada.js <path-to-dist>/ig-doorbell-card.js   (standalone, a single build)
//   node sim_carrera_reentrada.js --controls                          <- what the standalone run needs
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  WHAT IT MEASURES, AND WHY IT CAN'T BE MEASURED BY READING THE CODE
//
//  The bug this chases (measured 2026-09-07 on the living-room tablet) is the kind that CANNOT be seen
//  by reading: three connections opened in 0.3 s after a ring and only the LAST one closed. It depends
//  entirely on the order in which several waits resolve, and that order isn't written anywhere
//  in the file. Here it's reproduced with controlled clocks.
//
//  The REAL dist/ file gets loaded (not a copy) and NOTHING under test gets replaced:
//  startWebRTC, startNativeSession, buildNativePeerConnection, tryLocalSignaling,
//  startRelaySignaling, _teardownConnectionObjects, _superseded and _armIdleWakeLockTimer run
//  exactly as they are in the dist. The only thing replaced is the NETWORK LAYER (WebSocket,
//  EventSource, fetch, RTCPeerConnection, AudioContext, HA's WebSocket) and the UI sheets that
//  have nothing to do with this (painting pills, the mic state, the door).
//
//  ⚠️ PHASE 0 (2026-09-25): the card no longer has a relay or STUN/TURN. Signaling goes ONLY through
//  Home Assistant's proxy (EventSource over the signed URL), so what's counted now is
//  EventSources, not WebSockets. The EventSource double delivers the offer; the race's window
//  is opened by the `get_local_signal_url` wait (before: the TURN credentials). Cases
//  8-13 are the new rules: deadline from the entity, call veto, live_pause -> grace -> bye,
//  tap and ring that resume, and no path outside Home Assistant.
//
//  ⚠️ WHAT THIS IS NOT: it doesn't talk to a doorbell, doesn't negotiate ICE/DTLS, and doesn't prove
//  that, in Chromium, an IntersectionObserver sees what's expected. A green here is NOT "it works on the
//  wallpanel". It's "the reentrancy state machine does what it says it does".
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE CONTROLS, WHICH ARE THE SERIOUS HALF OF THIS FILE (CLAUDE.md: "an instrument with no negative
//  test isn't a weak measurement: it isn't a measurement")
//
//  A bench that always said OK would pass just as well. `--controls` takes it apart from both
//  sides, and EACH control is of the same kind and in the same shape as what's being measured:
//
//   · NEGATIVE CONTROL -- the file from BEFORE the fix (commit 3983f68, never a branch
//     name: see the note in PREVIOUS_COMMIT) has to FAIL cases 1 and 5. If it passed them, this
//     bench wouldn't be seeing the real bug.
//   · POSITIVE CONTROL A -- a mutant whose guard NEVER lets anything through (a `return` on entering
//     startWebRTC) has to FAIL case 2. Without this control, the easiest way to "fix"
//     a buildup of connections would be to never connect at all, and every other case would come out
//     green with the card black forever.
//   · POSITIVE CONTROL B -- a mutant with `_superseded()` always `false` (i.e.: reentrancy guard
//     yes, generation counter no) has to FAIL case 3. This is what
//     proves both pieces are needed and that case 3 genuinely measures the second one.
//   · POSITIVE CONTROL C -- a mutant that reproduces the old bug (a tap updates the
//     mark without rearming the clock) AND ALSO skips the re-check of the absolute deadline has
//     to FAIL case 7, the one about NOT releasing the video while someone is touching. Both mutations
//     are deliberately combined: either one of the two defenses is enough on its own to cover the bug, and
//     with only one of them mutated case 7 would still be green -- meaning the control would distinguish
//     nothing. That both are needed to break it is, in fact, the proof that both defend.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Network-layer doubles. Each one carries its own counter: what's measured is HOW MANY open and
//  how many close, which is exactly the real bug's signature ("of N, one closes").
// ─────────────────────────────────────────────────────────────────────────────────────────────
function buildEnvironment(clock) {
  const census = { ws: [], pc: [], es: [], iceServers: [], fetch: [], nav: [] };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.closed = false;
      this.sent = [];
      census.ws.push(this);
      setTimeout(() => {
        if (this.closed) return;
        this.readyState = 1;
        if (this.onopen) this.onopen();
      }, clock.wsOpenMs);
    }
    send(d) { this.sent.push(d); }
    close() { this.closed = true; this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  }
  FakeWebSocket.OPEN = 1;

  class FakePeerConnection {
    constructor(cfg) { this.cfg = cfg; this.closed = false; this.connectionState = 'new'; census.pc.push(this); census.iceServers.push(cfg && cfg.iceServers); }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=sendrecv' }; }
    async setLocalDescription() {}
    get remoteDescription() { return {}; }
    addTransceiver() { return { direction: 'recvonly', sender: {} }; }
    addTrack(t) { const s = { track: t, replaceTrack: async () => {} }; this._sender = s; return s; }
    getTransceivers() { return [{ sender: this._sender, direction: 'sendrecv' }]; }
    async getStats() { return new Map(); }
    close() { this.closed = true; }
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url; this.closed = false; census.es.push(this);
      // The doorbell assigns a slot and sends the offer as soon as it accepts the SSE (§1.4).
      setTimeout(() => {
        if (this.closed || !this.onmessage) return;
        this.onmessage({ data: JSON.stringify({ type: 'offer', slot: 0, sdp: 'v=0' }) });
      }, clock.esOfertaMs || 5);
    }
    close() { this.closed = true; }
  }

  class FakeAudioContext {
    constructor() { this.closed = false; }
    createMediaStreamDestination() {
      return { stream: { getAudioTracks: () => [{ id: 'muda', stop() {} }] } };
    }
    close() { this.closed = true; }
  }

  return { census, FakeWebSocket, FakePeerConnection, FakeEventSource, FakeAudioContext, startPath: clock && clock.startPath };
}

function loadCardClass(src, environment, docListeners) {
  let CardClass = null;
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    HTMLElement: class {},
    WebSocket: environment.FakeWebSocket,
    EventSource: environment.FakeEventSource,
    RTCPeerConnection: environment.FakePeerConnection,
    IntersectionObserver: class { observe() {} disconnect() {} },
    // The local path's reachability probe: it's rejected, so the local path is abandoned
    // right away and the whole race window ends up governed by `clock.turnMs`, which is what
    // we want to control. (On the real device that window is opened by the TURN request to Germany.)
    fetch: (url) => { environment.census.fetch.push(url); return Promise.reject(new Error('no network in the simulation')); },
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},                       // WITHOUT wakeLock, like the wallpanel's webview
    document: {
      visibilityState: 'visible',
      createElement: () => ({ style: {}, setAttribute() {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} } }),
      addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
      removeEventListener() {},
      body: { classList: { add() {}, remove() {} } },
    },
    window: {
      addEventListener() {}, removeEventListener() {}, AudioContext: environment.FakeAudioContext,
      // 1.2.0: the idle deadline navigates to Home Assistant's default page instead of pausing.
      location: { pathname: environment.startPath || '/ig-doorbell' },
      history: { pushState(st, t, url) { environment.census.nav.push(url); sandbox.window.location.pathname = url; } },
      dispatchEvent() {},
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    customElements: { get: () => undefined, define: (n, c) => { if (n === 'ig-doorbell-view' || (n === 'ig-doorbell-card' && !CardClass)) CardClass = c; } },  // pre-1.10.0 commits (negative control) have no view element: the card IS the view
  };
  sandbox.window.customCards = [];
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  if (CardClass) CardClass.__doc = sandbox.document;   // the visibility cases change visibilityState
  return CardClass;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  A live card without going through setConfig()/render(): same initial state, no DOM.
//  ONLY UI sheets get replaced. None of the connection machinery.
// ─────────────────────────────────────────────────────────────────────────────────────────────
function newCard(CardClass, options) {
  const c = Object.create(CardClass.prototype);
  const o = options || {};
  c.config = { device_id: 'abc' };
  c._hass = {
    connection: {
      sendMessagePromise: (msg) => {
        if (msg.type === 'ig_doorbell/get_connection_info') {
          // Phase 0: no credential or relay; the entities the card reads.
          const info = { device_id: 'abc', live_timeout_entity: o.entityDeadline === undefined ? null : 'number.x_live_view_timeout', events_entity: 'event.x_events' };
          // The BEFORE code (negative control) read these two: they're given to it so it can follow its path.
          info.relay_ws_url = 'wss://relay/ws'; info.credential = 'X';
          return new Promise((r) => setTimeout(() => r(info), o.infoMs || 0));
        }
        // The race window: it used to be opened by the TURN request, today by the signed URL's.
        if (msg.type === 'ig_doorbell/get_turn_credentials' || msg.type === 'ig_doorbell/get_local_signal_url') {
          if (o.turnHung) return new Promise(() => {});   // never resolves: the fuse case
          const r0 = msg.type === 'ig_doorbell/get_turn_credentials' ? { urls: [] } : { signal_url: '/api/ig_doorbell/signal/abc?authSig=x' };
          return new Promise((r) => setTimeout(() => r(r0), o.turnMs || 0));
        }
        if (msg.type === 'frontend/get_user_data') return Promise.resolve({ value: o.defaultPanel ? { default_panel: o.defaultPanel } : null });
        if (msg.type === 'frontend/get_system_data') return Promise.resolve({ value: null });
        return Promise.reject(new Error('unknown'));
      },
    },
    panels: { home: {}, lovelace: {} },
    states: o.entityStates || {},
    callApi: (method, route, requestBody) => { c._enviados.push(requestBody); return Promise.resolve({}); },
  };
  c._enviados = [];
  if (o.entityDeadline !== undefined) c._hass.states['number.x_live_view_timeout'] = { state: String(o.entityDeadline) };
  Object.assign(c, {
    pc: null, nativeSSE: null, nativeWS: null, _slot: null,
    _connGen: 0, _startInFlightGen: null, _startInFlightAt: 0,
    _watchdogTimer: null, _reconnectTimer: null, _reconnectAttempt: 0, _reconnecting: false,
    _lastLifeSignalAt: null, _prevPacketsReceived: null,
    _idleReleaseMs: o.idleMs === undefined ? 0 : o.idleMs,
    _idleWakeLockTimer: null, _wakeLock: null, _fsActive: false,
    _pauseState: null, _pauseGraceTimer: null, _idleGraceMs: o.graceMs === undefined ? 15000 : o.graceMs,
    _livePauseWanted: false, _livePauseAck: null, _rescueTimers: [],
    _talkHeld: false, _talkPending: false,
    talkActive: false, localAudioStream: null, dummyAudioTrack: null,
    _audioOn: false, _audioOnBeforeMic: false, _listenOnly: false,
    isConnected: true, content: true,
  });
  // UI sheets: none of this takes part in the race or the clock.
  c._mark = () => {};
  c._flashStatusLine = () => {};
  c._resetStatusLine = () => {};
  c._setLiveState = () => {};
  c._paintMicState = () => {};
  c._updateMotionPill = () => {};
  c._resetMulticlientState = () => {};
  c._disarmDoorConfirm = () => {};
  c._clearDoorWait = () => {};
  c._setAudioOn = () => {};
  c._stopAudioSendDiagnostics = () => {};
  c._startRetryCountdown = () => {};
  c._stopRetryCountdown = () => {};
  c._reportPairingRejected = () => {};
  c._probeQualitySupport = () => {};
  c._setDoorLabel = () => {};
  c._acquireWakeLock = async () => {};        // there's no navigator.wakeLock, same as on the tablet
  c._releaseWakeLock = () => {};
  // _registerIdleActivityListeners is NOT replaced: case 7 depends on the real interaction
  // handler existing, which is the path the bug came in through. Only the element's own
  // addEventListener gets a double.
  c.addEventListener = () => {};
  c.removeEventListener = () => {};
  c._registerUnloadHandler = () => {};
  c._sueltas = [];
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Collects a card at the end of a case WITHOUT assuming the new functions exist: the controls
// also run the old code, and there a missing method must show up as a case in red,
// not take down the whole bench.
function cleanup(c) {
  for (const f of ['_cancelPause', '_teardownConnectionObjects', '_clearIdleWakeLockTimer']) {
    if (typeof c[f] === 'function') { try { c[f](); } catch (err) { /* collected */ } }
  }
}

// The BEFORE code (negative control) handles offers from already-superseded sessions on a null `pc`
// and rejects promises nobody's waiting on. That's part of the bug the control must SEE through its effect
// (accumulated connections), not a reason for the whole bench to crash without reporting.
let unhandledRejections = 0;
process.on('unhandledRejection', (e) => { unhandledRejections += 1; if (process.env.SIM_DEBUG) console.error('REJECTION', e); });

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  The cases
// ─────────────────────────────────────────────────────────────────────────────────────────────
async function runCases(src, verbose) {
  const failures = [];
  const docListeners = {};
  const environment = buildEnvironment({ wsOpenMs: 5 });
  const CardClass = loadCardClass(src, environment, docListeners);
  if (!CardClass) return { failures: ['could not capture the class'], total: 0 };

  let total = 0;
  const check = (label, cond) => {
    total += 1;
    if (!cond) failures.push(label);
    if (verbose) console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`);
  };
  const section = (t) => { if (verbose) console.log(`\n== ${t} ==`); };

  const aliveCount = (list) => list.filter((x) => !x.closed).length;

  // ── 1. THE MEASURED BUG ─────────────────────────────────────────────────────────────────────
  // Three triggers in 0.3 s (a ring: visibilitychange + render + connectedCallback) with the
  // TURN request taking 400 ms. Before the fix: 3 WebSockets open, 1 closed.
  section('1. Three startups in 0.3s after a ring (the measured bug)');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 400 });
    c.startWebRTC('visibilitychange');
    await wait(140);
    c.startWebRTC('render');
    await wait(160);
    c.startWebRTC('connectedCallback');
    await wait(900);
    check(`EventSources ALIVE = 1 (opened ${e.census.es.length}, alive ${aliveCount(e.census.es)})`, aliveCount(e.census.es) === 1);
    check(`RTCPeerConnection ALIVE = 1 (created ${e.census.pc.length}, alive ${aliveCount(e.census.pc)})`, aliveCount(e.census.pc) === 1);
    check('  -> and the one that stays alive is the one the card holds in this.nativeSSE', c.nativeSSE && !c.nativeSSE.closed);
    c._teardownConnectionObjects();
  }

  // ── 2. NO-BLOCKING CONTROL: a lone startup HAS to connect ─────────────────────────────────
  // Without this, "connections don't pile up" would also be satisfied by a card that never connects.
  section('2. A normal startup DOES connect (no-blocking control)');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 20 });
    await c.startWebRTC('sole');
    await wait(200);
    check('there is a live session: pc assigned and not closed', !!c.pc && !c.pc.closed);
    check('there is an EventSource through Home Assistant\'s proxy, open', !!c.nativeSSE && !c.nativeSSE.closed && c.nativeSSE.url.startsWith('/api/ig_doorbell/signal/'));
    check('  -> and the offer was answered through the proxy', c._slot === 0 && c._enviados.some((m) => m.type === 'answer' && m.slot === 0));
    c._teardownConnectionObjects();
  }

  // ── 3. SUPERSESSION DURING A WAIT (this is what the generation counter measures) ──────────
  // The reentrancy guard does NOT cover this case: here the old startup has been torn down
  // out from under it (what _scheduleReconnect does), so the new one rightfully gets through. What stops the
  // leak is that the old one, on waking up, realizes it and closes its own.
  section('3. Teardown while a startup is waiting (generation counter)');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 400 });
    c.startWebRTC('the one that will be superseded');
    await wait(120);
    c._teardownConnectionObjects();          // exactly what _scheduleReconnect() does
    c.startWebRTC('the replacement');
    await wait(900);
    check(`EventSources ALIVE = 1 (opened ${e.census.es.length}, alive ${aliveCount(e.census.es)})`, aliveCount(e.census.es) === 1);
    check(`RTCPeerConnection ALIVE = 1 (created ${e.census.pc.length}, alive ${aliveCount(e.census.pc)})`, aliveCount(e.census.pc) === 1);
    check('  -> the replacement DID stay connected (the guard did not eat it)', !!c.nativeSSE && !c.nativeSSE.closed);
    c._teardownConnectionObjects();
  }

  // ── 4. FUSE: a stuck startup can't leave the card black forever ───────────────────────────
  section('4. A stuck startup gets superseded by the fuse, it never blocks forever');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const options = { turnHung: true };
    const c = newCard(C, options);
    c.startWebRTC('the one that hangs');
    await wait(50);
    check('while it is young, a second trigger is discarded', c._startInFlightGen !== null);
    c.startWebRTC('too soon');
    await wait(50);
    check('  -> and it has not opened any extra connection', e.census.es.length === 0);
    // The marker is aged instead of waiting 12 s of real clock time: what's tested is the fuse's
    // rule, not setTimeout's punctuality.
    c._startInFlightAt = Date.now() - 60000;
    // And the network comes back: if the supersession also got stuck, this check could NEVER
    // pass and would be an impossible case disguised as a test -- the kind that reads as a product bug.
    options.turnHung = false;
    c.startWebRTC('after the fuse');
    await wait(200);
    check('past the fuse, a new trigger DOES start', !!c.nativeSSE && !c.nativeSSE.closed);
    c._teardownConnectionObjects();
  }

  // ── 5. THE IDLE CLOCK EXISTS WITHOUT wakeLock ─────────────────────────────────────────────
  // The sandbox's `navigator` has NO `wakeLock`, and the card never enters fullscreen:
  // exactly the wallpanel where v1.5.0/v1.5.1/v1.6.0 all three failed.
  section('5. The idle clock arms with no wake lock and no fullscreen');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 300 });
    await c.startWebRTC('sole');
    await wait(100);
    check('there is a countdown armed with the session running', !!c._idleWakeLockTimer);
    c._teardownConnectionObjects();
    if (c._idleWakeLockTimer) clearTimeout(c._idleWakeLockTimer);
  }

  // ── 6. AND IT FIRES: without touching anything, it goes HOME (1.2.0) ───────────────────────
  // Iñaki, 2026-09-27: while the card is visible there is ALWAYS a stream; the deadline takes the
  // screen back to Home Assistant's default page, and leaving the card is what stops the stream.
  section('6. With no interaction, the deadline takes the screen home -- and does NOT cut the stream');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 250, graceMs: 50, defaultPanel: 'dashboard-casa' });
    await c.startWebRTC('sole');
    await wait(600);
    check("it navigated to the user's default page", e.census.nav.length === 1 && e.census.nav[0] === '/dashboard-casa');
    check('  -> the session is still alive (the deadline no longer pauses)', !!c.pc && !c.pc.closed && !c._pauseState);
    check('  -> and no live_pause was sent by the deadline', !c._enviados.some((m) => m.type === 'live_pause'));
    cleanup(c);
  }
  section('6b. On the default page itself it stays (never a navigation loop); with no setting, "home"');
  {
    const e = buildEnvironment({ wsOpenMs: 5, startPath: '/home/overview' });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 200, graceMs: 50 });
    await c.startWebRTC('sole');
    await wait(500);
    check('on /home (the built-in default) it does not navigate', e.census.nav.length === 0);
    check('  -> and keeps its stream', !!c.pc && !c.pc.closed && !c._pauseState);
    cleanup(c);
    const e2 = buildEnvironment({ wsOpenMs: 5, startPath: '/ig-doorbell' });
    const C2 = loadCardClass(src, e2, {});
    const c2 = newCard(C2, { turnMs: 10, idleMs: 200, graceMs: 50 });
    await c2.startWebRTC('sole');
    await wait(500);
    check('from the call page with no setting it goes to /home', e2.census.nav.length === 1 && e2.census.nav[0] === '/home');
    cleanup(c2);
  }

  // ── 7. NO-FIRE CONTROL: while touching, it can NEVER release ──────────────────────────────
  // This is the more important of the clock's two controls: cutting the video for someone who's
  // watching is a worse bug than leaving the screen on for too long.
  section('7. With periodic taps it NEVER releases (no-fire control)');
  {
    const e = buildEnvironment({ wsOpenMs: 5 });
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 250 });
    await c.startWebRTC('sole');
    check('the real interaction handler is registered', typeof c._onIdleActivity === 'function');
    // One touch every 100 ms with a 250 deadline, via the REAL PATH: it fires the same
    // `_onIdleActivity` the card registers, not `_armIdleWakeLockTimer` by hand. The difference isn't
    // cosmetic -- it's exactly where the bug lived (a tap updated the mark without rearming), and
    // calling the timer directly would leave the case with nothing to detect.
    // If there's no handler (the code from before the fix never registers one) the loop is skipped:
    // the case has already marked it as a failure above, and crashing here would take down the rest
    // of the bench -- an instrument that crashes doesn't report, and in a control that reads as "it doesn't break".
    for (let i = 0; c._onIdleActivity && i < 12; i += 1) {
      await wait(100);
      c._onIdleActivity();
    }
    // ⚠️ OPEN SESSIONS ARE COUNTED, THE FINAL STATE IS NOT LOOKED AT, and that difference is the whole
    // case. The first version checked `!!c.pc` at the end, and that was also passed by a card
    // that releases the video midway and restores it on the next tap: `pc` exists again, the
    // check comes out green, and the user still saw a black box. By counting how many
    // sessions have actually been built, "it released and came back" can no longer be disguised as "it never
    // released". (Found precisely because the mutant further below was passing this case.)
    check(`after 1.2s of taps with a 0.25s deadline it did NOT release even once (sessions built: ${e.census.pc.length})`, e.census.pc.length === 1 && e.census.es.length === 1);
    check('  -> the session is still alive', !!c.pc && !c.pc.closed);
    check('  -> and it was not marked as released', !c._pauseState);
    // Phase 0: expiring no longer hangs up right away (live_pause + grace), so "it paused and the
    // next tap resumed it" leaves no trace in pc/sessions. It shows up in what was sent to the doorbell.
    check('  -> and not a single live_pause was sent', !(c._enviados || []).some((m) => m.type === 'live_pause'));
    check('  -> and it never navigated away', e.census.nav.length === 0);
    c._teardownConnectionObjects();
    if (c._idleWakeLockTimer) clearTimeout(c._idleWakeLockTimer);
  }

  // ══ PHASE 0 ═══════════════════════════════════════════════════════════════════════════════
  // ── 8. The deadline is set by the integration's entity ────────────────────────────────────
  section('8. The deadline comes from number.*_live_view_timeout (and 0 disables it)');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, entityDeadline: 0.25, graceMs: 20000 });
    await c.startWebRTC('sole');
    await wait(500);
    check('with the entity at 0.25 s it expires even if the fallback is 999 s', e.census.nav.length === 1);
    cleanup(c);
    const c2 = newCard(C, { turnMs: 10, idleMs: 250, entityDeadline: 0 });
    await c2.startWebRTC('sole');
    await wait(500);
    check('  -> and with the entity at 0 it never expires (no navigation, stream on)', e.census.nav.length === 1 && !c2._pauseState && !!c2.pc);
    cleanup(c2);
  }

  // ── 9. Never with a call in progress ───────────────────────────────────────────────────────
  section('9. With the mic open it NEVER expires (§1.4-bis: never pause during a call)');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 250, graceMs: 50 });
    await c.startWebRTC('sole');
    c.talkActive = true;
    await wait(800);
    check('with the mic open for 0.8 s and a 0.25 s deadline: neither pause nor bye', !c._pauseState && !!c.pc && !c.pc.closed);
    check('  -> and it does NOT go home during an answered call', e.census.nav.length === 0);
    check('  -> and no live_pause was sent', !c._enviados.some((m) => m.type === 'live_pause'));
    c.talkActive = false;
    cleanup(c);
  }

  // ── 10. On expiry: live_pause RIGHT AWAY, bye after grace (the slot is released) ───────────
  section('10. The pause machinery (by hand since 1.2.0): live_pause right away and bye after the grace period');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 0, graceMs: 300 });
    await c.startWebRTC('sole');
    const pc = c.pc;
    await wait(150);
    if (c._pause) c._pause('idle');   // 1.2.0: no deadline pauses any more; the machinery, by hand
    await wait(200);
    check('within the grace period: live_pause sent and the session is still alive', c._enviados.some((m) => m.type === 'live_pause' && m.slot === 0) && c.pc === pc && !pc.closed);
    check('  -> still no bye', !c._enviados.some((m) => m.type === 'bye'));
    await wait(400);
    check('past the grace period: bye sent (the slot is released right away, not after 20 s)', c._enviados.some((m) => m.type === 'bye' && m.slot === 0));
    check('  -> session closed and EventSource closed', c.pc === null && e.census.es.every((x) => x.closed));
    check('  -> and the card is left paused, waiting for a tap', !!c._pauseState && c._pauseState.phase === 'hung_up');
  }

  // ── 11. A tap within the grace period resumes the SAME session ───────────────────────────
  section('11. A tap within the grace period: live_resume, no new session');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, graceMs: 2000 });   // listeners on, never fires
    await c.startWebRTC('sole');
    await wait(150);
    if (c._pause) c._pause('idle');
    check('it is in the grace period', !!c._pauseState && c._pauseState.phase === 'grace');
    if (c._onIdleActivity) c._onIdleActivity();
    await wait(50);
    check('after the tap: live_resume sent', c._enviados.some((m) => m.type === 'live_resume'));
    check('  -> the same session, no new one', e.census.pc.length === 1 && !!c.pc && !c.pc.closed);
    check('  -> and no bye', !c._enviados.some((m) => m.type === 'bye'));
    cleanup(c);
  }

  // ── 12. A ring wakes up the hung-up card; a package doesn't ─────────────────────────────────
  section('12. A ring (event_type ring) after hanging up: new session; a package does not');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 0, graceMs: 50 });
    c.config.ring_entity = undefined;
    c._hass.states['event.x_events'] = { state: 't0', attributes: { event_type: 'ring' } };
    await c.startWebRTC('sole');
    c._updateRingState();                       // first read: doesn't fire
    await wait(100);
    if (c._pause) c._pause('idle');
    await wait(400);
    check('hung up due to inactivity', !!c._pauseState && c._pauseState.phase === 'hung_up' && c.pc === null);
    c._hass.states['event.x_events'] = { state: 't1', attributes: { event_type: 'package' } };
    c._updateRingState();
    await wait(100);
    check('a package does NOT wake it up', !!c._pauseState && c._pauseState.phase === 'hung_up' && e.census.pc.length === 1);
    c._hass.states['event.x_events'] = { state: 't2', attributes: { event_type: 'ring' } };
    c._updateRingState();
    await wait(60);
    check('a ring DOES: new session', !c._pauseState && e.census.pc.length === 2 && !!c.pc);
    cleanup(c);
  }

  // ── 13. No path outside Home Assistant ───────────────────────────────────────────────────
  section('13. No STUN/TURN, no relay, no fetch to the doorbell: only Home Assistant');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10 });
    await c.startWebRTC('sole');
    await wait(100);
    check('RTCPeerConnection with no iceServers', e.census.iceServers.length === 1 && Array.isArray(e.census.iceServers[0]) && e.census.iceServers[0].length === 0);
    check('  -> no WebSocket at all', e.census.ws.length === 0);
    check('  -> no direct fetch', e.census.fetch.length === 0);
    check('  -> and the SSE is the one from HA\'s proxy', e.census.es.every((x) => x.url.startsWith('/api/ig_doorbell/')));
    cleanup(c);
  }

  // ══ IÑAKI'S RULE 2026-09-25: OFF-SCREEN, PAUSE; ON RETURN, IN THE SAME STATE ═══════════════
  const ocultar = (C, c, v) => { C.__doc.visibilityState = v; c._onVisibilityForStream && c._onVisibilityForStream(); };

  // ── 14. Hiding: live_pause RIGHT AWAY, session alive; returning: live_resume, the same session ──
  section('14. Hidden -> live_pause right away; visible -> live_resume on the same session');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, graceMs: 5000 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    await c.startWebRTC('sole');
    await wait(80);
    const pc = c.pc;
    ocultar(C, c, 'hidden');
    await wait(30);
    check('on hiding: live_pause sent right away and the session continues', c._enviados.some((m) => m.type === 'live_pause') && c.pc === pc && !pc.closed);
    check('  -> no bye yet', !c._enviados.some((m) => m.type === 'bye'));
    ocultar(C, c, 'visible');
    await wait(30);
    check('on returning: live_resume, same session, no new one', c._enviados.some((m) => m.type === 'live_resume') && c.pc === pc && e.census.pc.length === 1);
    cleanup(c); C.__doc.visibilityState = 'visible';
  }

  // ── 15. Hidden WITH a call: pauses, but never hangs up; on return the turn is requested again ──
  section('15. Hidden with the mic open: live_pause, no bye; on return, talk_request');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, graceMs: 100 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    c._stopTalk = function () { this.talkActive = false; this._talkHeld = false; };
    c._requestTalkTurn = function () { this.sendNativeSignal({ type: 'talk_request' }); };
    await c.startWebRTC('sole');
    await wait(80);
    c.talkActive = true; c._talkHeld = true;
    ocultar(C, c, 'hidden');
    await wait(400);
    check('with a call: live_pause and NO bye past the grace period', c._enviados.some((m) => m.type === 'live_pause') && !c._enviados.some((m) => m.type === 'bye') && !!c.pc);
    ocultar(C, c, 'visible');
    await wait(30);
    check('  -> on returning: live_resume and the turn is requested again (same state)', c._enviados.some((m) => m.type === 'live_resume') && c._enviados.some((m) => m.type === 'talk_request'));
    cleanup(c); C.__doc.visibilityState = 'visible';
  }

  // ── 16. Hidden with no call: after the grace period, bye (the slot is released) ─────────────
  section('16. Hidden with no call: bye after the grace period');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, graceMs: 100 });
    c._registerVisibilityStreamHandler && c._registerVisibilityStreamHandler();
    await c.startWebRTC('sole');
    await wait(80);
    ocultar(C, c, 'hidden');
    await wait(300);
    check('with no call: bye past the grace period', c._enviados.some((m) => m.type === 'bye') && c.pc === null);
    ocultar(C, c, 'visible');
    await wait(80);
    check('  -> and on returning, a new session', e.census.pc.length === 2 && !!c.pc && !c._pauseState);
    cleanup(c); C.__doc.visibilityState = 'visible';
  }

  // ── 17. The loop measured on the tablet: re-inserting the paused card does NOT open a session ──
  section('17. connectedCallback on a doorbell paused for inactivity: it does not start');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 0, graceMs: 50 });
    await c.startWebRTC('sole');
    await wait(100);
    if (c._pause) c._pause('idle');
    await wait(300);
    check('hung up due to inactivity', !!c._pauseState && c._pauseState.phase === 'hung_up');
    const displayBefore = e.census.pc.length;
    const c2 = newCard(C, { turnMs: 10, idleMs: 150, graceMs: 50 });   // Home Assistant recreates the element
    c2._registerFullscreenListeners = () => {}; c2._registerVisibilityStreamHandler = () => {}; c2._registerOffscreenStreamHandler = () => {};
    c2.connectedCallback();
    c.connectedCallback && (c._registerFullscreenListeners = () => {}, c._registerVisibilityStreamHandler = () => {}, c._registerOffscreenStreamHandler = () => {}, c.connectedCallback());
    await wait(200);
    check('neither the reinserted card nor a recreated one opens a session', e.census.pc.length === displayBefore && !!c2._pauseState);
    cleanup(c); cleanup(c2);
  }

  // ── 18. A recent ring wakes up a freshly created card (its "first read") ───────────────────
  section('18. A ring from 5 s ago on the first read of a paused card: it wakes it up');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 0, graceMs: 50 });
    await c.startWebRTC('sole');
    await wait(100);
    if (c._pause) c._pause('idle');
    await wait(300);
    const c2 = newCard(C, { turnMs: 10, idleMs: 150, graceMs: 50 });
    c2._connInfo = { events_entity: 'event.x_events' };
    c2._hass.states['event.x_events'] = { state: new Date(Date.now() - 5000).toISOString(), attributes: { event_type: 'ring' } };
    c2._restoreSavedPause && c2._restoreSavedPause();
    const displayBefore = e.census.pc.length;
    c2._updateRingState();
    await wait(60);
    check('new card while paused + recent ring: new session', e.census.pc.length === displayBefore + 1 && !c2._pauseState);
    cleanup(c); cleanup(c2);
  }

  // ── 19. Switching Lovelace views removes the card from the DOM: pause, and on return the SAME element
  section('19. disconnectedCallback -> live_pause (no bye); connectedCallback -> live_resume, same session');
  {
    const e = buildEnvironment({});
    const C = loadCardClass(src, e, {});
    const c = newCard(C, { turnMs: 10, idleMs: 999000, graceMs: 5000 });
    c._registerFullscreenListeners = () => {};
    await c.startWebRTC('sole');
    await wait(80);
    const pc = c.pc;
    c.disconnectedCallback();
    await wait(30);
    check('taken out of the DOM: live_pause and the session continues (no bye)', c._enviados.some((m) => m.type === 'live_pause') && !c._enviados.some((m) => m.type === 'bye') && c.pc === pc);
    c.connectedCallback();
    await wait(30);
    check('  -> reinserted: live_resume on the same session', c._enviados.some((m) => m.type === 'live_resume') && c.pc === pc && e.census.pc.length === 1);
    cleanup(c);
  }

  return { failures, total };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
//  Guarded substitution: the anchor appears exactly once or it ABORTS (CLAUDE.md).
//  Without this, a mutant whose anchor doesn't match would come out identical to the original -- and then the
//  positive control would say "the mutant fails just like the good one... so it passes", silently.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The dist file is saved with Windows line endings and `git show` delivers them with Unix ones. Without
// this, any anchor spanning more than one line NEVER matches against the file on disk -- and
// the only thing that kept that from going unnoticed was `mutate()`'s guard: without it, a mutant
// whose anchor doesn't match comes out IDENTICAL to the original, i.e. a positive control that controls nothing and
// that on top of that says OK.
const normalizeLineEndings = (t) => t.split('\r\n').join('\n');

function mutate(src, anchor, replacement, mutantLabel) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) throw new Error(`mutant "${mutantLabel}": the anchor appears ${n} times, not 1 - ABORTED`);
  return src.replace(anchor, replacement);
}

(async () => {
  const arg = process.argv[2];
  const distPath = path.join(__dirname, '..', '..', 'custom_components', 'ig_doorbell', 'frontend', 'ig-doorbell-card.js');

  if (arg && arg !== '--controls') {
    const r = await runCases(fs.readFileSync(arg, 'utf8'), true);
    console.log(r.failures.length === 0 ? `\nALL OK (${r.total} checks)\n` : `\n${r.failures.length} FAILED CHECK(S)\n`);
    process.exit(r.failures.length === 0 ? 0 : 1);
  }

  // ⚠️ CRLF -> LF ON READ. The dist file is saved with Windows line endings and `git show`
  // delivers them with Unix ones. Without normalizing, mutant anchors spanning more than one
  // line NEVER match -- and `mutate()` loudly aborts, which is what happened the first time. Without
  // `mutate()`'s guard they would have passed as mutants... identical to the original, i.e. positive
  // controls that control nothing.
  const src = normalizeLineEndings(fs.readFileSync(distPath, 'utf8'));
  let bad = 0;

  console.log('\n############ THE REAL FILE ############');
  const goodRun = await runCases(src, true);
  if (goodRun.failures.length) { console.log(`\n${goodRun.failures.length} FAILURES in the current dist`); bad += 1; }
  else console.log(`\nALL OK (${goodRun.total} checks)`);

  console.log('\n############ CONTROLS ############');

  // ── NEGATIVE CONTROL: the file from before the fix has to FAIL ───────────────────────────
  // ⚠️ A COMMIT, NEVER A BRANCH NAME -- and this already cost us once (2026-09-07). The first
  // version said `main:dist/...`, and this repo's working tree is shared by several agents:
  // while the fix was being written, another branch change made the fix's commit end up ON
  // main. The negative control then compared the fixed file against itself, came out green, and
  // said "the old code didn't accumulate connections" -- exactly the opposite verdict from what was measured.
  // A control validated against a moving reference validates nothing. 3983f68 is the last commit
  // BEFORE this fix and it will never move.
  // Since 1.0.0 that build is a FIXTURE (tests/card/fixtures/legacy/card_3983f68.js, translated to
  // today's names by fixtures/make_legacy.js): the card's git history stayed in its old repository.
  // A fixed file is the same guarantee as a commit - it never moves.
  const PREVIOUS_COMMIT = '3983f68';
  let previousSrc = null;
  try {
    previousSrc = normalizeLineEndings(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy', `card_${PREVIOUS_COMMIT}.js`), 'utf8'));
  } catch (err) {
    console.log(`  WARNING: could not read the ${PREVIOUS_COMMIT} fixture - the NEGATIVE control did not run.`);
    console.log('         Without it, this bench is NOT validated: it could be saying OK without looking at anything.');
    bad += 1;
  }
  if (previousSrc) {
    // An exception is a failure, never a pass by default.
    let r;
    try { r = await runCases(previousSrc, false); } catch (err) { r = { failures: ['exception: ' + err.message], total: 0 }; }
    const seesLeak = r.failures.some((f) => f.startsWith('EventSources ALIVE'));
    const seesClock = r.failures.some((f) => f.startsWith('there is a countdown armed'));
    console.log(`  ${seesLeak ? 'OK  ' : 'FAIL'} negative control: the code from before the fix ACCUMULATES connections (case 1)`);
    console.log(`  ${seesClock ? 'OK  ' : 'FAIL'} negative control: the code from before the fix does NOT arm the clock (case 5)`);
    if (!seesLeak || !seesClock) {
      console.log(`         failures observed in the old code: ${JSON.stringify(r.failures)}`);
      bad += 1;
    }
  }

  // ── POSITIVE CONTROLS: each mutant has to break EXACTLY its own case ─────────────────────
  const mutants = [
    {
      mutantLabel: 'the guard never lets anything through (card black forever)',
      src: () => mutate(src,
        "    const inFlight = this._startInFlightGen;",
        "    return; const inFlight = this._startInFlightGen;",
        'total guard'),
      mustFail: 'there is a live session',
    },
    {
      mutantLabel: 'generation counter disabled (_superseded always false)',
      src: () => mutate(src,
        '  _superseded(gen) { return gen !== this._connGen; }',
        '  _superseded(gen) { return false; }',
        'no generation'),
      mustFail: 'EventSources ALIVE',
    },
    {
      mutantLabel: 'the tap does not rearm (the old bug) AND no re-check of the deadline',
      src: () => {
        // ⚠️ A SINGLE-LINE ANCHOR WITH NOT ONE BACKSLASH, and it's not a style choice: the first
        // version of this mutant carried an escaped newline inside the anchor, and that
        // escape collapsed into a real newline when crossing a shell layer -- exactly the
        // landmine CLAUDE.md already had written down. It broke the file visibly, which is the
        // lucky outcome; the dangerous failure mode is the silent one, an anchor that stops matching and a
        // substitution that does nothing without saying so. Hence `mutate()`'s guard.
        let m = mutate(src,
          '      this._armIdleWakeLockTimer(true);',
          '      /* mutante: el toque actualiza la marca pero NO rearma, como antes del arreglo */',
          'tap that does not rearm');
        return mutate(m,
          '      if (remainingMs > 0) {',
          '      if (false) {',
          'no re-check');
      },
      // Phase 0: expiring no longer releases right away, it pauses (live_pause) and the next tap resumes it;
      // case 7 sees this in what was sent to the doorbell.
      // 1.2.0: expiring navigates home, so case 7 sees it as a navigation away.
      mustFail: '  -> and it never navigated away',
    },
    {
      mutantLabel: 'phase 0: the deadline ignores the entity',
      src: () => mutate(src, "    if (Number.isFinite(v) && v >= 0) return v * 1000;", "    if (false) return v * 1000;", 'no entity'),
      mustFail: 'with the entity at 0.25 s',
    },
    {
      mutantLabel: 'phase 0: no call veto',
      src: () => mutate(src, "    return !!(this.talkActive || this._talkHeld || this._talkPending);", "    return false;", 'no veto'),
      mustFail: '  -> and it does NOT go home during an answered call',
    },
    {
      mutantLabel: 'phase 0: on expiry it hangs up with no live_pause or grace period',
      src: () => mutate(src, "    if (!inCall) this._pauseGraceTimer = setTimeout(() => this._hangUpPaused(), this._idleGraceMs);", "    if (!inCall) { this._hangUpPaused(); return; }", 'no grace period'),
      mustFail: 'within the grace period',
    },
    {
      mutantLabel: 'phase 0: the grace period never hangs up (the slot never releases)',
      src: () => mutate(src, "    this._teardownConnectionObjects();    // sends `bye`", "    // mutante", 'no bye'),
      mustFail: 'past the grace period',
    },
    {
      mutantLabel: 'phase 0: the ring does not wake it up',
      src: () => mutate(src, "    if (this._pauseState && document.visibilityState === 'visible') this._resume('ring');", "", 'no ring'),
      mustFail: 'a ring DOES',
    },
    {
      mutantLabel: 'phase 0: the VPS STUN server comes back',
      src: () => mutate(src, "    const iceServers = [];", "    const iceServers = [{ urls: 'stun:46.225.57.138:3478' }];", 'with stun'),
      mustFail: 'RTCPeerConnection with no iceServers',
    },
    {
      mutantLabel: 'Iñaki\'s rule: hiding tears down again right away (1.9.0)',
      src: () => mutate(src, "      if (document.visibilityState === 'hidden') {", "      if (document.visibilityState === 'hidden') { this._teardownConnectionObjects(); return;", 'tears down on hide'),
      mustFail: 'on hiding: live_pause sent',
    },
    {
      mutantLabel: 'Iñaki\'s rule: it also hangs up during a call',
      src: () => mutate(src, "    if (!inCall) this._pauseGraceTimer = setTimeout(", "    if (true) this._pauseGraceTimer = setTimeout(", 'hangs up with a call'),
      mustFail: 'with a call: live_pause and NO bye',
    },
    {
      mutantLabel: 'Iñaki\'s rule: returning does not recover the turn',
      src: () => mutate(src, "      if (p.micOpen) this._requestTalkTurn();", "", 'no turn'),
      mustFail: '  -> on returning: live_resume and the turn is requested again',
    },
    {
      mutantLabel: 'the tablet loop: the pause lives only in `this` again',
      src: () => mutate(src, "    if (!this.config || !PAUSED_BY_DOORBELL[this.config.device_id]) return false;", "    if (!this.config || !this._pauseState) return false;", 'pause per instance'),
      mustFail: 'neither the reinserted card nor a recreated one',
    },
    {
      mutantLabel: 'switching views tears down again (1.9.0)',
      // A ONE-line anchor with no backslashes (CLAUDE.md): the first version carried an escaped
      // newline that a shell layer turned into a real one and broke this file.
      src: () => mutate(src, "    this._pause('hidden');                     // leaving the DOM = pausing, not tearing down", "    this._teardownConnectionObjects();", 'tears down on leaving the DOM'),
      mustFail: 'taken out of the DOM: live_pause',
    },
    {
      mutantLabel: 'a recent ring ignored on the first read',
      src: () => mutate(src, "        && Date.now() - Date.parse(marker) < RECENT_RING_MS", "        && false", 'no recent ring'),
      mustFail: 'new card while paused + recent ring',
    },
  ];

  for (const m of mutants) {
    let r;
    try { r = await runCases(m.src(), false); } catch (err) {
      console.log(`  FAIL positive control: ${m.mutantLabel} -> ${err.message}`);
      bad += 1;
      continue;
    }
    const breaks = r.failures.some((f) => f.startsWith(m.mustFail));
    console.log(`  ${breaks ? 'OK  ' : 'FAIL'} positive control: "${m.mutantLabel}" breaks the case it should`);
    if (!breaks) {
      console.log(`         expected a failure starting with "${m.mustFail}"; observed: ${JSON.stringify(r.failures)}`);
      bad += 1;
    }
  }

  console.log(bad === 0 ? '\nBENCH GREEN AND VALIDATED FROM BOTH SIDES\n' : `\n${bad} PROBLEM(S) (check: a failed control invalidates the whole bench)\n`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error("EXCEPTION in the bench (not a green run):", e); process.exit(2); });
