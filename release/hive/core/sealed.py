# Purpose: the key that seals a hive's connector secrets, kept out of the data folder in the platform's own key store,
# and the seal that binds each sealed entry to its owner, connector and name.
"""The connector store's key and its seal (hive/core/connectors.py keeps the store).

The key is a Fernet key (the `cryptography` package's, already in the hive's environment). Where it lives decides what the
encryption protects, so it never sits beside what it seals:

- ``HIVE_SECRETS_KEY_FILE``, when set: the key is read from that file. It is for containers and servers (a Docker
  secret, a systemd LoadCredential= file) and for a Mac hive started outside a login session. The hive never writes it.
- On a Mac: an item of the login Keychain (service ``omegahive-connectors``, account the hive's id), written through
  ``security -i`` so the key goes over stdin and never into a command line. The login keychain answers only inside the
  person's login session; started over SSH it refuses ("User interaction is not allowed") and the store stays shut.
- On Linux and in WSL: sealed by ``systemd-creds --user`` (systemd 256 or later) into ``<data>/connectors/key.cred``,
  which binds it to the host's root-only key, this user and the machine id (and a TPM2 where there is one), so the
  sealed file opens only for this user on this machine. Older systemd has no ``--user``: the key is then a 0600 file
  under ``~/.config/omegahive``, which protects copies of the data folder but not of the home folder, and the store
  says so.
- A hive whose data folder is a temporary one, as a test hive's is, keeps a throwaway key inside it.

None of these keeps the key from a process running as the hive's own user, which can ask the key store as the hive does.
A key store that doesn't answer leaves the store shut with the reason (`StoreLocked`). The hive never makes a new key
while it holds sealed entries, since those could then never be read again.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import pathlib
import subprocess
import sys

from cryptography.fernet import Fernet, InvalidToken, MultiFernet

KEYCHAIN_SERVICE = "omegahive-connectors"   # a Mac's login Keychain item: this service, the hive's id as its account
CRED_NAME = "omegahive-connectors"          # the name systemd-creds seals into the key, checked again when it opens
CRED_FILE = "key.cred"                      # the sealed key, in the data folder's connectors folder
THROWAWAY_FILE = "throwaway.key"            # a temporary hive's key, inside its own (temporary) connectors folder
SYSTEMD_USER_CREDS = 256                    # systemd-creds --user arrived in systemd 256 (systemd-creds(1))
_NAMES = b"omegahive connector entry names"


class StoreLocked(Exception):
    """This hive's connector key is unavailable; the message says why and what to do."""


def hive_id(data_dir) -> str:
    """A stable id for one hive on this machine (its data folder), so two hives keep two keys."""
    return hashlib.sha256(os.path.realpath(str(data_dir)).encode()).hexdigest()[:16]


def _checked(key: str, where: str) -> bytes:
    try:
        Fernet(key.strip())
    except (ValueError, TypeError):
        raise StoreLocked(f"{where} does not hold a connector key (a Fernet key, 44 characters)") from None
    return key.strip().encode()


def _first_line(text) -> str:
    return next((line.strip() for line in str(text or "").splitlines() if line.strip()), "no message")


def _run(runner, args, stdin=None):
    try:
        return runner(args, input=stdin, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return None


def _read_file(path: pathlib.Path):
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None


def _write_private(path: pathlib.Path, text: str):
    """A new 0600 file holding `text`, made beside `path` and renamed into place, in a 0700 folder."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _keychain(runner, account, make):
    """The key from the login Keychain, or a new one written there when `make`; None when there is none."""
    found = _run(runner, ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
    if found is None:
        raise StoreLocked("this Mac has no /usr/bin/security; set HIVE_SECRETS_KEY_FILE to a file holding the key")
    if found.returncode == 0:
        return _checked(found.stdout, "the login Keychain item " + KEYCHAIN_SERVICE)
    if found.returncode != 44:   # errSecItemNotFound; anything else is a keychain that did not answer
        raise StoreLocked("the login Keychain did not answer (" + _first_line(found.stderr) + "); start the hive in "
                          "your login session, or set HIVE_SECRETS_KEY_FILE to a file holding the key")
    if not make:
        return None
    key = Fernet.generate_key().decode()
    # security -i reads its command from stdin, so the key never appears in a command line any process can list
    added = _run(runner, ["/usr/bin/security", "-i"],
                 f"add-generic-password -U -s {KEYCHAIN_SERVICE} -a {account} -w {key}\n")
    again = _run(runner, ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
    if added is None or added.returncode != 0 or again is None or again.stdout.strip() != key:
        raise StoreLocked("the login Keychain did not keep the connector key ("
                          + _first_line((added.stderr if added else "") or (again.stderr if again else "")) + ")")
    return key.encode()


def _systemd_version(runner):
    out = _run(runner, ["systemd-creds", "--version"])
    if out is None or out.returncode != 0:
        return None
    words = _first_line(out.stdout).split()
    return int(words[1]) if len(words) > 1 and words[0] == "systemd" and words[1].isdigit() else None


def _creds(runner, path: pathlib.Path, make):
    """The key sealed with systemd-creds --user at `path`, or a new one sealed there when `make`."""
    if path.is_symlink():
        raise StoreLocked(f"{path} is a link; the sealed connector key must be a plain file")
    if path.exists():
        out = _run(runner, ["systemd-creds", "--user", f"--name={CRED_NAME}", "decrypt", str(path), "-"])
        if out is None or out.returncode != 0:
            raise StoreLocked(f"{path} did not open for this user on this machine ("
                              + _first_line(out.stderr if out else "systemd-creds is missing")
                              + "); restore the machine it was sealed on, or set HIVE_SECRETS_KEY_FILE")
        return _checked(out.stdout, str(path))
    if not make:
        return None
    key = Fernet.generate_key().decode()
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    out = _run(runner, ["systemd-creds", "--user", f"--name={CRED_NAME}", "encrypt", "-", str(tmp)], key)
    if out is None or out.returncode != 0:
        tmp.unlink(missing_ok=True)
        raise StoreLocked("systemd-creds could not seal the connector key (" + _first_line(out.stderr if out else "")
                          + "); set HIVE_SECRETS_KEY_FILE to a file holding the key")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
    return key.encode()


def _plain(path: pathlib.Path, make):
    text = _read_file(path)
    if text is not None:
        return _checked(text, str(path))
    if not make:
        return None
    key = Fernet.generate_key().decode()
    _write_private(path, key + "\n")
    return key.encode()


def fallback_file(data_dir) -> pathlib.Path:
    config = pathlib.Path(os.environ.get("XDG_CONFIG_HOME") or pathlib.Path.home() / ".config")
    return config / "omegahive" / f"connectors-{hive_id(data_dir)}.key"


def choose_home(settings, throwaway, runner=subprocess.run, platform=sys.platform):
    """Where this hive's key lives, as {"home": ...} with a "warning" when that home protects less: the one rule
    open_key follows and the store reports before any key exists."""
    if getattr(settings, "secrets_key_file", None):
        return {"home": "key-file"}
    if throwaway:
        return {"home": "throwaway", "warning": (
            "this hive's data folder is in a temporary folder, so its connector key is a plain file in that folder and "
            "protects nothing: this is for a hive thrown away with its folder, as a test's is")}
    if platform == "darwin":
        return {"home": "keychain"}
    version = _systemd_version(runner)
    if version is not None and version >= SYSTEMD_USER_CREDS:
        return {"home": "systemd-creds"}
    why = f"systemd {version}" if version is not None else "no systemd-creds"
    return {"home": "fallback-file", "warning": (
        f"{why} here, so the connector key is the file {fallback_file(settings.data_dir)}: it protects copies of the "
        f"hive's data folder, not of your home folder (systemd 256 or later seals it to this machine)")}


# Time: at most four short subprocess calls (security or systemd-creds), once per hive start that needs the key.
def open_key(settings, folder, sealed, throwaway, runner=subprocess.run, platform=sys.platform):
    """(key, info) for this hive: `info` says where the key lives ("home") and, when that home protects less, a
    "warning". `sealed` is how many entries the store already holds sealed: with none a missing key is made, with
    some a missing key is StoreLocked, never replaced. `folder` is the data folder's connectors folder."""
    folder = pathlib.Path(folder)
    make = sealed == 0
    info = choose_home(settings, throwaway, runner, platform)
    home = info["home"]
    if home == "key-file":
        named = settings.secrets_key_file
        text = _read_file(pathlib.Path(named))
        if text is None:
            raise StoreLocked(f"HIVE_SECRETS_KEY_FILE names {named}, which does not exist")
        return _checked(text, f"HIVE_SECRETS_KEY_FILE ({named})"), info
    if home == "throwaway":
        key, where = _plain(folder / THROWAWAY_FILE, make), folder / THROWAWAY_FILE
    elif home == "keychain":
        key = _keychain(runner, hive_id(settings.data_dir), make)
        where = f"the login Keychain item {KEYCHAIN_SERVICE}"
    elif home == "systemd-creds":
        key, where = _creds(runner, folder / CRED_FILE, make), folder / CRED_FILE
    else:
        key, where = _plain(fallback_file(settings.data_dir), make), fallback_file(settings.data_dir)
    if key is None:
        raise StoreLocked(f"{where} is missing while this hive holds sealed connector entries; restore it, or set "
                          "HIVE_SECRETS_KEY_FILE to a file holding the key")
    return key, info


class Seal:
    """Seals one entry's value bound to its owner, connector and name, so a sealed value moved to another row does not
    open, and names an entry by an HMAC so a name (a WhatsApp key file's, which carries a phone number) isn't kept."""

    def __init__(self, key: bytes):
        self._fernet = MultiFernet([Fernet(key)])   # MultiFernet: a later key can join in front for rotation
        self._names = hmac.new(base64.urlsafe_b64decode(key), _NAMES, hashlib.sha256).digest()

    def name(self, owner, connector, name) -> str:
        return hmac.new(self._names, "\0".join((owner, connector, name)).encode(), hashlib.sha256).hexdigest()

    def seal(self, owner, connector, name, value: str) -> str:
        body = json.dumps({"o": owner, "c": connector, "n": name, "v": value}, ensure_ascii=False)
        return self._fernet.encrypt(body.encode()).decode()

    def open(self, owner, connector, name, token: str) -> str:
        """The value, or StoreLocked when the token does not open under this key or names another entry."""
        try:
            body = json.loads(self._fernet.decrypt(token.encode()))
        except (InvalidToken, ValueError):
            raise StoreLocked("a sealed connector entry did not open under this hive's key") from None
        if (body.get("o"), body.get("c"), body.get("n")) != (owner, connector, name):
            raise StoreLocked("a sealed connector entry names another owner, connector or name")
        return body["v"]
