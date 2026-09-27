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
| **Panel: page to return to after the call** | For example `/lovelace/0`. If you leave it empty, the panel goes to the app's home page. |

To turn it off again, leave both lists empty. **If you already have your own automation for the
bell, turn one of the two off**, or every ring will arrive twice.

## What happens on a ring

1. Every phone and panel you picked rings right away. The picture comes a moment later and never
   delays the ring.
2. Once someone answers, from the app, the card, a quick reply or the doorbell's own screen, the
   notification **disappears from every device**. Panels go back to their dashboard.
3. If nobody answers, the notification on each phone is quietly replaced by *"Missed call at 16:13"*.

Clearing notifications when a call is answered needs **doorbell firmware 0.101.3** or later. With
older firmware they still ring, but they are not cleared. Panels go back to their dashboard after
2 minutes anyway.

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
