// Harness for the v1.10.0 real-browser check: zero-config card + live doorbell switcher.
//
// Loads the REAL dist/ file (index.html) and builds the card exactly as Home Assistant does
// (`custom:ig-doorbell-card`, the SHELL element, which then creates one
// `ig-doorbell-view` per doorbell). Only the network and hass are doubled:
//   - hass.devices / hass.entities / hass.states: two doorbells of our integration, like the real
//     registries (identifiers ['ig_doorbell', id], entities with platform + translation_key);
//   - hass.connection.sendMessagePromise: get_connection_info / get_local_signal_url /
//     get_quick_replies, with a per-doorbell delay so a LATE answer from the old doorbell can be
//     staged after the switch;
//   - EventSource (the local signalling SSE through the integration proxy): a FAKE DOORBELL per
//     device that hands out slots and sends a REAL SDP offer (made by a second RTCPeerConnection in
//     this page), so the card's real buildNativePeerConnection/handleNativeSignal run;
//   - hass.callApi POST (answer/candidate/bye to the proxy): recorded per doorbell and slot.
// RTCPeerConnection is Chromium's real class (wrapped only to COUNT which ones are still open).
// ICE never connects (no real doorbell), so "live" is forced with the card's own _setLiveState()
// where a test needs a doorbell that is streaming -- the thing under test is the SWITCH.

window.TESTLOG = [];
window.__t0 = performance.now();
function log(msg) {
  const line = `[t+${(performance.now() - window.__t0).toFixed(0)}ms] ${msg}`;
  window.TESTLOG.push(line);
}

// ---- doorbells ---------------------------------------------------------------------------------
window.__db = {
  aaaa1111: { name: 'Ermita 10', role: 'admin', connDelay: 20, sse: 'offer', sseDelay: 60, available: true, qr: [{ id: 1, name: 'Ahora bajo' }] },
  bbbb2222: { name: 'Waveshare', role: 'user', connDelay: 20, sse: 'offer', sseDelay: 60, available: true, qr: [{ id: 7, name: 'Déjelo en la puerta' }] },
};
window.tDb = function (id, patch) { Object.assign(window.__db[id], patch); window.tRebuild(); };
window.tOnlyOne = function () { delete window.__db.bbbb2222; window.tRebuild(); };

window.__lang = 'es';
window.tRebuild = function () {
  const devices = {}; const entities = {}; const states = {};
  for (const id of Object.keys(window.__db)) {
    const d = window.__db[id];
    const ha = 'ha-' + id;
    devices[ha] = { id: ha, name: d.name, name_by_user: null, identifiers: [['ig_doorbell', id]], disabled_by: null };
    const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const add = (eid, tk, state, attrs) => {
      entities[eid] = { entity_id: eid, device_id: ha, platform: 'ig_doorbell', translation_key: tk };
      states[eid] = { entity_id: eid, state: d.available ? state : 'unavailable', attributes: attrs || {} };
    };
    add(`select.${slug}_mode`, 'mode', 'normal', { options: ['normal', 'away', 'do_not_disturb'] });
    add(`switch.${slug}_rec`, 'rec', 'off');
    add(`event.${slug}_events`, 'events', '2026-09-26T10:00:00.000+00:00', { event_type: 'ring' });
    add(`binary_sensor.${slug}_visitor`, 'visitor', 'off');
  }
  // an unrelated device of another integration, to prove the filter
  devices['ha-other'] = { id: 'ha-other', name: 'Lampara', identifiers: [['hue', 'x']] };
  window.__devices = devices; window.__entities = entities; window.__states = states;
};
window.tRebuild();

// ---- fake doorbells: sessions ------------------------------------------------------------------
window.__sessions = [];      // { dev, slot, sse, closed, bye }
window.__posts = [];
const slotNext = {};
let offerSdp = null;
async function realOffer() {
  if (offerSdp) return offerSdp;
  const pc = new window.__RealPC();
  pc.addTransceiver('video', { direction: 'sendonly' });
  pc.addTransceiver('audio', { direction: 'sendrecv' });
  const o = await pc.createOffer();
  pc.close();
  offerSdp = o.sdp;
  return offerSdp;
}
function devFromUrl(url) { const m = /signal\/([^/?]+)/.exec(String(url)); return m ? m[1] : null; }

class FakeEventSource {
  constructor(url) {
    this.url = url; this.onmessage = null; this.onerror = null; this._closed = false;
    const dev = devFromUrl(url);
    const cfg = window.__db[dev] || { sse: 'error', sseDelay: 10 };
    const slot = slotNext[dev] = (slotNext[dev] === undefined ? 0 : slotNext[dev] + 1);
    this._sess = { dev, slot, closed: false, bye: false };
    window.__sessions.push(this._sess);
    log(`SSE open ${dev} slot=${slot}`);
    if (cfg.sse === 'hang') return;
    this._t = setTimeout(async () => {
      if (this._closed) return;
      if (cfg.sse === 'error') { if (this.onerror) this.onerror(new Event('error')); return; }
      const sdp = await realOffer();
      if (this._closed) return;
      if (this.onmessage) this.onmessage({ data: JSON.stringify({ type: 'offer', slot, sdp }) });
    }, cfg.sseDelay);
  }
  close() { this._closed = true; this._sess.closed = true; if (this._t) clearTimeout(this._t); log(`SSE close ${this._sess.dev} slot=${this._sess.slot}`); }
}
window.EventSource = FakeEventSource;
window.fetch = () => Promise.reject(new TypeError('network (doubled)'));

// "open at the doorbell" = its SSE is still open and no bye for its slot arrived
window.tOpenSessions = function () {
  return window.__sessions.filter((s) => !s.closed && !s.bye).map((s) => `${s.dev}#${s.slot}`);
};

// ---- RTCPeerConnection: real, only counted -----------------------------------------------------
window.__RealPC = window.RTCPeerConnection;
window.__pcs = [];
window.RTCPeerConnection = class extends window.__RealPC {
  constructor(...a) { super(...a); window.__pcs.push(this); }
};
window.tOpenPcs = function () { return window.__pcs.filter((p) => p.signalingState !== 'closed').length; };

// ---- hass --------------------------------------------------------------------------------------
window.__calledServices = [];
function makeHass() {
  return {
    get language() { return window.__lang; },
    get devices() { return window.__devices; },
    get entities() { return window.__entities; },
    get states() { return window.__states; },
    user: { is_admin: true },
    formatEntityState: (st, opt) => opt,
    callService: (domain, service, data) => { window.__calledServices.push({ domain, service, data }); return Promise.resolve(); },
    callApi: async (method, path, payload) => {
      const dev = devFromUrl(path);
      window.__posts.push({ dev, payload });
      if (payload && payload.type === 'bye') {
        const s = window.__sessions.find((x) => x.dev === dev && x.slot === payload.slot);
        if (s) s.bye = true;
        log(`POST bye ${dev} slot=${payload.slot}`);
      }
      return {};
    },
    connection: {
      sendMessagePromise: async (msg) => {
        const d = window.__db[msg.device_id];
        if (msg.type === 'ig_doorbell/get_connection_info') {
          if (!d) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
          await new Promise((r) => setTimeout(r, d.connDelay));
          log(`connInfo ${msg.device_id} role=${d.role}`);
          const slug = d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
          // back_home (1.2.3): the integration's answer to "is this page a configured wall panel?".
          // A bench that needs a panel sets window.__backHomeFor(login, msg); by default no page is one.
          // (1.2.4) The integration knows the page by its companion LOGIN, not by anything the card
          // says: here the window's own user agent stands for that login (never msg.ua, which the
          // card no longer sends); msg.panel_nonce is the one thing the card hands over.
          return { device_id: msg.device_id, role: d.role, live_timeout_entity: null, events_entity: `event.${slug}_events`,
            back_home: window.__backHomeFor ? !!window.__backHomeFor(navigator.userAgent, msg) : false };
        }
        if (msg.type === 'ig_doorbell/get_local_signal_url') {
          return { signal_url: `/api/ig_doorbell/signal/${msg.device_id}?authSig=fake` };
        }
        if (msg.type === 'ig_doorbell/get_quick_replies') return { quick_replies: d ? d.qr : [] };
        if (msg.type === 'ig_doorbell/get_turn_credentials') throw new Error('no turn');
        if (msg.type === 'history/history_during_period') return { [msg.entity_ids[0]]: [] };
        throw new Error('unsupported: ' + msg.type);
      },
    },
  };
}
window.__hass = makeHass();

// ---- card helpers ------------------------------------------------------------------------------
window.tCard = null;
window.tCreate = function (config) {
  const card = document.createElement('ig-doorbell-card');
  let err = null;
  try { card.setConfig(config || { type: 'custom:ig-doorbell-card' }); } catch (e) { err = String(e); }
  card.hass = window.__hass;
  document.getElementById('host').appendChild(card);
  window.tCard = card;
  return err;
};
window.tView = function () { return window.tCard ? window.tCard.querySelector('ig-doorbell-view') : null; };
window.tViews = function () { return document.querySelectorAll('ig-doorbell-view').length; };
window.tTick = function () { window.tCard.hass = window.__hass; };
window.tPick = function (id) {
  const v = window.tView();
  v.querySelector('#db-pill').click();
  const opt = v.querySelector(`.db-opt[data-id="${id}"]`);
  if (!opt) return false;
  opt.click();
  return true;
};
window.tPicker = function () {
  const v = window.tView();
  if (!v) return null;
  return {
    device: v.config.device_id,
    name: v.querySelector('#db-name').textContent,
    dot: v.querySelector('#db-dot').dataset.state,
    live: v.querySelector('#live-tag').dataset.state,
    chevron: v.querySelector('#db-chev').style.display !== 'none',
    title: v.querySelector('#db-pill').getAttribute('title'),
    menuOpen: v.querySelector('#db-menu').style.display !== 'none',
  };
};
window.tReset = function () {
  // Destroy (hang up) every view first: just removing them would PAUSE them (bye after 15 s) and
  // their sessions would leak into the next test's counts.
  document.querySelectorAll('ig-doorbell-view').forEach((v) => { try { v._destroy('test reset'); } catch (e) { /* */ } });
  document.getElementById('host').innerHTML = '';
  window.__sessions = []; window.__posts = [];
  try { localStorage.clear(); } catch (e) { /* */ }
};
log('harness ready');
