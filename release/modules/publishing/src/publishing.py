"""Optional publishing membrane for OmegaClaw.

The core runtime should not depend on one deployment's website. This module
keeps the MeTTa publication affordance stable while delegating to a local
webhost organ only when that organ is present in the runtime environment.
"""

from __future__ import annotations

import importlib
import pathlib
import sys


CORE_ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC_DIR = CORE_ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))


def _webhost():
    try:
        return importlib.import_module("webhost")
    except Exception as exc:
        raise RuntimeError(f"publishing surface is not configured: {exc}") from exc


def _call(name, *args):
    try:
        target = getattr(_webhost(), name)
        return target(*args)
    except Exception as exc:
        return f"PUBLISHING-NOT-CONFIGURED {type(exc).__name__}: {exc}"


def write_web_page(slug, html):
    return _call("write_web_page", slug, html)


def list_web_pages():
    return _call("list_web_pages")


def public_web_url(slug):
    return _call("public_web_url", slug)


def publishing_status():
    return _call("webhost_status")


def webhost_status():
    return publishing_status()


def publish_artifact(artifact_id, shelf, title):
    return _call("publish_artifact", artifact_id, shelf, title)


def artifact_id_for_path(path):
    return _call("artifact_id_for_path", path)


def unpublish_artifact(slug):
    return _call("unpublish_artifact", slug)


def list_published_artifacts():
    return _call("list_published_artifacts")
