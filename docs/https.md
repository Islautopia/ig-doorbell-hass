# Secure local connection (HTTPS)

An option of the IG Doorbell integration, **off by default**. It serves your Home Assistant over
HTTPS on your home network, on a port of its own (8443 unless you choose another), so that
browsers let the doorbell card use the **microphone**.

- [Why it exists](#why-it-exists)
- [What it is not](#what-it-is-not)
- [Turning it on](#turning-it-on)
- [The two addresses](#the-two-addresses)
- [Setting up your devices](#setting-up-your-devices)
- [The local certificate authority, and where its key lives](#the-local-certificate-authority-and-where-its-key-lives)
- [What our cloud sees](#what-our-cloud-sees)
- [Living alongside Home Assistant Cloud, a reverse proxy, or HA's own certificate](#living-alongside-home-assistant-cloud-a-reverse-proxy-or-has-own-certificate)
- [Installation types and ports](#installation-types-and-ports)
- [Turning it off](#turning-it-off)
- [Troubleshooting](#troubleshooting)
- [What has been tested, and what has not](#what-has-been-tested-and-what-has-not)

---

## Why it exists

Browsers only give a web page the microphone when the page is a *secure context*: served over
HTTPS (or from the same machine, `localhost`). A Home Assistant opened as
`http://192.168.1.10:8123` is not one. On that page the browser has no microphone to offer at
all, so the card can show the doorbell and play its sound, but you cannot talk back.

If you reach Home Assistant through Home Assistant Cloud or through your own domain with HTTPS,
you already have a secure context **on that address**. This option is for everyone else, and for
the moments that address is not usable:

- you have **no remote access** set up and open Home Assistant by its local address;
- you want HTTPS at home that **keeps working without internet** (your line or our servers down);
- a wall tablet or a phone on the home Wi-Fi that should not depend on a cloud path to talk to
  the door.

## What it is not

- **It is not remote access.** It serves Home Assistant on your home network only. It does not
  open anything to the internet, and it does **not** replace Home Assistant Cloud or your own
  domain with a reverse proxy. If you want to use Home Assistant away from home, you still need
  one of those.
- **It does not change Home Assistant's own settings.** Port 8123, the `http:` section of your
  configuration, `trusted_proxies`, your own certificates: all untouched. It *adds* a port.

## Turning it on

**Settings → Devices & services → Islautopia Garage Doorbell → Configure → Secure local
connection (HTTPS)**. Tick *Enable HTTPS*, keep port 8443 or choose another, and submit. It starts
at once; no restart.

- If the port is already used by another program, the form tells you and nothing is changed.
  If the port gets taken later (for example after a restart), a repair appears in **Settings →
  System → Repairs** naming the port.
- It is one setting for the whole Home Assistant, whichever doorbell you open it from. The
  doorbell of the entry you enable it from is the one asked to vouch for the public name (below).

## The two addresses

Every device on your network can use either. They are served on the same port; the certificate
is picked by the name the device asks for.

### 1. The public name — nothing to install on your devices

`https://<id>.ha.doorbell.islautopia.com:8443`

A certificate from Let's Encrypt, trusted by every phone, tablet and computer out of the box.

**It needs an IG Doorbell in your installation.** Specifically, a doorbell paired with this Home
Assistant **as administrator** and **registered with the Islautopia cloud** (every doorbell that
has been set up with the app is). The doorbell *vouches* for your Home Assistant: it signs a
short-lived voucher, and our cloud only creates a name and asks for a certificate when an official
doorbell has signed for it. Without that, anyone could get certificates under our domain.

- The **private key** of that certificate is generated inside your Home Assistant and **never
  leaves it**. Only a certificate request (the public half) is sent.
- It **renews itself** 30 days before it expires. Each renewal needs a fresh voucher from the
  doorbell and internet access. If the doorbell is unpaired from this Home Assistant or reset,
  renewals stop, and after 100 days without a voucher the name is released.
- **One public name per doorbell.** If another Home Assistant already holds your doorbell's name
  (for example an old installation), a repair offers to move it here.
- A doorbell paired as a **guest** (role *user*) cannot vouch: the name is reserved for the
  owner. A doorbell not registered with the cloud cannot either. In both cases the repair says
  so and the local address below keeps working.

**Things to know about it:**

- **The name is public.** Every certificate issued on the internet is listed in public
  *Certificate Transparency* logs, so anyone can see that the name exists. It resolves to your
  Home Assistant's **private** address (like `192.168.1.10`), which is useless from outside your
  network. It does not reveal your public IP address.
- **Some routers block it.** A name on the internet that points to a private address is what a
  "DNS rebinding" attack looks like, and some routers (and DNS filters such as Pi-hole or
  AdGuard with that option on) refuse to answer it. The address then simply does not open. Either
  allow `ha.doorbell.islautopia.com` in the router's rebind-protection exceptions, or use the
  local address.
- **Looking up the name needs internet** (or at least a working DNS server). Without internet,
  use the local address.

### 2. The local address — works without internet and without a doorbell

`https://192.168.1.10:8443` (your Home Assistant's IP) or `https://homeassistant.local:8443`

The certificate comes from the integration's **own local certificate authority** (next section).
Each device trusts it once you **install its root certificate** on that device — a one-minute
step the install page walks you through. After that it works with no internet, no cloud and no
doorbell. This path never contacts our servers.

## Setting up your devices

Open the **install page** on each device:

`http://<your-home-assistant-ip>:8123/ig_doorbell/https`

(There is a link to it next to the option in the integration. The card also leads you there, see
below.) The page:

- shows the public name first, if you have one (nothing to install);
- detects the device and shows only its steps:
  - **iPhone / iPad**: one button installs a configuration profile (use Safari). Then the step
    everyone misses: **Settings → General → About → Certificate Trust Settings**, turn on the
    root. Without that switch iOS installs the profile but does not trust it.
  - **Android**: download the certificate, then **Settings → Security → Encryption &
    credentials → Install a certificate → CA certificate** (on Samsung: Settings → Security and
    privacy → More security settings → Install from device storage → CA certificate).
  - **Computer**: a QR code to open the page on your phone, and the steps for Windows, macOS and
    Linux/ChromeOS on the computer itself;
- ends with a **Check** button that tries the secure address from that device and says *Ready*
  or what is missing;
- keeps the root's fingerprint as a detail, for those who want to compare it.

The page only answers to devices on your home network.

**The card leads users there.** If someone taps the microphone on a page that is not secure, the
card no longer fails silently: it explains why and links to the install page (with a QR code on
a computer). If HTTPS is off, it says an administrator can turn it on.

**Home Assistant app.** To talk from the companion app at home, set its internal URL to the
secure address (in the app: Settings → Companion app → your server). *Not measured yet*, see the
end of this page.

## The local certificate authority, and where its key lives

A *certificate authority* is what vouches for a website's certificate. Browsers come with a list
of public ones (Let's Encrypt is one). The integration creates a **small one of its own, just for
your Home Assistant**: a *root certificate* and its private key, generated in your Home
Assistant. It then issues the certificate for your Home Assistant's local addresses with it, and
re-issues it on its own when those addresses change. You install the **root** once on a device;
from then on the device trusts whatever that root vouches for.

That is different from a *self-signed* certificate for the server itself, which you would have to
accept again every time it changes.

**What this root can vouch for is limited, by design.** It carries *name constraints*: it can
only vouch for private network addresses (10.x, 172.16–31.x, 192.168.x, link-local and their IPv6
equivalents), names ending in `.local`, `localhost`, and Home Assistant names under
`ha.doorbell.islautopia.com`. Even if someone got hold of its key, devices that trust it would
refuse a certificate it signed for any other website (measured in Chromium, see the end).

**Where its key lives, and what that means.** In your Home Assistant configuration folder:
`ig_doorbell_https/ca.key` (the key of the public name, `public.key`, is there too). That folder
is readable by:

- your **backups** (encrypted only if you encrypt them),
- **add-ons** that share or edit your configuration (Samba, SSH, File editor, Studio Code Server…),
- every **other custom integration** you install (they run in the same process).

Anyone who reads `ca.key` could, towards devices that installed your root, pretend to be your
Home Assistant on your network — for example to capture a login typed into a fake page. They
could not impersonate any other website. Keep backups encrypted and only install add-ons and
integrations you trust. If you think the key leaked: turn HTTPS off, delete the
`ig_doorbell_https` folder, turn it on again (a new root is created), remove the old root from
your devices and install the new one.

## What our cloud sees

Only while HTTPS is on, and only for the public name. The link between Home Assistant and the
doorbell stays entirely on your network (the voucher is asked of the doorbell locally).

Our cloud receives and keeps: the doorbell's id, the name it gives your Home Assistant, your Home
Assistant's **local** IP address (it is in the public DNS record), a fingerprint of the
certificate's public key, and the certificate itself (public anyway). Our servers log the public
IP the request came from. It never receives the certificate's private key, your Home Assistant
login, or any audio or video. The local address never contacts it at all.

## Living alongside Home Assistant Cloud, a reverse proxy, or HA's own certificate

It adds a listener that hands each secure connection straight to Home Assistant's own web server.
There is no proxy in between, so:

- **Nothing to configure**: no `use_x_forwarded_for`, no `trusted_proxies`.
- Home Assistant sees the **real address** of each device, so its login protections (IP bans)
  work exactly as on port 8123 — a proxy would make every device look like one and a few failed
  logins would lock everyone out.
- **Your own reverse proxy** in front of port 8123 keeps working as before, as does **Home
  Assistant Cloud**, and a certificate you configured in Home Assistant's own `http:` section.

## Installation types and ports

- **Home Assistant OS / Supervised**: Home Assistant runs on the host's network, so the port
  opens on the machine's own address. Nothing else to do.
- **Home Assistant Container**: with `network_mode: host` (the documented way) nothing else to
  do. With bridge networking, publish the port too (`-p 8443:8443`).
- **Home Assistant Core**: nothing else to do; the port must be free and allowed by the machine's
  firewall.

## Turning it off

Untick *Enable HTTPS*. The port closes at once and open connections through it are closed. The
certificates stay in `ig_doorbell_https`, so turning it on again reuses the same root and your
devices keep trusting it. Removing the last doorbell from the integration also closes the port.
To remove everything, delete that folder; a public name nobody renews is released after 100
days.

## Troubleshooting

**The public name does not open, the local address does.** Your router or DNS filter blocks names
that point to private addresses (see *Some routers block it*), or the device has no internet.

**The Check button says *Not ready yet*.** On iPhone/iPad, almost always the Certificate Trust
Settings switch. On Android, the certificate was installed as a VPN/app or Wi-Fi certificate
instead of a *CA certificate*. On a computer, the browser was not restarted, or it is Firefox,
which keeps its own list (Settings → Privacy & Security → Certificates → View Certificates →
Authorities → Import).

**Repairs you may see**, and the codes in *Public name unavailable*:

| code | meaning | what to do |
|---|---|---|
| port taken | another program uses the port | choose another port in the option |
| `admin_required` | the doorbell is paired as a guest | re-pair with an administrator account (Configure → Re-pair) |
| `device_not_paired` | the doorbell is not registered with the cloud | finish its setup in the app |
| `doorbell_has_ha_name` | another Home Assistant holds this doorbell's name | the repair offers to move it here |
| `voucher_unsupported` | the doorbell's firmware is too old to vouch | update the doorbell (0.101.1 or newer) |
| `ip_must_be_private_ipv4` | this Home Assistant has no private IPv4 address | the public name only points to private addresses; use the local address |
| `no_doorbell` | no doorbell of the integration is loaded | check the doorbell entry |
| `vps_unreachable`, `doorbell_unreachable`, `rate_limited`, `upstream_failed`, `issuance_limited`, `clock_not_set` | temporary | retried on its own after 30 s, 1, 2, 5, 15 and 30 min, then every hour; a repair is raised only once the public name has been failing for an hour. HTTPS itself stays on and the local address keeps working |
| `unknown_device`, `device_not_authorized` | the cloud does not recognise the doorbell | contact support |

The log has the detail:

```yaml
logger:
  logs:
    custom_components.ig_doorbell.https_manager: debug
```

## What has been tested, and what has not

Measured (release 1.1.0), in a throwaway Home Assistant 2026.9 in Docker with a real IG Doorbell
and our live cloud (Let's Encrypt *staging* certificates):

- The local and the public certificate served on one port and chosen by name; negative controls
  (each certificate refused under the other's authority, and an untrusted root refused).
- **Chromium** (Linux, real user trust store): with the root installed, the local address opens
  Home Assistant, the page is a secure context and the microphone works; without it, the browser
  refuses. A certificate for `www.example.com` signed with the **same root key** is refused
  because of the name constraints, and accepted by the same browser under a copy of the root
  **without** constraints — so the refusal really comes from the constraints.
- The install page's Check button, with and without the root; the card's notice on a plain-HTTP
  page.
- Port 8123, a request with a forged `X-Forwarded-For`, and a user's own reverse proxy behave the
  same with the option on and off.

**Not measured yet** (said plainly so nobody takes it as tested):

- **iPhone/iPad (Safari) and macOS**: installing the profile, the full-trust switch, and whether
  Apple's verifier accepts roots with IP-address name constraints. Apple documents support for
  name constraints; not verified on a device here.
- **Android** (Chrome and the Home Assistant app), **Firefox**, and **Chrome on Windows with the
  root in the Windows store**. Chrome uses the same certificate verifier on every desktop
  platform, so the Chromium result is expected to hold there, but it was not run.
- The Home Assistant companion apps pointed at the secure address.
- Home Assistant Cloud running at the same time (argued above, not run: no subscription on the
  test machine).
