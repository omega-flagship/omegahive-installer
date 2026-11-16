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
    # CI diagnostics only: name the exact path and its metadata when plain() refuses (never contents).
    original_plain = base.plain
    def traced_plain(path, owner=None, directory=False):
        try:
            return original_plain(path, owner, directory)
        except base.Refused:
            try:
                info = os.lstat(path)
                print("CI plain() refused: %s mode=%o uid=%d euid=%d link=%s dir=%s" % (
                    path, info.st_mode, info.st_uid, os.getuid(), os.path.islink(path), directory), file=sys.stderr)
                current = os.umask(0o077); os.umask(current)
                print("CI umask now %04o" % current, file=sys.stderr)
                import subprocess
                release = os.path.dirname(os.path.dirname(str(path)))
                for target in (str(path), release, os.path.dirname(release), os.path.expanduser("~"), "/tmp",
                               os.path.expanduser("~/.local/share/omegahive"), os.path.expanduser("~/.local/share/omegahive/cache"),
                               os.path.expanduser("~/.local/share/omegahive/cache/uv"), os.environ.get("TMPDIR", "/tmp")):
                    subprocess.run(["/usr/bin/getfacl", "-p", target], check=False)
                    subprocess.run(["/usr/bin/stat", "-c", "%a %n", target], check=False)
            except OSError as error:
                print("CI plain() refused: %s (%s)" % (path, error), file=sys.stderr)
            raise
    base.plain = traced_plain
    tracer = str(pathlib.Path(__file__).with_name("trace_helper.py"))
    original_run = base.Installer.run
    def traced_run(self, argv, **kwargs):
        # CI diagnostics only: the bootstrap helper hides its exception; run it through a tracing wrapper.
        if len(argv) >= 4 and argv[1:3] == ["-I", "-B"] and argv[3].endswith("bootstrap.py"):
            argv = argv[:3] + [tracer] + argv[3:]
        return original_run(self, argv, **kwargs)
    base.Installer.run = traced_run
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
