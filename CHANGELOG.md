# Changelog

All notable changes to this integration are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [1.1.1] — unreleased

### Fixed

- **The card no longer puts the call buttons over the picture when there is room beside it.** On a
  phone in landscape with a portrait camera (the Home Assistant app on an iPhone), sound, mic and
  door covered the lower half of a picture that used a quarter of the screen's width - the part
  where a visitor's face is - with a third of the width empty on each side. The buttons now sit in
  a column next to the picture, and on a phone in landscape the doorbell picker, mode, REC, bell,
  Recordings and Quick replies move to a column on the other side, so the picture gets the full
  height (844x390, portrait camera: 146x260 covered -> 177x314 uncovered). Landscape cameras in the
  same kind of space get the same treatment. Buttons stay over the picture only when the picture
  fills the width and there is genuinely no room beside it. Every other layout (portrait phones,
  tablets, wall panels, desktop) is unchanged.

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
