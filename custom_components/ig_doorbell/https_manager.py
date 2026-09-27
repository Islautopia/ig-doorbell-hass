"""Local HTTPS for Home Assistant, served by this integration (off by default).

What it is for: the IG Doorbell card needs the browser's microphone, and browsers only give the
microphone to a *secure context* - a page served over HTTPS (or from localhost). A Home Assistant
opened at `http://192.168.1.10:8123` is not one, so two-way audio cannot work there. This module
opens ONE extra port (8443 by default) that serves the very same Home Assistant over TLS.

What it is NOT: remote access. The port is for the home network. Nothing here replaces Home
Assistant Cloud or the user's own domain + reverse proxy, and nothing here changes Home
Assistant's own `http:` settings.

## How the port is served ("mode A" of the proof of concept, docs/https.md)

The TLS socket is handed straight to Home Assistant's own aiohttp runner, the same pattern Home
Assistant uses for its own port: `loop.create_server(hass.http.runner.server, ssl=...)`. There is
no proxy in between, so:
- requests reach HA's middlewares with the REAL client address, and no `X-Forwarded-For` exists -
  `use_x_forwarded_for` / `trusted_proxies` never come into play, and a user's own reverse proxy
  in front of `:8123` keeps working exactly as before;
- IP bans hit the real client (a proxy would make every client 127.0.0.1, and three failed logins
  would lock EVERYONE out of this port - measured on the proof of concept).

⚠️ `hass.http.runner` is not public API (present from 2024.1 to 2026.9 at least). If it is
missing, this says so with a repair issue and does NOT fall back to a proxy: a proxy brings back
both problems above.

## Two certificates, chosen per connection by SNI (https_certs.py)

- Local path (bare IP, `homeassistant.local`, anything else): a leaf from the integration's own
  local certificate authority. Never touches the internet. Each device installs the root once.
- Public name `<id>.ha.doorbell.islautopia.com`: a Let's Encrypt certificate, nothing to install.
  Only with an IG Doorbell paired as ADMIN that is registered with our cloud, because the doorbell
  vouches for this Home Assistant (API_CONTRACT §4-ter, https_cloud.py). The key is generated
  here and never leaves Home Assistant.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import errno
import ipaddress
import json
import logging
import socket
from pathlib import Path
from typing import Any

from homeassistant.components import network
from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_call_later, async_track_time_interval
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from . import https_certs, https_cloud
from .const import CONF_CREDENTIAL, CONF_DEVICE_ID, DOMAIN

_LOGGER = logging.getLogger(__name__)

DATA_HTTPS = f"{DOMAIN}_https"
STORAGE_KEY = f"{DOMAIN}.https"
STORAGE_VERSION = 1
FILES_DIR = "ig_doorbell_https"

DEFAULT_PORT = 8443
INSTALL_PATH = f"/{DOMAIN}/https"

# How often the manager looks at its own state: has the LAN IP changed, is a certificate due.
# LOCAL checks only; the VPS is called only when one of them says so (or after a failure).
CHECK_INTERVAL = dt.timedelta(hours=1)
PUBLIC_RENEW_DAYS = 30

# After a failure that may pass by itself (VPS or doorbell unreachable, a cert call abandoned by
# our timeout while Let's Encrypt was still working...), the public name is tried again after
# these delays, then every CHECK_INTERVAL. The first retry is short on purpose: a cert call we
# gave up on is usually finished and cached on the VPS by then, and comes back "reused" at once.
PUBLIC_RETRY_DELAYS_S = (30, 60, 120, 300, 900, 1800)
# "Weather" failures raise no repair for a line that is down for a while, but they do once the
# public name has been failing for this long: after that it is not weather any more.
PUBLIC_REPAIR_AFTER = dt.timedelta(hours=1)

ISSUE_PORT_IN_USE = "https_port_in_use"
ISSUE_UNSUPPORTED = "https_unsupported"
ISSUE_ADMIN_REQUIRED = "https_public_name_admin_required"
ISSUE_NOT_REGISTERED = "https_public_name_not_registered"
ISSUE_NAME_TAKEN = "https_public_name_taken"
ISSUE_PUBLIC_FAILED = "https_public_name_failed"
PUBLIC_ISSUES = (ISSUE_ADMIN_REQUIRED, ISSUE_NOT_REGISTERED, ISSUE_NAME_TAKEN, ISSUE_PUBLIC_FAILED)


def get_manager(hass: HomeAssistant) -> HttpsManager | None:
    return hass.data.get(DATA_HTTPS)


async def async_setup_manager(hass: HomeAssistant) -> HttpsManager:
    """Create the one manager of this Home Assistant (HTTPS is per Home Assistant, not per
    doorbell) and start it once Home Assistant has started, if enabled."""
    if (mgr := get_manager(hass)) is not None:
        return mgr
    mgr = HttpsManager(hass)
    # Loaded BEFORE anyone can see it: an options flow that reached a half-loaded manager would
    # store the user's choice and then have the stored (older) setting written over it.
    await mgr.async_load()
    hass.data[DATA_HTTPS] = mgr

    @callback
    def _started(_hass: HomeAssistant) -> None:
        mgr.started = True
        hass.async_create_task(mgr.async_apply(), eager_start=False)

    async_at_started(hass, _started)
    return mgr


def _private_ipv4(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return addr.version == 4 and addr.is_private and not addr.is_loopback and not addr.is_link_local


class HttpsManager:
    """Owns the listener, the certificates and the public-name upkeep."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.dir = Path(hass.config.path(FILES_DIR))
        self.ca = https_certs.LocalCA(self.dir)
        self.public_key_path = self.dir / "public.key"
        self.public_chain_path = self.dir / "public-fullchain.crt"
        self.adopt_path = self.dir / "adopt.json"
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.data: dict[str, Any] = {"enabled": False, "port": DEFAULT_PORT}
        self.started = False
        self.sni: https_certs.SniContexts | None = None
        self.server: asyncio.AbstractServer | None = None
        self.bound_port: int | None = None
        self.error: str | None = None
        self.local_names: tuple[list[str], list[str]] = ([], [])
        self.fingerprint: str | None = None
        self.ca_name: str | None = None
        self.constrained: bool | None = None
        self.public: dict[str, Any] = {"state": "off"}
        self._lock = asyncio.Lock()
        self._unsub_timer = None
        self._public_task: asyncio.Task | None = None
        self._public_permanent: str | None = None
        self._replace_next = False
        self._retry_unsub = None
        self._fail_streak = 0
        self._failing_since: dt.datetime | None = None

    # ------------------------------------------------------------------ settings
    @property
    def enabled(self) -> bool:
        return bool(self.data.get("enabled"))

    @property
    def port(self) -> int:
        return int(self.data.get("port") or DEFAULT_PORT)

    async def async_load(self) -> None:
        stored = await self._store.async_load()
        if isinstance(stored, dict):
            self.data.update(stored)

    async def async_save(self) -> None:
        await self._store.async_save(self.data)

    async def async_configure(self, *, enabled: bool, port: int, device_id: str | None) -> None:
        """Options flow: store the setting and apply it now (no reload of any entry).

        ⚠️ THE ONLY PLACE `enabled` IS WRITTEN, and only the user's own choice in the options
        reaches it. Nothing in the public-name path may ever turn HTTPS off: whatever happens to
        the public name (VPS down, a timeout, a refused certificate), the local path keeps
        running, a repair explains the public-name problem and a retry comes back later.
        """
        self.data["enabled"] = enabled
        self.data["port"] = port
        if device_id and not self.data.get("device_id"):
            self.data["device_id"] = device_id
        # A new decision by the user deserves a new attempt at the public name.
        self._public_permanent = None
        self._reset_retry()
        await self.async_save()
        await self.async_apply()

    def port_is_ours(self, port: int) -> bool:
        return self.server is not None and self.bound_port == port

    # ------------------------------------------------------------------ lifecycle
    async def async_apply(self) -> None:
        """Make the running state match the setting."""
        if not self.started:
            return
        async with self._lock:
            if not self.enabled or not self._has_entries():
                await self._async_stop(close_clients=True)
                self._clear_issues()
                return
            if self.server is not None and self.bound_port != self.port:
                await self._async_stop(close_clients=True)
            if self.server is None:
                await self._async_start()
        if self.server is not None:
            self._kick_public()

    async def async_shutdown(self) -> None:
        async with self._lock:
            await self._async_stop(close_clients=False)

    def _has_entries(self) -> bool:
        # ANY entry, loaded or not: an entry reloads every time its options change, and stopping
        # the port for that instant would cut the very page the user is changing them from.
        # Only removing the last doorbell (async_remove_entry) turns HTTPS off.
        return bool(self.hass.config_entries.async_entries(DOMAIN))

    async def _async_start(self) -> None:
        self.error = None
        runner = getattr(getattr(self.hass, "http", None), "runner", None)
        if runner is None or getattr(runner, "server", None) is None:
            self.error = "unsupported"
            ir.async_create_issue(
                self.hass, DOMAIN, ISSUE_UNSUPPORTED, is_fixable=False,
                severity=ir.IssueSeverity.ERROR, translation_key=ISSUE_UNSUPPORTED,
            )
            _LOGGER.error(
                "HTTPS not started: this Home Assistant version does not expose its HTTP runner "
                "(hass.http.runner). No fallback is used on purpose (see https_manager.py)."
            )
            return
        ir.async_delete_issue(self.hass, DOMAIN, ISSUE_UNSUPPORTED)

        dns, ips = await self._async_local_names()
        try:
            sni = await self.hass.async_add_executor_job(self._prepare_contexts, dns, ips)
        except (OSError, ValueError) as err:
            self.error = "certificates"
            _LOGGER.error("HTTPS not started: could not prepare the certificates: %s", err)
            return
        self.sni = sni

        http = self.hass.http
        host = http.server_host if getattr(http, "server_host", None) is not None else None
        try:
            self.server = await self.hass.loop.create_server(
                runner.server, host, self.port, ssl=sni.listen, backlog=128
            )
        except OSError as err:
            self.server = None
            if err.errno in (errno.EADDRINUSE, getattr(errno, "WSAEADDRINUSE", -1)) or "in use" in str(err):
                self.error = "port_in_use"
                ir.async_create_issue(
                    self.hass, DOMAIN, ISSUE_PORT_IN_USE, is_fixable=False,
                    severity=ir.IssueSeverity.ERROR, translation_key=ISSUE_PORT_IN_USE,
                    translation_placeholders={"port": str(self.port)},
                )
                _LOGGER.error(
                    "HTTPS not started: port %s is already in use by another program. Choose "
                    "another port in the IG Doorbell integration options.", self.port,
                )
            else:
                self.error = "listen_failed"
                _LOGGER.error("HTTPS not started on port %s: %s", self.port, err)
            return
        self.bound_port = self.port
        ir.async_delete_issue(self.hass, DOMAIN, ISSUE_PORT_IN_USE)
        if self._unsub_timer is None:
            self._unsub_timer = async_track_time_interval(
                self.hass, self._async_periodic, CHECK_INTERVAL, name="ig_doorbell https upkeep"
            )
        _LOGGER.info(
            "HTTPS for Home Assistant on port %s (local names %s %s; root %s)",
            self.port, dns, ips, self.fingerprint,
        )

    async def _async_stop(self, *, close_clients: bool) -> None:
        self._reset_retry()
        if self._unsub_timer is not None:
            self._unsub_timer()
            self._unsub_timer = None
        if self._public_task is not None and not self._public_task.done():
            self._public_task.cancel()
        self._public_task = None
        if self.server is not None:
            self.server.close()
            if close_clients and hasattr(self.server, "close_clients"):
                self.server.close_clients()
            self.server = None
            _LOGGER.info("HTTPS for Home Assistant stopped (port %s)", self.bound_port)
        self.bound_port = None
        self.public = {"state": "off"}

    def _clear_issues(self) -> None:
        for issue in (ISSUE_PORT_IN_USE, ISSUE_UNSUPPORTED, *PUBLIC_ISSUES):
            ir.async_delete_issue(self.hass, DOMAIN, issue)

    # ------------------------------------------------------------------ local certificate
    async def _async_local_names(self) -> tuple[list[str], list[str]]:
        ips: list[str] = []
        try:
            for adapter in await network.async_get_adapters(self.hass):
                if not adapter["enabled"]:
                    continue
                ips += [a["address"] for a in adapter["ipv4"]]
                ips += [a["address"].split("%")[0] for a in adapter["ipv6"]]
        except Exception as err:  # noqa: BLE001 - never block HTTPS on adapter discovery
            _LOGGER.warning("Could not list network adapters for the local certificate: %s", err)
        ips = ["127.0.0.1", *ips]
        dns = ["homeassistant.local", "localhost"]
        host = socket.gethostname().split(".")[0].lower()
        if host and all(c.isalnum() or c == "-" for c in host):
            dns.append(f"{host}.local")
        if (hostname := self.data.get("public", {}).get("hostname")):
            # The local root also covers the public name: if the public certificate cannot be
            # renewed (no internet for months), devices that installed the root keep working.
            dns.append(hostname)
        return https_certs.constrained_names(dns, ips)

    def _prepare_contexts(self, dns: list[str], ips: list[str]) -> https_certs.SniContexts:
        created = self.ca.ensure()
        if created:
            _LOGGER.info("Created the local certificate authority in %s", self.dir)
        if not self.ca.leaf_is_current(dns, ips):
            self.ca.issue_leaf(dns, ips)
        sni = https_certs.SniContexts()
        sni.load_local(self.ca.leaf)
        self.local_names = (dns, ips)
        self.fingerprint = self.ca.fingerprint()
        self.ca_name = self.ca.common_name()
        self.constrained = self.ca.is_constrained()
        pub = self.data.get("public", {})
        if pub.get("hostname") and self._public_cert_valid(pub["hostname"]):
            sni.load_public(pub["hostname"], self.public_chain_path, self.public_key_path)
        return sni

    async def _async_refresh_local(self) -> None:
        """Re-issue the local leaf if the addresses changed; swapped in place, port kept."""
        if self.sni is None:
            return
        dns, ips = await self._async_local_names()
        if (dns, ips) == self.local_names:
            return

        def _reissue() -> None:
            if not self.ca.leaf_is_current(dns, ips):
                self.ca.issue_leaf(dns, ips)
            assert self.sni is not None
            self.sni.load_local(self.ca.leaf)
            self.local_names = (dns, ips)

        await self.hass.async_add_executor_job(_reissue)
        _LOGGER.info("Local HTTPS certificate re-issued for %s %s", dns, ips)

    # ------------------------------------------------------------------ public name
    def _public_cert_valid(self, hostname: str, min_days: int = 0) -> bool:
        """Blocking. The stored public chain matches our key and name and has > min_days left."""
        if not (self.public_chain_path.exists() and self.public_key_path.exists()):
            return False
        try:
            pem = self.public_chain_path.read_bytes()
            key = https_certs.load_or_create_key(self.public_key_path)
            if not https_certs.public_cert_usable(pem, key, hostname):
                return False
            left = https_certs.not_after(https_certs.load_cert_chain_first(pem)) - dt.datetime.now(dt.UTC)
        except (OSError, ValueError, IndexError):
            return False
        return left > dt.timedelta(days=min_days)

    def _reset_retry(self) -> None:
        if self._retry_unsub is not None:
            self._retry_unsub()
            self._retry_unsub = None
        self._fail_streak = 0
        self._failing_since = None

    @callback
    def _retry_public(self, _now: dt.datetime) -> None:
        self._retry_unsub = None
        self._kick_public()

    def _kick_public(self) -> None:
        if self._public_task is not None and not self._public_task.done():
            return
        self._public_task = self.hass.async_create_background_task(
            self._async_public_name(), "ig_doorbell https public name"
        )

    async def _async_periodic(self, _now: dt.datetime | None = None) -> None:
        await self._async_refresh_local()
        self._kick_public()

    def request_replace(self) -> None:
        """Repair flow: the owner chose to move the doorbell's name to this Home Assistant."""
        self._replace_next = True
        self._public_permanent = None
        ir.async_delete_issue(self.hass, DOMAIN, ISSUE_NAME_TAKEN)
        self._kick_public()

    def _vouching_entry(self) -> dict | None:
        """The doorbell that vouches: the one the name is bound to, else the one HTTPS was
        enabled from, else the first loaded one. Never silently a different doorbell once a name
        exists: another doorbell would get ANOTHER name (one name per doorbell)."""
        bound = self.data.get("public", {}).get("device_id")
        wanted = bound or self.data.get("device_id")
        loaded = []
        for entry in self.hass.config_entries.async_entries(DOMAIN):
            data = self.hass.data.get(DOMAIN, {}).get(entry.entry_id)
            if entry.state is ConfigEntryState.LOADED and data and data.get("session"):
                loaded.append(
                    {
                        "device_id": entry.data[CONF_DEVICE_ID],
                        "credential": entry.data[CONF_CREDENTIAL],
                        "session": data["session"],
                    }
                )
        for item in loaded:
            if item["device_id"] == wanted:
                return item
        if bound:
            return None
        return loaded[0] if loaded else None

    async def _async_lan_ip(self) -> str | None:
        try:
            source = await network.async_get_source_ip(self.hass)
        except Exception:  # noqa: BLE001
            source = None
        if source and _private_ipv4(source):
            return source
        for adapter in await network.async_get_adapters(self.hass):
            if adapter["enabled"]:
                for a in adapter["ipv4"]:
                    if _private_ipv4(a["address"]):
                        return a["address"]
        return None

    async def _async_public_name(self) -> None:
        if not self.enabled or self.server is None or self.sni is None:
            return
        if self._public_permanent:
            return
        pub = dict(self.data.get("public") or {})
        hostname = pub.get("hostname")
        try:
            doorbell = self._vouching_entry()
            if doorbell is None:
                raise https_cloud.PublicNameError("no_doorbell")
            ip = await self._async_lan_ip()
            if ip is None:
                raise https_cloud.PublicNameError("ip_must_be_private_ipv4")
            key = await self.hass.async_add_executor_job(
                https_certs.load_or_create_key, self.public_key_path
            )
            ha_key = https_certs.spki_sha256(key.public_key())
            vps = async_get_clientsession(self.hass)

            if not hostname or pub.get("ip") != ip or pub.get("ha_key") != ha_key or self._replace_next:
                self.public = {"state": "pending", "hostname": hostname}
                adopt = await self.hass.async_add_executor_job(self._read_adopt) if not hostname else None
                res = await self._async_claim(doorbell, vps, ha_key, ip, adopt)
                self._replace_next = False
                hostname = res["hostname"]
                pub.update(
                    hostname=hostname, ha_instance_id=res.get("ha_instance_id"), ip=ip,
                    ha_key=ha_key, device_id=doorbell["device_id"],
                )
                self.data["public"] = pub
                await self.async_save()
                if adopt:
                    await self.hass.async_add_executor_job(self.adopt_path.unlink, True)
                await self._async_refresh_local()

            due = not await self.hass.async_add_executor_job(
                self._public_cert_valid, hostname, PUBLIC_RENEW_DAYS
            )
            if due:
                self.public = {"state": "pending", "hostname": hostname}
                csr = await self.hass.async_add_executor_job(https_certs.make_csr, key, hostname)
                voucher = await https_cloud.async_voucher(
                    doorbell["session"], doorbell["device_id"], doorbell["credential"],
                    "ha_cert", ha_key,
                )
                res = await https_cloud.async_sign(vps, voucher, csr)
                chain = str(res.get("cert") or "").encode("ascii")

                def _store_and_check() -> bool:
                    if not https_certs.public_cert_usable(chain, key, hostname):
                        return False
                    https_certs.write_public(self.public_chain_path, chain)
                    return True

                if not await self.hass.async_add_executor_job(_store_and_check):
                    raise https_cloud.PublicNameError("bad_certificate_from_vps")
                _LOGGER.info(
                    "Public certificate for %s %s", hostname,
                    "reused" if res.get("reused") else "issued",
                )

            if self.sni.public_name != hostname.lower() or due:
                await self.hass.async_add_executor_job(
                    self.sni.load_public, hostname, self.public_chain_path, self.public_key_path
                )
            not_after_ts = await self.hass.async_add_executor_job(self._public_not_after)
            self.public = {"state": "ok", "hostname": hostname, "not_after": not_after_ts}
            self._reset_retry()
            for issue in PUBLIC_ISSUES:
                ir.async_delete_issue(self.hass, DOMAIN, issue)
        except https_cloud.PublicNameError as err:
            self._public_failed(err, hostname)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001 - the local path must survive anything here
            _LOGGER.exception("Public name upkeep failed")
            self._public_failed(https_cloud.PublicNameError("internal", None, {"error": str(err)}), hostname)

    def _public_not_after(self) -> int | None:
        try:
            cert = https_certs.load_cert_chain_first(self.public_chain_path.read_bytes())
        except (OSError, ValueError, IndexError):
            return None
        return int(https_certs.not_after(cert).timestamp())

    def _read_adopt(self) -> dict | None:
        """Internal drop-in for moving an existing name (switch-over of an existing install):
        `adopt.json` = {"ha_instance_id", "ha_secret"}. Deleted once a claim succeeds."""
        try:
            data = json.loads(self.adopt_path.read_text())
        except (OSError, ValueError):
            return None
        if isinstance(data, dict) and data.get("ha_instance_id") and data.get("ha_secret"):
            return {"ha_instance_id": str(data["ha_instance_id"]), "ha_secret": str(data["ha_secret"])}
        return None

    async def _async_claim(self, doorbell: dict, vps, ha_key: str, ip: str, adopt: dict | None) -> dict:
        voucher = await https_cloud.async_voucher(
            doorbell["session"], doorbell["device_id"], doorbell["credential"], "ha_claim", ha_key
        )
        try:
            return await https_cloud.async_claim(vps, voucher, ip, replace=self._replace_next, adopt=adopt)
        except https_cloud.PublicNameError as err:
            if err.code != "adopt_rejected" or not adopt:
                raise
            _LOGGER.warning("The existing name could not be taken over (%s); claiming a new one", err)
            await self.hass.async_add_executor_job(self.adopt_path.unlink, True)
            voucher = await https_cloud.async_voucher(
                doorbell["session"], doorbell["device_id"], doorbell["credential"], "ha_claim", ha_key
            )
            return await https_cloud.async_claim(vps, voucher, ip, replace=self._replace_next)

    def _public_failed(self, err: https_cloud.PublicNameError, hostname: str | None) -> None:
        code = err.code
        still_valid = self.sni is not None and self.sni.public is not None
        self.public = {
            "state": "ok" if still_valid else "unavailable",
            "hostname": hostname if still_valid else None,
            "code": code,
            "not_after": self.public.get("not_after") if still_valid else None,
        }
        if code in https_cloud.PERMANENT or code == "no_doorbell":
            self._public_permanent = code
        issue, placeholders = ISSUE_PUBLIC_FAILED, {"code": code}
        if code == "admin_required":
            issue, placeholders = ISSUE_ADMIN_REQUIRED, {}
        elif code == "device_not_paired":
            issue, placeholders = ISSUE_NOT_REGISTERED, {}
        elif code == "doorbell_has_ha_name":
            issue, placeholders = ISSUE_NAME_TAKEN, {"hostname": str(err.detail.get("hostname") or "")}
        transient = code not in https_cloud.PERMANENT and code != "no_doorbell"
        delay = None
        if transient:
            now = dt_util.utcnow()
            if self._failing_since is None:
                self._failing_since = now
            delays = PUBLIC_RETRY_DELAYS_S
            delay = delays[self._fail_streak] if self._fail_streak < len(delays) else None
            self._fail_streak += 1
            if self._retry_unsub is not None:
                self._retry_unsub()
                self._retry_unsub = None
            if delay is not None:
                # Beyond the list, the hourly upkeep (_async_periodic) is the retry.
                self._retry_unsub = async_call_later(self.hass, delay, self._retry_public)
        _LOGGER.log(
            logging.INFO if transient else logging.WARNING,
            "Public name for Home Assistant not available (%s)%s; local HTTPS is not affected",
            code,
            (f", retrying in {delay} s" if delay is not None else ", retrying within the hour")
            if transient else "",
        )
        if (
            transient
            and code in ("vps_unreachable", "doorbell_unreachable", "rate_limited",
                         "upstream_failed", "clock_not_set")
            and dt_util.utcnow() - self._failing_since < PUBLIC_REPAIR_AFTER
        ):
            # Weather, not a fault: no repair issue for a line that is down for a while. After
            # PUBLIC_REPAIR_AFTER of failing it is not weather any more, and the user is told.
            # `issuance_limited` is left out ON PURPOSE: it is retried like the others, but the
            # cloud's quota (3 certificates per name per 7 days) can hold for days, so the
            # repair appears at once (docs/https.md, "Repairs you may see").
            return
        for other in PUBLIC_ISSUES:
            if other != issue:
                ir.async_delete_issue(self.hass, DOMAIN, other)
        ir.async_create_issue(
            self.hass, DOMAIN, issue, is_fixable=issue == ISSUE_NAME_TAKEN,
            severity=ir.IssueSeverity.WARNING, translation_key=issue,
            translation_placeholders=placeholders,
        )

    # ------------------------------------------------------------------ status
    def install_url(self) -> str | None:
        """Where a phone on the LAN opens the install page: HA's own port, plain LAN address."""
        api = getattr(self.hass.config, "api", None)
        if api is None or not api.local_ip:
            return None
        scheme = "https" if api.use_ssl else "http"
        return f"{scheme}://{api.local_ip}:{api.port}{INSTALL_PATH}"

    def status(self) -> dict[str, Any]:
        dns, ips = self.local_names
        running = self.server is not None
        local_urls: list[str] = []
        if running:
            port = self.bound_port
            for ip in ips:
                if ip.startswith("127.") or ip == "::1" or ip.startswith("fe80") or ip.startswith("172.17."):
                    continue
                host = f"[{ip}]" if ":" in ip else ip
                local_urls.append(f"https://{host}:{port}")
            for name in dns:
                if name.endswith(".local"):
                    local_urls.append(f"https://{name}:{port}")
        public = dict(self.public)
        if running and public.get("state") == "ok" and public.get("hostname"):
            public["url"] = f"https://{public['hostname']}:{self.bound_port}"
        return {
            "enabled": self.enabled,
            "running": running,
            "port": self.bound_port or self.port,
            "error": self.error,
            "local_urls": local_urls,
            "fingerprint": self.fingerprint,
            "ca_name": self.ca_name,
            "constrained": self.constrained,
            "public": public,
            "install_url": self.install_url(),
        }
