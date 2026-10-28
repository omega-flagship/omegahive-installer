"""CI-only x86_64 entry: run the exact release installer with the generated test catalogue.

Same contract as the reviewed internal entry, without the guest profile pin: isolated Python, umask 077, the unchanged
installer module from the bundle, and its own refusal words printed. Not a published or qualified release.
"""
import json
import os
import pathlib
import signal
import sys
import types

P = pathlib.Path


def main():
    assert sys.flags.isolated and sys.dont_write_bytecode and sys.flags.no_site, "run with python -I -B -S"
    bundle = P(sys.argv[1]).resolve(strict=True)
    raw = (bundle / "install.py").read_bytes()
    base = types.ModuleType("omegahive_ci_x86_install")
    base.__file__ = str(bundle / "install.py")
    exec(compile(raw, base.__file__, "exec"), base.__dict__)
    catalogue = json.loads((bundle / "release-manifest.json").read_text())
    # Run the public release validator on a ready=True copy, so the test catalogue has the exact public shape.
    base.validate_catalogue(dict(catalogue, ready=True))
    home = base.canonical_home()
    os.umask(0o077)
    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, base.stop_requested)
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    print("CI x86_64 test run — not a published or qualified release.", flush=True)
    try:
        return base.Installer(bundle, catalogue, home).install()
    except base.Refused as error:
        print("Refused: " + str(error), file=sys.stderr)
        return 64


if __name__ == "__main__":
    raise SystemExit(main())
