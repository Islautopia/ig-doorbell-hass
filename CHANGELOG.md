# Changelog

All notable changes to this integration are documented here.

This project follows [Semantic Versioning](https://semver.org/).

---

## [1.5.0] — 2026-10-02

### Added

- **Light, dark and system themes for the card**, the same ones the doorbell's web now has. Same
  palette in both (the card's colors are the web's design tokens, with the card's `--ig-` prefix).
  The default is **System**, which follows Home Assistant's own dark mode (the profile setting), not
  just the operating system; **Light** and **Dark** force one. Pick it from the new theme button
  next to the Advanced button, in the corner of the picture (Advanced view only: simple view stays as
  clean as before). The choice is
  remembered per browser. Whatever is drawn over the camera picture (status chips, the buttons
  floating on the video) stays dark in both themes, as on the web. Translated into English, Spanish,
  French, Italian, German and Portuguese.

## [1.4.5] — 2026-09-30

### Fixed

- **A second Home Assistant with the same name no longer takes the first one's access.** The name a
  Home Assistant pairs with on the doorbell was built from the Home Assistant location name only, so
  two installations both called, say, "Home" and paired with the same administrator account shared
  it: the doorbell reused the slot, and the first Home Assistant silently lost access. New pairings
  now add six characters of Home Assistant's own installation id ("Home Assistant Home 0f1e2d"),
  which is stable across restarts and different on every installation. Doorbells already paired
  keep their current pairing: nothing to redo.

### Changed

- **Moving the notifications is now a question.** A doorbell sends its rings and events to one Home
  Assistant. If it already notifies another Home Assistant, adding it (or re-pairing it) now says so,
  with that Home Assistant's address, and asks for confirmation before moving the notifications
  here. Translated into English, Spanish, French, Italian, German and Portuguese.

## [1.4.4] — 2026-09-30

### Added

- **The card's live view works away from home**, like the mobile apps. When you open Home Assistant
  from outside (Home Assistant Cloud, your own domain…), video and audio cross our relay server
  end-to-end encrypted; at home they still go straight to the doorbell. An **Internet** badge on the
  picture says when the media goes through the internet.

### Fixed

- From outside the home network the card never got a picture: it retried forever with only "No
  connection". It now connects, and when no path works at all it says so ("No video path to the
  doorbell from this network") while it retries.
- The status badge could say **Live** a few seconds into a session that never received a single
  frame.

### Privacy and local-first

- The browser gets a **one-hour relay pass** from the integration (only for logged-in Home
  Assistant users); the doorbell's pairing credential still never leaves Home Assistant. The relay
  forwards encrypted packets it cannot read and stores nothing.
- Nothing at home depends on it: with the internet or our servers down the card connects over your
  network exactly as before, and the integration never waits more than 2.5 s for the pass.

## [1.4.3] — 2026-09-29

First published release since 1.1.2: it also ships everything listed under 1.2.0–1.4.0 below, which were never
released on their own. Needs doorbell firmware **0.103.2** or later for every entity (0.105.1 recommended).

### Added

- **Simple live view in the card**, the default: the picture, Listen, Microphone and Door, and a wide
  **Quick replies** button. The **Advanced** button (sliders icon, next to full screen on the picture) brings
  back the full view: doorbell picker, mode, bell, recordings and REC. The choice is remembered per browser.
- A short notice over the picture when the stream quality changes, and why (slow connection, audio only,
  restored). The permanent quality chip is gone.

### Changed

- The viewers counter and the IG Doorbell logo show in both simple and advanced mode.
- Full screen shows Listen, Microphone, Door and Quick replies.

## [1.4.0] — shipped in 1.4.3

Needs doorbell firmware **0.103.2** (0.103.1 for everything but *In call*). With an older firmware the new
entities show as unavailable and the actions say the firmware is too old.

### Added

- **In call** binary sensor: on from the moment a ring is answered until the conversation ends — the person
  who answered closes the microphone, leaves the live view or sends the app to the background, hangs up, or
  drops, and nobody else takes over within 3 seconds. The doorbell itself reports the end (`call_finished`, a
  new event type), and every poll corrects a lost notice. The last duration and how it ended are attributes.
- **Quick reply** select and **Play quick reply** button. The list comes from the doorbell and follows the
  app; picking one plays nothing, the button plays it.
- **Firmware** update entity, read from the doorbell's own check (never from our servers). "Could not check"
  shows as unknown, never as up to date. Administrator pairings can install; the doorbell downloads and
  verifies the image itself, and the update is reported done only when it runs the new version.
- `ig_doorbell.play_sequence` also takes the quick reply's **name** (`sequence`).

### Changed

- Quick replies, sequences and **Manual recording** use the doorbell's local route for them instead of a
  signalling session. The recording switch now shows exactly what the doorbell records (a call's recording
  too) and turns off by itself when the doorbell stops; it no longer ends when Home Assistant restarts.
- Manual recording is unavailable, not failing, with a user pairing.

## [1.3.0] — shipped in 1.4.3

### Added

- **Snapshot camera.** A still of the street for dashboards, notifications and voice devices. One
  capture every 5 seconds at most, shared by every viewer; none while the doorbell rings (it shows
  the ring's own picture instead), and none of the caller when the doorbell is set to send no
  picture with a ring. No live stream: the live call stays in the card.
- **Ringing** binary sensor, from the ring to its answer, decline or miss (with the outcome and who
  answered). When no answer arrives, the doorbell is asked instead of guessing.
- **The doorbell's settings as entities**, the same the apps change: image (brightness, contrast,
  saturation, hue, black and white, exposure mode and compensation, manual exposure and gain),
  timestamp and its position, detection per class with thresholds and minimum size, lock type,
  door open time, opening from the car, the doorbell's name, and the video streams (disabled by
  default). They need an administrator pairing and show as unavailable with any other.
- **Restart** button (administrator pairings).
- **Mode reason** sensor: why the doorbell is in its mode, and until when.
- **Diagnostics**: SD card state, size and free space; Wi-Fi network and IP address; this pairing's
  role; camera flips (read-only); and, disabled by default, memory, last start, last restart
  reason and microphone gain (read-only).

### Changed

- **Opening the door is now a lock** (`lock.<doorbell>_door`) instead of the *Open door* button,
  which is removed. Home Assistant asks for confirmation before opening. Unlock releases the door
  for the open time set on the doorbell and it reports locked again by itself. Automations that
  pressed `button.<doorbell>_open_door` must call `lock.unlock` (or `lock.open`) instead.
- The privacy sentence: *we never store an image or a sound*. A still or clip that you save in your
  own Home Assistant is your copy.

### Fixed

- Opening the door through a Home Assistant entity could be reported as failed after 8 seconds
  when the doorbell was still waiting (up to ~9 s) for Home Assistant to confirm it.
- The doorbell can no longer be pointed at one of this integration's own entities (its own lock
  would loop back to the doorbell); they are left out of the entity picker and refused if asked.

## [1.2.4] — shipped in 1.4.3

### Fixed

- **An iPad picked as a wall panel was never recognised as one** (so it never went back to the home
  page by itself). Panels were matched by the device model in the browser's user agent, which the
  iPad's companion app does not include. A panel is now recognised by the companion app's own login:
  automatically when its Home Assistant user has only one companion app of that kind, otherwise the
  first time the call page is opened from that panel's own ring notification. A computer, a phone
  or a device that cannot be identified is never treated as a panel.

## [1.2.3] — shipped in 1.4.3

### Fixed

- **Back to the home page applies only to wall panels.** It used to apply wherever the card was
  open: a desktop browser was sent home at the same moment as the wall panel (the same ring
  started both clocks). Now only a page recognised as one of the wall panels picked in *Ring
  notifications* goes back by itself; a computer or a phone is never navigated away. The setting
  is now called *Wall panels: back to the home page after* (`0` = never).
- **After going home once, the panel bounced straight back from the card on every later visit.**
  Every visit to the card now starts the full time again, and so does every touch. The deadline
  never navigates a page the user went to by hand, and a page keeps a single back-home timer even
  with several cards on it.

## [1.2.2] — shipped in 1.4.3

### Fixed

- **Privacy: the microphone could stay open with no call.** Several paths (leaving the view while
  a talk request was pending, the microphone permission answered after the talk was stopped, a
  second start, a failed start, closing the page) could leave a microphone capture running on a
  hidden page. The microphone is now open only during an active talk turn, and a watchdog stops
  (and logs) any microphone left open without one within 2 seconds, at once when the page is hidden.
- **A ring no longer opens a new window on an Android wall panel.** The companion app's command
  opened a new window on every ring (four stacked on a real panel, each with its own video session).
  The page already on screen now navigates to the call page itself; the app's command is only the
  fallback when no page answers.
- **The picture no longer freezes under a "play" button** when a ring turns the sound on in a page
  nobody has touched (a wall panel): the browser refuses sound without a tap, and the video now keeps
  playing muted. Tap the speaker to hear.
- **A visible card never pauses by itself**: the "Back to the home page after" time only takes the
  screen home; a test now proves it past the default 120 s.
- **The call page never shows another doorbell.** `/ig-doorbell?device=<id>` with an unknown id
  showed a different doorbell. It now says "This doorbell isn't set up in Home Assistant", with no
  video and no microphone. The Home Assistant device id is also accepted.

## [1.2.1] — shipped in 1.4.3

### Fixed

- **"Custom element doesn't exist: ig-doorbell-card" on every launch of the installed Home
  Assistant app (or a wall panel), until Ctrl+F5.** Home Assistant's service worker can keep
  serving an old copy of the page that was saved before this integration added the card to it -
  and for the app's start page that copy never expires. The card is now also a Lovelace resource
  (added and kept up to date automatically; removed with the last doorbell), which dashboards load
  fresh each time, and the call page loads the card itself. With dashboards in YAML resource mode
  nothing changes.

## [1.2.0] — shipped in 1.4.3

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
