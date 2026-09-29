// Harness for the "Live view: simple mode by default, Advanced toggle, no fixed quality chip"
// bench (2026-09-29, spec shared with the iOS/Android apps). Same principle as
// tests/card/ui_v1_9_2/harness.js: only fetch/EventSource/WebSocket and the
// hass.connection.sendMessagePromise bridge get doubled, the NETWORK, never the card's logic -
// setConfig()/render() run for real, on a real DOM, so a real localStorage/CSS-visibility/timer
// bug would show up here exactly as it would in a real browser.

window.TESTLOG = [];
function log(msg) {
  const line = `[t+${(performance.now() - window.__t0).toFixed(0)}ms] ${msg}`;
  window.TESTLOG.push(line);
  console.log('TESTLOG ' + line);
}
window.__t0 = performance.now();

const CARD_ELEMENT_TAG = customElements.get('ig-doorbell-view') ? 'ig-doorbell-view' : 'ig-doorbell-card';
const CardClass = customElements.get(CARD_ELEMENT_TAG);
if (!CardClass) log('ERROR: ig-doorbell-card did not register');

// ── Network double: fails fast, without blocking each test for seconds ─────────────────────
window.fetch = function () {
  return new Promise((_, reject) => setTimeout(() => reject(new TypeError('network error (doubled)')), 10));
};
class FakeEventSource {
  constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; }
  close() {}
}
window.EventSource = FakeEventSource;
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.onopen = null; this.onerror = null; this.onmessage = null; this.onclose = null; }
  send() {}
  close() { this.readyState = 3; }
}
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
window.WebSocket = FakeWebSocket;

// ── Doubled hass: admin role by default (REC's gate), language switchable per test. ────────
window.__states = {};
window.__role = 'admin';
window.tSetRole = function (v) { window.__role = v; };
window.__lang = 'en';
window.tSetLang = function (v) { window.__lang = v; };
window.__devices = {};
window.__entities = {};
window.tRegistry = function (deviceId) {
  const ha = 'ha-' + deviceId;
  const devices = Object.assign({}, window.__devices);
  const entities = Object.assign({}, window.__entities);
  devices[ha] = { id: ha, name: 'Doorbell ' + deviceId, identifiers: [['ig_doorbell', deviceId]] };
  // A 'rec' entity is present on purpose (this bench is ALSO checking the compact REC action -
  // hidden without a real entity, same rule as the header pill, see _updateRecButton()).
  entities['switch.' + deviceId + '_rec'] = { entity_id: 'switch.' + deviceId + '_rec', device_id: ha, platform: 'ig_doorbell', translation_key: 'rec' };
  window.__devices = devices;
  window.__entities = entities;
  window.__states['switch.' + deviceId + '_rec'] = { entity_id: 'switch.' + deviceId + '_rec', state: 'off', attributes: {} };
};

function makeHass() {
  return {
    get devices() { return window.__devices; },
    get entities() { return window.__entities; },
    language: window.__lang,
    callApi: async () => { throw { status_code: 404 }; },
    user: { is_admin: true },
    get states() { return window.__states; },
    formatEntityState: (stateObj, opt) => opt,
    callService: (domain, service, data) => {
      log(`callService(${domain}.${service}, ${JSON.stringify(data)})`);
      return Promise.resolve();
    },
    connection: {
      sendMessagePromise: async (msg) => {
        log(`sendMessagePromise(${msg.type})`);
        if (msg.type === 'ig_doorbell/get_connection_info') {
          return { device_id: 'test-device', role: window.__role, live_timeout_entity: null, events_entity: null };
        }
        if (msg.type === 'ig_doorbell/get_quick_replies') return { quick_replies: [] };
        throw new Error('message not supported by the hass double: ' + msg.type);
      },
    },
  };
}

window.__cards = {};
window.tCreateCard = function (id, config) {
  const deviceId = (config && config.device_id) || ('test-device-' + id);
  window.tRegistry(deviceId);
  const card = document.createElement(CARD_ELEMENT_TAG);
  card.__tid = id;
  card.hass = makeHass();
  card.setConfig(Object.assign({ device_id: deviceId }, config));
  window.__cards[id] = card;
  log(`tCreateCard(${id})`);
  return id;
};
window.tAttach = function (id) {
  document.getElementById('host').appendChild(window.__cards[id]);
  log(`tAttach(${id})`);
};
window.tDestroy = function (id) {
  const card = window.__cards[id];
  if (card && card.parentElement) card.parentElement.removeChild(card);
  delete window.__cards[id];
};
window.tView = function (id) { return window.__cards[id]; };
window.tClick = function (id, selector) {
  const el = window.__cards[id].querySelector(selector);
  if (!el) { log(`tClick(${id}, ${selector}) -- NOT FOUND`); return false; }
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  log(`tClick(${id}, ${selector})`);
  return true;
};
// Whether `selector` is truly visible: exists AND no ancestor (up to the card) is display:none.
// Same criterion as ui_v1_11_0's pageMeasure() ("shown"), reused here on purpose - one definition
// of "visible" for every card bench, not a second one invented for this file.
window.tVisible = function (id, selector) {
  const card = window.__cards[id];
  const el = card && card.querySelector(selector);
  if (!el) return false;
  for (let p = el; p && p !== card; p = p.parentElement) {
    if (getComputedStyle(p).display === 'none') return false;
  }
  return true;
};
window.tText = function (id, selector) {
  const el = window.__cards[id].querySelector(selector);
  return el ? el.textContent : null;
};
// Simulates a quality_state arriving over signalling - white-box, same criterion as
// sim_multicliente.js (which also drives handleNativeSignal-adjacent internals directly): this
// bench is about the UI REACTION to the signal, not about re-proving WebRTC/SSE plumbing that
// other benches (mount_sessions, idle_release_network...) already cover.
window.tQuality = function (id, mode, reason) {
  const view = window.__cards[id];
  view._handleQualityState(reason ? { mode, reason } : { mode });
};
// Simulates entering/leaving fullscreen without the real Fullscreen API (headless Chromium
// without a user gesture would reject requestFullscreen() outright) - _applyFullscreenUI() only
// reads/writes `_fsActive` and paints classes, it never calls the browser API itself (that lives
// in _toggleFullscreen()), so this is a faithful simulation of the STATE, not a shortcut around it.
window.tSetFullscreen = function (id, on) {
  const view = window.__cards[id];
  view._fsActive = !!on;
  view._applyFullscreenUI();
};
window.tRect = function (id, selector) {
  const el = selector ? window.__cards[id].querySelector(selector) : window.__cards[id];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};
// Layout dimension (spec: "layout benches green in both modes, new mode as an extra dimension
// where it matters"): fakes the stream's aspect ratio the same way ui_v1_11_0/ui_v1_10_0 do
// (override _contentSize()), then re-measures.
window.tSetStream = function (id, w, h) {
  window.__cards[id]._contentSize = () => ({ w, h });
};
window.tRefit = function (id) {
  const view = window.__cards[id];
  view._scheduleFit();
};
window.tLayoutInfo = function (id) {
  const view = window.__cards[id];
  const c = view.content;
  const layouts = ['ig-stack', 'ig-side', 'ig-split'].filter((k) => c.classList.contains(k));
  return { layouts, feedH: view.feedWrap.getBoundingClientRect().height, cls: c.className };
};
// Constrains #host's own width (independent of the viewport) to simulate a narrow Sections/
// Masonry column on an otherwise wide screen - the card is `display:block; width:100%`, so its
// own width just follows whatever #host gives it. Pass a falsy value to remove the constraint.
window.tSetHostWidth = function (px) {
  document.getElementById('host').style.width = px ? px + 'px' : '';
};
// Direct reproduction of the "5 buttons in one row" bug (card_simple.png, fixed 2026-09-29,
// canonical layout §4): the round-button row (and the wide Quick-replies row) never get a
// scrollbar - their ancestors either clip with `overflow:hidden` (.feed-wrap) or don't constrain
// width at all - so a row too wide for its box doesn't scroll, it just renders some of its
// children PARTIALLY OUTSIDE that box ("Escuchar"/"Respuestas rápidas" clipped at the edges).
// `scrollWidth` is unreliable here (browsers don't consistently report overflow past a box with
// `overflow: visible`), so this checks actual geometry instead: every visible child of `selector`
// must stay fully within `boundsSelector`'s own rendered box.
window.tRowClipped = function (id, selector, boundsSelector) {
  const card = window.__cards[id];
  const bounds = card && card.querySelector(boundsSelector);
  const row = card && card.querySelector(selector);
  if (!bounds || !row) return false;
  const b = bounds.getBoundingClientRect();
  const items = Array.from(row.children).filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && el.offsetWidth > 0;
  });
  return items.some((el) => {
    const r = el.getBoundingClientRect();
    return r.left < b.left - 0.5 || r.right > b.right + 0.5;
  });
};

log('harness ready');
