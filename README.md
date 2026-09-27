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
- Turn what the doorbell reports (a ring, a visitor, a parcel, the door opened, a key refused…)
  into Home Assistant events and entities, the moment it happens.
- Let you change the doorbell's mode, open the door, start a recording and play a message at the
  street from Home Assistant.
- Show the doorbell live in a card, with two-way audio, and play its recordings.

**It does not:**

- **Give you access from outside your home.** The card works wherever the browser can reach your
  Home Assistant and the doorbell on your network. For access away from home you still need a
  remote-access method for Home Assistant (Home Assistant Cloud, or your own domain with a
  reverse proxy). The optional HTTPS below does **not** replace that: it is local.
- **Store any image or sound anywhere but on the doorbell.** Recordings stay on the doorbell's
  memory card. Home Assistant plays them from there; it does not copy them.
- **Use the internet or our cloud to reach the doorbell.** Not as a fallback either. The single
  exception is optional and off by default: the *public name* of the secure connection (below)
  asks our cloud for a name and a certificate — never for anything about the doorbell's video,
  audio or events.
- **Need an MQTT broker, YAML, or a separate card install.**

---

## Two principles this is built on

**Local first.** Everything here works inside your home network with no internet at all. If your
line or our servers go down, the live view, two-way audio, the door, the recordings and your
automations keep working.

**Privacy first.** Not a frame of video or a second of audio is stored anywhere but on the
doorbell's own memory card. The live stream goes straight from the doorbell to your browser; it
does not pass through Home Assistant. The pairing credential stays on your Home Assistant server
and never reaches a browser.

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

## Entities and events

| | |
|---|---|
| **Events** | everything the doorbell reports: a ring, a visitor, a parcel, the door opened, a failed login, a key refused, a problem with the memory card, an unexpected restart… Use it directly as an automation trigger |
| **Visitor** / **Package at the door** | the ones you want as a state rather than an instant |
| **Mode** | Normal, Away, Do not disturb, Custom — *"Do not disturb at 23:00"* is a two-line automation |
| **Open door** | a button, when the doorbell has a lock |
| **Manual recording** | a switch (administrator pairings) |
| **Viewers** | how many people are watching right now |
| **Live view timeout** | seconds without anyone touching the card before it pauses the live view (default 120, `0` = never) |
| Firmware version, street panel, fingerprint reader | diagnostics |

Urgent things (a ring) arrive **pushed** by the doorbell over a local webhook the moment they
happen; the rest is refreshed every 30 seconds. If the doorbell cannot be reached, its entities
become *unavailable* — which is what that means — and the card keeps working for the others.

### Actions

`ig_doorbell.play_sequence` and `ig_doorbell.play_audio` play one of the doorbell's sequences or
quick replies at the street — the same messages the apps send.

### The doorbell can switch your Home Assistant devices

In **Configure → Entities the doorbell can act on**, choose up to 5 entities that turn on and off
(lock, light, switch, input boolean, fan, siren). The doorbell can then use them as its door, or
in a step of one of its sequences, and the apps offer them by name. The doorbell cannot touch
anything that is not on that list.

| You point the doorbell at… | Open does | Then, after the open time set on the doorbell |
|---|---|---|
| `lock.front_door` | `lock.unlock` | `lock.lock` |
| `light.porch`, `switch.gate`, `input_boolean.…`, `fan.…`, `siren.…` | `turn_on` | `turn_off` |

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
