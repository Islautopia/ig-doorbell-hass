"""1.1.0: secure local connection (HTTPS) served by the integration.

What these tests pin, each with its negative and positive control:
- the local root carries NAME CONSTRAINTS, and a verifier really enforces them (a leaf for a public
  site signed with the same key is REJECTED; the legitimate leaf is accepted);
- the leaf never carries a name outside the constraints (one public IP would break it everywhere);
- a real TLS listener handed to a web runner, with the certificate chosen per connection by SNI:
  bare IP and unknown names get the local leaf, the public name gets the public certificate;
- OFF by default: nothing listens and the cloud is never called;
- a taken port is a repair issue and a clear form error, never a crash;
- the public name: the key stays here (only a CSR travels), the voucher comes from the doorbell,
  the certificate is only accepted for our key and name; admin_required / name taken become
  repair issues and the local path keeps running;
- the install page and its files answer only to the local network.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import socket
import ssl
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from aiohttp import web
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from homeassistant.config_entries import ConfigEntryState
from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.ig_doorbell import https_certs, https_cloud, https_manager
from custom_components.ig_doorbell.const import DOMAIN

from .conftest import CREDENTIAL, DEVICE_ID

PUBLIC = "0123456789abcdef.ha.doorbell.islautopia.com"

# Real sockets on 127.0.0.1: the listener and the handshakes are the thing under test.
pytestmark = pytest.mark.usefixtures("socket_enabled")


class _LanSession:
    """Stands in for the entry's LAN session; only its identity matters here."""

    async def close(self) -> None:
        return None


# ----------------------------------------------------------------------------- helpers
def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _client_ctx(cafile: Path | None = None, cadata: str | None = None, check_hostname=True):
    ctx = ssl.create_default_context(cafile=str(cafile) if cafile else None, cadata=cadata)
    ctx.check_hostname = check_hostname
    return ctx


def _handshake(port: int, ctx: ssl.SSLContext, sni: str | None) -> x509.Certificate:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        with ctx.wrap_socket(raw, server_hostname=sni) as tls:
            return x509.load_der_x509_certificate(tls.getpeercert(binary_form=True))


def _sign_as_fake_le(csr_pem: str, days: int = 90) -> tuple[str, bytes]:
    """Stand-in for Let's Encrypt: signs the CSR with a throwaway CA. Returns (chain, ca_pem)."""
    ca_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Fake LE")])
    now = dt.datetime.now(dt.timezone.utc)
    ca = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name)
        .public_key(ca_key.public_key()).serial_number(1)
        .not_valid_before(now - dt.timedelta(hours=1)).not_valid_after(now + dt.timedelta(days=900))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    csr = x509.load_pem_x509_csr(csr_pem.encode())
    leaf = (
        x509.CertificateBuilder().subject_name(csr.subject).issuer_name(name)
        .public_key(csr.public_key()).serial_number(2)
        .not_valid_before(now - dt.timedelta(hours=1)).not_valid_after(now + dt.timedelta(days=days))
        .add_extension(csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value, critical=False)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    return (leaf.public_bytes(pem) + ca.public_bytes(pem)).decode(), ca.public_bytes(pem)


ADAPTERS = [
    {"enabled": True, "ipv4": [{"address": "192.168.1.10"}], "ipv6": []},
    # A public address on some adapter: must NOT reach the leaf (constraints).
    {"enabled": True, "ipv4": [{"address": "8.8.4.4"}], "ipv6": []},
    {"enabled": False, "ipv4": [{"address": "10.9.9.9"}], "ipv6": []},
]


class _Runner:
    """A real aiohttp server factory standing in for hass.http.runner."""

    def __init__(self) -> None:
        async def probe(request: web.Request) -> web.Response:
            return web.json_response({"secure": request.secure, "remote": request.remote,
                                      "xff": request.headers.get("X-Forwarded-For")})

        self.app = web.Application()
        self.app.router.add_get("/probe", probe)
        self.runner = web.AppRunner(self.app)

    @property
    def server(self):
        return self.runner.server


@pytest.fixture
async def env(hass, tmp_path, monkeypatch):
    """A manager with a real listener factory, fake adapters and one loaded doorbell entry."""
    monkeypatch.setattr(hass.config, "config_dir", str(tmp_path))
    # The negative handshakes below make the CLIENT abort (unknown CA). asyncio reports that
    # through the loop's exception handler only in debug mode, which the harness turns on and
    # then counts as a test failure. Production loops are not in debug mode; HA's own TLS port
    # behaves the same way.
    was_debug = hass.loop.get_debug()
    hass.loop.set_debug(False)
    runner = _Runner()
    await runner.runner.setup()
    fake_http = SimpleNamespace(runner=runner, server_host=["127.0.0.1"], server_port=8123)
    monkeypatch.setattr(hass, "http", fake_http, raising=False)
    monkeypatch.setattr(hass.config, "api", SimpleNamespace(local_ip="192.168.1.10", port=8123, use_ssl=False), raising=False)

    async def _adapters(_hass):
        return ADAPTERS

    async def _source(_hass, *a):
        return "192.168.1.10"

    monkeypatch.setattr(https_manager.network, "async_get_adapters", _adapters)
    monkeypatch.setattr(https_manager.network, "async_get_source_ip", _source)

    entry = MockConfigEntry(domain=DOMAIN, data={"device_id": DEVICE_ID, "credential": CREDENTIAL}, unique_id=DEVICE_ID)
    entry.add_to_hass(hass)
    entry.mock_state(hass, ConfigEntryState.LOADED)
    lan_session = _LanSession()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = {"session": lan_session}

    mgr = https_manager.HttpsManager(hass)
    mgr.started = True
    hass.data[https_manager.DATA_HTTPS] = mgr
    yield SimpleNamespace(mgr=mgr, runner=runner, entry=entry, lan_session=lan_session,
                          dir=tmp_path / https_manager.FILES_DIR, fake_http=fake_http)
    await mgr.async_shutdown()
    await runner.runner.cleanup()
    hass.loop.set_debug(was_debug)


class _Cloud:
    """Records every call to the cloud path; answers like the contract (§4-ter)."""

    def __init__(self, *, voucher_error=None, claim_errors=()):
        self.vouchers: list[tuple] = []
        self.claims: list[dict] = []
        self.signs: list[dict] = []
        self.voucher_error = voucher_error
        self.claim_errors = list(claim_errors)
        self.le_ca: bytes | None = None

    async def voucher(self, session, device_id, credential, purpose, ha_key):
        self.vouchers.append((session, device_id, credential, purpose, ha_key))
        if self.voucher_error:
            raise https_cloud.PublicNameError(self.voucher_error, 403)
        return f"igv1.fake.{purpose}.{len(self.vouchers)}"

    async def claim(self, session, voucher, ip, *, replace=False, adopt=None):
        self.claims.append({"voucher": voucher, "ip": ip, "replace": replace, "adopt": adopt})
        if self.claim_errors:
            code, detail = self.claim_errors.pop(0)
            raise https_cloud.PublicNameError(code, 409, detail)
        return {"hostname": PUBLIC, "ha_instance_id": PUBLIC.split(".")[0], "status": "created"}

    async def sign(self, session, voucher, csr_pem):
        self.signs.append({"voucher": voucher, "csr": csr_pem})
        chain, self.le_ca = _sign_as_fake_le(csr_pem)
        return {"hostname": PUBLIC, "cert": chain, "not_after": 0, "reused": False}

    def patch(self):
        return (
            patch.object(https_cloud, "async_voucher", self.voucher),
            patch.object(https_cloud, "async_claim", self.claim),
            patch.object(https_cloud, "async_sign", self.sign),
        )


async def _enable(env, cloud: _Cloud, port: int | None = None):
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        await env.mgr.async_configure(enabled=True, port=port or _free_port(), device_id=DEVICE_ID)
        if env.mgr._public_task is not None:
            await env.mgr._public_task


# ----------------------------------------------------------------------------- certificates
def test_root_is_name_constrained_and_openssl_enforces_it(tmp_path):
    ca = https_certs.LocalCA(tmp_path)
    ca.ensure()
    nc = ca.cert().extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical
    dns = {n.value for n in nc.value.permitted_subtrees if isinstance(n, x509.DNSName)}
    assert dns == {"local", "localhost", "ha.doorbell.islautopia.com"}

    leaf = ca.issue_leaf(["homeassistant.local"], ["192.168.1.10"])
    # POSITIVE control: the legitimate leaf passes a real OpenSSL handshake against the root.
    _tls_roundtrip(ca.ca_cert_path, leaf.chain.read_bytes(), leaf.key.read_bytes(), "homeassistant.local")
    # NEGATIVE control: a leaf for a public site, signed with the SAME root key, is rejected by
    # OpenSSL - which is what makes a leaked root key useless against other websites.
    chain, key = _rogue_leaf(ca, "www.example.com")
    with pytest.raises(ssl.SSLCertVerificationError, match="(?i)name constraint|permitted"):
        _tls_roundtrip(ca.ca_cert_path, chain, key, "www.example.com")
    # ...and the same rogue leaf WOULD pass under an unconstrained root (proves the rejection
    # above comes from the constraints, not from something else wrong with the rogue leaf).
    unconstrained = _unconstrained_copy(ca, tmp_path / "plain")
    chain2, key2 = _rogue_leaf(unconstrained, "www.example.com")
    _tls_roundtrip(unconstrained.ca_cert_path, chain2, key2, "www.example.com")


def _rogue_leaf(ca: https_certs.LocalCA, name: str) -> tuple[bytes, bytes]:
    key = serialization.load_pem_private_key(ca.ca_key_path.read_bytes(), None)
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "x")]))
        .issuer_name(ca.cert().subject).public_key(leaf_key.public_key()).serial_number(7)
        .not_valid_before(now - dt.timedelta(minutes=1)).not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(name)]), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    pem = serialization.Encoding.PEM
    key_pem = leaf_key.private_bytes(pem, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return cert.public_bytes(pem) + ca.cert_pem(), key_pem


def _unconstrained_copy(ca: https_certs.LocalCA, directory: Path) -> https_certs.LocalCA:
    """Same key, same name, NO constraints: the control for the rogue-leaf test."""
    key = serialization.load_pem_private_key(ca.ca_key_path.read_bytes(), None)
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(ca.cert().subject).issuer_name(ca.cert().subject)
        .public_key(key.public_key()).serial_number(9)
        .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .sign(key, hashes.SHA256())
    )
    other = https_certs.LocalCA(directory)
    directory.mkdir()
    other.ca_key_path.write_bytes(ca.ca_key_path.read_bytes())
    other.ca_cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return other


def _tls_roundtrip(cafile: Path, chain_pem: bytes, key_pem: bytes, hostname: str) -> None:
    """A throwaway TLS server with `chain_pem`, and an OpenSSL client verifying against `cafile`."""
    import tempfile
    import threading

    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "c.pem").write_bytes(chain_pem)
        (Path(d) / "k.pem").write_bytes(key_pem)
        sctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        sctx.load_cert_chain(Path(d) / "c.pem", Path(d) / "k.pem")
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)

    def _serve():
        conn, _ = srv.accept()
        try:
            with sctx.wrap_socket(conn, server_side=True) as tls:
                tls.recv(1)
        except (ssl.SSLError, OSError):
            pass

    t = threading.Thread(target=_serve, daemon=True)
    t.start()
    try:
        _handshake(srv.getsockname()[1], _client_ctx(cafile), hostname)
    finally:
        srv.close()
        t.join(5)


def test_leaf_never_carries_a_name_outside_the_constraints(tmp_path):
    ca = https_certs.LocalCA(tmp_path)
    ca.ensure()
    leaf = ca.issue_leaf(["homeassistant.local", "evil.example.com", PUBLIC], ["192.168.1.10", "8.8.4.4", "fe80::1"])
    dns, ips = https_certs.cert_san(https_certs.load_cert_chain_first(leaf.chain.read_bytes()))
    assert dns == {"homeassistant.local", PUBLIC}
    assert ips == {"192.168.1.10", "fe80::1"}


def test_csr_carries_only_the_public_key_and_the_name():
    key = ec.generate_private_key(ec.SECP256R1())
    csr_pem = https_certs.make_csr(key, PUBLIC)
    assert "PRIVATE" not in csr_pem
    csr = x509.load_pem_x509_csr(csr_pem.encode())
    assert csr.is_signature_valid
    sans = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
    assert sans == [PUBLIC]
    assert https_certs.spki_sha256(csr.public_key()) == https_certs.spki_sha256(key.public_key())


def test_mobileconfig_carries_the_root_and_nothing_private(tmp_path):
    ca = https_certs.LocalCA(tmp_path)
    ca.ensure()
    body = https_certs.mobileconfig(ca.cert_der(), ca.common_name(), ca.fingerprint()).decode()
    import base64
    import plistlib

    plist = plistlib.loads(body.encode())
    payload = plist["PayloadContent"][0]
    assert payload["PayloadType"] == "com.apple.security.root"
    assert x509.load_der_x509_certificate(payload["PayloadContent"]).fingerprint(hashes.SHA256()) == ca.cert().fingerprint(hashes.SHA256())
    assert "PRIVATE" not in body and base64 is not None


# ----------------------------------------------------------------------------- listener
async def test_off_by_default_nothing_listens_and_the_cloud_is_never_called(hass, env):
    cloud = _Cloud()
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        await env.mgr.async_apply()
    assert not env.mgr.enabled
    assert env.mgr.server is None
    assert cloud.vouchers == [] and cloud.claims == [] and cloud.signs == []
    assert not env.dir.exists()  # not even a key generated


async def test_sni_picks_the_certificate_and_ha_sees_the_real_client(hass, env):
    cloud = _Cloud()
    port = _free_port()
    await _enable(env, cloud, port)
    assert env.mgr.server is not None, env.mgr.error
    ca_file = env.dir / "ca.crt"

    # Bare IP (no SNI) -> local leaf, valid against the local root.
    leaf = await hass.async_add_executor_job(_handshake, port, _client_ctx(ca_file, check_hostname=False), None)
    assert "192.168.1.10" in https_certs.cert_san(leaf)[1]
    # homeassistant.local -> local leaf, hostname checked.
    leaf = await hass.async_add_executor_job(_handshake, port, _client_ctx(ca_file), "homeassistant.local")
    assert leaf.issuer == x509.load_pem_x509_certificate(ca_file.read_bytes()).subject
    # Public name -> the public certificate, valid against ITS CA and not against the local one.
    pub = await hass.async_add_executor_job(_handshake, port, _client_ctx(cadata=cloud.le_ca.decode()), PUBLIC)
    assert pub.issuer.rfc4514_string() == "CN=Fake LE"
    with pytest.raises(ssl.SSLCertVerificationError):
        await hass.async_add_executor_job(_handshake, port, _client_ctx(ca_file), PUBLIC + "x")
    # Unknown name -> local leaf (negative: public CA does not validate it).
    with pytest.raises(ssl.SSLCertVerificationError):
        await hass.async_add_executor_job(_handshake, port, _client_ctx(cadata=cloud.le_ca.decode(), check_hostname=False), "other.example")

    # A real HTTP request through it: HA (here the stand-in runner) sees TLS and the real peer,
    # and no forwarded header exists.
    import aiohttp

    async with aiohttp.ClientSession() as s:
        async with s.get(f"https://127.0.0.1:{port}/probe", ssl=_client_ctx(ca_file, check_hostname=False)) as r:
            body = await r.json()
    assert body == {"secure": True, "remote": "127.0.0.1", "xff": None}


async def test_public_name_key_stays_here_and_only_a_csr_travels(hass, env):
    cloud = _Cloud()
    await _enable(env, cloud)
    assert env.mgr.public["state"] == "ok", env.mgr.public
    # Vouchers asked of the doorbell over the entry's LAN session, with its credential.
    assert [v[3] for v in cloud.vouchers] == ["ha_claim", "ha_cert"]
    assert all(v[0] is env.lan_session and v[1] == DEVICE_ID and v[2] == CREDENTIAL for v in cloud.vouchers)
    key = serialization.load_pem_private_key((env.dir / "public.key").read_bytes(), None)
    ha_key = https_certs.spki_sha256(key.public_key())
    assert all(v[4] == ha_key for v in cloud.vouchers)
    assert cloud.claims[0]["ip"] == "192.168.1.10" and cloud.claims[0]["replace"] is False
    sent = repr(cloud.claims) + repr(cloud.signs)
    key_pem = (env.dir / "public.key").read_text()
    assert "PRIVATE" not in sent and key_pem.splitlines()[1] not in sent
    # The local leaf now also covers the public name (works for root-trusting devices offline).
    dns, _ = https_certs.cert_san(https_certs.load_cert_chain_first((env.dir / "local-fullchain.crt").read_bytes()))
    assert PUBLIC in dns


async def test_a_certificate_for_another_key_is_refused(hass, env):
    cloud = _Cloud()

    async def sign_other(session, voucher, csr_pem):
        other = https_certs.make_csr(ec.generate_private_key(ec.SECP256R1()), PUBLIC)
        chain, cloud.le_ca = _sign_as_fake_le(other)
        return {"hostname": PUBLIC, "cert": chain, "not_after": 0, "reused": False}

    cloud.sign = sign_other
    await _enable(env, cloud)
    assert env.mgr.public["state"] == "unavailable"
    assert env.mgr.public["code"] == "bad_certificate_from_vps"
    assert env.mgr.sni.public is None
    assert env.mgr.server is not None  # local path unaffected


async def test_guest_pairing_gets_a_repair_and_keeps_local_https(hass, env):
    cloud = _Cloud(voucher_error="admin_required")
    await _enable(env, cloud)
    assert env.mgr.server is not None
    assert env.mgr.public["state"] == "unavailable"
    issues = ir.async_get(hass).issues
    assert (DOMAIN, https_manager.ISSUE_ADMIN_REQUIRED) in issues
    # Permanent: the hourly upkeep does not hammer the doorbell.
    n = len(cloud.vouchers)
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        await env.mgr._async_periodic()
        if env.mgr._public_task is not None:
            await env.mgr._public_task
    assert len(cloud.vouchers) == n


async def test_name_held_by_another_ha_is_a_fixable_repair_that_moves_it(hass, env):
    cloud = _Cloud(claim_errors=[("doorbell_has_ha_name", {"hostname": PUBLIC})])
    await _enable(env, cloud)
    issue = ir.async_get(hass).issues.get((DOMAIN, https_manager.ISSUE_NAME_TAKEN))
    assert issue is not None and issue.is_fixable
    assert cloud.claims[-1]["replace"] is False
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        env.mgr.request_replace()
        await env.mgr._public_task
    assert cloud.claims[-1]["replace"] is True
    assert env.mgr.public["state"] == "ok"
    assert (DOMAIN, https_manager.ISSUE_NAME_TAKEN) not in ir.async_get(hass).issues


async def test_a_taken_port_is_a_repair_not_a_crash(hass, env):
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    blocker.listen()
    port = blocker.getsockname()[1]
    try:
        await _enable(env, _Cloud(), port)
        assert env.mgr.server is None
        assert env.mgr.error == "port_in_use"
        issue = ir.async_get(hass).issues.get((DOMAIN, https_manager.ISSUE_PORT_IN_USE))
        assert issue is not None and issue.translation_placeholders == {"port": str(port)}
    finally:
        blocker.close()


async def test_disabling_closes_the_port_and_clears_the_issues(hass, env):
    port = _free_port()
    await _enable(env, _Cloud(voucher_error="admin_required"), port)
    assert env.mgr.server is not None
    await env.mgr.async_configure(enabled=False, port=port, device_id=DEVICE_ID)
    assert env.mgr.server is None
    assert (DOMAIN, https_manager.ISSUE_ADMIN_REQUIRED) not in ir.async_get(hass).issues
    with pytest.raises(OSError):
        await hass.async_add_executor_job(socket.create_connection, ("127.0.0.1", port), 2)


# ----------------------------------------------------------------------------- install page
@pytest.fixture
async def page(hass, hass_client_no_auth, tmp_path, monkeypatch, socket_enabled):
    from homeassistant.setup import async_setup_component

    from custom_components.ig_doorbell import https_views

    monkeypatch.setattr(hass.config, "config_dir", str(tmp_path))
    await async_setup_component(hass, "http", {})
    https_views.async_register_https_views(hass)
    mgr = https_manager.HttpsManager(hass)
    hass.data[https_manager.DATA_HTTPS] = mgr
    client = await hass_client_no_auth()
    return SimpleNamespace(client=client, mgr=mgr)


async def test_install_page_and_files_from_the_lan(hass, page):
    # HTTPS off: the page still opens (it explains how to turn it on), the root does not exist.
    r = await page.client.get("/ig_doorbell/https")
    assert r.status == 200 and "text/html" in r.headers["Content-Type"]
    html = await r.text()
    assert "/ig_doorbell/https/status" in html and "root.mobileconfig" in html
    st = await (await page.client.get("/ig_doorbell/https/status")).json()
    assert st["enabled"] is False and st["running"] is False
    assert (await page.client.get("/ig_doorbell/https/root.crt")).status == 404

    await hass.async_add_executor_job(page.mgr.ca.ensure)
    r = await page.client.get("/ig_doorbell/https/root.crt")
    assert r.status == 200
    pem = await r.read()
    assert b"BEGIN CERTIFICATE" in pem and b"PRIVATE" not in pem
    r = await page.client.get("/ig_doorbell/https/root.mobileconfig")
    assert r.status == 200 and r.headers["Content-Type"].startswith("application/x-apple-aspen-config")
    r = await page.client.get("/ig_doorbell/https/qr.svg")
    assert r.status == 200 and b"<svg" in await r.read()
    r = await page.client.get("/ig_doorbell/https/check")
    assert r.status == 200 and r.headers["Access-Control-Allow-Origin"] == "*"
    assert (await r.json())["secure"] is False  # plain HTTP here: the page's check needs TLS


async def test_install_page_refuses_requests_from_outside_the_lan(hass, page):
    from custom_components.ig_doorbell import https_views

    await hass.async_add_executor_job(page.mgr.ca.ensure)
    for view in (https_views.InstallPageView, https_views.StatusView, https_views.RootCertView,
                 https_views.MobileConfigView, https_views.QrView, https_views.CheckView):
        outside = SimpleNamespace(remote="203.0.113.7", app={"hass": hass}, secure=False)
        inside = SimpleNamespace(remote="192.168.1.20", app={"hass": hass}, secure=False,
                                 url=None, host="x")
        assert (await view().get(outside)).status == 403, view
        if view is not https_views.StatusView:  # status needs a full request (url)
            assert (await view().get(inside)).status == 200, view


async def test_card_learns_where_the_install_page_is_and_nothing_secret(hass, hass_ws_client, tmp_path, monkeypatch):
    from custom_components.ig_doorbell import websocket_api as wsapi

    monkeypatch.setattr(hass.config, "config_dir", str(tmp_path))
    hass.data[https_manager.DATA_HTTPS] = https_manager.HttpsManager(hass)
    wsapi.async_register_websocket_commands(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json({"id": 1, "type": "ig_doorbell/https_status"})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"]["enabled"] is False and msg["result"]["install_path"] == "/ig_doorbell/https"
    assert set(msg["result"]) == {"enabled", "running", "port", "install_path", "install_url", "public_url"}


# ----------------------------------------------------------------------------- options flow
async def _https_step(hass, env):
    result = await hass.config_entries.options.async_init(env.entry.entry_id)
    # Opening the options loads the integration, which sets up the real `http` component over
    # our stand-in runner (not started in tests): put the stand-in back.
    hass.http = env.fake_http
    assert result["type"] == "menu" and "https" in result["menu_options"]
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"next_step_id": "https"})
    assert result["step_id"] == "https"
    return result


async def test_options_refuse_a_taken_port_and_ha_own_port_in_the_form(hass, env):
    blocker = socket.socket()
    blocker.bind(("0.0.0.0", 0))
    blocker.listen()
    taken = blocker.getsockname()[1]
    try:
        result = await _https_step(hass, env)
        assert result["description_placeholders"]["install_url"] == "http://192.168.1.10:8123/ig_doorbell/https"
        result = await hass.config_entries.options.async_configure(result["flow_id"], {"enabled": True, "port": taken})
        assert result["errors"] == {"port": "port_in_use"}
        result = await hass.config_entries.options.async_configure(result["flow_id"], {"enabled": True, "port": 8123})
        assert result["errors"] == {"port": "port_is_ha"}
        assert env.mgr.enabled is False and env.mgr.server is None  # nothing half-applied
    finally:
        blocker.close()


async def test_options_enable_applies_at_once_and_keeps_the_entry_options(hass, env):
    hass.config_entries.async_update_entry(env.entry, options={"entities": ["light.porch"]})
    cloud = _Cloud(voucher_error="device_not_paired")
    port = _free_port()
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        result = await _https_step(hass, env)
        result = await hass.config_entries.options.async_configure(result["flow_id"], {"enabled": True, "port": port})
        assert result["type"] == "create_entry"
        if env.mgr._public_task is not None:
            await env.mgr._public_task
    assert env.entry.options == {"entities": ["light.porch"]}
    assert env.mgr.enabled and env.mgr.server is not None and env.mgr.bound_port == port, (env.mgr.error, env.mgr.data)
    assert (DOMAIN, https_manager.ISSUE_NOT_REGISTERED) in ir.async_get(hass).issues
    # Stored for the next start.
    stored = await https_manager.Store(hass, https_manager.STORAGE_VERSION, https_manager.STORAGE_KEY).async_load()
    assert stored["enabled"] is True and stored["port"] == port and stored["device_id"] == DEVICE_ID


# ----------------------------------------------------------------------------- existing name / root
async def test_adopt_drop_in_is_sent_once_then_deleted(hass, env):
    env.dir.mkdir(parents=True, exist_ok=True)
    (env.dir / "adopt.json").write_text('{"ha_instance_id": "d0d0d0d0d0d0d0d0", "ha_secret": "s"}')
    cloud = _Cloud()
    await _enable(env, cloud)
    assert cloud.claims[0]["adopt"] == {"ha_instance_id": "d0d0d0d0d0d0d0d0", "ha_secret": "s"}
    assert not (env.dir / "adopt.json").exists()
    assert env.mgr.public["state"] == "ok"


async def test_adopt_rejected_falls_back_to_a_new_name(hass, env):
    env.dir.mkdir(parents=True, exist_ok=True)
    (env.dir / "adopt.json").write_text('{"ha_instance_id": "d0d0d0d0d0d0d0d0", "ha_secret": "wrong"}')
    cloud = _Cloud(claim_errors=[("adopt_rejected", {})])
    await _enable(env, cloud)
    assert [c["adopt"] is not None for c in cloud.claims] == [True, False]
    assert env.mgr.public["state"] == "ok"
    assert not (env.dir / "adopt.json").exists()


def test_an_existing_rsa_root_is_used_as_is(tmp_path):
    """A root placed in the folder before the first start (switch-over of an existing install)
    is kept, even RSA and without constraints; the page then says it has no restrictions."""
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Old root")])
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(3).not_valid_before(now - dt.timedelta(hours=1)).not_valid_after(now + dt.timedelta(days=99))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .sign(key, hashes.SHA256())
    )
    (tmp_path / "ca.key").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    (tmp_path / "ca.crt").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    ca = https_certs.LocalCA(tmp_path)
    assert ca.ensure() is False and not ca.is_constrained()
    leaf = ca.issue_leaf(["homeassistant.local"], ["192.168.1.10"])
    assert ca.leaf_is_current(["homeassistant.local"], ["192.168.1.10"])
    _tls_roundtrip(ca.ca_cert_path, leaf.chain.read_bytes(), leaf.key.read_bytes(), "homeassistant.local")


async def test_the_fix_flow_names_the_hostname_and_moves_it(hass, env):
    from custom_components.ig_doorbell import repairs

    cloud = _Cloud(claim_errors=[("doorbell_has_ha_name", {"hostname": PUBLIC})])
    await _enable(env, cloud)
    flow = await repairs.async_create_fix_flow(hass, https_manager.ISSUE_NAME_TAKEN, None)
    flow.hass = hass
    form = await flow.async_step_confirm()
    assert form["description_placeholders"] == {"hostname": PUBLIC}
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        await flow.async_step_confirm({})
        await env.mgr._public_task
    assert cloud.claims[-1]["replace"] is True and env.mgr.public["state"] == "ok"


# ----------------------------------------------------------------------------- first enable (1.1.1)
# Seen on a real Home Assistant with 1.1.0: HTTPS was enabled, the name was claimed, and seconds
# later the setting was OFF - the certificate call to the VPS was cut (the VPS logged a broken
# pipe writing an already issued certificate) and HTTPS stayed off until enabled again. The only
# writer of `enabled` is the options form, so these pin both ends: nothing but a choice made
# against the CURRENT value turns it off, and nothing in the public-name path ever does.
class _FakeVps:
    """A real HTTP server speaking the section 4-ter v2 endpoints, with a slow Let's Encrypt."""

    def __init__(self, cert_delay: float = 0.0) -> None:
        self.cert_delay = cert_delay
        self.issued: dict[str, str] = {}  # hostname -> chain, cached like the VPS does
        self.cert_calls = 0
        self.cert_answers_written = 0
        self.app = web.Application()
        self.app.router.add_post("/ha_instance/v2/claim", self._claim)
        self.app.router.add_post("/ha_instance/v2/cert", self._cert)
        self.runner = web.AppRunner(self.app)
        self.base = ""

    async def _claim(self, request: web.Request) -> web.Response:
        await request.json()
        return web.json_response({"hostname": PUBLIC, "ha_instance_id": PUBLIC.split(".")[0], "status": "created"})

    async def _cert(self, request: web.Request) -> web.Response:
        body = await request.json()
        self.cert_calls += 1
        if PUBLIC in self.issued:
            return web.json_response({"hostname": PUBLIC, "cert": self.issued[PUBLIC], "not_after": 0, "reused": True})
        # Issuing goes on even if the client gives up (it did on the real VPS).
        chain = await asyncio.shield(asyncio.ensure_future(self._issue(body["csr"])))
        self.cert_answers_written += 1
        return web.json_response({"hostname": PUBLIC, "cert": chain, "not_after": 0, "reused": False})

    async def _issue(self, csr: str) -> str:
        await asyncio.sleep(self.cert_delay)
        chain, _ = _sign_as_fake_le(csr)
        self.issued[PUBLIC] = chain
        return chain

    async def __aenter__(self):
        await self.runner.setup()
        port = _free_port()
        await web.TCPSite(self.runner, "127.0.0.1", port).start()
        self.base = f"http://127.0.0.1:{port}"
        return self

    async def __aexit__(self, *exc):
        await self.runner.cleanup()


async def _voucher_only(session, device_id, credential, purpose, ha_key):
    return f"igv1.fake.{purpose}"


def _against(vps: _FakeVps):
    return patch.object(https_cloud, "VPS_BASE", vps.base), patch.object(https_cloud, "async_voucher", _voucher_only)


async def _enable_against(env, vps: _FakeVps, port: int | None = None):
    p1, p2 = _against(vps)
    with p1, p2:
        await env.mgr.async_configure(enabled=True, port=port or _free_port(), device_id=DEVICE_ID)
        if env.mgr._public_task is not None:
            await env.mgr._public_task


@pytest.mark.timeout(120)
async def test_a_slow_production_certificate_is_waited_for(hass, env):
    """Production Let's Encrypt takes tens of seconds (the Docker check used staging)."""
    async with _FakeVps(cert_delay=45) as vps:
        await _enable_against(env, vps)
    assert env.mgr.public["state"] == "ok", env.mgr.public
    assert vps.cert_answers_written == 1 and vps.cert_calls == 1
    assert env.mgr.enabled and env.mgr.server is not None


async def test_an_abandoned_certificate_call_keeps_https_on_and_retries_soon(hass, env, monkeypatch):
    """Our timeout fires before the VPS answers: HTTPS stays ON, the local path keeps serving,
    the setting stays stored ON, and a retry soon picks up the certificate the VPS finished."""
    import aiohttp
    from homeassistant.util import dt as dt_util
    from pytest_homeassistant_custom_component.common import async_fire_time_changed

    monkeypatch.setattr(https_cloud, "_VPS_TIMEOUT", aiohttp.ClientTimeout(total=1))
    async with _FakeVps(cert_delay=2) as vps:
        port = _free_port()
        await _enable_against(env, vps, port)
        assert env.mgr.public["state"] == "unavailable" and env.mgr.public["code"] == "vps_unreachable"
        assert env.mgr.enabled and env.mgr.server is not None and env.mgr.bound_port == port
        stored = await https_manager.Store(hass, https_manager.STORAGE_VERSION, https_manager.STORAGE_KEY).async_load()
        assert stored["enabled"] is True
        await asyncio.sleep(2.5)  # the VPS finishes issuing after we gave up
        assert PUBLIC in vps.issued
        p1, p2 = _against(vps)
        with p1, p2:
            async_fire_time_changed(hass, dt_util.utcnow() + dt.timedelta(seconds=31))
            await hass.async_block_till_done()
            if env.mgr._public_task is not None:
                await env.mgr._public_task
    assert env.mgr.public["state"] == "ok", env.mgr.public
    assert vps.cert_calls == 2
    assert env.mgr.enabled and env.mgr.server is not None


async def test_weather_failures_repair_after_an_hour_and_never_turn_https_off(hass, env):
    cloud = _Cloud(voucher_error="doorbell_unreachable")
    await _enable(env, cloud)
    assert (DOMAIN, https_manager.ISSUE_PUBLIC_FAILED) not in ir.async_get(hass).issues  # not yet
    assert env.mgr._retry_unsub is not None
    env.mgr._failing_since -= dt.timedelta(minutes=61)
    p1, p2, p3 = cloud.patch()
    with p1, p2, p3:
        await env.mgr._async_periodic()
        if env.mgr._public_task is not None:
            await env.mgr._public_task
    issue = ir.async_get(hass).issues.get((DOMAIN, https_manager.ISSUE_PUBLIC_FAILED))
    assert issue is not None and issue.translation_placeholders == {"code": "doorbell_unreachable"}
    assert env.mgr.enabled and env.mgr.server is not None


async def test_a_form_opened_before_https_was_enabled_cannot_turn_it_off(hass, env):
    """The form shows the toggle as it was when OPENED. Submitting a stale one must not undo a
    change made meanwhile; a choice made on the refreshed form is honoured."""
    port = _free_port()
    stale = await _https_step(hass, env)  # opened while HTTPS is off: toggle shows off
    await _enable(env, _Cloud(), port)  # someone else turns it on meanwhile
    assert env.mgr.enabled and env.mgr.server is not None
    result = await hass.config_entries.options.async_configure(stale["flow_id"], {"enabled": False, "port": port})
    assert result["type"] == "form" and result["errors"] == {"base": "https_changed_elsewhere"}
    assert env.mgr.enabled and env.mgr.server is not None
    # The form now shows the current value; turning it off from there is the user's choice.
    result = await hass.config_entries.options.async_configure(result["flow_id"], {"enabled": False, "port": port})
    assert result["type"] == "create_entry"
    assert not env.mgr.enabled and env.mgr.server is None


async def test_the_manager_is_visible_only_once_loaded(hass, tmp_path, monkeypatch):
    """An options flow reaching a half-loaded manager would have its choice overwritten by the
    stored setting when the load finished."""
    monkeypatch.setattr(hass.config, "config_dir", str(tmp_path))
    gate = asyncio.Event()
    seen: list = []

    async def slow_load(self):
        seen.append(https_manager.get_manager(hass))
        await gate.wait()
        return {"enabled": False, "port": 8443}

    monkeypatch.setattr(https_manager.Store, "async_load", slow_load)
    task = hass.async_create_task(https_manager.async_setup_manager(hass))
    for _ in range(3):
        await asyncio.sleep(0)
    assert seen == [None] and https_manager.get_manager(hass) is None
    gate.set()
    mgr = await task
    assert https_manager.get_manager(hass) is mgr
    hass.data.pop(https_manager.DATA_HTTPS)
