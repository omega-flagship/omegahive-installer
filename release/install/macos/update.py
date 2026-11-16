"""Purpose: offer the owner of a Mac hive a newer release and install it in place, only when a statement signed with a
key its own release trusts says so. omegahive.sh runs `update.py check --home $OH` with the hive's toolchain Python
before it starts the hive (with --terminal when it has no terminal, as when the Omega Hive app runs it), and its
launchd job runs `update.py check --home $OH --job` every hour while the hive runs; whatever happens here, the hive
keeps starting and running on the version it has.

What a hive trusts comes from the build that made its release, never from the repository: the build writes
update-trust.json beside this file (publish-update.py trust, and rotate when a key is replaced), {"channel", "feed",
"keys", "next_keys", "seq", "rotations"}. A build made without one takes no updates. The feed holds {"statement": {app,
channel, version, label, notes, url, zip_sha256, zip_length, tree_sha256, expires}, "sig": hex, "rotations": [...]}. A
hive believes the statement only when (after Sparkle's signed feeds and TUF's rules):
  - the Ed25519 signature checks against one of its channel's current keys that it has not retired (release_sig.py);
  - app is this app and channel is the trust file's, so a hive from one channel (the maintainers' "release") never
    takes another channel's statement (our "test" builds), whichever key signed it;
  - the statement has not expired (an expired one is "could not check", never "up to date"), and its version is not
    below the highest this hive has seen on its channel (no replay of an older statement);
  - its version is above the installed RELEASE_VERSION (dotted numbers such as 0.10, compared number by number).
Keys are replaced as TUF replaces root keys, with KERI's pre-rotation: each trust file names next keys beside its keys,
and a rotation record {"rotation": {app, channel, seq, keys, next_keys}, "sig": hex} replaces the keys of rotation
seq - 1 (seq 0 being a channel's first keys) only when its keys were that rotation's next keys and one of them signed
it. Whoever holds only a current key, a stolen one included, cannot replace the keys, and a lost key is replaced by its
successor without it. The feed carries every rotation of its channel, and before checking the statement a hive walks
from its own trust file's seq through each later rotation in turn, however many replacements behind it is; the keys a
rotation replaced sign nothing more here. A rotation naming the next seq that fails stops the check, as TUF stops at a
root it cannot verify (section 5.3). Before running a release's installer, the hive reads the release's own trust file
and runs it only when it is of this hive's channel and leads, through the feed's rotations, to the key that signed the
statement, so no update leaves a hive unable to check the next one.
Then the owner chooses "Update to <label>" or "Not now" (asked again a day later); an offer nobody answers, a dialog
that gave up or a Mac with no screen to show it on, is asked again at the next check. On Update the zip comes by direct
download, which after a stall or a dropped connection asks again for the rest (download()), or, while the release
needs a GitHub sign-in, through the owner's browser into ~/Downloads, where this waits for it. Either the zip arrives
(at most zip_length bytes read, its sha256 checked) or, since Safari unzips a download itself and keeps only the
folder, an unpacked folder whose tree digest (release_sig.tree_digest_of_dir) is the statement's. Nothing is unpacked
or run before its bytes match, and the copy that runs is checked again where it is staged, so a download that changes
in ~/Downloads after its check is refused. The release's RELEASE_VERSION must equal the statement's, and its installer
then refreshes the hive in place (the installer's refresh path) and opens it.

Exit status: 0 nothing installed here (none newer, declined, could not check, or the hourly job handed the refresh to
Terminal); 10 updated, the new installer opened the hive, or with --terminal the refresh went to a Terminal window of
its own, whose installer opens the hive; 1 the owner accepted but the update failed (shown and logged; the hive goes on
with the version it has); 3, only with --page, another run holds run/update.lock, so nothing was checked.

run/update-state.json, which the hive's Updates page reads through the HIVE_UPDATE_STATE its launcher sets, holds the
channel, the newest version taken ("seen"), the statement taken last ("offer": its signed version, label and notes),
when that was ("checked", UTC), why the last check could not tell whether a newer release is out ("check_failed":
when, the plain reason the page says and the log's detail, until a check takes a statement, so the page never calls
an old answer current), a Not now ("deferred") and why the last accepted update failed
("failed": version, error, when). The page offers "offer" while its version is above the running release, and its
Update now runs `update.py check --home $OH --job --answer Update`, the hourly job's own path with the answer given.
Its Check now runs `update.py check --home $OH --job --page`, the same path asking nothing: what the check found goes
into the state for the page, which offers the release itself, so no dialog opens and a Not now does not hide it (as
Sparkle shows a skipped update to a check its owner asked for).
"""
import argparse
import datetime
import fcntl
import hashlib
import http.client
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_sig  # noqa: E402

APP = "omegahive-mac"               # what every Mac statement names, so no other app's signed statement passes here
TRUST_FILE = pathlib.Path(__file__).resolve().parent / "update-trust.json"
FEED_CAP = 64 * 1024                # a statement is a few hundred bytes
ZIP_CAP = 4 * 1024 ** 3
DEFER_SECONDS = 24 * 3600           # "Not now" asks again a day later, as Sparkle's default check interval
# After a stall or a dropped connection the download asks again for the bytes from where it stopped (Range, RFC 9110
# section 14), as pip's resume retries, curl -C - and wget -c do: a tester's update over hotel wifi failed twice with
# "The read operation timed out" while each try began again at byte 0. These are the seconds waited before each retry
# in a row that gets no further than every try before it; after the last of them the download gives up.
RETRY_WAITS = (2, 5, 10, 20, 40)
UPDATED = 10
BUSY = 3                            # --page: another run holds run/update.lock, so this one checked nothing
VERSION =re.compile(r"[0-9]{1,9}(\.[0-9]{1,9}){0,3}")
INSTALLER = pathlib.Path("install") / "macos" / "Install OmegaHive.command"


class UpdateError(Exception):
    pass


def version_key(text):
    """0.10 above 0.9 above 0.8.1: the dotted numbers compared one by one."""
    return tuple(int(part) for part in text.split("."))


class Hive:
    def __init__(self, home):
        self.home = pathlib.Path(home)
        self.app = self.home / "app"
        self.run = self.home / "run"
        self.log_path = self.home / "logs" / "update.log"
        self.state_path = self.run / "update-state.json"

    def log(self, text):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.log_path, "a") as out:
            out.write(time.strftime("%Y-%m-%d %H:%M:%S ") + text + "\n")

    def installed_version(self):
        """The installed release's RELEASE_VERSION; "0" for a build from before releases were numbered, which is
        older than any numbered release."""
        try:
            text = (self.app / "RELEASE_VERSION").read_text().split()[0]
        except (OSError, IndexError):
            return "0"
        return text if VERSION.fullmatch(text) else "0"

    def running(self):
        """Whether the hive answers on its control socket (omegahive.sh's own test asks it hello)."""
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(2)
        try:
            sock.connect(str(self.home / "data" / "run" / "control.sock"))
            return True
        except OSError:
            return False
        finally:
            sock.close()

    def state(self):
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return {}
        return state if isinstance(state, dict) else {}

    def save(self, state):
        self.run.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, sort_keys=True) + "\n")
        os.replace(tmp, self.state_path)


def utc_stamp():
    """Now in the state file's form, UTC to the second: 2026-11-16T03:50:00Z."""
    return datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


# Why a check could not tell whether a newer release is out, in the words the Updates page says; the log keeps the
# detail. A tester's page said "Up to date" from a check 23 hours old while two releases were out, because the checks
# after it saved nothing (16 November).
CANNOT = {"no_channel": "this build takes no updates",
          "bad_trust": "this hive's update settings can't be read",
          "unreachable": "the release feed couldn't be reached",
          "bad_keys": "the release feed's signing keys didn't check out",
          "unpublished": "the release feed has no release in it",
          "bad_statement": "the newest release in the feed didn't check out",
          "expired": "the newest release in the feed has expired",
          "older": "the feed offered an older release than one this hive already saw"}


def could_not_check(hive, state, why, detail):
    """A check that could not tell whether a newer release is out: the detail goes to the log, and the check's time,
    its plain reason (CANNOT[why]) and the detail into the state as check_failed, which a check that takes a statement
    clears. Returns the check's exit status, 0."""
    hive.log(detail)
    state["check_failed"] = {"at": utc_stamp(), "reason": CANNOT[why], "detail": detail[:500]}
    hive.save(state)
    return 0


def fetch_bytes(url, cap, timeout):
    """GET url, refusing an answer longer than cap bytes."""
    with urllib.request.urlopen(url, timeout=timeout) as answer:
        data = answer.read(cap + 1)
    if len(data) > cap:
        raise UpdateError(f"{url} answered more than {cap} bytes")
    return data


def is_hex64(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def is_keys(value, at_least=0):
    """A list of at least at_least public keys of 64 lowercase hex."""
    return isinstance(value, list) and len(value) >= at_least and all(is_hex64(k) for k in value)


def is_sig(value):
    return isinstance(value, str) and len(value) == 128 and all(c in "0123456789abcdef" for c in value)


def is_fetch_url(url):
    """Where a hive may fetch a feed or a zip from: https, or this Mac's loopback (tests)."""
    return isinstance(url, str) and (url.startswith("https://") or url.startswith("http://127.0.0.1:"))


def read_trust(data):
    """update-trust.json's content as {"channel", "feed", "keys", "next_keys", "seq", "rotations"}, or ValueError saying
    what is wrong. seq counts the rotations since the channel's first keys, and rotations holds those records in order,
    the last naming these keys and next keys; a file without them holds a channel's first keys (seq 0). Their
    signatures are checked where a hive walks them (walk), and by publish-update.py rotate, which writes them. A file
    from before channels ({"app", "feed", "pubkey"}, written into releases 0.10 to 0.13) is the test channel with that
    one key."""
    if isinstance(data, dict) and "pubkey" in data and "keys" not in data:
        data = {"channel": "test", "feed": data.get("feed"), "keys": [data["pubkey"]], "next_keys": []}
    if not isinstance(data, dict):
        raise ValueError("it is not an object")
    keys, next_keys = data.get("keys"), data.get("next_keys", [])
    seq, rotations = data.get("seq", 0), data.get("rotations", [])
    problems = []
    if not (isinstance(data.get("channel"), str) and data["channel"]):
        problems.append("its channel is not a name")
    if not is_fetch_url(data.get("feed")):
        problems.append("its feed is neither https nor this Mac's loopback")
    if not is_keys(keys, 1):
        problems.append("its keys are not one or more public keys of 64 lowercase hex")
    if not is_keys(next_keys):
        problems.append("its next_keys are not public keys of 64 lowercase hex")
    elif isinstance(keys, list) and set(map(str, keys)) & set(next_keys):
        problems.append("a key is listed both as a key and as a next key")
    if not (type(seq) is int and seq >= 0):
        problems.append("its seq is not a count of rotations")
    elif not (isinstance(rotations, list) and len(rotations) == seq):
        problems.append(f"its rotations are not the {seq} record(s) its seq counts")
    else:
        for n, record in enumerate(rotations, 1):
            body = record.get("rotation") if isinstance(record, dict) else None
            if not (isinstance(body, dict) and type(body.get("seq")) is int and body["seq"] == n
                    and body.get("channel") == data.get("channel") and is_sig(record.get("sig"))):
                problems.append(f"its rotation {n} is not a signed record of rotation {n} of its channel")
                break
        else:
            if rotations and (rotations[-1]["rotation"].get("keys") != keys
                              or rotations[-1]["rotation"].get("next_keys") != next_keys):
                problems.append("its last rotation names other keys or next keys than it does")
    if problems:
        raise ValueError("; ".join(problems))
    return {"channel": data["channel"], "feed": data["feed"], "keys": list(keys), "next_keys": list(next_keys),
            "seq": seq, "rotations": list(rotations)}


def rotation_problems(body, channel, seq, next_keys, history):
    """What keeps a rotation record's body from replacing the keys of rotation seq - 1, whose next keys are next_keys,
    its signature aside; history holds every key current so far on the walk, which no rotation names as next again."""
    if not isinstance(body, dict):
        return ["it is not an object"]
    keys, nxt = body.get("keys"), body.get("next_keys")
    problems = []
    if body.get("app") != APP:
        problems.append(f"it is for {body.get('app')!r}, not {APP!r}")
    if body.get("channel") != channel:
        problems.append(f"it is for channel {body.get('channel')!r}, not {channel!r}")
    if not (type(body.get("seq")) is int and body["seq"] == seq):
        problems.append(f"its seq is not {seq}")
    if not is_keys(keys, 1):
        problems.append("its keys are not one or more public keys of 64 lowercase hex")
    elif not set(keys) <= set(next_keys):
        problems.append("its keys were not the next keys of the rotation before it")
    if not is_keys(nxt):
        problems.append("its next_keys are not public keys of 64 lowercase hex")
    elif set(nxt) & (history | set(keys if is_keys(keys) else [])):
        problems.append("a next key it names has already been a current key")
    return problems


def walk(trust, rotations):
    """This channel's keys as they stand now: the trust file's, carried through each rotation record after its seq in
    turn, as a TUF client checks each newer root against the one before (section 5.3). Returns (seq, keys, replaced),
    replaced holding every key a rotation on the way replaced, which signs nothing more. Records at or below the trust
    file's seq are history and skipped; a record naming the next seq that fails raises UpdateError, as TUF stops at a
    root it cannot verify. Time: one dictionary entry per record, then for each record after the file's seq one
    canonical encoding and at most one signature check per key it names."""
    if not isinstance(rotations, list):
        raise UpdateError("refused the feed's rotations: they are not a list")
    by_seq = {}
    for record in rotations:
        body = record.get("rotation") if isinstance(record, dict) else None
        n = body.get("seq") if isinstance(body, dict) else None
        if type(n) is not int:
            raise UpdateError("refused the feed's rotations: one has no seq")
        if n in by_seq:
            raise UpdateError(f"refused the feed's rotations: two claim rotation {n}")
        by_seq[n] = record
    seq, keys, next_keys = trust["seq"], list(trust["keys"]), list(trust["next_keys"])
    history, replaced = set(keys), []
    while seq + 1 in by_seq:
        record = by_seq[seq + 1]
        body = record["rotation"]
        problems = rotation_problems(body, trust["channel"], seq + 1, next_keys, history)
        if not problems:
            try:
                data = release_sig.message(body, release_sig.ROTATION)
            except ValueError:          # a value with no canonical JSON, such as a float, was never signed
                data = None
            if data is None or not any(release_sig.verify(k, record.get("sig"), data) for k in body["keys"]):
                problems.append("no key it names signed it")
        if problems:
            raise UpdateError(f"refused key rotation {seq + 1}: " + "; ".join(problems))
        replaced += [k for k in keys if k not in replaced]
        seq, keys, next_keys = seq + 1, list(body["keys"]), list(body["next_keys"])
        history |= set(keys)
    return seq, keys, replaced


def signing_key(keys, st, sig):
    """The key among keys whose Ed25519 signature over the statement sig is; None when there is none. Time: at most one
    verification per key."""
    if not isinstance(sig, str):
        return None
    try:
        data = release_sig.message(st)
    except ValueError:                  # a value with no canonical JSON, such as a float, was never signed
        return None
    for key in keys:
        if release_sig.verify(key, sig, data):
            return key
    return None


def statement_problems(st, trust):
    """What makes a signed statement unusable on a hive with this trust file; empty when every field is the kind its
    check needs."""
    if not isinstance(st, dict):
        return ["the statement is not an object"]
    problems = []
    if st.get("app") != APP:
        problems.append(f"it is for {st.get('app')!r}, not {APP!r}")
    if st.get("channel") != trust["channel"]:
        problems.append(f"it is for channel {st.get('channel')!r}, not this hive's {trust['channel']!r}")
    if not (isinstance(st.get("version"), str) and VERSION.fullmatch(st["version"])):
        problems.append("its version is not dotted numbers like 0.10")
    if not (type(st.get("zip_length")) is int and 1 <= st["zip_length"] <= ZIP_CAP):
        problems.append("its zip_length is not a size")
    for field in ("zip_sha256", "tree_sha256"):
        if not is_hex64(st.get(field)):
            problems.append(f"its {field} is not 64 lowercase hex")
    if not is_fetch_url(st.get("url")):
        problems.append("its url is neither https nor this Mac's loopback")
    for field in ("label", "notes"):
        if not isinstance(st.get(field), str) or len(st[field]) > 600:
            problems.append(f"its {field} is not a short text")
    try:
        datetime.datetime.strptime(st.get("expires", ""), "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        problems.append("its expires is not a UTC time like 2026-12-10T00:00:00Z")
    return problems


def expired(st, now):
    end = datetime.datetime.strptime(st["expires"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.UTC)
    return now >= end


def osascript(script, env):
    return subprocess.run(["/usr/bin/osascript", "-e", script], env=dict(os.environ, **env), capture_output=True,
                          text=True)


def ask(st, installed):
    """"Update" or "Not now" as the owner chose in a macOS dialog, or "No answer" when nobody answered within ten
    minutes or there was no screen to ask on: a person away from the Mac has declined nothing, so the next hourly check
    asks again, as Sparkle's update alert stays until it is answered. osascript reports the Not now button, the dialog's
    cancel button, as error -128 (User canceled), and a dialog that gave up with "gave up:true"."""
    have = f"release {installed}" if installed != "0" else "an earlier test build"
    text = (f"Omega hive {st['label']} is ready. This Mac has {have}.\n\n{st['notes']}\n\n"
            "Your hive restarts on the new version, and its minds, files and settings stay.")
    button = f"Update to {st['label']}"
    done = osascript('display dialog (system attribute "OH_UPDATE_TEXT") with title "Omega hive update" '
                     'buttons {"Not now", (system attribute "OH_UPDATE_BUTTON")} default button 2 '
                     'cancel button "Not now" giving up after 600',
                     {"OH_UPDATE_TEXT": text, "OH_UPDATE_BUTTON": button})
    out = done.stdout.strip()
    if done.returncode == 0 and "gave up:true" not in out:
        return "Update" if f"button returned:{button}" in out else "Not now"
    if done.returncode != 0 and "(-128)" in done.stderr:
        return "Not now"
    return "No answer"


def tell(text, dialog=True):
    """A message the owner sees: a dialog when a person is at the screen, the terminal otherwise. A run answered by
    --answer has no person at the screen, so it only prints (a dialog there would wait out its five minutes)."""
    if not dialog or osascript('display dialog (system attribute "OH_UPDATE_TEXT") with title "Omega hive update" buttons {"OK"} '
                 'default button "OK" giving up after 300', {"OH_UPDATE_TEXT": text}).returncode != 0:
        print(text, file=sys.stderr)


class Hasher:
    """sha256 of at most `length` bytes; more is refused while reading, before anything is unpacked."""

    def __init__(self, length):
        self.length, self.seen, self.digest = length, 0, hashlib.sha256()

    def take(self, chunk):
        self.seen += len(chunk)
        if self.seen > self.length:
            raise UpdateError(f"the download is longer than the {self.length} bytes the statement names")
        self.digest.update(chunk)


def file_matches(path, st):
    try:
        if path.stat().st_size != st["zip_length"]:
            return False
        h = Hasher(st["zip_length"])
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.take(chunk)
        return h.digest.hexdigest() == st["zip_sha256"]
    except (OSError, UpdateError):
        return False


def content_range_start(answer):
    """The first byte a 206 answer holds, from its Content-Range ("bytes 1000-1099/92872227"); None when it has none
    this can read."""
    m = re.fullmatch(r"bytes ([0-9]+)-[0-9]+/(?:[0-9]+|\*)", (answer.headers.get("Content-Range") or "").strip())
    return int(m.group(1)) if m else None


def download(st, dest, timeout=60, waits=RETRY_WAITS):
    """The zip straight from its URL; None when the URL needs the owner's sign-in (a private release).

    A read that waits `timeout` seconds is a stall. After a stall or a dropped connection the next try asks for the
    rest (Range: bytes=<seen>-) and appends it when the answer is a 206 starting exactly there; a 200 is the whole zip
    again, so the file starts over, and an answer that is neither leaves nothing to keep, so the next try asks for the
    whole zip. A try that gets further than every try before it is followed by the next at once; the download gives up
    when a try and then len(waits) more in a row get no further, waiting waits[i] seconds before each of those. GitHub's
    release assets redirect to a host that answers Range with 206 (checked on the v0.29 zip). No If-Range: the
    statement pins the zip's length and sha256, checked at the end as before, so bytes of a changed file never pass,
    and that host answers a mismatched If-Range with 206 anyway.
    Time: at most len(waits) + 1 tries in a row without progress, each ending after `timeout` seconds of silence at
    most, plus sum(waits) seconds of waiting; a try that progresses resets that count."""
    length = st["zip_length"]
    h, best, misses, why, private = Hasher(length), 0, 0, "", False
    with open(dest, "wb") as out:
        while h.seen < length and misses <= len(waits):
            if misses:
                time.sleep(waits[misses - 1])
            asked = h.seen
            ask = urllib.request.Request(st["url"], headers={"Range": f"bytes={asked}-"} if asked else {})
            try:
                with urllib.request.urlopen(ask, timeout=timeout) as answer:
                    first = content_range_start(answer) if answer.status == 206 else 0 if answer.status == 200 else None
                    if first != asked:          # not the rest of what is here, so the file starts over
                        out.seek(0)
                        out.truncate()
                        h = Hasher(length)
                    if first == h.seen:
                        # read1 hands over what has arrived, so a stall keeps every byte that came before it
                        for chunk in iter(lambda: answer.read1(1 << 20), b""):
                            h.take(chunk)
                            out.write(chunk)
                        why = "the connection closed before the end"
                    else:
                        why = (f"asked for the bytes from {asked}, it answered {answer.status} "
                               f"{answer.headers.get('Content-Range') or ''}".rstrip())
            except urllib.error.HTTPError as err:
                if err.code in (401, 403, 404) and not best:
                    private = True
                    break
                why = f"HTTP {err.code}"
            except (OSError, http.client.HTTPException) as err:     # timeouts, resets, TLS and name errors (URLError)
                why = str(getattr(err, "reason", None) or err)
            best, misses = (h.seen, 0) if h.seen > best else (best, misses + 1)
    if private:
        dest.unlink()
        return None
    if h.seen < length:
        dest.unlink()
        raise UpdateError(f"the download stopped at {h.seen / 1e6:.1f} of {length / 1e6:.1f} MB after {misses} tries "
                          f"in a row got no further: {why}")
    if h.digest.hexdigest() != st["zip_sha256"]:
        dest.unlink()
        raise UpdateError("the download is not the release the statement names (length or sha256 differs)")
    return dest


def release_folders(downloads, since):
    """Folders in downloads made since `since` that hold a release: Safari's unzip of the download ("Omega Hive",
    "Omega Hive 2" when the first is still there)."""
    for path in sorted(pathlib.Path(downloads).iterdir()):
        try:
            if path.is_dir() and path.stat().st_mtime >= since and (path / "omegahive" / INSTALLER).is_file():
                yield path
        except OSError:
            continue


def from_browser(st, downloads, opener, wait):
    """Open the release in the owner's browser, then wait in downloads for either its zip (by length and sha256,
    whatever name the browser gives it) or the folder Safari unzips it to (by the signed tree digest, once the unzip
    is whole). Time: a listing every 2 seconds, one sha256 pass per zip of the right length, and one tree digest per
    candidate folder each time it changes."""
    started = time.time()
    subprocess.run([opener, st["url"]], check=False)
    print(f"Your browser is downloading Omega hive {st['label']}. The update goes on by itself once the download "
          f"finishes (it waits up to {wait // 60} minutes).", flush=True)
    rejected, digests = set(), {}
    while time.time() - started < wait:
        for path in sorted(pathlib.Path(downloads).glob("*.zip")):
            try:
                key = (str(path), path.stat().st_mtime_ns)
                if key in rejected or path.stat().st_mtime < started - 60:
                    continue
                if file_matches(path, st):
                    return path
                if path.stat().st_size == st["zip_length"]:
                    rejected.add(key)          # complete and wrong: never looked at again
            except OSError:
                continue
        for folder in release_folders(downloads, started - 60):
            # A folder still being unzipped changes between looks; its digest is taken again only when it has.
            mark = sum(1 for _ in folder.rglob("*")), max((p.lstat().st_mtime_ns for p in folder.rglob("*")), default=0)
            if digests.get(folder) == mark:
                continue
            digests[folder] = mark
            if release_sig.tree_digest_of_dir(folder) == st["tree_sha256"]:
                return folder
        time.sleep(2)
    raise UpdateError(f"no download of {st['label']} with the right checksum reached {downloads} within {wait // 60} minutes")


def unpack(got, st, stage):
    """The release, zip or Safari's folder, copied into stage without macOS's quarantine (ditto --noqtn) and checked
    again there, since what runs is the copy: a zip is copied beside stage while its sha256 is taken and only that copy
    is unpacked, and the unpacked folder's tree digest must be the statement's. A download in ~/Downloads that changes
    after from_browser checked it (anything running as this user can write there) is refused before it runs.
    Time: one copy of the release and one sha256 pass over its files, two for a zip."""
    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)
    if got.is_dir():
        subprocess.run(["/usr/bin/ditto", "--noqtn", str(got), str(stage / got.name)], check=True)
    else:
        copy = stage.parent / "checked.zip"
        h = Hasher(st["zip_length"])
        try:
            with open(got, "rb") as src, open(copy, "wb") as out:
                for chunk in iter(lambda: src.read(1 << 20), b""):
                    h.take(chunk)
                    out.write(chunk)
            if h.seen != st["zip_length"] or h.digest.hexdigest() != st["zip_sha256"]:
                raise UpdateError("its length or sha256 differs now")
        except UpdateError as err:
            copy.unlink(missing_ok=True)
            raise UpdateError(f"the download changed after it was checked: {err}") from err
        subprocess.run(["/usr/bin/ditto", "-x", "-k", "--noqtn", str(copy), str(stage)], check=True)
        copy.unlink()
    subprocess.run(["/usr/bin/xattr", "-dr", "com.apple.quarantine", str(stage)], check=False, capture_output=True)
    roots = [p for p in stage.iterdir() if (p / "omegahive" / INSTALLER).is_file()]
    if len(roots) != 1:
        raise UpdateError("the release does not hold one Omega hive folder with its installer")
    if release_sig.tree_digest_of_dir(roots[0]) != st["tree_sha256"]:
        raise UpdateError("the release changed after it was checked: the copy made to run is not the signed tree")
    return roots[0] / "omegahive"


def hand_to_terminal(hive, src, opener, work):
    """The refresh in a Terminal window of its own: launchd's job must not run the installer as its child, since the
    installer's `omegahive.sh stop` boots the job out together with its children, and the Omega Hive app has no window
    of its own to show a refresh of several minutes in."""
    script = work / "update.command"
    script.write_text("#!/bin/bash\n# Purpose: run the verified release's installer over this hive (update.py).\n"
                      f"export OMEGAHIVE_HOME='{hive.home}'\nexec /bin/bash '{src / INSTALLER}'\n")
    script.chmod(0o755)
    subprocess.run([opener, "-a", "Terminal", str(script)], check=True)


def check(args):
    hive = Hive(args.home)
    if args.job and not hive.running():
        return 0                            # the hourly job offers updates only while the hive runs
    # One run at a time, and every word a run keeps for the Updates page is written under this lock.
    hive.run.mkdir(parents=True, exist_ok=True)
    lock = open(hive.run / "update.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return BUSY if args.page else 0     # another check is asking or updating right now
    state = hive.state()
    if not TRUST_FILE.exists():
        return could_not_check(hive, state, "no_channel", f"no {TRUST_FILE.name}: this build was made without an "
                                                          "update channel, so it takes no updates")
    try:
        trust = read_trust(json.loads(TRUST_FILE.read_text()))
    except (OSError, ValueError) as err:
        return could_not_check(hive, state, "bad_trust", f"{TRUST_FILE} is not a trust file this updater reads: {err}")
    feed = args.feed or trust["feed"]
    installed = hive.installed_version()
    for old in (hive.home / "build").glob("update-*"):
        # What an update handed to Terminal left: gone once the hive runs that release or a later one.
        if VERSION.fullmatch(old.name[7:]) and version_key(old.name[7:]) <= version_key(installed):
            shutil.rmtree(old, ignore_errors=True)
    try:
        doc = json.loads(fetch_bytes(feed, FEED_CAP, timeout=10))
    except (OSError, ValueError, UpdateError) as err:
        return could_not_check(hive, state, "unreachable", f"could not check {feed}: {err}")
    st, sig, rotations = ((doc.get("statement"), doc.get("sig"), doc.get("rotations", [])) if isinstance(doc, dict)
                          else (None, None, []))
    if state.get("channel") != trust["channel"]:
        state = {"channel": trust["channel"]}   # a channel's versions and retired keys are its own
    retired = set(state.get("retired") or [])
    try:
        seq, keys, replaced = walk(trust, rotations)
    except UpdateError as err:
        return could_not_check(hive, state, "bad_keys", str(err))
    newly = set(replaced) - retired
    if newly:
        # A rotation stands on its own, as a TUF root does: what it replaced stays retired whatever the statement says.
        hive.log(f"the release keys moved to rotation {seq}: the {len(newly)} key(s) it replaced sign nothing more here")
        retired |= newly
        state["retired"] = sorted(retired)
        hive.save(state)
    if st is None:
        return could_not_check(hive, state, "unpublished", "no release is published yet")
    key = signing_key([k for k in keys if k not in retired], st, sig)
    if key is None:
        if signing_key(sorted(retired), st, sig):
            return could_not_check(hive, state, "bad_statement", "refused a statement signed by a key a rotation replaced")
        return could_not_check(hive, state, "bad_statement",
                               "refused a statement whose signature does not check against the release keys")
    problems = statement_problems(st, trust)
    if problems:
        return could_not_check(hive, state, "bad_statement", "refused a signed statement: " + "; ".join(problems))
    now = datetime.datetime.now(datetime.UTC)
    if expired(st, now):
        return could_not_check(hive, state, "expired", f"could not check: the newest statement (version "
                                                       f"{st['version']}) expired at {st['expires']}")
    seen = state.get("seen")
    if isinstance(seen, str) and VERSION.fullmatch(seen) and version_key(st["version"]) < version_key(seen):
        return could_not_check(hive, state, "older", f"refused statement version {st['version']}, below version {seen} "
                                                     "seen before")
    # The statement is taken: it is the newest this hive has seen.
    # What the Updates page shows comes from here: the signed statement's own version, label and notes, and when it
    # was taken, so the page names a release on offer, or says up to date, without reading the feed itself.
    state["seen"] = st["version"]
    state["offer"] = {"version": st["version"], "label": st["label"], "notes": st["notes"]}
    state["checked"] = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    state.pop("check_failed", None)
    hive.save(state)
    if version_key(st["version"]) <= version_key(installed):
        hive.log(f"up to date: release {installed}, newest {st['version']}")
        return 0
    if args.page:
        # The Updates page's Check now: the page offers the release with its own Update now, so nothing asks here.
        hive.log(f"found {st['label']} (version {st['version']}) over release {installed} for the Updates page")
        return 0
    deferred = state.get("deferred") or {}
    if not args.answer and deferred.get("version") == st["version"] and time.time() < deferred.get("until", 0):
        return 0
    answer = args.answer or ask(st, installed)
    hive.log(f"offered {st['label']} (version {st['version']}) over release {installed}: {answer}")
    if answer == "No answer":
        return 0                            # nothing declined: the next check asks again
    if answer != "Update":
        state["deferred"] = {"version": st["version"], "until": int(time.time()) + DEFER_SECONDS}
        hive.save(state)
        return 0
    try:
        work = hive.home / "build" / f"update-{st['version']}"
        work.mkdir(parents=True, exist_ok=True)
        got = download(st, work / "release.zip")
        if got is None:
            got = from_browser(st, args.downloads or pathlib.Path.home() / "Downloads", args.opener, args.wait)
        hive.log(f"verified {got} against the statement for {st['label']}")
        src = unpack(got, st, work / "unpacked")
        try:
            inside = (src / "RELEASE_VERSION").read_text().split()[0]
        except (OSError, IndexError):
            inside = None
        if inside != st["version"]:
            raise UpdateError(f"the release says it is {inside}, the statement {st['version']}")
        # The release's own trust file is what this hive trusts once it runs. Missing, of another channel, or not
        # leading through the feed's rotations to the key that signed this statement, it would strand the hive.
        try:
            theirs = read_trust(json.loads((src / INSTALLER.parent / TRUST_FILE.name).read_text()))
        except (OSError, ValueError) as err:
            raise UpdateError(f"the release has no {TRUST_FILE.name} this updater reads ({err}), so it would take "
                              "no updates after this one") from err
        if theirs["channel"] != trust["channel"]:
            raise UpdateError(f"the release follows channel {theirs['channel']!r}, not this hive's "
                              f"{trust['channel']!r}")
        if key not in walk(theirs, rotations)[1]:
            raise UpdateError(f"the release's {TRUST_FILE.name} does not lead to the key that signed it, so after it "
                              "this hive could not check the next statement")
        state.pop("deferred", None)
        state.pop("failed", None)
        hive.save(state)
        if args.job or args.terminal:
            hand_to_terminal(hive, src, args.opener, work)
            hive.log(f"handed {st['label']}'s installer to Terminal")
            return UPDATED if args.terminal else 0
        installer = src / INSTALLER
        hive.log(f"running {installer}")
        done = subprocess.run(["/bin/bash", str(installer)], env=dict(os.environ, OMEGAHIVE_HOME=str(hive.home)))
        if done.returncode != 0:
            raise UpdateError(f"its installer stopped with status {done.returncode} (see {hive.home}/logs/install.log)")
        if hive.installed_version() != st["version"]:
            raise UpdateError(f"after its installer the hive still reports release {hive.installed_version()}")
        shutil.rmtree(work, ignore_errors=True)
        hive.log(f"updated to {st['label']} (version {st['version']})")
        return UPDATED
    except (UpdateError, OSError, subprocess.CalledProcessError) as err:
        hive.log(f"update to {st['label']} failed: {err}")
        # The page says why an accepted update did not finish, since a person who pressed Update now on it was not
        # necessarily at the screen the message below reaches.
        state["failed"] = {"version": st["version"], "error": str(err)[:500],
                           "at": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
        hive.save(state)
        tell(f"Omega hive {st['label']} could not be installed: {err}. Your hive goes on with the version it has.",
             dialog=not args.answer)
        return 1


def main(argv=None):
    p = argparse.ArgumentParser(description="Check for a newer signed Omega hive release and offer it to the owner.")
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser("check")
    c.add_argument("--home", required=True, help="the hive folder, $OMEGAHIVE_HOME")
    c.add_argument("--job", action="store_true",
                   help="the hourly launchd job: check only while the hive runs, and hand the refresh to Terminal")
    c.add_argument("--terminal", action="store_true",
                   help="hand a refresh the owner takes to a Terminal window, then exit 10: a caller with no terminal")
    c.add_argument("--feed", help="another statement URL than update-trust.json's (a test feed)")
    c.add_argument("--answer", choices=["Update", "Not now", "No answer"],
                   help="answer without asking (scripts and tests); No answer stands for a dialog nobody answered")
    c.add_argument("--page", action="store_true",
                   help="the Updates page's Check now: keep what the check finds in the state for the page and ask "
                        "nothing; exit 3 when another run holds the lock")
    c.add_argument("--opener", default="/usr/bin/open", help="what opens the release URL and Terminal")
    c.add_argument("--downloads", type=pathlib.Path, help="where the browser saves downloads (default ~/Downloads)")
    c.add_argument("--wait", type=int, default=900, help="seconds to wait for the browser download")
    args = p.parse_args(argv)
    return check(args)


if __name__ == "__main__":
    sys.exit(main())
