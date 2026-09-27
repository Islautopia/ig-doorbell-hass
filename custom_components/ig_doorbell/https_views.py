"""The root-install page and what it needs, served by Home Assistant's own HTTP server.

    /ig_doorbell/https               the page (frontend/https-install.html)
    /ig_doorbell/https/status        what the page shows (JSON)
    /ig_doorbell/https/root.crt      the local root, PEM (Android, Windows, macOS, Linux)
    /ig_doorbell/https/root.mobileconfig   the same root as an Apple profile (iPhone, iPad)
    /ig_doorbell/https/qr.svg        QR of the page's address, to open it on a phone
    /ig_doorbell/https/check         answers over the HTTPS port; the page's "Check" fetches it
    /ig_doorbell/https/logo.png      the integration's logo

Served on Home Assistant's port (8123), NOT on a port of our own: the page has to open BEFORE the
device trusts anything, so it must be reachable over whatever the user already uses, and a second
plain-HTTP port would be one more thing to open, collide or explain. Through the HTTPS port the
same routes exist too, since that port serves the whole Home Assistant.

⚠️ NO AUTHENTICATION, BUT ONLY FROM THE LOCAL NETWORK. The device installing the root is by
definition not logged in yet (it is often a phone opening a QR). Nothing here is secret - a root
CERTIFICATE is public by nature, its private key is never served - but the page does list the
Home Assistant's LAN addresses and public name, so a request from a non-local address (Home
Assistant exposed through a cloud tunnel or a reverse proxy) gets 403.
"""
from __future__ import annotations

import io
from http import HTTPStatus
from ipaddress import ip_address
from pathlib import Path

from aiohttp import web

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback
from homeassistant.util.network import is_local

from . import https_certs
from .https_manager import INSTALL_PATH, get_manager

PAGE_PATH = Path(__file__).parent / "frontend" / "https-install.html"
LOGO_PATH = Path(__file__).parent / "brand" / "icon.png"
DATA_VIEWS = "ig_doorbell_https_views"


def _from_lan(request: web.Request) -> bool:
    try:
        return is_local(ip_address(request.remote or ""))
    except ValueError:
        return False


def _forbidden() -> web.Response:
    return web.Response(
        status=HTTPStatus.FORBIDDEN,
        text="Open this page from your home network.",
        content_type="text/plain",
    )


_NO_STORE = {"Cache-Control": "no-store"}


class _LanView(HomeAssistantView):
    requires_auth = False
    cors_allowed = False


class InstallPageView(_LanView):
    url = INSTALL_PATH
    name = "ig_doorbell:https:page"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        hass: HomeAssistant = request.app["hass"]
        html = await hass.async_add_executor_job(PAGE_PATH.read_bytes)
        return web.Response(
            body=html, content_type="text/html", charset="utf-8", headers=_NO_STORE
        )


class StatusView(_LanView):
    url = INSTALL_PATH + "/status"
    name = "ig_doorbell:https:status"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        hass: HomeAssistant = request.app["hass"]
        mgr = get_manager(hass)
        status = mgr.status() if mgr else {"enabled": False, "running": False}
        status["page_url"] = _page_url(request, mgr)
        status["secure_here"] = request.secure
        return web.json_response(status, headers=_NO_STORE)


def _page_url(request: web.Request, mgr) -> str:
    """The address a PHONE should open: HA's LAN address if known (a desktop may be on
    `homeassistant.local`, which some phones do not resolve), else what this request used."""
    if mgr is not None and (url := mgr.install_url()):
        return url
    return str(request.url.with_path(INSTALL_PATH).with_query(None))


class RootCertView(_LanView):
    url = INSTALL_PATH + "/root.crt"
    name = "ig_doorbell:https:root"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        mgr = get_manager(request.app["hass"])
        if mgr is None or not await request.app["hass"].async_add_executor_job(mgr.ca.exists):
            return web.Response(status=HTTPStatus.NOT_FOUND, text="HTTPS is not enabled")
        pem = await request.app["hass"].async_add_executor_job(mgr.ca.cert_pem)
        return web.Response(
            body=pem,
            content_type="application/x-x509-ca-cert",
            headers={
                "Content-Disposition": 'attachment; filename="ig-doorbell-ha-root.crt"',
                **_NO_STORE,
            },
        )


class MobileConfigView(_LanView):
    url = INSTALL_PATH + "/root.mobileconfig"
    name = "ig_doorbell:https:mobileconfig"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        hass = request.app["hass"]
        mgr = get_manager(hass)
        if mgr is None or not await hass.async_add_executor_job(mgr.ca.exists):
            return web.Response(status=HTTPStatus.NOT_FOUND, text="HTTPS is not enabled")

        def _build() -> bytes:
            return https_certs.mobileconfig(mgr.ca.cert_der(), mgr.ca.common_name(), mgr.ca.fingerprint())

        body = await hass.async_add_executor_job(_build)
        return web.Response(
            body=body,
            content_type="application/x-apple-aspen-config",
            headers={
                "Content-Disposition": 'attachment; filename="ig-doorbell-ha.mobileconfig"',
                **_NO_STORE,
            },
        )


class QrView(_LanView):
    url = INSTALL_PATH + "/qr.svg"
    name = "ig_doorbell:https:qr"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        hass = request.app["hass"]
        # Only ever OUR page's address: a QR endpoint that encodes arbitrary text would be a
        # free phishing-QR printer with this Home Assistant's name on it.
        target = _page_url(request, get_manager(hass))

        def _svg() -> bytes:
            import segno  # noqa: PLC0415 - imported late: only this view needs it

            buf = io.BytesIO()
            segno.make(target, error="m").save(buf, kind="svg", scale=6, border=2, dark="#070D1A", light="#FFFFFF")
            return buf.getvalue()

        return web.Response(body=await hass.async_add_executor_job(_svg), content_type="image/svg+xml", headers=_NO_STORE)


class CheckView(_LanView):
    """Fetched by the page ACROSS origins (http://ip:8123 → https://ip:8443): if the fetch
    resolves at all, the browser completed a TLS handshake it trusts. `secure` confirms it arrived
    over TLS. CORS open on purpose - the answer carries nothing but that."""

    url = INSTALL_PATH + "/check"
    name = "ig_doorbell:https:check"

    async def get(self, request: web.Request) -> web.Response:
        if not _from_lan(request):
            return _forbidden()
        return web.json_response(
            {"ok": True, "secure": request.secure, "host": request.host},
            headers={"Access-Control-Allow-Origin": "*", **_NO_STORE},
        )


class LogoView(_LanView):
    url = INSTALL_PATH + "/logo.png"
    name = "ig_doorbell:https:logo"

    async def get(self, request: web.Request) -> web.Response:
        hass = request.app["hass"]
        body = await hass.async_add_executor_job(LOGO_PATH.read_bytes)
        return web.Response(body=body, content_type="image/png", headers={"Cache-Control": "max-age=86400"})


@callback
def async_register_https_views(hass: HomeAssistant) -> None:
    if hass.data.get(DATA_VIEWS):
        return
    hass.data[DATA_VIEWS] = True
    for view in (InstallPageView, StatusView, RootCertView, MobileConfigView, QrView, CheckView, LogoView):
        hass.http.register_view(view())
