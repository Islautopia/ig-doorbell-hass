# IG Doorbell for Home Assistant

The Home Assistant integration **and** dashboard card for the **Islautopia Garage Doorbell**
(IG Doorbell), a video doorbell that keeps your video and audio on your own hardware.

One install from HACS gives you:

- the doorbell as a **Home Assistant device**, with entities and events for your automations;
- a **live view card** with two-way audio, door control, recordings and the doorbell's notices,
  which needs no resource, no YAML and no options;
- optionally, a **secure local connection (HTTPS)** for your Home Assistant, so browsers on your
  home network let the card use the microphone.

---

## Before you start: two-way audio needs HTTPS

Browsers only let a web page use the microphone when the page is served securely (HTTPS). This
affects one thing only: talking back through the card. Video, sound, the door, recordings and
automations all work regardless.

- **Already reach Home Assistant over HTTPS** — Home Assistant Cloud (Nabu Casa), or your own
  domain behind a reverse proxy? **Nothing to do.** The card already gets the microphone on that
  address.
- **Open Home Assistant as `http://…`, at home or on a wall tablet?** Turn on this integration's
  own **Secure local connection (HTTPS)** (Configure → Secure local connection (HTTPS)). It is
  **not** remote access and does not replace Home Assistant Cloud or a reverse proxy — it only
  adds a secure address on your home network. It offers two ways in: a **public name** that needs
  no install on any device but requires an IG Doorbell paired here as administrator and
  registered with the Islautopia cloud to vouch for it, and a **local address** from the
  integration's own certificate authority that needs its root installed once per device but works
  with no doorbell and no internet at all.

Step-by-step instructions with screenshots for iPhone/iPad, Android, Windows, macOS and wall
tablets: **[docs/two-way-audio.md](docs/two-way-audio.md)**. Full reference (what our cloud sees,
routers, troubleshooting): **[docs/https.md](docs/https.md)**.

---

## What it does, and what it does not do

**It does:**

- Talk to the doorbell **only over your home network**, at its local address.
- Show the live view **away from home too**: when you open Home Assistant from outside (Home
  Assistant Cloud, your own domain…), the card's video and audio cross through our relay server,
  end-to-end encrypted, exactly like the mobile apps. At home it goes straight to the doorbell.
- Turn what the doorbell reports (a ring, a visitor, a parcel, the door opened, a key refused…)
  into Home Assistant events and entities, the moment it happens.
- Let you change the doorbell's mode, open the door, start a recording and play a message at the
  street from Home Assistant, and change the settings the apps have (image, detection, door,
  name).
- Show a still of the street as a camera, for dashboards and notifications.
- Show the doorbell live in a card, with two-way audio, and play its recordings.

**It does not:**

- **Give you access to Home Assistant from outside your home.** To open your dashboards away from
  home you still need a remote-access method for Home Assistant (Home Assistant Cloud, or your own
  domain with a reverse proxy). The optional HTTPS below does **not** replace that: it is local.
  Once you can open Home Assistant from outside, the card's live view works there too (above).
- **Store any image or sound.** We never store it: recordings stay on the doorbell's memory card,
  and Home Assistant plays them from there without copying them. The camera's still lives in
  memory only. If *you* choose to save a still or a clip in your own Home Assistant (for example
  with `camera.snapshot`), that copy is yours, in your house.
- **Use the internet or our cloud to reach the doorbell.** Not as a fallback either: every command,
  event and recording goes over your network. Two things do ask our cloud, and neither is needed
  at home: the live view **away from home** gets a short-lived relay pass (one hour) so its
  encrypted media can cross our relay server, which cannot decrypt it and keeps nothing; and the
  optional *public name* of the secure connection (below) asks for a name and a certificate. With
  the internet or our servers down, everything at home keeps working.
- **Need an MQTT broker, YAML, or a separate card install.**

---

## Two principles this is built on

**Local first.** Everything here works inside your home network with no internet at all. If your
line or our servers go down, the live view, two-way audio, the door, the recordings and your
automations keep working.

**Privacy first.** Not a frame of video or a second of audio is stored anywhere but on the
doorbell's own memory card. The live stream goes from the doorbell to your browser; it does not
pass through Home Assistant. At home it goes straight there; away from home it crosses our relay
server end-to-end encrypted (DTLS-SRTP): the relay forwards packets it cannot decrypt and stores
nothing. The pairing credential stays on your Home Assistant server and never reaches a browser;
what the browser gets for the relay is a one-hour pass, good for nothing else.

What Home Assistant itself keeps is what it keeps for any device: the **history of the entities**
(for example "Events: ring at 10:02", "Mode: Away") in its own database, like every other entity
you have. No pictures, no audio.

---

## Installing

### Before you start

1. **An IG Doorbell that is already set up**, on your network, with an administrator account. If
   it is brand new, set it up from the mobile app or its own web page first.
2. **Home Assistant 2024.7 or newer.**
3. **Home Assistant reachable from the doorbell on your own network.** The doorbell writes to Home
   Assistant directly, so Home Assistant needs a *local* address (Settings → System → Network →
   *Home Assistant URL*).

### With HACS (recommended)

1. In HACS, open the **⋮** menu and choose **Custom repositories**.
2. Paste `https://github.com/Islautopia/ig-doorbell-hass` and pick the **Integration** category.
3. Find **Islautopia Garage Doorbell** in the list and download it.
4. Restart Home Assistant.
5. **Add it:** Settings → Devices & services → **Add integration** → *Islautopia Garage Doorbell*
   (or accept it under *Discovered*), and pair your doorbell — see [Pairing a doorbell](#pairing-a-doorbell).

The card comes with the integration. You do **not** add a dashboard resource.

### By hand

Copy the `custom_components/ig_doorbell/` folder into your Home Assistant `custom_components`
folder, restart, and add it as in step 5 above.

---

## Pairing a doorbell

**Settings → Devices & services → Add integration → Islautopia Garage Doorbell.** If the doorbell
is on the same network, Home Assistant may already offer it under *Discovered*. Otherwise type its
IP address — the reliable route when the doorbell and Home Assistant sit on different VLANs.

Then enter the doorbell's **administrator email and password**. They are used **once**, to ask the
doorbell for a dedicated pairing credential for this Home Assistant, and are never stored. Setup
checks that the doorbell answers on your network with a valid certificate; if anything fails, it
says so and configures nothing (a half-made pairing is undone on the doorbell).

Repeat for each doorbell. Each pairing appears in the doorbell's list of clients, where it can be
revoked; if that happens, **Configure → Re-pair** asks for the password again.

**Administrator or guest.** A pairing made with an administrator account can change the mode,
record, see recordings and vouch for the public HTTPS name; with a guest account, what the pairing
may do is what the doorbell allows its guests. The card follows **the pairing's**
role, not the role of whoever is looking at the dashboard.

---

## The card

Add it to a dashboard: **Edit dashboard → Add card → IG Doorbell**, or in YAML:

```yaml
type: custom:ig-doorbell-card
```

That is the whole configuration: it shows every doorbell of the integration.

- **Every doorbell, one card.** A switcher in the header lists your doorbells by name. Switching
  hangs up the old session and starts a fresh one.
- **Live video in about a second** and **two-way audio**, with one talk turn shared with the
  mobile apps: if someone else is talking, you are told instead of being cut in.
- **At home or away.** At home the picture goes straight from the doorbell to your screen. Away
  from home (Home Assistant opened through Home Assistant Cloud or your own domain) it crosses our
  relay server, end-to-end encrypted, and an **Internet** badge shows on the picture — the same
  badge as the apps. If no path works from where you are, the card says so and keeps retrying.
- **The microphone needs a secure page.** Browsers only allow it over HTTPS. If you open Home
  Assistant as `http://…` and tap the microphone, the card explains this and takes you to the
  setup page of the [secure local connection](#secure-local-connection-https), with a QR code to do
  it from your phone.
- **Door with confirmation**: the first press arms, the second opens, and the card says *Open*
  only when the doorbell confirms it. No door button when the doorbell has no lock.
- **Watching is not listening**: the speaker starts muted and turns on when you tap it or when
  someone rings.
- **Mode**, **REC** and **Recordings** (administrator pairings), **Quick replies** played at the
  street, and a **bell** with the doorbell's recent notices — rings, visitors, parcels, the door,
  security and device health — read from the Events entity's history in Home Assistant.
- **Leaves the doorbell alone when nobody is looking**: leaving the view pauses the stream and,
  after a grace period, frees the doorbell (unless you are in a call). The *Live view timeout*
  entity pauses it when nobody touches the card.
- **Adapts to the space** it is given (stacked, overlaid or side column), fullscreen, pinch to
  zoom, touch-sized buttons on touch screens.
- Translated to English, Spanish, French, Italian, German and Portuguese - the same six languages
  as the iOS and Android apps, fallback English.

### Updating

HACS updates the integration and the card together. After the update, **restart Home Assistant**
and **reload the browser page**. No cache clearing is needed.

---

## Ring notifications (phones and wall panels, no app needed)

The integration can ring your phones and wall panels itself. They only need the **Home Assistant
companion app**, and you don't write any automation. Go to **Settings → Devices & services → IG
Doorbell → Configure → Ring notifications** and pick the phones and the panels:

- **Phones** get a notification with the visitor's picture that rings even in silent mode (a
  critical alert on iPhone). Tapping it opens the doorbell full-screen.
- **Android wall panels** wake up and show the doorbell. They go back to Home Assistant's default
  page after the doorbell's *Wall panels: back to the home page after* time (`0` = never), but not
  while an answered call lasts. Only the panels picked here ever go back by themselves: a computer or
  a phone showing the card is attended, and the card never takes it away from the page.
- **Speakers** (optional): Echo speakers play Alexa's doorbell chime, and other speakers play the
  IG Doorbell chime. They can also say which doorbell is ringing.
- When someone answers, the notification **disappears from every device**. A missed call is left
  as a quiet "Missed call at 16:13". This needs doorbell firmware 0.101.3 or later.

It is off until you pick a device. Setup per device, what works away from home, and privacy:
[docs/ring-notifications.md](docs/ring-notifications.md).

---

## Entities and events

| | |
|---|---|
| **Events** | everything the doorbell reports: a ring, a visitor, a parcel, the door opened, a failed login, a key refused, a problem with the memory card, an unexpected restart… Use it directly as an automation trigger |
| **Ringing** | on from the ring until someone answers, declines, or it is missed; the outcome and who answered are attributes |
| **In call** | on from the moment a ring is answered (by opening the microphone) until the conversation ends: whoever answered closes the microphone, leaves the live view or sends the app to the background, hangs up, or drops — and nobody else takes over within 3 seconds. A quick reply answers the ring without a conversation. The doorbell itself says when it ends (firmware 0.103.2 or newer; unavailable with an older one); the last duration and how it ended are attributes |
| **Visitor** / **Package at the door** | the ones you want as a state rather than an instant |
| **Snapshot** (camera) | a still of the street, refreshed at most every 5 seconds for all viewers together. No live stream (the live call is the card's). While it rings, it shows the ring's own picture and takes no new one; if the doorbell is set to send no picture with a ring, it shows none |
| **Door** (lock) | when the doorbell has a lock. *Unlock* (or *Open*) releases the door for the open time set on the doorbell, then it reports *locked* again by itself; *Lock* has nothing to do. Home Assistant asks for confirmation before opening. For automations, trigger on the *Door opened* event, which reports every opening from any app |
| **Mode** | Normal, Away, Do not disturb, Custom — *"Do not disturb at 23:00"* is a two-line automation |
| **Mode reason** | why it is in that mode: set by hand, by the schedule, no rule; *until* as an attribute |
| **Manual recording** | a switch (administrator pairings) that shows what the doorbell is recording. It turns off by itself when the doorbell stops: after 10 minutes, when a ring or a detection takes over, or when someone stops it from an app. Firmware 0.103.1 or newer |
| **Quick reply** + **Play quick reply** | pick one of the doorbell's quick replies (their names come from the doorbell and follow the app), then press the button to play it at the street. Picking plays nothing. During a ring it answers the call, as in the apps |
| **Firmware** (update) | the doorbell's own check for a new firmware: the doorbell asks, Home Assistant asks the doorbell — never our servers. When the doorbell could not check, the latest version shows as unknown, never as "up to date". Install (administrator pairings) is done by the doorbell itself; progress is shown until it restarts on the new version |
| **Viewers** | how many people are watching right now |
| **Wall panels: back to the home page after** | seconds before a wall panel returns to Home Assistant's home page (`0` = never) |
| Firmware version, street panel, fingerprint reader, SD card (state, size, free), Wi-Fi network, IP address, this pairing's role, camera flips | diagnostics |
| Memory, last start, last restart reason, microphone gain | diagnostics, **disabled by default** — the doorbell is not asked for them until you enable one |

**Settings** (configuration section of the device) — the same ones the apps' settings screens
change, applied by the doorbell at once. They need a pairing made from an **administrator**
account: with any other pairing they show as *unavailable* (the *This pairing's role* sensor says
which one you have).

| | |
|---|---|
| Image | brightness, contrast, saturation, hue; black and white; exposure mode (automatic / manual), exposure compensation, manual exposure time and gain |
| Timestamp | on the video or not, and its position |
| Detection | person and package on/off, their thresholds, and the minimum size |
| Door | lock type (doorbell relay, a Home Assistant entity, none), open time, opening from the car allowed |
| Name | the doorbell's name (up to 31 bytes; accented letters take two) |
| Restart | a button |
| Streams | main and sub-stream frame rate, bitrate, rate control, sub-stream on/off — **disabled by default** |

Left out on purpose: **flips** are shown but cannot be changed from Home Assistant (changing them
while the camera runs spoils the colour until the doorbell restarts — set them once from the app);
**automatic white balance** (switching it off has no effect on this hardware yet); **microphone
gain** (fixed by the firmware and tuned together with the echo canceller); and anything secret,
irreversible or that needs an editor — Wi-Fi password, door codes, formatting the memory card,
factory reset, sequences.

Urgent things (a ring) arrive **pushed** by the doorbell over a local webhook the moment they
happen; the rest is refreshed every 30 seconds. If the doorbell cannot be reached, its entities
become *unavailable* — which is what that means — and the card keeps working for the others.

### Actions

`ig_doorbell.play_sequence` plays one of the doorbell's quick replies or sequences at the street, by
its **name** as shown in the app (`sequence: Leave it at the door`) or by its id (`seq_id`).
`ig_doorbell.play_audio` plays a quick-reply audio slot (1-10). Any pairing may use them; they fail
with a readable reason (no such quick reply, the doorbell is busy, the firmware is too old) instead of
doing nothing. Firmware 0.103.1 or newer.

The street panel's firmware has no update entity: the doorbell brings its panel up to date by itself
when it starts, and there is no catalog to compare the panel with.

### The doorbell can switch your Home Assistant devices

In **Configure → Entities the doorbell can act on**, choose up to 5 entities that turn on and off
(lock, light, switch, input boolean, fan, siren) or that can be launched (script, automation). The doorbell can then use them as its door, or
in a step of one of its sequences, and the apps offer them by name. The doorbell cannot touch
anything that is not on that list.

| You point the doorbell at… | Open does | Then, after the open time set on the doorbell |
|---|---|---|
| `lock.front_door` | `lock.unlock` | `lock.lock` |
| `light.porch`, `switch.gate`, `input_boolean.…`, `fan.…`, `siren.…` | `turn_on` | `turn_off` |
| `script.…` | `script.turn_on` (launches it) | nothing: a script has no "off" |
| `automation.…` | `automation.trigger` (runs its actions; its conditions still apply) | nothing |

**Scripts and automations are launch-only** (1.5.3). A sequence step can launch one, but "turn
off" is refused (`no_off`) instead of stopping the script or disabling the automation, and a
disabled automation answers `disabled`. For something that must be *undone* at the end of a
sequence, use a helper (`input_boolean`) and let an automation react to it. Full contract for
firmware and apps: [docs/hass-entities-contract.md](docs/hass-entities-contract.md). Worked example:
[docs/examples/halloween-lights.md](docs/examples/halloween-lights.md).

---

## Secure local connection (HTTPS)

**Off by default.** Turn it on in **Configure → Secure local connection (HTTPS)**. It serves your
Home Assistant over HTTPS on your home network, on a port of its own (8443), so browsers let the
card use the microphone. It does not touch Home Assistant's own port or settings, and it works
alongside Home Assistant Cloud or your own reverse proxy.

**It is not remote access**, and it does not remove the need for one if you want Home Assistant
away from home.

It gives two addresses:

- **A public name** such as `https://<id>.ha.doorbell.islautopia.com:8443` — a certificate every
  device already trusts, **nothing to install**. It needs **an IG Doorbell paired here as
  administrator** and registered with the Islautopia cloud: the doorbell vouches for your Home
  Assistant. The certificate's private key is created in your Home Assistant and never leaves it.
  The name is visible in public certificate logs and points to your Home Assistant's *private*
  address; some routers block such names (DNS rebinding protection) — then use the local address.
- **Your local address** (`https://<ip>:8443` or `https://homeassistant.local:8443`) — works
  **without internet and without a doorbell**. Its certificate comes from the integration's own
  local certificate authority; you install that authority's root certificate once on each device,
  guided by a setup page with a *Check* button. The root can only vouch for private addresses and
  local names, never for other websites.

Setup page: `http://<your-home-assistant-ip>:8123/ig_doorbell/https` (linked from the option and
from the card). Everything about it — what our cloud sees, where the keys live and what that
means, routers, installation types, troubleshooting, and what is tested — is in
**[docs/https.md](docs/https.md)**.

---

## If something does not work

**The card says "Custom element doesn't exist: ig-doorbell-card".** Home Assistant was not
restarted after installing, or the page was not reloaded after the restart.

**I can see and hear, but the microphone does not work.** The page is not secure (`http://`). Tap
the microphone: the card shows why and where to go. See [docs/https.md](docs/https.md).

**Nothing happens when the door is opened.** Check that the doorbell's door type is *Home
Assistant* and that the entity is in *Configure → Entities the doorbell can act on*.

**The entities are all unavailable.** The integration cannot reach the doorbell. If the doorbell
moved to another IP, set it in *Configure → Doorbell address*. If it says the doorbell no longer
recognises it, re-pair from *Configure*.

**Nothing arrives the moment it happens, but the entities are fine.** The doorbell does not know
where to write: Home Assistant has no local address configured (see *Before you start*), or the
pairing is not an administrator. The log says which.

More detail in the log:

```yaml
logger:
  logs:
    custom_components.ig_doorbell: debug
```

---

## For developers

- Integration tests: `python -m pytest tests -q` in a container with
  `pytest-homeassistant-custom-component` and `segno`; `python tools/mutants.py` re-breaks each rule
  and checks the suite goes red.
- Card benches: `cd tests/card && npm install && node run_all.js` (Playwright + simulations, with
  their own positive and negative controls). What the card has learned so far is in
  [docs/card.md](docs/card.md).

## License

MIT — see [LICENSE](LICENSE). Made by [Islautopia Garage](https://islautopia.com).
