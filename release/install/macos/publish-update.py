"""Purpose: the release side of Mac hive updates: make release keys, write the update-trust.json a release build ships
(its channel, feed, keys and next keys), replace its keys with a next key, sign the statement that offers a release zip
to that channel's hives (release_sig.py's rule), and publish it where they read it, reading it back to check.

  publish-update.py keygen [--key K]
      a new Ed25519 key in K (default ~/.config/omegahive/mac-release-key.json, owner-only), printing its public key;
      refuses to overwrite a key. A next key is made the same way and kept apart from the first, offline.
  publish-update.py trust --channel C --feed URL --pubkey HEX [--pubkey HEX ...] [--next-pubkey HEX ...] --out F
      the trust file a release build writes to install/macos/update-trust.json: hives built with it take statements
      for channel C, read from URL and signed by one of these keys, and no other statement; the next keys may replace
      these keys (rotate)
  publish-update.py trust --from T --out F
      the trust file T (or a release zip's) written to F as it is, once its rotations check as a hive walks them: how a
      build ships a channel's keys after a rotation
  publish-update.py rotate T --key K --next-pubkey HEX [--next-pubkey HEX ...] --out F
      replaces the keys of trust file T (or a release zip's) with K, one of its next keys: F is T at the next rotation,
      its rotations ending in the record K signs, which names K as the key and these next keys; builds write F from
      then on, and statements are signed with K
  publish-update.py sign ZIP --url U [--version N] [--label L] [--notes T] [--days D] [--key K] [--out F]
      the signed statement for ZIP, written to F (default ZIP.statement.json): its channel is the zip's trust file's,
      its version the zip's omegahive/RELEASE_VERSION (a --version must equal it), its label vN unless given, and it
      carries the zip's sha256 and length and its tree digest (release_sig.tree_digest_of_zip, for a browser that
      unzips the download itself), beside every rotation of the zip's channel; refuses unless K is one of the zip's
      keys, so its hives can check the next statement too
  publish-update.py publish ZIP ... --gist ID | --release TAG [--repo OWNER/REPO]
      sign, then put the statement where the zip's trust file says its hives read it: into gist ID, whose raw file its
      feed must be, or as an asset of GitHub release TAG named as the feed's last part, where a feed of
      https://github.com/OWNER/REPO/releases/download/TAG/FILE names the release and repository it must be; then read
      back what hives read
  publish-update.py verify F|URL --trust T
      check a statement as a hive does (rotations, signature, app, channel, fields, expiry); T is a trust file or a
      release zip, of any release of the channel

Replacing a key (TUF's root rotation, with KERI's pre-rotation): every trust file lists its keys and the next keys that
may replace them, made with keygen and kept apart from the keys, offline; two next keys kept in different places leave
a successor when one is lost. To replace the keys, a lost or stolen one included, run rotate with a next key and a
fresh next key after it, build the next release with the trust file it writes, and sign that release's statement with
the new key. The feed carries every rotation of the channel, so a hive on any earlier release walks them in turn and
takes the statement, and from then on refuses whatever the replaced keys sign. A current key alone cannot replace the
keys, so a stolen one stops counting on each hive that has seen the rotation.
The private keys never leave the release machine; hives hold only the public halves. A statement expires after D days
(default 30): re-run publish for the same zip before then, or hives report "could not check" instead of trusting an
old statement (TUF's freeze rule). Versions only ever grow (0.9, 0.10, ...): hives refuse a statement below one they
have seen.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import release_sig  # noqa: E402
import update  # noqa: E402

DEFAULT_KEY = pathlib.Path.home() / ".config" / "omegahive" / "mac-release-key.json"
TRUST_IN_ZIP = "omegahive/install/macos/update-trust.json"


def zip_member(zf, suffix):
    names = [n for n in zf.namelist() if n.endswith(suffix) and n.count("/") == suffix.count("/") + 1]
    if len(names) != 1:
        raise SystemExit(f"the zip holds {len(names)} files ending {suffix}, not one")
    return zf.read(names[0]).decode()


def trust_of(path):
    """The trust file at path, or the one inside the release zip at path, as update.read_trust reads it, its rotations
    checked one after another as a hive walks them."""
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as zf:
                trust = update.read_trust(json.loads(zip_member(zf, TRUST_IN_ZIP)))
        else:
            trust = update.read_trust(json.loads(pathlib.Path(path).read_text()))
    except ValueError as err:
        raise SystemExit(f"{path}: not a trust file a hive reads: {err}") from err
    check_rotations(trust, path)
    return trust


def check_rotations(trust, where):
    """Each of the trust file's rotation records signed by a key it names, and each after the first taken by a hive
    holding the one before, as update.walk takes them. The first one's link to the channel's first keys was checked by
    rotate, which made it from a trust file holding them. Time: one walk over the records."""
    if not trust["rotations"]:
        return
    first = trust["rotations"][0]
    body = first["rotation"]
    problems = update.rotation_problems(body, trust["channel"], 1, body.get("keys") or [], set())
    if not problems:
        try:
            data = release_sig.message(body, release_sig.ROTATION)
        except ValueError:
            data = None
        if data is None or not any(release_sig.verify(k, first["sig"], data) for k in body["keys"]):
            problems = ["no key it names signed it"]
    if problems:
        raise SystemExit(f"{where}: rotation 1 is not one a hive would take: " + "; ".join(problems))
    start = {"channel": trust["channel"], "seq": 1, "keys": body["keys"], "next_keys": body["next_keys"]}
    try:
        update.walk(start, trust["rotations"])
    except update.UpdateError as err:
        raise SystemExit(f"{where}: {err}") from err


def sign(args):
    key = release_sig.load_key_file(args.key)
    zip_path = pathlib.Path(args.zip)
    with zipfile.ZipFile(zip_path) as zf:
        inside = zip_member(zf, "omegahive/RELEASE_VERSION").split()[0]
    trust = trust_of(zip_path)
    version = args.version or inside
    if inside != version:
        raise SystemExit(f"the zip is release {inside}; this statement would say {version}")
    label = args.label or f"v{version}"
    if key.pubkey_hex not in trust["keys"]:
        raise SystemExit("the zip's update-trust.json does not list this key among its keys, so once installed its "
                         "hives could not check the statements after this one")
    digest, length = hashlib.sha256(), 0
    with open(zip_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
            length += len(chunk)
    expires = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(days=args.days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    st = {"app": update.APP, "channel": trust["channel"], "version": version, "label": label, "notes": args.notes,
          "url": args.url, "zip_sha256": digest.hexdigest(), "zip_length": length,
          "tree_sha256": release_sig.tree_digest_of_zip(zip_path), "expires": expires}
    problems = update.statement_problems(st, trust)
    if problems:
        raise SystemExit("not a statement a hive would take: " + "; ".join(problems))
    doc = {"statement": st, "sig": key.sign(release_sig.message(st))}
    if trust["rotations"]:
        doc["rotations"] = trust["rotations"]       # the whole chain, so a hive any number of rotations behind follows
    out = pathlib.Path(args.out or f"{zip_path}.statement.json")
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(f"signed {label} (version {version}, channel {trust['channel']}, {length} bytes, sha256 {st['zip_sha256']}), "
          f"expires {expires}: {out}")
    return out, doc, trust


def check_doc(doc, trust, where):
    """The statement in doc as a hive holding this trust file takes it: rotations walked, then signature, fields and
    expiry."""
    st, sig, rotations = ((doc.get("statement"), doc.get("sig"), doc.get("rotations", [])) if isinstance(doc, dict)
                          else (None, None, []))
    try:
        _, keys, _ = update.walk(trust, rotations)
    except update.UpdateError as err:
        raise SystemExit(f"{where}: {err}") from err
    if update.signing_key(keys, st, sig) is None:
        raise SystemExit(f"{where}: the signature does not check against the trust file's keys, carried through the "
                         "feed's rotations")
    problems = update.statement_problems(st, trust)
    if problems:
        raise SystemExit(f"{where}: " + "; ".join(problems))
    if update.expired(st, datetime.datetime.now(datetime.UTC)):
        raise SystemExit(f"{where}: expired at {st['expires']}")
    return st


def gist_of(feed):
    """The gist id and file name of a gist's raw URL, https://gist.githubusercontent.com/<owner>/<id>/raw/<file>."""
    parts = urllib.parse.urlsplit(feed)
    segments = parts.path.split("/")[1:]
    if parts.netloc != "gist.githubusercontent.com" or len(segments) != 4 or segments[2] != "raw":
        raise SystemExit(f"the zip's feed {feed} is no gist's raw file; a feed in a GitHub release takes --release TAG")
    return segments[1], urllib.parse.unquote(segments[3])


def release_of(feed):
    """The repository and tag a GitHub release asset's URL names, https://github.com/<owner>/<repo>/releases/download/
    <tag>/<file>, or None for any other feed (a loopback one in tests, a release's latest/ alias)."""
    parts = urllib.parse.urlsplit(feed)
    segments = parts.path.split("/")[1:]
    if parts.netloc == "github.com" and len(segments) == 6 and segments[2:4] == ["releases", "download"]:
        return f"{segments[0]}/{segments[1]}", urllib.parse.unquote(segments[4])
    return None


def publish(args):
    if args.repo and not args.release:
        raise SystemExit("--repo names the repository of a --release")
    out, doc, trust = sign(args)
    feed = trust["feed"]
    if args.release:
        repo = args.repo
        named = release_of(feed)
        if named:
            if args.release != named[1] or (repo and repo != named[0]):
                raise SystemExit(f"the zip's hives read release {named[1]} of {named[0]} ({feed}), not release "
                                 f"{args.release}{' of ' + repo if repo else ''}")
            repo = named[0]
        # gh names an uploaded asset after its file, so the statement goes up under the feed's own last part.
        name = urllib.parse.unquote(urllib.parse.urlsplit(feed).path.rsplit("/", 1)[-1])
        with tempfile.TemporaryDirectory(dir=out.parent) as folder:
            asset = pathlib.Path(folder) / name
            shutil.copy(out, asset)
            subprocess.run(["gh", "release", "upload", args.release, str(asset), "--clobber",
                            *(["--repo", repo] if repo else [])], check=True, stdout=subprocess.DEVNULL)
        # Read back exactly what a hive reads: the feed, with no GitHub sign-in.
        try:
            served = update.fetch_bytes(feed, update.FEED_CAP, timeout=30)
        except urllib.error.HTTPError as err:
            hint = (" (a private repository's release assets answer 404 to anyone not signed in to GitHub, as hives "
                    "are not)") if err.code == 404 else ""
            raise SystemExit(f"uploaded to release {args.release}, but hives cannot read {feed}: HTTP {err.code}"
                             f"{hint}") from err
        except (OSError, update.UpdateError) as err:
            raise SystemExit(f"uploaded to release {args.release}, but hives cannot read {feed}: {err}") from err
        where = feed
    else:
        gist, name = gist_of(feed)
        if gist != args.gist:
            raise SystemExit(f"the zip's hives read gist {gist} ({feed}), not gist {args.gist}")
        body = json.dumps({"files": {name: {"content": out.read_text()}}}).encode()
        subprocess.run(["gh", "api", "--method", "PATCH", f"/gists/{gist}", "--input", "-"], input=body, check=True,
                       stdout=subprocess.DEVNULL)
        # The gist's raw URL is cached for minutes, so the gist itself is read back through the API.
        served = subprocess.run(["gh", "api", f"/gists/{gist}", "--jq", f".files[{json.dumps(name)}].content"],
                                check=True, capture_output=True, text=True).stdout
        where = f"gist {gist}"
    served = json.loads(served)
    st = check_doc(served, trust, where)
    if served != doc:
        raise SystemExit(f"{where} serves another statement or other rotations than the ones just signed")
    print(f"published {st['label']} for channel {st['channel']}; hives read it from {feed}")


def verify(args):
    trust = trust_of(args.trust)
    where = args.statement
    raw = (update.fetch_bytes(where, update.FEED_CAP, timeout=10) if where.startswith(("https://", "http://"))
           else pathlib.Path(where).read_bytes())
    st = check_doc(json.loads(raw), trust, where)
    print(f"ok: {st['label']} version {st['version']} on channel {st['channel']}, {st['zip_length']} bytes, "
          f"sha256 {st['zip_sha256']}, expires {st['expires']}")


def write_trust(args):
    if args.from_trust:
        if args.channel or args.feed or args.pubkey or args.next_pubkey:
            raise SystemExit("--from writes a trust file as it is, so it takes no --channel, --feed or keys")
        trust = trust_of(args.from_trust)
    else:
        if not (args.channel and args.feed and args.pubkey):
            raise SystemExit("trust needs --channel, --feed and --pubkey, or --from a trust file")
        try:
            trust = update.read_trust({"channel": args.channel, "feed": args.feed, "keys": args.pubkey,
                                       "next_keys": args.next_pubkey})
        except ValueError as err:
            raise SystemExit(f"no hive could use that trust file: {err}") from err
    out = pathlib.Path(args.out)
    out.write_text(json.dumps(trust, indent=1, sort_keys=True) + "\n")
    print(f"{out}: channel {trust['channel']}, feed {trust['feed']}, {len(trust['keys'])} key(s), "
          f"{len(trust['next_keys'])} next key(s)")


def rotate(args):
    """The trust file at the next rotation: its keys replaced by --key, one of its next keys, which signs the record."""
    trust = trust_of(args.trust)
    key = release_sig.load_key_file(args.key)
    if key.pubkey_hex not in trust["next_keys"]:
        raise SystemExit("this key is not one of the trust file's next keys: only a next key replaces the keys, so a "
                         "current key, a stolen one included, cannot")
    body = {"app": update.APP, "channel": trust["channel"], "seq": trust["seq"] + 1, "keys": [key.pubkey_hex],
            "next_keys": args.next_pubkey}
    history = set(trust["keys"]) | {k for record in trust["rotations"] for k in record["rotation"]["keys"]}
    problems = update.rotation_problems(body, trust["channel"], body["seq"], trust["next_keys"], history)
    if problems:
        raise SystemExit("no hive would take that rotation: " + "; ".join(problems))
    record = {"rotation": body, "sig": key.sign(release_sig.message(body, release_sig.ROTATION))}
    new = update.read_trust({"channel": trust["channel"], "feed": trust["feed"], "keys": body["keys"],
                             "next_keys": body["next_keys"], "seq": body["seq"],
                             "rotations": trust["rotations"] + [record]})
    if update.walk(trust, new["rotations"])[1] != new["keys"]:      # what a hive holding T reaches through the feed
        raise SystemExit("a hive holding the old trust file would not reach the new key")
    out = pathlib.Path(args.out)
    out.write_text(json.dumps(new, indent=1, sort_keys=True) + "\n")
    print(f"{out}: channel {new['channel']} at rotation {new['seq']}, key {key.pubkey_hex}, "
          f"{len(new['next_keys'])} next key(s); build releases with it and sign their statements with {args.key}")


def keygen(args):
    path = pathlib.Path(args.key)
    if path.exists():
        raise SystemExit(f"{path} exists; a release key is made once")
    print(release_sig.new_key_file(path, "omegahive-mac-release"))


def main(argv=None):
    p = argparse.ArgumentParser(description="Sign and publish Omega hive Mac release statements.")
    sub = p.add_subparsers(dest="command", required=True)
    k = sub.add_parser("keygen")
    k.add_argument("--key", default=str(DEFAULT_KEY))
    t = sub.add_parser("trust")
    t.add_argument("--channel", help='the channel its hives follow, such as "release" or "test"')
    t.add_argument("--feed", help="the URL its hives read statements from")
    t.add_argument("--pubkey", action="append", default=[], help="a release key's public half, 64 hex; repeatable")
    t.add_argument("--next-pubkey", action="append", default=[], help="a next key's public half; repeatable")
    t.add_argument("--from", dest="from_trust", help="a trust file, or a release zip holding one, to write as it is")
    t.add_argument("--out", required=True)
    r = sub.add_parser("rotate")
    r.add_argument("trust", help="the trust file whose keys are replaced, or a release zip holding it")
    r.add_argument("--key", required=True, help="the key file of one of its next keys, which becomes the key")
    r.add_argument("--next-pubkey", action="append", required=True,
                   help="the public half of a fresh key that may replace it in turn; repeatable")
    r.add_argument("--out", required=True)
    for name in ("sign", "publish"):
        s = sub.add_parser(name)
        s.add_argument("zip")
        s.add_argument("--version", help="must equal the zip's RELEASE_VERSION (default: that)")
        s.add_argument("--label", help="what the owner is offered, default v<version>")
        s.add_argument("--url", required=True)
        s.add_argument("--notes", default="")
        s.add_argument("--days", type=int, default=30)
        s.add_argument("--key", default=str(DEFAULT_KEY))
        s.add_argument("--out")
        if name == "publish":
            target = s.add_mutually_exclusive_group(required=True)
            target.add_argument("--gist", help="the gist whose raw file is the zip's feed (the test channel's)")
            target.add_argument("--release", help="the GitHub release tag whose asset is the zip's feed")
            s.add_argument("--repo", help="OWNER/REPO of that release (default: the one a GitHub release feed names, "
                                          "else gh's own)")
    v = sub.add_parser("verify")
    v.add_argument("statement")
    v.add_argument("--trust", required=True, help="a trust file, or a release zip holding one")
    args = p.parse_args(argv)
    {"keygen": keygen, "trust": write_trust, "rotate": rotate, "sign": sign, "publish": publish,
     "verify": verify}[args.command](args)


if __name__ == "__main__":
    main()
