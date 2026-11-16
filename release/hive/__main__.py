"""Run the hive:  python3 -m hive  (see hive/README.md for configuration)."""

import logging
import os
import re
import sys

import uvicorn

from .core import exclusive
from .core.app import create_app
from .core.code_aggregate import close_app_resources
from .core.config import load_settings
from .core.mind_gateway import scrub_logged


class _RedactTokens(logging.Filter):
    """Access logs never keep credentials: ?token=... (live-event sockets, links) is blanked before it is written, and
    no mind token survives in any form (gateway r1c, scrub_logged), whether or not the redactor is on."""
    _token = re.compile(r"([?&](?:token|access_token|key)=)[^&\s\"]+")

    def _clean(self, text):
        return scrub_logged(self._token.sub(r"\1REDACTED", text))

    def filter(self, record):
        if isinstance(record.args, tuple):
            record.args = tuple(self._clean(a) if isinstance(a, str) else a for a in record.args)
        if isinstance(record.msg, str):
            record.msg = self._clean(record.msg)
        return True


ACCESS_LOGGERS = ("uvicorn.access", "uvicorn.error", "uvicorn")


def redact_access_logs():
    """The access-log filter, in every mode (main, before uvicorn writes a line)."""
    for name in ACCESS_LOGGERS:
        logging.getLogger(name).addFilter(_RedactTokens())


def main():
    redact_access_logs()
    from .core import localowner
    if localowner.enabled():
        # J1 r2 C / r3 N / r2 F: umask 077, no core dumps, the one redactor, before any file or log line exists; then
        # the start refusals (K-3, public address, non-loopback bind, unsandboxed minds) and the data folder's mode.
        localowner.prepare_process()
        try:
            localowner.check_environment()
            settings = load_settings()
            localowner.check_data_dir(settings.data_dir)
        except localowner.LocalOwnerRefused as exc:
            print(f"[hive] not starting: {exc}", file=sys.stderr)
            raise SystemExit(78)
    else:
        settings = load_settings()
    # §L: one process owns the data directory for its lifetime (exit 75 in use, 78 cannot establish); held until exit.
    exclusive.acquire_or_exit(settings.data_dir, exclusive.HELD)
    app = None
    startup_primary = None
    try:
        try:
            app = create_app(settings)
        except localowner.LocalOwnerRefused as exc:
            print(f"[hive] not starting: {exc}", file=sys.stderr)
            raise SystemExit(78)
        # The one startup recovery: under the lock, after the app is built, before anything is served (OPEN-17).
        try:
            exclusive.startup_recovery(exclusive.HELD, app.state.hive)
        except Exception as exc:
            print(f"[hive] startup recovery failed and was rolled back: {type(exc).__name__}: {exc}; not starting",
                  file=sys.stderr)
            raise SystemExit(exclusive.EXIT_RECOVERY)
        print(f"[hive] data: {settings.data_dir}")
        # never print the password: logs are kept and read widely; it lives in the data directory's admin-password file
        print(f"[hive] operator password: in {settings.data_dir / 'admin-password'} (set HIVE_ADMIN_PASSWORD to choose one)")
        uvicorn.run(app, host=os.environ.get("HIVE_HOST", "127.0.0.1"), port=int(os.environ.get("HIVE_PORT", "8700")),
                    log_level=os.environ.get("HIVE_LOG_LEVEL", "info"), ws_max_size=1 << 20)
    except BaseException as primary:
        startup_primary = primary  # retain before the independent resource tail
        raise
    finally:
        if app is not None:
            # Covers startup recovery or uvicorn failure before ASGI lifespan.
            # The private owner latches retirement before any unknown close.
            close_app_resources(app, startup_primary)



if __name__ == "__main__":
    main()
