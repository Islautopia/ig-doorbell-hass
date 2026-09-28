# Changelog

All notable changes to this integration are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [1.2.1] — unreleased

### Fixed

- **"Custom element doesn't exist: ig-doorbell-card" on every launch of the installed Home
  Assistant app (or a wall panel), until Ctrl+F5.** Home Assistant's service worker can keep
  serving an old copy of the page that was saved before this integration added the card to it -
  and for the app's start page that copy never expires. The card is now also a Lovelace resource
  (added and kept up to date automatically; removed with the last doorbell), which dashboards load
  fresh each time, and the call page loads the card itself. With dashboards in YAML resource mode
  nothing changes.

## [1.2.0] — unreleased

### Added

- **Ring notifications without any automation.** In the integration's options, *Ring
  notifications*: pick the phones and wall panels that have the Home Assistant app, and they ring
  when someone presses the bell - with the visitor's picture, a button to open the call, and
  optionally one to open the door. When the call is answered, declined or missed they are cleared
  everywhere, a missed call is left as a quiet "Missed call at 16:13", and Android wall panels wake
  up showing the doorbell. Off until you pick a device.
  Guide: docs/ring-notifications.md. Needs doorbell firmware 0.101.3 to clear the notifications
  when the call is answered; with older firmware they ring but are not cleared.
- **Speakers announce the call** (optional, off by default): Echo speakers play Alexa's doorbell
  chime, and other speakers play the new IG Doorbell chime. They can also say which doorbell is ringing.
- **The live view timeout becomes "Back to the home page after".** While the card is on screen the
  video stays on; it stops as soon as the card leaves the screen. After the set time with nobody
  touching it, the screen goes back to Home Assistant's default page. For an unanswered call the time
  counts from the ring; it never happens during an answered call, and never on the default page
  itself. `0` = never. Your existing value is kept.
- **Call page** at `/ig-doorbell?device=<id>`: the doorbell full-screen, what the notifications
  open. Not in the sidebar; no dashboard to build.
- **Visitor picture** entity (`image`): the picture of the last ring, kept in memory only and
  respecting the doorbell's "photo in call notices" setting.
- The events entity also reports **call answered / declined / missed** (firmware 0.101.3), with who
  answered when known.

### Fixed

- **A doorbell that is off when Home Assistant starts no longer breaks the integration.** Its
  requests timed out with an error nobody caught, the integration ended in "failed to set up" and
  stayed that way until reloaded by hand - so no ring would have reached Home Assistant.
- The event names are now translated in French, German and Portuguese too.

## [1.1.2] — 2026-09-27

### Fixed

- **The card no longer shows "Configuration error" when a dashboard opens.** On some page loads -
  most of them over HTTPS, where Home Assistant's service worker serves the card from cache - the
  whole card was replaced by Home Assistant's red "Configuration error" until a hard reload
  (Ctrl+F5). The card was being registered before Home Assistant finished setting up the page, and
  Home Assistant then could not find it. It now registers again once Home Assistant is ready, so
  it appears on every load, cached or not.

## [1.1.1] — 2026-09-27

### Changed

- **Six languages, the same as the IG Doorbell apps: English, Spanish, French, Italian, German and
  Portuguese.** Italian is new across the integration, the card and the HTTPS setup page. Chinese,
  Russian, Hindi and Arabic are no longer offered; a Home Assistant set to a language that is not
  one of the six shows the integration in English.

### Fixed

- **HTTPS no longer switches itself off.** An options form left open from before HTTPS was turned
  on could, when submitted, turn it back off and interrupt the certificate being fetched. If the
  setting has changed since the form was opened, the form now shows the current value and asks you
  to check it and submit again.
- **The public name recovers by itself.** After a failure that can pass on its own (the cloud or
  the doorbell unreachable, a slow certificate), it is retried after 30 s, 1, 2, 5, 15 and 30
  minutes, then every hour. A repair appears only if it is still failing after an hour; HTTPS and
  the local address keep working throughout.
- **Opening the card no longer shows two viewers on the doorbell for a few seconds.** When you left
  the dashboard and came back shortly after, the previous view kept its paused connection until
  it timed out; it is now closed as soon as the new view connects.
- **The card no longer puts the call buttons over the picture when there is room beside it.** On a
  phone in landscape with a portrait camera, sound, mic and door covered the lower half of the
  picture - where a visitor's face is - with a third of the width empty on each side. The buttons
  now sit in a column next to the picture, and on a phone in landscape the doorbell picker, mode,
  REC, bell, Recordings and Quick replies move to a column on the other side, so the picture gets
  the full height. Landscape cameras in the same kind of space get the same treatment. Buttons stay
  over the picture only when it fills the width and there is no room beside it. Every other layout
  (portrait phones, tablets, wall panels, desktop) is unchanged.

## [1.1.0] — 2026-09-27

### New: secure local connection (HTTPS) — off by default

Turn it on in **Configure → Secure local connection (HTTPS)**. Home Assistant is then also served
over HTTPS on your home network, on a port of its own (8443 by default), so browsers let the card
use the microphone. Home Assistant's own port and settings are not touched. It is local: it is
not remote access and does not replace one. Full details: [docs/https.md](docs/https.md).

- **Two addresses on one port.** A **public name** (`<id>.ha.doorbell.islautopia.com`) with a
  certificate every device trusts, available when an IG Doorbell paired as administrator vouches
  for this Home Assistant; and the **local address** (IP or `homeassistant.local`), with a
  certificate from the integration's own local certificate authority, which works with no internet
  and no doorbell.
- **The private keys never leave Home Assistant.** For the public name only a certificate request
  is sent; the voucher is asked of the doorbell over the local network. The local path never
  contacts our servers.
- **The local root can only vouch for private addresses and local names** (X.509 name
  constraints), so its key is useless against any other website.
- **Setup page** at `/ig_doorbell/https`, translated, with each device's steps (an iPhone/iPad
  profile, Android, computers), a QR code to continue on the phone, and a **Check** button.
- **Repairs** when the port is taken, when the doorbell cannot vouch (guest pairing, not
  registered, older firmware), or when another Home Assistant holds the doorbell's name (with a
  button to move it here).
- Home Assistant sees each device's real address through the secure port: no proxy, nothing to
  add to `trusted_proxies`, login protections unchanged.

### Card

- **The microphone explains itself.** On a page that is not secure, tapping the microphone used to
  do nothing; it now says why and links to the setup page (with a QR code on a computer), or, if
  HTTPS is off, to the option that turns it on. The talk turn is not taken in that case.

---

## [1.0.0] — 2026-09-26

First release of **IG Doorbell for Home Assistant**: the integration and its dashboard card in one
install.

- Pairing from the doorbell's discovery or its IP, with the administrator password used once and
  never stored; nothing is left half-configured if a step fails.
- Local only: Home Assistant reaches the doorbell at its address on your network, never through
  the internet.
- Entities: Events, Visitor, Package at the door, Mode, Open door, Manual recording, Viewers, Live
  view timeout, and diagnostics. Urgent notices arrive over a local webhook.
- Up to 5 Home Assistant entities the doorbell may switch, as its door or in its sequences.
- Actions to play the doorbell's sequences and quick replies at the street.
- The card, loaded automatically: every doorbell in one card, live video and two-way audio with a
  shared talk turn, door with confirmation, mode, recording, recordings, quick replies and the
  doorbell's notices, in nine languages.
