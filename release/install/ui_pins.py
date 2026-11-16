#!/usr/bin/env python3
"""Purpose: give an exported release tree the files its web UI imports from outside hive/ui before the UI is built.

The UI imports lib_nal.metta and lib_pln.metta from the third_party/Omega submodule, which a git archive of the
revision never carries, and lib_hive.metta from hive/spaces. hive/ui/src/lib/mindSpace/metta/PIN.json names each
one's place and sha256: a pinned file missing from its place is copied there from its copy beside PIN.json, or read
from the release's own Omega core bundle (the omega-core-*.bundle prebuilt) at core-dependency.json's revision, and
used only when its sha256 is the pin's, so the build compiles exactly the pinned semantics or stops. Both release
builds run it before building the UI (install/macos/make-mac-release.sh, install/windows/make-windows-release.sh).

Usage: python3 -I ui_pins.py <exported tree> <scratch folder> [prebuilt file ...]
Exit status 0 when every pinned file is in place (each one it wrote printed as "pinned <place> from <origin>"), 1 when
one is missing and nothing supplies its pinned bytes.
Time: one sha256 per pinned file, plus one bundle clone (about 7 MB) when a pinned core file has no copy.
"""
import hashlib
import json
import pathlib
import subprocess
import sys

PIN = pathlib.Path("hive/ui/src/lib/mindSpace/metta/PIN.json")


def main(argv):
    code, work, prebuilt = pathlib.Path(argv[1]), pathlib.Path(argv[2]), argv[3:]
    pin = code / PIN
    if not pin.is_file():
        return 0
    bundle = next((f for f in prebuilt if pathlib.Path(f).name.startswith("omega-core-") and f.endswith(".bundle")), "")
    dep_file = code / "core-dependency.json"
    dep = json.loads(dep_file.read_text()) if dep_file.is_file() else None
    core_git = None     # the bundle, cloned once on the first file it has to supply

    def from_core(rel):
        """The bytes of rel (a path inside the core checkout) at the pinned core revision, from the core bundle."""
        nonlocal core_git
        if core_git is None:
            core_git = work / "core-bundle"
            subprocess.run(["git", "clone", "-q", "--no-checkout", bundle, str(core_git)], check=True)
        return subprocess.run(["git", "-C", str(core_git), "cat-file", "blob", f"{dep['revision']}:{rel}"],
                              check=True, capture_output=True).stdout

    for name, entry in json.loads(pin.read_text())["files"].items():
        dest = code / entry["from"]
        if dest.exists():
            continue
        src = pin.parent / name
        if src.is_file() and hashlib.sha256(src.read_bytes()).hexdigest() == entry["sha256"]:
            data, origin = src.read_bytes(), str(src.relative_to(code))
        elif bundle and dep and entry["from"].startswith(dep["path"].rstrip("/") + "/"):
            data = from_core(entry["from"][len(dep["path"].rstrip("/")) + 1:])
            origin = f"{pathlib.Path(bundle).name} at {dep['revision'][:12]}"
            if hashlib.sha256(data).hexdigest() != entry["sha256"]:
                print(f"{entry['from']} in {origin} is not its pinned sha256 {entry['sha256'][:12]}", file=sys.stderr)
                return 1
        else:
            print(f"{entry['from']} is missing, {src.relative_to(code)} is not its pinned copy"
                  " and no core bundle has it", file=sys.stderr)
            return 1
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
        print(f"pinned {entry['from']} from {origin}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
