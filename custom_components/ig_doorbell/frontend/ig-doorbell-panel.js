// The call page (integration 1.2.0, docs/design/ha-only-ringing.md): the doorbell card full-screen
// for ONE doorbell, at /ig-doorbell?device=<device_id>. It is what a ring notification opens and
// what an Android wall panel is sent to, so nobody has to build a dashboard view for it.
//
// It only HOSTS the card: every behaviour (live view, talk, open door, quick replies, the wall-panel
// wake lock and idle pause) is the card's own, so there is exactly one implementation of each.
// The card module is loaded on every page by the integration (card.py, add_extra_js_url).
const PANEL_TAG = 'ig-doorbell-panel';
const TEXTS = {
  en: { close: 'Close', none: 'No doorbell chosen. Open this page from a ring notification.' },
  es: { close: 'Cerrar', none: 'No se ha elegido ningún portero. Abre esta página desde un aviso de timbre.' },
  fr: { close: 'Fermer', none: "Aucune sonnette choisie. Ouvrez cette page depuis une notification d'appel." },
  it: { close: 'Chiudi', none: 'Nessun videocitofono scelto. Apri questa pagina da una notifica di chiamata.' },
  de: { close: 'Schließen', none: 'Keine Türklingel gewählt. Öffne diese Seite über eine Klingel-Benachrichtigung.' },
  pt: { close: 'Fechar', none: 'Nenhuma campainha escolhida. Abra esta página a partir de uma notificação.' },
};

function tr(hass, key) {
  const lang = (hass && hass.language ? hass.language : 'en').substring(0, 2);
  return (TEXTS[lang] || TEXTS.en)[key];
}

class IgDoorbellPanel extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    if (!this._built) this._build();
    if (this._card) {
      // Home Assistant can keep this element when only the query changes (?device=A -> ?device=B):
      // the card follows the URL, never the other way round (1.2.2).
      const id = this._deviceId();
      if (id !== this._builtId) { this._builtId = id; this._eventsId = undefined; this._card.forcedDoorbell = id; }
      this._card.hass = hass;
    }
    this._watchRing(hass);
  }

  // THE IG DOORBELL CHIME WHEN A RING ARRIVES WITH THIS PAGE ALREADY OPEN (1.2.0).
  //
  // Only then, and it is deliberate: when the page was OPENED BY the ring (an Android panel sent here
  // by the notifier, a tap on a notification) the notification has already sounded, and chiming
  // again would ring twice. The case this covers is the page left open on a panel (an iPad in
  // Guided Access): there, nothing else would sound in the house. Played once, never looped.
  // Browsers only let a page play sound after a person has touched it; a kiosk page was touched when
  // it was set up. If the browser refuses, it is logged - never retried in a loop.
  _eventsEntity(hass) {
    if (this._eventsId !== undefined) return this._eventsId;
    const id = this._deviceId();
    let found = null;
    if (id && hass.entities && hass.devices) {
      for (const eid of Object.keys(hass.entities)) {
        const e = hass.entities[eid];
        if (!e || e.platform !== 'ig_doorbell' || !eid.startsWith('event.')) continue;
        const dev = hass.devices[e.device_id];
        // Our doorbell id, or Home Assistant's device id (both accepted by the card, explicitly).
        if (dev && (e.device_id === id || (dev.identifiers || []).some((x) => x && x[0] === 'ig_doorbell' && x[1] === id))) { found = eid; break; }
      }
    }
    this._eventsId = found;
    return found;
  }

  _watchRing(hass) {
    const eid = this._eventsEntity(hass);
    const st = eid && hass.states ? hass.states[eid] : null;
    if (!st) return;
    const marker = String(st.state);
    const prev = this._ringMarker;
    this._ringMarker = marker;
    if (prev === undefined || marker === prev) return;          // first read = what opened the page
    if (!st.attributes || st.attributes.event_type !== 'ring') return;
    if (document.visibilityState !== 'visible') return;
    this._chime();
  }

  _chime() {
    try {
      const a = new Audio('/ig_doorbell/sounds/ig-doorbell-chime.mp3');
      const p = a.play();
      if (p && p.catch) {
        p.then(() => console.info('[ig-doorbell-panel] ring: chime played'))
          .catch((err) => console.warn('[ig-doorbell-panel] ring: the browser did not let the page play the chime', err && err.name));
      }
    } catch (err) {
      console.warn('[ig-doorbell-panel] ring: chime failed', err);
    }
  }

  set panel(p) { this._panel = p; }
  set narrow(_n) { /* full-screen either way */ }
  set route(_r) { /* the device comes from the query string */ }

  // ⚠️ (1.2.2) NEVER A FALLBACK TO ANOTHER DOORBELL. A `device` that is given is passed to the card AS
  // IS, even if it is unknown: the card resolves it explicitly (our doorbell id or Home Assistant's
  // device id) or shows "This doorbell isn't set up in Home Assistant" with no stream and no mic.
  // Until 1.2.1 an unknown id silently showed - and connected to - another doorbell.
  // The only case without the parameter that shows a doorbell is an installation with exactly ONE
  // (an iPad bookmark, a kiosk URL; docs/ring-notifications.md): there is no other one to confuse it
  // with. With two or more, no parameter = the "no doorbell chosen" message.
  _deviceId() {
    const q = new URLSearchParams(window.location.search);
    if (q.has('device')) return (q.get('device') || '').trim() || null;
    const list = (this._panel && this._panel.config && this._panel.config.devices) || [];
    return list.length === 1 ? list[0] : null;
  }

  async _build() {
    this._built = true;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        /* Inside Home Assistant's panel area (right of the sidebar), NOT fixed to the window: a fixed
           page slid under the sidebar and hid the close button (Docker HA, 2026-09-27). */
        :host { display:block; position:relative; height:100vh; height:100dvh; background:#000; color:#fff; }
        .wrap { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
        .card { width:100%; padding:52px 8px 8px; box-sizing:border-box; }
        .close { position:absolute; top:max(12px, env(safe-area-inset-top)); left:12px; z-index:10;
                 background:rgba(0,0,0,.55); color:#fff; border:1px solid rgba(255,255,255,.35);
                 border-radius:20px; padding:8px 16px; font:500 15px system-ui, sans-serif; cursor:pointer; }
        .none { padding:24px; font:16px system-ui, sans-serif; text-align:center; }
      </style>
      <button class="close" type="button"></button>
      <div class="wrap"><div class="card"></div></div>`;
    const btn = root.querySelector('.close');
    btn.textContent = tr(this._hass, 'close');
    btn.addEventListener('click', () => this._leave());
    const id = this._deviceId();
    this._builtId = id;
    const host = root.querySelector('.card');
    if (!id) { host.innerHTML = `<div class="none"></div>`; host.firstChild.textContent = tr(this._hass, 'none'); return; }
    // (1.2.1) The card normally arrives with the page (an extra module in its HTML). That HTML can be
    // a stale copy from Home Assistant's service worker that imports no card at all (card.py): then
    // this would wait forever on a black page - and this page is where a ring sends the wall panel.
    // The panel config comes over the websocket, so its URL is the current one; the same URL as
    // the extra module, so when the page did import it this is the same module and runs nothing.
    const cardUrl = this._panel && this._panel.config && this._panel.config.card_url;
    if (!customElements.get('ig-doorbell-card') && cardUrl) {
      import(cardUrl).catch((err) => console.warn(`[ig-doorbell-panel] could not load the card: ${err && err.message}`));
    }
    await customElements.whenDefined('ig-doorbell-card');
    const card = document.createElement('ig-doorbell-card');
    // The card has no options (1.10.0): the doorbell is given through `forcedDoorbell`, which is
    // not saved, so the dashboard card keeps the owner's own choice.
    card.forcedDoorbell = id;
    card.setConfig({ type: 'custom:ig-doorbell-card' });
    card.hass = this._hass;
    this._card = card;
    host.appendChild(card);
  }

  _leave() {
    // Back to where the person came from; a page opened straight from a notification has no
    // history, so it goes to the default dashboard instead.
    if (window.history.length > 1) { window.history.back(); return; }
    window.history.replaceState(null, '', '/');
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: true } }));
  }
}

if (!customElements.get(PANEL_TAG)) customElements.define(PANEL_TAG, IgDoorbellPanel);
