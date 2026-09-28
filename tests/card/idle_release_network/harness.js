// Test harness for "the video doesn't come back on tapping after releasing on idle", WITHOUT replacing
// startWebRTC(). The one known limit of the sibling harness (test-idle-release-browser) was exactly
// that: it replaced the whole of startWebRTC(), masking the very race that needs measuring.
//
// Here ONLY the network layer is doubled: fetch, EventSource, WebSocket, and the
// hass.connection.sendMessagePromise bridge (Home Assistant's WebSocket to the integration -- there's
// no real Home Assistant possible in this harness, so it's the closest double to "network" that
// exists for that channel). RTCPeerConnection is the browser's REAL class: it gets constructed, has
// transceivers/tracks added to it, and its ICE gathering genuinely runs. It isn't required to reach
// 'connected' -- what this harness measures is the reentrancy/restoration state machine
// (_streamPausedByHide, _connGen, _startInFlightGen, this.pc), not the full SDP negotiation.
//
// _armIdleWakeLockTimer(), startWebRTC(), startNativeSession(), buildNativePeerConnection(),
// tryLocalSignaling(), startRelaySignaling(), _teardownConnectionObjects(), connectedCallback(),
// disconnectedCallback(), and the pointerdown/keydown/visibilitychange/
// IntersectionObserver listeners are ALL real, unmodified code.

window.TESTLOG = [];
function log(msg) {
  const line = `[t+${(performance.now() - window.__t0).toFixed(0)}ms] ${msg}`;
  window.TESTLOG.push(line);
  console.log('TESTLOG ' + line);
}
window.__t0 = performance.now();

// delay=0 resolves via a pure MICROTASK (no setTimeout) -- to be able to run the network as
// fast as the event loop itself allows, and see whether that wins the race against the
// idle clock's own setTimeout(0) on restoring (see CASE 4/5 in the driver).
function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }

// Before 1.10.0 the whole card was one element under the CARD tag; a control run with an old
// build (CARD_FILE=tests/card/fixtures/legacy/...) needs that fallback, or it goes red on a
// missing element instead of on the checks.
const CARD_ELEMENT_TAG = customElements.get('ig-doorbell-view') ? 'ig-doorbell-view' : 'ig-doorbell-card';
const CardClass = customElements.get(CARD_ELEMENT_TAG);
if (!CardClass) log('ERROR: ig-doorbell-card did not register');

// ── Network-double configuration, mutable between tests ──────────────────────────────────────
window.__netCfg = {
  connInfoDelay: 30,       // get_connection_info (HA's WS)
  turnDelay: 30,           // get_turn_credentials (HA's WS)
  turnFail: true,          // no TURN of its own -> STUN only (non-blocking in the real code)
  localSignalUrlDelay: 30, // get_local_signal_url -> null forces the 'direct' path
  esOutcome: 'error',      // 'error' | 'hang' | 'offer'  (the local path's EventSource)
  esDelay: 60,
  wsOutcome: 'open',       // 'open' | 'hang' | 'error'   (the relay's WebSocket)
  wsDelay: 60,
};
window.tSetNetCfg = function (patch) {
  Object.assign(window.__netCfg, patch);
  log('netCfg <- ' + JSON.stringify(patch) + ' => ' + JSON.stringify(window.__netCfg));
};

// ── Doubled fetch: always fails fast (there's no real doorbell to reach from this harness) ────
window.__fetchLog = [];
window.fetch = function (url, opts) {
  window.__fetchLog.push(String(url));
  log(`fetch() [doubled] -> ${url}`);
  return new Promise((_, reject) => setTimeout(() => reject(new TypeError('network error (doubled, offline harness)')), 15));
};

// ── Doubled EventSource: represents LOCAL signaling (SSE) ────────────────────────────────────
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this._closed = false;
    log(`FakeEventSource creado -> ${url}`);
    const c = window.__netCfg;
    if (c.esOutcome === 'hang') return; // never fires anything -- the real code's 3000ms timeout decides
    this._t = setTimeout(() => {
      if (this._closed) return;
      if (c.esOutcome === 'error') {
        log(`FakeEventSource -> onerror (${url})`);
        if (this.onerror) this.onerror(new Event('error'));
      } else if (c.esOutcome === 'offer') {
        log(`FakeEventSource -> onmessage 'offer' (${url})`);
        if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'offer', slot: 0, sdp: 'FAKE-SDP-NOT-VALID' }) });
      }
    }, c.esDelay);
  }
  close() {
    this._closed = true;
    if (this._t) clearTimeout(this._t);
    log(`FakeEventSource.close() -> ${this.url}`);
  }
}
window.EventSource = FakeEventSource;

// ── Doubled WebSocket: represents REMOTE signaling (relay) ──────────────────────────────────
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = null; this.onerror = null; this.onmessage = null; this.onclose = null;
    log(`FakeWebSocket creado -> ${url}`);
    const c = window.__netCfg;
    if (c.wsOutcome === 'hang') return; // never opens or fails -- simulates an unreachable relay/doorbell
    this._t = setTimeout(() => {
      if (this.readyState === 3) return; // already closed (superseded) before the network "arrived"
      if (c.wsOutcome === 'open') {
        this.readyState = 1; // OPEN
        log(`FakeWebSocket -> onopen (${url})`);
        if (this.onopen) this.onopen();
      } else if (c.wsOutcome === 'error') {
        log(`FakeWebSocket -> onerror (${url})`);
        if (this.onerror) this.onerror(new Event('error'));
      }
    }, c.wsDelay);
  }
  send(data) { log(`FakeWebSocket.send -> ${data}`); }
  close() {
    if (this._t) clearTimeout(this._t);
    const wasOpen = this.readyState === 1;
    this.readyState = 3; // CLOSED
    log(`FakeWebSocket.close() -> ${this.url}`);
    if (wasOpen && this.onclose) this.onclose({ code: 1000 });
  }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
window.WebSocket = FakeWebSocket;

// ── Doubled hass: Home Assistant's WS bridge to the ig_doorbell integration ────────

// (1.10.0) The card no longer accepts entities in the YAML: it finds them in HA's registries
// (hass.devices + hass.entities, ig_doorbell platform, by translation_key). This
// harness translates the old options the drivers still use (rec_entity, mode_entity...)
// into the card's doorbell registry entries, which is exactly what the integration publishes.
window.__devices = {};
window.__entities = {};
window.tRegistry = function (deviceId, config) {
  const ha = 'ha-' + deviceId;
  const devices = Object.assign({}, window.__devices);
  const entities = Object.assign({}, window.__entities);
  devices[ha] = { id: ha, name: 'Portero ' + deviceId, identifiers: [['ig_doorbell', deviceId]] };
  const map = { rec_entity: 'rec', mode_entity: 'mode', motion_entity: 'visitor', ring_entity: 'events' };
  for (const k of Object.keys(map)) {
    if (config && config[k]) entities[config[k]] = { entity_id: config[k], device_id: ha, platform: 'ig_doorbell', translation_key: map[k] };
  }
  window.__devices = devices;       // NEW objects: the card caches by identity
  window.__entities = entities;
};

function makeHass() {
  return {
    get devices() { return window.__devices; },
    get entities() { return window.__entities; },
    language: 'en',
    callApi: async () => { throw { status_code: 404 }; },
    connection: {
      sendMessagePromise: async (msg) => {
        const c = window.__netCfg;
        log(`sendMessagePromise(${msg.type})`);
        if (msg.type === 'ig_doorbell/get_connection_info') {
          await sleep(c.connInfoDelay);
          // back_home (1.2.3): this bench plays a configured wall panel - the only page the deadline applies to.
          return { credential: 'FAKE-CRED', relay_ws_url: 'wss://fake-relay.example/ws', back_home: true };
        }
        if (msg.type === 'ig_doorbell/get_turn_credentials') {
          await sleep(c.turnDelay);
          if (c.turnFail) throw { code: 'no_turn' };
          return { urls: [] };
        }
        if (msg.type === 'ig_doorbell/get_local_signal_url') {
          await sleep(c.localSignalUrlDelay);
          return null; // forces the 'direct' path (easier to double than the proxy)
        }
        throw new Error('message not supported by the hass double: ' + msg.type);
      },
    },
  };
}

// ── Harness control ─────────────────────────────────────────────────────────────────────────
window.__cards = {};

window.tCreateCard = function (id, config) {
  const card = document.createElement(CARD_ELEMENT_TAG);
  card.__tid = id;
  card.hass = makeHass();
  window.tRegistry((config && config.device_id) || ('test-device-' + id), config);
  card.setConfig(Object.assign({ device_id: 'test-device-' + id }, config));
  window.__cards[id] = card;
  log(`tCreateCard(${id}) config=${JSON.stringify(config)}`);
  return id;
};

window.tAttach = function (id) {
  document.getElementById('host').appendChild(window.__cards[id]);
  log(`tAttach(${id})`);
};

window.tDetach = function (id) {
  window.__cards[id].remove();
  log(`tDetach(${id})`);
};

window.tTouch = function (id) {
  window.__cards[id].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  log(`tTouch(${id}) -- real pointerdown fired on the card`);
};

window.tState = function (id) {
  const card = window.__cards[id];
  if (!card) return null;
  return {
    hasPc: !!card.pc,
    pcConnState: card.pc ? card.pc.connectionState : null,
    streamPausedByHide: !!card._streamPausedByHide,
    connGen: card._connGen,
    startInFlightGen: card._startInFlightGen,
    reconnecting: !!card._reconnecting,
    isConnected: card.isConnected,
    content: !!card.content,
    idleTimerArmed: !!card._idleWakeLockTimer,
    offscreenTimerArmed: !!card._offscreenTimer,
    wakeLock: !!card._wakeLock,
    videoPaused: card.videoEl ? card.videoEl.paused : null,
    videoHasSrc: card.videoEl ? !!card.videoEl.srcObject : null,
    nativeWS: !!card.nativeWS,
    nativeSSE: !!card.nativeSSE,
  };
};

window.tHide = function (id) {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  log(`tHide(${id}) -- document.visibilityState = 'hidden'`);
};

window.tShow = function (id) {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  log(`tShow(${id}) -- document.visibilityState = 'visible'`);
};

log('harness ready');
