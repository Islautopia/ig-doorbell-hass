"""Mutation check for the Phase 0 rules: each mutant undoes ONE rule and the suite must go red.

    python tools/mutants.py          (from the repo root, where `pytest tests` works)

A test suite that always said "green" would pass every negative test; these mutants are the
positive controls. Every anchor must appear EXACTLY once or the run aborts (a replace() on a
missing anchor returns the text unchanged and would report a "surviving" mutant that was never
applied -- the failure CLAUDE.md warns about).
"""
from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = "custom_components/ig_doorbell/"

MUTANTS = [
    ("resolver falls back to DNS", PKG + "net.py",
     "        lan = self._address_map.get(host)\n        if lan is None:\n",
     "        lan = self._address_map.get(host)\n        if lan is None:\n            import socket as _s; _s.getaddrinfo(host, port)\n"),
    ("get_connection_info returns the credential", PKG + "websocket_api.py",
     '            "device_id": device_id,\n            "role": coordinator.role if coordinator is not None else "unknown",\n            "live_timeout_entity"',
     '            "device_id": device_id,\n            "credential": entry_data["credential"],\n            "role": coordinator.role if coordinator is not None else "unknown",\n            "live_timeout_entity"'),
    ("get_connection_info ignores the doorbell's own pairing role and always says admin", PKG + "websocket_api.py",
     '            "role": coordinator.role if coordinator is not None else "unknown",',
     '            "role": "admin",'),
    ("playback URL points the browser at the doorbell with ?token=", PKG + "media_source.py",
     "        return PlayMedia(signed_video_url(self.hass, device_id, filename), \"video/mp4\")",
     "        return PlayMedia(api.recording_url(device_id, doorbell[CONF_CREDENTIAL], filename), \"video/mp4\")"),
    ("recordings view without auth", PKG + "recordings_view.py",
     "    requires_auth = True", "    requires_auth = False"),
    ("failed pairing is not undone", PKG + "config_flow.py",
     "            undone = await api.async_unpair_app(session, device_id, label)",
     "            undone = False"),
    ("setup skips the TLS check", PKG + "config_flow.py",
     "        await api.async_check_tls(session, found)", "        pass"),
    ("cloud hostname resolved at setup", PKG + "config_flow.py",
     "    if not host or host.lower().rstrip(\".\").endswith(DOORBELL_HOSTNAME_SUFFIX):\n        return None\n",
     "    if not host:\n        return None\n"),
    ("live timeout default changed", PKG + "const.py",
     "LIVE_TIMEOUT_DEFAULT_S = 120", "LIVE_TIMEOUT_DEFAULT_S = 60"),
    ("an entity back to a hard-coded Spanish name", PKG + "button.py",
     '    _attr_translation_key = "open_door"\n', '    _attr_name = "Abrir puerta"\n'),
    ("signalling command leaves the slot to the 20 s reaper", PKG + "signal_client.py",
     '                await _post({"type": "bye", "slot": slot})', "                pass"),
    ("undo by label (404 with spaces on the firmware)", PKG + "api.py",
     'f"{base}/api/unpair_app", data={"slot": str(slots[0])}', 'f"{base}/api/unpair_app", data={"label": label}'),
    ("a language loses an entity name", PKG + "translations/de.json",
     '"name": "Tür öffnen"', '"nombre": "Tür öffnen"'),
    ("a REC ended by the doorbell itself never frees the slot", PKG + "rec_session.py",
     "                        asyncio.create_task(self.stop())\n                        return\n",
     "                        return\n"),
    ("the REC switch shows on without checking the doorbell's own rec_state", PKG + "switch.py",
     "        return self._session is not None and self._session.recording",
     "        return self._session is not None"),
    ("mode select goes back to the debounced refresh (a 2nd change within 10 s waits)", PKG + "select.py",
     "        self.coordinator.async_set_updated_data({**(self.coordinator.data or {}), **state})",
     "        await self.coordinator.async_request_refresh()"),
    ("mode select accepts a change the doorbell silently dropped", PKG + "select.py",
     "        if not applied:", "        if False:"),
    ("the card is served but never added to the frontend pages (needs a Lovelace resource again)",
     PKG + "card.py", "    add_extra_js_url(hass, url)\n", "    pass\n"),
    ("the card URL loses its cache-busting hash", PKG + "card.py",
     '    url = f"{CARD_URL}?v={digest}"', "    url = CARD_URL"),
    ("the card route tells browsers to keep a month-old copy", PKG + "card.py",
     "StaticPathConfig(CARD_URL, str(CARD_PATH), False)", "StaticPathConfig(CARD_URL, str(CARD_PATH), True)"),
    ("setup no longer registers the card", PKG + "__init__.py",
     "    await async_register_card(hass)\n", ""),
    # --- 1.2.2: the call page in the wall panel's window already on screen (call_page_nav.py) ------
    ("every ring opens a new companion window again", PKG + "notify_ring.py",
     "            if await call_page_nav.async_get(self.hass).async_show(",
     "            if False and await call_page_nav.async_get(self.hass).async_show("),
    ("an acknowledgement from another user counts", PKG + "call_page_nav.py",
     "        if p is None or p.user_id != user_id or p.fut.done():",
     "        if p is None or p.fut.done():"),
    ("a page of another user or model is asked to navigate", PKG + "call_page_nav.py",
     '    return bool(model) and sub_user == user_id and model.lower() in (ua or "").lower()',
     "    return True"),
    # --- 1.2.1: the card is also a Lovelace resource (a stale page HTML imports no card) ----------
    ("the card is never added as a Lovelace resource", PKG + "card.py",
     "    await async_sync_lovelace_resource(hass, url)\n    return url\n", "    return url\n"),
    ("a resource at an old URL is left pointing at the old build", PKG + "card.py",
     '        elif keep.get("url") != url or keep.get("type") != RESOURCE_TYPE:',
     "        elif False:"),
    ("a duplicate card resource is kept", PKG + "card.py",
     "keep, extra = (ours[0], ours[1:]) if ours else (None, [])",
     "keep, extra = (ours[0], []) if ours else (None, [])"),
    ("a resource error takes the integration setup down", PKG + "card.py",
     "    except Exception:  # noqa: BLE001", "    except ZeroDivisionError:  # noqa: BLE001"),
    ("the last doorbell removed leaves the resource behind", PKG + "__init__.py",
     "        await async_sync_lovelace_resource(hass, None)\n", "        pass\n"),
    ("removing one of two doorbells removes the card resource", PKG + "__init__.py",
     "    if not [e for e in hass.config_entries.async_entries(DOMAIN) if e.entry_id != entry.entry_id]:",
     "    if True:"),
    ("the call page is not told the card URL", PKG + "panel.py",
     '"card_url": hass.data.get(DATA_CARD_URL)}', '"card_url": None}'),
    # --- 1.1.0: secure local connection (HTTPS) ------------------------------------------------
    ("the local root loses its name constraints", PKG + "https_certs.py",
     "            .add_extension(constraints, critical=True)\n", ""),
    ("the leaf carries names outside the constraints", PKG + "https_certs.py",
     "        if self.is_constrained():\n            dns_names, ips = constrained_names(dns_names, ips)\n", ""),
    ("SNI always serves the local certificate", PKG + "https_certs.py",
     "        if name and self.public is not None and name.lower() == self.public_name:",
     "        if False:"),
    ("HTTPS starts even when it is off", PKG + "https_manager.py",
     "            if not self.enabled or not self._has_entries():", "            if not self._has_entries():"),
    ("the private key travels with the CSR", PKG + "https_certs.py",
     '    return csr.public_bytes(serialization.Encoding.PEM).decode("ascii")\n',
     '    return csr.public_bytes(serialization.Encoding.PEM).decode("ascii") + _key_pem(key).decode()\n'),
    ("a certificate for another key is accepted from the cloud", PKG + "https_manager.py",
     "                    if not https_certs.public_cert_usable(chain, key, hostname):\n"
     "                        return False\n", ""),
    ("the ha_cert voucher is asked through the shared session", PKG + "https_manager.py",
     '                    doorbell["session"], doorbell["device_id"], doorbell["credential"],\n'
     '                    "ha_cert", ha_key,',
     '                    vps, doorbell["device_id"], doorbell["credential"],\n'
     '                    "ha_cert", ha_key,'),
    ("permanent public-name errors are retried every hour", PKG + "https_manager.py",
     '        if code in https_cloud.PERMANENT or code == "no_doorbell":\n'
     "            self._public_permanent = code\n",
     "        if False:\n            self._public_permanent = code\n"),
    ("a taken port crashes instead of raising a repair", PKG + "https_manager.py",
     '                self.error = "port_in_use"\n', "                raise\n"),
    ("the options flow skips the port check", PKG + "config_flow.py",
     "                errors = await _check_port(self.hass, mgr, port)\n", "                errors = {}\n"),
    ("the install page answers outside the LAN", PKG + "https_views.py",
     "def _from_lan(request: web.Request) -> bool:\n    try:",
     "def _from_lan(request: web.Request) -> bool:\n    return True\n    try:"),
    ("the card is not told where the install page is", PKG + "websocket_api.py",
     '            "install_path": INSTALL_PATH,\n', ""),
    # 1.1.1: HTTPS turned itself off seconds after the first enable on a real Home Assistant.
    ("a stale options form turns HTTPS off", PKG + "config_flow.py",
     "            if mgr.enabled != shown and enabled != mgr.enabled:\n",
     "            if False:\n"),
    ("no retry after a transient public-name failure", PKG + "https_manager.py",
     "                self._retry_unsub = async_call_later(self.hass, delay, self._retry_public)\n",
     "                pass\n"),
    ("weather failures never raise a repair", PKG + "https_manager.py",
     "            and dt_util.utcnow() - self._failing_since < PUBLIC_REPAIR_AFTER\n",
     "            and True\n"),
    ("the manager is visible before it is loaded", PKG + "https_manager.py",
     "    await mgr.async_load()\n    hass.data[DATA_HTTPS] = mgr\n",
     "    hass.data[DATA_HTTPS] = mgr\n    await mgr.async_load()\n"),
    ("the cert call gives up before production Let's Encrypt answers", PKG + "https_cloud.py",
     "_VPS_TIMEOUT = aiohttp.ClientTimeout(total=180)\n",
     "_VPS_TIMEOUT = aiohttp.ClientTimeout(total=30)\n"),
    # --- 1.2.0: ring notifications sent by the integration itself -------------------------------
    ("ring tag loses the call (a late resolution clears the next ring)", PKG + "notify_ring.py",
     '    return f"igd_{device_id}_{call_id}"', '    return f"igd_{device_id}"'),
    ("a resolution does not clear the ring", PKG + "notify_ring.py",
     "                coros.append(self._clear(call, t))", "                pass"),
    ("a second resolution is processed again", PKG + "notify_ring.py",
     "        if call is None or call.outcome is not None:\n            return      # not a call we rang",
     "        if call is None:\n            return      # not a call we rang"),
    ("open door accepted from a stale notification", PKG + "notify_ring.py",
     '        if time.monotonic() - call.started > OPEN_DOOR_WINDOW_S:\n            return "too_late"\n', ""),
    ("open door offered by default", PKG + "notify_ring.py",
     '        if (target.role == "phone" and o.get(CONF_NOTIFY_OPEN_DOOR, False)',
     '        if (target.role == "phone" and o.get(CONF_NOTIFY_OPEN_DOOR, True)'),
    ("iPhone ring no longer critical", PKG + "notify_ring.py",
     '                {"interruption-level": "critical",', '                {"interruption-level": "active",'),
    ("the panel chime notice is never cleared without a resolution", PKG + "notify_ring.py",
     '            await self._each(self._clear(call, t) for t in call.targets if t.role == "panel")' + chr(10),
     ""),
    ("a new ring keeps showing the previous visitor", PKG + "image.py",
     "        self._jpeg = None" + chr(10) + "        self._ring_at = time.monotonic()",
     "        self._ring_at = time.monotonic()"),
    ("a 403 keeps a picture for the ring", PKG + "image.py",
     "            _LOGGER.info(\"The owner turned off the picture in ring notices (call_snap): none\")" + chr(10) + "            jpeg = None",
     "            _LOGGER.info(\"The owner turned off the picture in ring notices (call_snap): none\")" + chr(10) + "            jpeg = b'stale'"),
    ("the picture is captured at every ring even when nobody uses it", PKG + "image.py",
     "        if self._wanted_at_ring():", "        if True:"),
    ("a late request fetches a picture of whoever is there now", PKG + "image.py",
     "                and time.monotonic() - self._ring_at <= LAZY_WINDOW_S):", "                ):"),
    ("snapshot request not marked for=alert (call_snap ignored)", PKG + "api.py",
     'f"?for=alert&token={quote(credential)}")', 'f"?token={quote(credential)}")'),
    ("call page becomes admin-only", PKG + "panel.py",
     "        require_admin=False,", "        require_admin=True,"),
    ("notifications step wipes the other options", PKG + "config_flow.py",
     "            options = dict(self._entry.options)\n            options[CONF_NOTIFY_PHONES]",
     "            options = {}\n            options[CONF_NOTIFY_PHONES]"),
    ("a request timeout escapes as a bare TimeoutError (entry dies if the doorbell is off at boot)",
     PKG + "api.py",
     '    except (aiohttp.ClientError, TimeoutError) as err:' + chr(10) + '        raise DoorbellApiError(f"Could not reach the doorbell to configure it',
     '    except aiohttp.ClientError as err:' + chr(10) + '        raise DoorbellApiError(f"Could not reach the doorbell to configure it'),
    ("missed-call time ignores the doorbell's zone", PKG + "notify_ring.py",
     "        tz = dt_util.get_time_zone(tz_name) if isinstance(tz_name, str) and tz_name else None",
     "        tz = None"),
    ("Android clear / missed-call replacement back to normal priority (held by Doze)", PKG + "notify_ring.py",
     'ANDROID_NOW = {"priority": "high", "ttl": 0}', "ANDROID_NOW = {}"),
    ("call page registered without the lock (2 doorbells: one entry in setup_error)", PKG + "panel.py",
     "    async with lock:" + chr(10) + "        await _async_register_locked(hass)",
     "    await _async_register_locked(hass)"),
    ("a failing call page takes the entry down", PKG + "__init__.py",
     "    try:" + chr(10) + "        await async_register_call_page(hass)" + chr(10) + "    except Exception:",
     "    await async_register_call_page(hass)" + chr(10) + "    if False:" + chr(10) + "     try: pass" + chr(10) + "     except Exception:"),
    ("the missed-call notice drops the picture", PKG + "notify_ring.py",
     "        if img is not None and image_id and img.picture_of(call.call_id):",
     "        if False:"),
    ("a later ring's face shown on an older call's notice", PKG + "image.py",
     "        return self._jpeg is not None and call_id is not None and self.call_id == call_id",
     "        return self._jpeg is not None"),
    ("the ring announces a picture the doorbell refused", PKG + "notify_ring.py",
     "        if image and call.picture:", "        if image and self._has_picture():"),
    ("speakers alone do not enable the ring handling", PKG + "notify_ring.py",
     "                    or o.get(CONF_ANNOUNCE_PLAYERS))", "                    )"),
    ("the chime is not served to the speakers", PKG + "announce.py",
     "        [StaticPathConfig(SOUND_URL, str(SOUND_PATH), True)]", "        [StaticPathConfig(SOUND_URL, str(SOUND_PATH), True)] if False else []"),
    ("Alexa gets our mp3 URL, which an Echo cannot play", PKG + "announce.py",
     "        if entry is not None and entry.platform == ALEXA_PLATFORM and entry.device_id:",
     "        if False:"),
    ("the event entity forgets the call resolutions", PKG + "event.py",
     '    "call_answered", "call_declined", "call_missed",\n]', "]"),
]


def main() -> int:
    # NEGATIVE CONTROL FIRST: the unmutated suite must be green, or a "killed" mutant proves
    # nothing (on 2026-09-26 a harness error in the first test made all 17 look killed).
    r = subprocess.run([sys.executable, "-m", "pytest", "tests", "-q", "-p", "no:cacheprovider"],
                       cwd=ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        print("ABORT: the unmutated suite is not green - mutants would be meaningless")
        print(r.stdout[-2000:])
        return 2
    print("unmutated suite: green")
    survivors = []
    for name, file_, anchor, change in MUTANTS:
        with tempfile.TemporaryDirectory() as tmp:
            copy_dir = pathlib.Path(tmp) / "repo"
            shutil.copytree(ROOT, copy_dir, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
            target_path = copy_dir / file_
            text_ = target_path.read_text(encoding="utf-8")
            n = text_.count(anchor)
            if n != 1:
                print(f"ABORT: anchor for '{name}' appears {n} times in {file_}")
                return 2
            target_path.write_text(text_.replace(anchor, change), encoding="utf-8")
            r = subprocess.run(
                [sys.executable, "-m", "pytest", "tests", "-q", "-x", "-p", "no:cacheprovider"],
                cwd=copy_dir, capture_output=True, text=True,
            )
            red = r.returncode != 0
            print(f"{'RED   (killed)' if red else 'GREEN (SURVIVED)'}  {name}")
            if not red:
                survivors.append(name)
    print(f"\n{len(MUTANTS) - len(survivors)}/{len(MUTANTS)} mutants killed")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
