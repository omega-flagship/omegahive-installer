#!/usr/bin/env python3
"""Purpose: the one rule for what a public Mac or Windows release zip carries, under the maintainers' tier decisions on
omega-flagship/omegahive#106 (11 and 12 Nov 2026): Code and Create ship publicly; the WhatsApp bridge ships with its GPL-3
dependency's licence beside it; Evolve stays out until it launches, the OmegaTown experience stays out, and Assist stays
out until the maintainers say otherwise. The release builds (install/macos/make-mac-release.sh,
install/windows/make-windows-release.sh) prune the exported tree with it before packing, and check every zip they make
with it, so a closed part that gets in stops the build instead of shipping.

  public_release.py prune TREE   remove from TREE, a release's omegahive/ folder, what a public zip leaves out, and
                                 print each path removed; refuses a published folder that lacks its licence
  public_release.py check ZIP    exit 1 naming each path ZIP may not carry, reading inside the Windows zip's
                                 omegahive.tar.gz and the member names of every other archive it carries

The rule has two parts:
  - a folder holding CLOSED_SOURCE.md is closed, the handover's tier marker that travels with the code; it stays out
    unless PUBLISHED names it, and then it ships only with the licence file PUBLISHED names beside it;
  - KEPT_OUT names components that stay out whatever their markers say, each by the pattern a path segment of theirs
    matches: for Evolve any segment naming it, for the others a segment starting with their id, so a renamed folder or
    a prebuilt archive of them is caught too.
"""
import argparse
import io
import pathlib
import re
import shutil
import sys
import tarfile
import zipfile

MARKER = "CLOSED_SOURCE.md"
# Closed folders published with Code and Create (omega-flagship/omegahive#106, 17:25Z), each with the licence that must
# ship beside it: the bridge's GPL-3.0 dependency, libsignal 6.0.0, whose own LICENSE file this is.
PUBLISHED = {
    "channels/whatsapp_bridge": "LICENSE-libsignal-GPL-3.0",
    "modules/channel_whatsapp/src/whatsapp_bridge": "LICENSE-libsignal-GPL-3.0",
}
# Components out of public zips whatever their markers say (omega-flagship/omegahive#106), each with the pattern a path
# segment of theirs matches, case-insensitively. Evolve stays out until it launches (11 Nov 17:25Z and 17:41Z; on 12 Nov,
# issuecomment-6829941322, out of main and every public release). Its files are named for it in every layer, such as
# hive/plugins/omegaevolve/, hive/core/evolve_seed.py, hive/spaces/lib_evolve.metta, EvolveObjective.tsx and a built
# evolvePc-<hash>.js chunk, so any segment naming evolve is Evolve's: mac-hive-v0.26 carried hive/core's evolve modules
# and their tests while the rule matched only segments starting with omegaevolve. OmegaTown is retired and ships nowhere
# (17:25Z), and Assist stays out until the maintainers confirm (16:55Z and 17:01Z): a segment starting with their ids.
KEPT_OUT = {"Evolve": re.compile("evolve", re.I), "OmegaTown": re.compile("^omegatown", re.I),
            "Assist": re.compile("^omegaassist", re.I)}
ARCHIVES = (".tgz", ".tar.gz", ".zip", ".whl")


def kept_out(rel):
    """The component a release-relative path belongs to, if KEPT_OUT keeps it out of public zips, else None."""
    for segment in rel.split("/"):
        for name, pattern in KEPT_OUT.items():
            if pattern.search(segment):
                return name
    return None


def prune(tree):
    """Remove from tree every closed folder PUBLISHED does not name and every KEPT_OUT path; return the removed
    release-relative paths, sorted. A published folder without its licence is refused before anything is removed.
    Time: one walk of the tree."""
    tree = pathlib.Path(tree)
    closed = sorted({m.parent.relative_to(tree).as_posix() for m in tree.rglob(MARKER)})
    for folder in closed:
        licence = PUBLISHED.get(folder)
        if licence and not (tree / folder / licence).is_file():
            raise SystemExit(f"{folder} is published only with {licence} beside it, and the tree has none")
    doomed = {folder for folder in closed if folder not in PUBLISHED}
    for path in sorted(tree.rglob("*")):
        rel = path.relative_to(tree).as_posix()
        if kept_out(rel) and not any(rel.startswith(d + "/") for d in doomed):
            doomed.add(rel)
    removed = []
    for rel in sorted(doomed, key=lambda r: (r.count("/"), r)):     # parents first, so a child goes with its parent
        path = tree / rel
        if not path.exists() and not path.is_symlink():
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()
        removed.append(rel)
    return sorted(removed)


def _release_paths(zf):
    """(release-relative path, bytes reader) for each file of a release zip: below "<top>/omegahive/" in a Mac zip, and
    below "omegahive/" inside the Windows zip's omegahive.tar.gz. Members outside the release folder, such as the top
    folder's double-click file, are returned relative to the zip with a leading "../"."""
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        head, sep, rel = name.partition("/omegahive/")
        if not sep:
            yield "../" + name, (lambda i=info: zf.read(i))
            continue
        if rel == "omegahive.tar.gz":
            with tarfile.open(fileobj=io.BytesIO(zf.read(info)), mode="r:gz") as tf:
                for member in tf.getmembers():
                    if member.isfile() or member.issym():
                        inner = member.name.partition("omegahive/")[2]
                        # Only a carried archive is read again (for its member names), so only its bytes are kept.
                        data = tf.extractfile(member).read() if member.isfile() and inner.endswith(ARCHIVES) else b""
                        yield inner, (lambda d=data: d)
            continue
        yield rel, (lambda i=info: zf.read(i))


def _archive_names(rel, data):
    """The member names of an archive the release carries (a prebuilt tarball, zip or wheel), for KEPT_OUT checks."""
    try:
        if rel.endswith(".zip") or rel.endswith(".whl"):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                return zf.namelist()
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as tf:
            return tf.getnames()
    except (zipfile.BadZipFile, tarfile.TarError) as err:
        return [f"<unreadable archive: {err}>"]


def problems(zip_path):
    """Every reason the zip at zip_path may not be published: closed folders, KEPT_OUT components (also inside the
    archives it carries) and published folders without their licence. Time: one read of each member, one decompression
    of the Windows code tarball and of each carried archive."""
    with zipfile.ZipFile(zip_path) as zf:
        files = dict(_release_paths(zf))
        return _problems(files, zip_path)


def _problems(files, zip_path):
    """problems() over files, {release-relative path: bytes reader}, read while their zip is open."""
    found = []
    if not any(not rel.startswith("../") for rel in files):
        return [f"{zip_path} holds no release folder (no omegahive/ inside)"]
    for rel in sorted(files):
        component = kept_out(rel)
        if component:
            found.append(f"{rel}: {component} stays out of public zips")
            continue
        if rel.endswith("/" + MARKER) or rel == MARKER:
            folder = rel.rpartition("/")[0]
            if folder not in PUBLISHED:
                found.append(f"{folder}: marked Closed Source for Product Consideration ({rel})")
        if rel.endswith(ARCHIVES) and not rel.startswith("../"):
            for name in _archive_names(rel, files[rel]()):
                component = kept_out(name)
                if component:
                    found.append(f"{rel}: carries {name}, and {component} stays out of public zips")
    for folder, licence in PUBLISHED.items():
        if any(rel.startswith(folder + "/") for rel in files) and f"{folder}/{licence}" not in files:
            found.append(f"{folder}: published only with {licence} beside it, and the zip has none")
    return found


def main(argv=None):
    p = argparse.ArgumentParser(description="What a public Omega hive release zip carries.")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("prune").add_argument("tree")
    sub.add_parser("check").add_argument("zip")
    args = p.parse_args(argv)
    if args.command == "prune":
        for rel in prune(args.tree):
            print(f"left out of the public release: {rel}")
        return 0
    found = problems(args.zip)
    for line in found:
        print(f"{args.zip}: {line}", file=sys.stderr)
    if found:
        print(f"{args.zip} may not be published: {len(found)} problem(s) above", file=sys.stderr)
        return 1
    print(f"{args.zip}: nothing closed, and every published folder carries its licence")
    return 0


if __name__ == "__main__":
    sys.exit(main())
