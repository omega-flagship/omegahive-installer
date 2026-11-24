# Purpose: the hive's connector secrets: each person's entries for each connector, sealed at rest (hive/core/sealed.py),
# reaching only the minds that person installed the connector on, and the one-time import of those a checkout or the
# data folder's old connectors folder still holds in plain files.
"""Connector secrets, scoped to the person who entered them and the minds they installed the connector on.

A connector's secret belongs to a person: a Home Assistant URL and token, a LibreLinkUp login, a WhatsApp pairing, an
Agentverse listener's seed. The person installs the connector on minds they own. A mind gets its own owner's secret, and
only for connectors installed on it; it is refused otherwise and is never lent another person's (the rule Jon set for
omega-connect's tokens). How a mind gets it depends on what the connector needs:

- Home Assistant and LibreLinkUp: the hive makes the calls itself, as it does Google Calendar reads, so no mind holds
  those keys. The mind's module sends each request to an agent route (`home_assistant_request`, `librelinkup_request`).
- WhatsApp and Agentverse: their live process needs the bytes (the bridge's Baileys session, which it rewrites as it
  runs; the listener's seed, from which uAgents derives its signing key), so the hive serves those entries to the
  installed mind (`entries`).

Entries are sealed with the hive's key, which lives outside the data folder (sealed.py), and kept in the hive's database
named by an HMAC, so a copy of the data folder holds none of them readable. Installing a connector also loads its module
into the mind at its next start (`installed_modules`, the supervisor's OMEGACLAW_EXTRA_MODULES). WhatsApp goes on one of an
owner's minds at a time, since a pairing is one live session.

`import_legacy` runs once as the hive starts: what a checkout still holds under the code folder, or the data folder's
connectors folder holds from an earlier release, becomes the entries of the hive's first admin (the operator in a
password-only hive), each checked to open to the same bytes before its file goes. The Mac and Windows installer deletes
the code folder an update replaces before the hive starts, so it first carries what that folder holds to the
connectors folder (connector_files.carry). A connector whose module the host's
loader already loads into every mind is installed on that person's own minds (WhatsApp on the oldest), so what worked
keeps working; one it doesn't load stays uninstalled, since no mind used it. A person's own minds are those they made,
not the ones the hive makes and keeps for a purpose: the foundation's Create · Code, Review and Research minds, a Studio
maker, an app's minds and their personal mind. Every pairing folder a bridge kept (*auth*: auth, auth_<label>) is
imported: the one the hive's minds used (the folder OMEGACLAW_WA_AUTH_DIR names, else auth), else the one Baileys wrote
last, becomes the person's live pairing, and each other is sealed aside whole under its folder's name, where no mind
can ask for it. A link is never followed, a file that differs from the one
imported is kept and reported, and a copy an interrupted earlier move left in the connectors folder is removed. While
the store is shut (a locked Keychain, a missing key file) every file stays where it is and the hive starts; the next
start that opens the store imports them. A hive whose data folder is temporary, as a test hive's is, imports nothing
and says so in its log.
"""
from __future__ import annotations

import dataclasses
import fnmatch
import json
import logging
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from . import connector_calls, sealed
# The legacy table and its path rules live where the installer's bare Python reads them too (connector_files.carry).
from .connector_files import FOLDER, LEGACY, MOVING, folder_unlinked as _folder, matches as _matches
from .redact import register as register_secret

NAME = re.compile(r"[A-Za-z0-9._@:+=-]{1,200}")
MAX_VALUE = 1024 * 1024


@dataclasses.dataclass(frozen=True)
class Connector:
    id: str
    module: str              # the OmegaClaw module directory an installed mind loads
    kind: str                # "calls": the hive makes the calls; "served": the hive serves entries to the mind
    exclusive: bool = False  # on one of an owner's minds at a time
    generated: tuple = ()    # served entries the hive makes on first read; a mind reads these and nothing else


CONNECTORS = {c.id: c for c in (
    Connector("home_assistant", "home_assistant", "calls"),
    Connector("librelinkup", "health_glucose", "calls"),
    Connector("whatsapp", "channel_whatsapp", "served", exclusive=True),
    Connector("agentverse", "agentverse", "served", generated=("seed",)),
)}


def store(settings) -> pathlib.Path:
    """The data folder's connectors folder: the sealed key on Linux (sealed.CRED_FILE), plain files of an earlier
    release until they are imported, and nothing a mind reads."""
    return pathlib.Path(settings.data_dir) / FOLDER


def _error(status, code, message):
    from .hive import HiveError
    return HiveError(status, code, message)


def _throwaway(folder):
    """Whether `folder` sits in a temporary folder, as a test hive's data folder does: such a hive is deleted with it,
    so it imports no checkout's secrets and seals with a throwaway key. The temporary folders are tempfile's current one
    and the system's own (TMPDIR, TEMP, TMP, /tmp, /var/tmp), since a test session may point tempfile at a folder of its
    own (the repository's conftest.py does)."""
    temps = {tempfile.gettempdir(), "/tmp", "/var/tmp"}
    temps |= {os.environ[k] for k in ("TMPDIR", "TEMP", "TMP") if os.environ.get(k)}
    real = os.path.realpath(folder)
    return any(real == t or real.startswith(t.rstrip(os.sep) + os.sep) for t in map(os.path.realpath, temps))


def host_loader_modules():
    """The module directories the host's loader imports into every mind (OMEGACLAW_MODULE_LOADER, else the checkout's
    modules/loader.metta), read the way the mind's command parser reads them."""
    from hive.runtime.extensions.helper_command_parser import _enabled_module_names, module_loader_path
    return set(_enabled_module_names(module_loader_path()))


LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def _url(value, schemes, loopback_http=False):
    """A base URL without credentials, query or fragment; with `loopback_http`, http only to this machine."""
    from urllib.parse import urlsplit
    if not isinstance(value, str) or not 0 < len(value) <= 2048 or any(ord(c) <= 32 for c in value):
        return None
    parts = urlsplit(value.strip())
    if (parts.scheme not in schemes or not parts.hostname or parts.username or parts.password or parts.query
            or parts.fragment or (loopback_http and parts.scheme == "http" and parts.hostname not in LOOPBACK)):
        return None
    return value.strip().rstrip("/")


def _text(value, limit):
    return value.strip() if isinstance(value, str) and 0 < len(value.strip()) <= limit else None


def clean_settings(connector_id, data):
    """A person's settings for a connector the hive calls, checked, or a 400."""
    if not isinstance(data, dict):
        raise _error(400, "bad_request", "settings are a JSON object")
    if connector_id == "home_assistant":
        if set(data) != {"url", "token"}:
            raise _error(400, "bad_request", "Home Assistant takes exactly url and token")
        url, token = _url(data["url"], ("http", "https")), _text(data["token"], 8192)
        if not url or not token:
            raise _error(400, "bad_request", "an http(s) URL without a query, and a token")
        return {"url": url, "token": token}
    if connector_id == "librelinkup":
        if not {"username", "password"} <= set(data) <= {"username", "password", "url", "version", "unit", "connections"}:
            raise _error(400, "bad_request", "LibreLinkUp takes username and password, and optionally url, version, unit "
                         "and connections")
        out = {"username": _text(data["username"], 320), "password": data["password"]
               if isinstance(data["password"], str) and 0 < len(data["password"]) <= 1024 else None}
        if "url" in data:
            out["url"] = _url(data["url"], ("https", "http"), loopback_http=True)
        if "version" in data:
            out["version"] = data["version"] if isinstance(data["version"], str) and re.fullmatch(
                r"[0-9]{1,3}(\.[0-9]{1,3}){0,3}", data["version"]) else None
        if "unit" in data:
            out["unit"] = data["unit"] if data["unit"] in ("mmol/L", "mg/dL") else None
        if "connections" in data:
            conns = data["connections"]
            ok = isinstance(conns, dict) and len(conns) <= 50 and all(
                _text(k, 128) and _text(v, 128) for k, v in conns.items())
            out["connections"] = {k.strip(): v.strip() for k, v in conns.items()} if ok else None
        if any(v is None for v in out.values()):
            bad = ", ".join(k for k, v in out.items() if v is None)
            raise _error(400, "bad_request", f"LibreLinkUp settings not valid: {bad}")
        return out
    raise _error(400, "bad_request", f"{connector_id} takes no settings; its entries come from the connector itself")


class ConnectorStore:
    """Every person's connector entries, sealed, and which minds each person installed each connector on."""

    SCHEMA = (
        "CREATE TABLE IF NOT EXISTS connector_entries (owner TEXT NOT NULL, connector TEXT NOT NULL, "
        "name_mac TEXT NOT NULL, value TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY (owner, connector, name_mac))",
        "CREATE TABLE IF NOT EXISTS connector_installs (agent_id TEXT NOT NULL, connector TEXT NOT NULL, "
        "owner TEXT NOT NULL, installed_at REAL NOT NULL, PRIMARY KEY (agent_id, connector))",
    )

    def __init__(self, hive, settings, runner=subprocess.run, platform=sys.platform, opener=None):
        self.hive, self.settings = hive, settings
        self.folder = store(settings)
        self._runner, self._platform = runner, platform
        self._opener = opener or connector_calls.OPENER
        self._lock = threading.RLock()
        self._seal, self._info, self._locked, self._planned = None, None, None, None
        self._llu_locks = {}   # one LibreLinkUp login at a time per owner
        for statement in self.SCHEMA:
            hive.db.execute(statement)
        if _throwaway(self.folder):
            logging.getLogger("hive").warning(
                "connectors: the data folder %s is in a temporary folder, so this hive seals connector secrets with a "
                "plain key file beside them and imports nothing a checkout holds; that is for a hive thrown away with "
                "its folder, as a test's is", settings.data_dir)

    # ---- the key -------------------------------------------------------------------------------------------------

    def _sealed_count(self):
        return self.hive.db.one("SELECT COUNT(*) AS n FROM connector_entries")["n"]

    def _open(self):
        """The seal, opening the key on first use: a key store is asked only once a secret is read or written."""
        with self._lock:
            if self._seal is None:
                try:
                    key, info = sealed.open_key(self.settings, self.folder, self._sealed_count(),
                                                _throwaway(self.folder), self._runner, self._platform)
                except sealed.StoreLocked as exc:
                    self._locked = str(exc)
                    raise _error(503, "connector_store_locked", str(exc)) from None
                self._seal, self._info, self._locked = sealed.Seal(key), info, None
                if info.get("warning"):
                    logging.getLogger("hive").warning("connectors: %s", info["warning"])
            return self._seal

    def info(self):
        """Whether the store is open, where its key lives and, when it protects less or is shut, why."""
        with self._lock:
            if self._seal is None and self._sealed_count():
                try:
                    self._open()
                except Exception:   # noqa: BLE001 - reported below as the store's reason
                    pass
            if self._seal is not None:
                return {"open": True, **self._info}
            if self._locked:
                return {"open": False, "reason": self._locked}
            if self._planned is None:   # nothing sealed yet: where the key will be made with the first secret
                self._planned = sealed.choose_home(self.settings, _throwaway(self.folder), self._runner, self._platform)
            return {"open": True, "made": False, **self._planned}

    # ---- entries -------------------------------------------------------------------------------------------------

    def _get(self, owner, connector, name):
        seal = self._open()
        row = self.hive.db.one("SELECT value FROM connector_entries WHERE owner = ? AND connector = ? AND name_mac = ?",
                               (owner, connector, seal.name(owner, connector, name)))
        if row is None:
            return None
        try:
            return seal.open(owner, connector, name, row["value"])
        except sealed.StoreLocked as exc:
            raise _error(503, "connector_store_locked", str(exc)) from None

    def _put(self, owner, connector, name, value):
        seal = self._open()
        self.hive.db.execute(
            "INSERT INTO connector_entries (owner, connector, name_mac, value, updated_at) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (owner, connector, name_mac) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (owner, connector, seal.name(owner, connector, name), seal.seal(owner, connector, name, value), time.time()))

    def _delete(self, owner, connector, name):
        seal = self._open()
        self.hive.db.execute("DELETE FROM connector_entries WHERE owner = ? AND connector = ? AND name_mac = ?",
                             (owner, connector, seal.name(owner, connector, name)))

    def _has(self, owner, connector):
        return self.hive.db.one("SELECT 1 AS x FROM connector_entries WHERE owner = ? AND connector = ? LIMIT 1",
                                (owner, connector)) is not None

    def _settings(self, owner, connector):
        text = self._get(owner, connector, "settings")
        return json.loads(text) if text else None

    # ---- people --------------------------------------------------------------------------------------------------

    @staticmethod
    def _connector(connector_id):
        connector = CONNECTORS.get(connector_id)
        if connector is None:
            raise _error(404, "not_found", "no such connector")
        return connector

    def _own_mind(self, principal, agent_id):
        row = self.hive.db.one("SELECT id, owner, kind, deleted FROM agents WHERE id = ?", (agent_id,))
        if row is None or row.get("deleted") or row.get("owner") != principal:
            raise _error(403, "not_your_mind", "only a mind's owner installs connectors on it")
        if row.get("kind") != "omega":
            raise _error(409, "kind_cannot_load", "connectors load into Omega minds only")
        return row

    def status(self, principal):
        """The person's connectors (which fields are entered, never their values; which of their minds have each) and
        their own minds, with the store's state."""
        minds = self.hive.db.all("SELECT id, name, status FROM agents WHERE owner = ? AND deleted = 0 AND kind = 'omega' "
                                 "ORDER BY created_at", (principal,))
        installs = self.hive.db.all("SELECT agent_id, connector FROM connector_installs WHERE owner = ?", (principal,))
        mine = {m["id"] for m in minds}
        rows = []
        for connector in CONNECTORS.values():
            fields = []
            if connector.kind == "calls" and self._has(principal, connector.id):
                fields = sorted((self._settings(principal, connector.id) or {}).keys())
            rows.append({"id": connector.id, "module": connector.module, "kind": connector.kind,
                         "exclusive": connector.exclusive, "set": self._has(principal, connector.id), "fields": fields,
                         "minds": sorted(i["agent_id"] for i in installs
                                         if i["connector"] == connector.id and i["agent_id"] in mine)})
        return {"store": self.info(), "connectors": rows,
                "minds": [{"id": m["id"], "name": m["name"], "running": m["status"] == "running"} for m in minds]}

    def _row(self, principal, connector_id):
        return next(r for r in self.status(principal)["connectors"] if r["id"] == connector_id)

    def set_settings(self, principal, connector_id, data):
        connector = self._connector(connector_id)
        if connector.kind != "calls":
            raise _error(400, "bad_request", f"{connector_id} takes no settings; its entries come from the connector")
        clean = clean_settings(connector_id, data)
        for key in ("token", "password"):
            register_secret(clean.get(key))
        with self._lock:
            self._put(principal, connector_id, "settings", json.dumps(clean))
            self._delete(principal, connector_id, "session")   # a new login starts a new session
        return self._row(principal, connector_id)

    def disconnect(self, principal, connector_id):
        self._connector(connector_id)
        with self._lock, self.hive.db.transaction():
            self.hive.db.execute("DELETE FROM connector_entries WHERE owner = ? AND connector = ?", (principal, connector_id))
            self.hive.db.execute("DELETE FROM connector_installs WHERE owner = ? AND connector = ?",
                                 (principal, connector_id))
        return self._row(principal, connector_id)

    def install(self, principal, connector_id, agent_id, installed):
        """Install a connector on one of the person's own minds, or take it off. WhatsApp moves from any other mind of
        theirs. The module loads or unloads when the mind next starts; `restart` names those running now."""
        connector = self._connector(connector_id)
        if type(installed) is not bool:
            raise _error(400, "bad_request", "installed is true or false")
        moved = []
        with self._lock, self.hive.db.transaction():
            self._own_mind(principal, agent_id)
            if installed:
                if connector.exclusive:
                    moved = [r["agent_id"] for r in self.hive.db.all(
                        "SELECT agent_id FROM connector_installs WHERE owner = ? AND connector = ? AND agent_id != ?",
                        (principal, connector_id, agent_id))]
                    self.hive.db.execute("DELETE FROM connector_installs WHERE owner = ? AND connector = ? AND agent_id != ?",
                                         (principal, connector_id, agent_id))
                self.hive.db.execute(
                    "INSERT INTO connector_installs (agent_id, connector, owner, installed_at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (agent_id, connector) DO UPDATE SET owner = excluded.owner",
                    (agent_id, connector_id, principal, time.time()))
            else:
                self.hive.db.execute("DELETE FROM connector_installs WHERE agent_id = ? AND connector = ?",
                                     (agent_id, connector_id))
        running = {r["id"] for r in self.hive.db.all(
            "SELECT id FROM agents WHERE status = 'running' AND id IN (%s)" % ",".join("?" * len([agent_id, *moved])),
            (agent_id, *moved))}
        return {**self._row(principal, connector_id), "restart": sorted(running)}

    # ---- minds ---------------------------------------------------------------------------------------------------

    def _installed_owner(self, agent, connector_id):
        """The owner whose entries this mind gets for a connector installed on it, or a 403: the install must be the
        mind's current owner's (a mind that changed hands loses what its old owner installed)."""
        owner = agent.get("owner")
        row = self.hive.db.one("SELECT owner FROM connector_installs WHERE agent_id = ? AND connector = ?",
                               (agent.get("id"), connector_id))
        if not owner or row is None or row["owner"] != owner:
            logging.getLogger("hive").warning("connectors: refused %s to mind %s, which its owner did not install it on",
                                              connector_id, agent.get("id"))
            raise _error(403, "connector_not_installed", f"{connector_id} is not installed on this mind by its owner")
        return owner

    def _still_installed(self, agent_id, connector_id, owner):
        """After an outbound call: the mind still has that owner and the install, or nothing goes back (the fence the
        Google connector's route keeps around its upstream read)."""
        row = self.hive.db.one("SELECT owner, deleted FROM agents WHERE id = ?", (agent_id,))
        install = self.hive.db.one("SELECT owner FROM connector_installs WHERE agent_id = ? AND connector = ?",
                                   (agent_id, connector_id))
        if row is None or row.get("deleted") or row.get("owner") != owner or install is None or install["owner"] != owner:
            raise _error(403, "connector_not_installed", f"{connector_id} was taken off this mind; try again")

    def installed_modules(self, agent):
        """The connector modules this mind loads beyond its host's loader: those of connectors its owner installed on
        it, less any the loader already imports. Only an Omega mind loads modules."""
        if agent.get("kind") != "omega" or not agent.get("owner"):
            return []
        rows = self.hive.db.all("SELECT connector FROM connector_installs WHERE agent_id = ? AND owner = ?",
                                (agent["id"], agent["owner"]))
        loaded = host_loader_modules()
        return sorted({CONNECTORS[r["connector"]].module for r in rows if r["connector"] in CONNECTORS} - loaded)

    @staticmethod
    def modules():
        """Every connector's module directory."""
        return sorted({c.module for c in CONNECTORS.values()})

    def home_assistant_request(self, agent, method, path, payload):
        owner = self._installed_owner(agent, "home_assistant")
        settings = self._settings(owner, "home_assistant")
        if not settings:
            raise _error(409, "connector_not_set", "the mind's owner has not entered Home Assistant's URL and token")
        try:
            result = connector_calls.home_assistant(settings, method, path, payload, self._opener)
        except connector_calls.NotAllowed as exc:
            raise _error(400, "path_not_allowed", str(exc)) from None
        except connector_calls.Unreachable as exc:
            raise _error(502, "connector_unreachable", str(exc)) from None
        self._still_installed(agent.get("id"), "home_assistant", owner)
        return result

    def librelinkup_request(self, agent, op, patient_id=None):
        owner = self._installed_owner(agent, "librelinkup")
        settings = self._settings(owner, "librelinkup")
        if not settings:
            raise _error(409, "connector_not_set", "the mind's owner has not entered a LibreLinkUp login")
        if op == "settings":
            return connector_calls.librelinkup_public(settings)
        lock = self._llu_locks.setdefault(owner, threading.Lock())

        def session():
            text = self._get(owner, "librelinkup", "session")
            return json.loads(text) if text else None

        def keep(value):
            register_secret(value.get("token"))
            self._put(owner, "librelinkup", "session", json.dumps(value))

        with lock:   # one login at a time per owner: a second caller reuses the session the first one kept
            try:
                result = connector_calls.librelinkup(settings, op, patient_id, session, keep, self._opener)
            except connector_calls.NotAllowed as exc:
                raise _error(400, "bad_request", str(exc)) from None
            except connector_calls.Unreachable as exc:
                raise _error(502, "connector_unreachable", str(exc)) from None
        self._still_installed(agent.get("id"), "librelinkup", owner)
        return result

    def entries(self, agent, connector_id, get=(), put=None, delete=()):
        """A served connector's entries for an installed mind: delete, then set, then get, one transaction."""
        connector = self._connector(connector_id)
        if connector.kind != "served":
            raise _error(400, "bad_request", f"the hive makes {connector_id}'s calls; it serves no entries")
        put = put or {}
        if (not isinstance(get, (list, tuple)) or not isinstance(delete, (list, tuple)) or not isinstance(put, dict)
                or any(not isinstance(n, str) or not NAME.fullmatch(n) for n in (*delete, *put, *get))
                or any(not isinstance(v, str) or len(v) > MAX_VALUE for v in put.values())):
            raise _error(400, "bad_request", "entries take get and delete lists of names and a set object of name to "
                         "text; a name is 1-200 letters, digits or ._@:+=- and a value at most 1 MiB")
        if connector.generated and (put or delete or any(n not in connector.generated for n in get)):
            raise _error(400, "bad_request", f"{connector_id} serves only {', '.join(connector.generated)}, which the "
                         "hive makes; a mind reads it and changes nothing")
        owner = self._installed_owner(agent, connector_id)
        values = {}
        with self._lock, self.hive.db.transaction():
            for name in delete:
                self._delete(owner, connector_id, name)
            for name, value in put.items():
                self._put(owner, connector_id, name, value)
            for name in get:
                value = self._get(owner, connector_id, name)
                if value is None and name in connector.generated:
                    value = "omega agentverse local listener " + secrets.token_hex(24)
                    self._put(owner, connector_id, name, value)
                values[name] = value
        if connector_id == "agentverse":
            register_secret(values.get("seed"))
        return {"values": values}

    # ---- the one-time import -------------------------------------------------------------------------------------

    def legacy_owner(self):
        """Whose the secrets a checkout held become: the hive's first admin, or the operator in a password-only hive."""
        row = self.hive.db.one("SELECT id FROM people WHERE role = 'admin' AND disabled = 0 ORDER BY created_at LIMIT 1")
        return f"user:{row['id']}" if row else "user:operator"

    # Time: one read and one seal of each legacy file found, plus a listing of each legacy folder; nothing is read when
    # no legacy file is left, which is every start after the first.
    def import_legacy(self, code_root):
        """Import the secrets a checkout (`code_root`) or the data folder's connectors folder holds in plain files.
        Returns one line per path acted on or kept."""
        if _throwaway(self.folder):
            return []
        report = []
        for rel in _unfinished_moves(self.folder):
            try:
                _remove(self.folder / rel)
                report.append(f"removed {FOLDER}/{rel}: a copy an interrupted move left, its original imported instead")
            except OSError as exc:
                report.append(f"kept {FOLDER}/{rel}: {exc.strerror or exc}")
        roots = ((self.folder, FOLDER + "/"), (pathlib.Path(code_root), ""))   # an earlier release's folder first
        found = [(item, prefix + rel, root / rel) for item in LEGACY for root, prefix in roots
                 for rel in _matches(root, item[2])]
        if not found:
            return report
        from .hive import HiveError
        try:
            self._open()   # the key store answers once, before any file is touched
        except HiveError as exc:   # shut (a locked Keychain, a missing key file): every file stays, and the hive starts
            return report + [f"kept {label}: the connector store is shut, {exc.message}" for _item, label, _path in found]
        owner, done = self.legacy_owner(), set()
        minds = self._own_minds(owner)
        live = _live_pairing([path for item, _label, path in found if item[0] == "whatsapp"])
        for (connector_id, entry, _rel, how), label, path in found:
            aside = connector_id == "whatsapp" and path.name != live
            if aside:   # another pairing: sealed whole under its folder's name, which no mind's request can name
                entry = f"pairings/{path.name}"
            try:
                values = _legacy_values(path, how)
                if aside:
                    values = {entry: json.dumps(values, sort_keys=True)}
                if (connector_id, entry) in done:     # a second copy of what was already imported
                    if any(self._get(owner, connector_id, n) != v for n, v in values.items()):
                        raise LegacyKept("it differs from the copy imported before it")
                    _remove(path)
                    report.append(f"removed {label}: the same as the copy imported")
                    continue
                with self._lock, self.hive.db.transaction():   # every entry or none, each checked to reopen the same
                    for name, value in values.items():
                        self._put(owner, connector_id, name, value)
                    if any(self._get(owner, connector_id, n) != v for n, v in values.items()):
                        raise LegacyKept("its sealed copy did not open to the same bytes, so nothing moved")
                if how == "llu-cache":
                    self._keep_glucose_state(minds, path)
                done.add((connector_id, entry))
                _remove(path)
                report.append(f"imported {label} as {owner}'s {connector_id}"
                              + (f", kept aside: a person's minds use one pairing, {live}" if aside else ""))
            except LegacyKept as exc:
                report.append(f"kept {label}: {exc}")
            except OSError as exc:
                report.append(f"kept {label}: {exc.strerror or exc}")
        self._install_where_loaded(owner, minds, {c for c, _ in done})
        return report

    def _own_minds(self, owner):
        """The owner's own Omega minds, oldest first: those they made, not the ones the hive makes and keeps for a
        purpose (the foundation's and a Studio maker, bound in person_minds; an app's, in app_person_minds; the
        personal mind, personal_of). Those come first in a hive's life, so the oldest mind is rarely the person's own."""
        return [r["id"] for r in self.hive.db.all(
            "SELECT id FROM agents WHERE owner = ? AND deleted = 0 AND kind = 'omega' AND personal_of IS NULL "
            "AND id NOT IN (SELECT agent_id FROM person_minds WHERE agent_id IS NOT NULL) "
            "AND id NOT IN (SELECT agent_id FROM app_person_minds) ORDER BY created_at, id", (owner,))]

    def _install_where_loaded(self, owner, minds, connector_ids):
        """Install each imported connector whose module the host's loader imports into every mind on the owner's own
        `minds` (WhatsApp on the oldest), so the minds they used it from keep it; a module the loader doesn't import was
        never used by a hive mind and stays uninstalled."""
        loaded = host_loader_modules()
        for connector_id in sorted(connector_ids):
            connector = CONNECTORS[connector_id]
            if connector.module not in loaded:
                continue
            for agent_id in (minds[:1] if connector.exclusive else minds):
                self.hive.db.execute("INSERT OR IGNORE INTO connector_installs (agent_id, connector, owner, installed_at) "
                                     "VALUES (?, ?, ?, ?)", (agent_id, connector_id, owner, time.time()))

    def _keep_glucose_state(self, minds, path):
        """The glucose reader's own state that shared its session's cache file (seen rings and measurements, per-person
        app state) goes beside the watches of each of the owner's own `minds`, which the import gives the reader."""
        if CONNECTORS["librelinkup"].module not in host_loader_modules():
            return
        cache = json.loads(path.read_text(encoding="utf-8"))
        state = {k: v for k, v in cache.items() if k not in LLU_SESSION}
        if not state:
            return
        for agent_id in minds:
            memory = pathlib.Path(self.settings.agents_dir) / agent_id / "memory"
            target = memory / "glucose_state.json"
            if memory.is_dir() and not target.exists():
                sealed._write_private(target, json.dumps(state, ensure_ascii=False, sort_keys=True))


LLU_SESSION = ("base_url", "token", "expires", "account_id", "user_id_hash", "updated")


class LegacyKept(Exception):
    """A legacy file stays where it is; the message says why."""


def _unfinished_moves(folder):
    """The .<name>.moving copies #443's move left in the connectors folder when a hive stopped between copying a
    secret and renaming it in; the original is still under the code folder then, so the copy is partial or a duplicate."""
    found = []
    for _connector, _entry, rel, _how in LEGACY:
        parent, _, name = rel.rpartition("/")
        where = _folder(folder, parent)
        if where is not None:
            found += [f"{parent}/{n}" for n in os.listdir(where) if n.startswith(".") and n.endswith(MOVING)
                      and fnmatch.fnmatchcase(n[1:-len(MOVING)], name)]
    return sorted(set(found))


def _live_pairing(folders):
    """The pairing folder whose files become the person's live WhatsApp entries: the one the hive's minds used, which
    is the folder OMEGACLAW_WA_AUTH_DIR names (the variable reaches every mind) or else the bridge's default, auth; with
    neither among them, the one whose creds.json Baileys wrote last, so the session that ran most recently goes on."""
    def pairing(p):
        creds = p / "creds.json"
        return not p.is_symlink() and p.is_dir() and creds.is_file() and not creds.is_symlink()
    pairings = [p for p in folders if pairing(p)]
    named = os.path.basename(os.path.normpath(os.environ.get("OMEGACLAW_WA_AUTH_DIR") or "")) or None
    for used in (named, "auth"):
        if used and any(p.name == used for p in pairings):
            return used
    return max(pairings, key=lambda p: ((p / "creds.json").stat().st_mtime, p.name)).name if pairings else None


def _links(path):
    if os.path.islink(path):
        return [path]
    return [os.path.join(here, n) for here, dirs, files in os.walk(path) for n in dirs + files
            if os.path.islink(os.path.join(here, n))] if os.path.isdir(path) else []


def _read_text(path):
    try:
        return pathlib.Path(path).read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise LegacyKept("it is not UTF-8 text") from None


def _legacy_values(path, how):
    """The entries a legacy file or folder holds, by entry name."""
    if _links(path):
        raise LegacyKept("it holds a link, which is never followed")
    if how == "baileys":
        if not os.path.isdir(path):
            raise LegacyKept("it is not a folder")
        values = {}
        for here, dirs, files in os.walk(path):
            if dirs or here != str(path):
                raise LegacyKept("it holds a folder, which a Baileys pairing never has")
            for name in files:
                if not NAME.fullmatch(name):
                    raise LegacyKept(f"it holds {name!r}, which is no Baileys file name")
                values[name] = _read_text(os.path.join(here, name))
        if "creds.json" not in values:
            raise LegacyKept("it holds no creds.json, so it is no pairing")
        return values
    text = _read_text(path)
    if how == "seed":
        if not text.strip():
            raise LegacyKept("it is empty")
        return {"seed": text.strip()}
    try:
        data = json.loads(text)
    except ValueError:
        raise LegacyKept("it is not JSON") from None
    if not isinstance(data, dict):
        raise LegacyKept("it is not a JSON object")
    if how == "llu-cache":
        session = {k: data[k] for k in LLU_SESSION if k in data}
        if not session.get("token"):
            raise LegacyKept("it holds no session")
        return {"session": json.dumps(session)}
    if how == "ha-json":
        settings = {"url": data.get("url") or data.get("base_url"), "token": data.get("token")}
    else:
        settings = {k: v for k, v in (("username", data.get("username") or data.get("email")),
                                      ("password", data.get("password")), ("url", data.get("url") or data.get("base_url")),
                                      ("version", data.get("version")), ("unit", data.get("unit")),
                                      ("connections", data.get("connections"))) if v not in (None, "", {})}
    connector_id = "home_assistant" if how == "ha-json" else "librelinkup"
    try:
        clean = clean_settings(connector_id, settings)
    except Exception as exc:  # noqa: BLE001 - HiveError: the legacy file is incomplete or malformed
        raise LegacyKept(f"it is not a complete login ({getattr(exc, 'message', exc)})") from None
    for key in ("token", "password"):
        register_secret(clean.get(key))
    return {"settings": json.dumps(clean)}


def _remove(path):
    (shutil.rmtree if os.path.isdir(path) and not os.path.islink(path) else os.unlink)(path)


def log_report(report):
    log = logging.getLogger("hive")
    for line in report:
        (log.warning if line.startswith("kept") else log.info)("connectors: %s", line)
    return report
