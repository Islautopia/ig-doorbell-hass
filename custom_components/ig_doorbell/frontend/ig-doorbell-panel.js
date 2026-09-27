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
    if (this._card) this._card.hass = hass;
  }

  set panel(p) { this._panel = p; }
  set narrow(_n) { /* full-screen either way */ }
  set route(_r) { /* the device comes from the query string */ }

  _deviceId() {
    const q = new URLSearchParams(window.location.search);
    const d = q.get('device');
    if (d) return d;
    // One doorbell only: the page works without the parameter (an iPad bookmark, a kiosk URL).
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
    const host = root.querySelector('.card');
    if (!id) { host.innerHTML = `<div class="none"></div>`; host.firstChild.textContent = tr(this._hass, 'none'); return; }
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
