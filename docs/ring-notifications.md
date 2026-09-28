# Ring notifications (phones and wall panels, no app needed)

From 1.2.0 the integration can ring your phones and wall panels itself. They only need the
**Home Assistant companion app**, not the IG Doorbell app. You don't write any automation.

## Turning it on

**Settings → Devices & services → IG Doorbell → Configure → Ring notifications**

| option | what it does |
|---|---|
| **Phones** | Companion-app phones. They get a notification with the visitor's picture. Tapping it opens the call page. |
| **Wall panels** | Companion-app tablets on the wall. On Android, the screen wakes up and shows the call page. On an iPad, see below. |
| **Ring through silent mode** | On by default. iPhone: a *critical alert*. Android: the alarm sound stream. |
| **"Open door" button on phones** | Off by default. It only works while the bell is ringing (up to 3 minutes). The iPhone asks for Face ID first. |
| **Speakers that announce the call** | Off by default. Echo speakers (the official Alexa integration) play Amazon's doorbell chime; every other speaker plays the IG Doorbell chime. If you already announce the bell on those speakers with an automation, you don't need this, or they will announce twice. |
| **Also say which doorbell is ringing** | Echo: an announcement. Other speakers: needs a text-to-speech engine in Home Assistant. |

**Phones are chosen one by one, per doorbell.** If a phone already takes this doorbell's calls
through the IG Doorbell app (for example, for CarPlay or Android Auto), don't add it here, or it
will ring twice. A phone you leave out still gets all its other Home Assistant notifications. If a
phone should get everything through Home Assistant, add it here and turn off calls for this
doorbell in the IG Doorbell app. Each phone can do it either way.

To turn it off again, leave both lists empty. **If you already have your own automation for the
bell, turn one of the two off**, or every ring will arrive twice.

## What happens on a ring

1. Every phone and panel you picked rings right away. The picture comes a moment later and never
   delays the ring.
2. Once someone answers, from the app, the card, a quick reply or the doorbell's own screen, the
   notification **disappears from every device**.
3. If nobody answers, the notification on each phone is quietly replaced by *"Missed call at 16:13"*.

Clearing notifications when a call is answered needs **doorbell firmware 0.101.3** or later. With
older firmware they still ring, but they are not cleared.

**When the doorbell page goes away.** Every card and call page follows the same rule. While it is on
screen, the video is on; when it leaves the screen, the video stops at once. The doorbell's
*Wall panels: back to the home page after* setting (default 120 s) takes the screen back to Home
Assistant's default page after that long with nobody touching it - **only on the wall panels picked
in these Ring notifications options**. A computer or a phone showing the card is attended: whoever
opened it closes it, and the card never navigates it away. For a call nobody answered, the time
counts from the ring. Every visit to the card starts the full time again, and so does every touch.
It never leaves during a call that was answered, and it never navigates away if the card is already
on the default page. `0` means never.

How a panel is recognised (1.2.4): by the companion app itself, never by what the page says. The
page's connection to Home Assistant uses the companion's own login, and the integration links that
login to the device in one of two ways:

- **Automatically**, when the page's Home Assistant user has only one companion app of that kind
  (Android or iOS) - typical for a wall panel with its own user.
- **The first time the call page is opened from that panel's own ring notification** (or, on
  Android, when the ring opens it). Every link sent to a picked panel carries a one-time code that
  only that device received; the page that opens it proves it is that device, and the login is
  remembered. This is how an iPad whose user also has an iPhone is recognised.

Anything it cannot identify - a computer, a phone, a panel not identified yet - is treated as
attended and never sent home. The same identity decides which page shows the call page in the
window already on screen. A companion app that logs out and in again (or is reinstalled) is
recognised again the same way.

## Setting up each device

**iPhone / iPad (companion app)**
- Allow notifications, and in *iOS Settings → Notifications → Home Assistant* turn on **Critical
  Alerts**. Without that, a critical alert can't get past silent mode.
- **If you wear an Apple Watch**, iOS sends the notification to the Watch while the iPhone is
  locked, and the iPhone stays silent. The Watch rings instead; that is how iOS handles it.
- An iPad can't be woken into a page remotely; that is an iOS limit. As a wall panel, leave the
  call page open (`/ig-doorbell?device=<id>`, or just `/ig-doorbell` with one doorbell) in
  **Guided Access**. The page reacts to the ring by itself. The iPad also gets the notification. *(iPad as a
  panel: designed, not measured on a device yet.)*

**Android phone / tablet (companion app)**
- Allow notifications.
- For a **wall panel**, the companion app needs **"Display over other apps"**. Android asks for it
  the first time. Without it, the panel shows a plain notification instead of the call page, and
  nothing tells you why.
- Keep the companion's persistent connection on (*Settings → Companion app → Persistent
  connection*) so the panel is reached over your home network.
- From 1.2.2 the call page opens **in the window already on screen**: the Home Assistant page the
  panel is showing navigates to it by itself. Only when no page of the panel answers (the app was
  closed) does the integration ask the app to open a new window, which is what the app's own
  command always does - a new window per ring, stacked behind each other (measured). The panel is
  recognised by the Home Assistant user its app is logged in with and its device model.

## Where it works

| | at home, internet up | at home, internet down | away from home |
|---|---|---|---|
| Wall panel rings and shows the call | yes | yes (over the local network) | — |
| Phone notification | yes | only with the companion's *local push* / *persistent connection* on your home Wi-Fi (not measured yet) | yes |
| Picture in the notification | yes | same as above | needs remote access to Home Assistant (Home Assistant Cloud or your own proxy) |
| Opening the call page, talking | yes | yes | needs remote access to Home Assistant |

**Talking needs a secure page.** Browsers only give a page the microphone over HTTPS: use the
integration's *Secure local connection* ([https.md](https.md)) or Home Assistant Cloud. On a plain
`http://` address the call page shows the video but has no microphone.

## Privacy

- The picture is taken by the doorbell when the bell is pressed. Home Assistant keeps it **in memory
  only**: one picture, replaced at the next ring and gone when Home Assistant restarts. It is never
  written to disk by this integration.
- The push that Apple or Google delivers carries **text and a link, not the picture**. The phone
  downloads the picture from **your own Home Assistant**. The companion app keeps it with the
  notification on your phone.
- If the doorbell's owner turns off the picture in call notices (the *call photo* setting in the
  doorbell's apps and web), the notification goes out without a picture.
- Nothing goes through or is stored on any server of ours.

## For automations

Everything the built-in notifications use is also there for your own automations:
- `event.<doorbell>_events`: `ring`, and from firmware 0.101.3 `call_answered`, `call_declined` and
  `call_missed`, each with `call_id` and, when known, `by` (who answered).
- `image.<doorbell>_visitor`: the picture of the last ring (`/api/image_proxy/image.<…>`).
- The call page: `/ig-doorbell?device=<doorbell id>`.

## The IG Doorbell chime

The integration ships its own chime, `/ig_doorbell/sounds/ig-doorbell-chime.mp3`. It was made for
this product: synthesized in `tools/make_chime.py`, with no third-party audio. Where it plays:

- **Speakers** that are not Echo devices, when *Speakers that announce the call* is on.
- **The call page**, when a ring arrives while the page is already open, as on an iPad left on it.
  It does not play when the ring itself opened the page, because the notification has already
  sounded. Browsers only let a page play sound after someone has touched it.
- **Android notifications**: the sound of a notification channel is chosen in Android, not by
  Home Assistant. To use the chime, download it to the device and pick it in *Settings → Apps →
  Home Assistant → Notifications → (channel) → Sound*.
- **iPhone notifications**: iOS only plays custom sounds that were imported into the Home Assistant
  app first. There is no way to send one with the notification.
