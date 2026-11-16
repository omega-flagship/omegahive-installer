"""Purpose: tests the app document's Content-Security-Policy and its per-answer nonce (flagship review #111, should fix
soon: no CSP on the app document).

The page carries a CSP whose nonce is fresh in every answer and fills the build's slot (hive/ui/vite.config.ts
html.cspNonce), however the page is asked for; scripts and styles are the hive's own or carry that nonce, and the srcdoc
frames the page makes take the same nonce (they inherit the policy). A build without the slot gets 'unsafe-inline' in
place of the nonce, and the hive says so when it starts.
"""

import logging
import pathlib
import re

import pytest

from hive.core import app as app_module
from hive.tests.test_core_api import PETTA
from hive.tests.test_cors_own_origins import hive_at  # noqa: F401  (fixture)

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

# the slot hive/ui/vite.config.ts and app.py name (test_the_build_writes_the_slot_the_hive_fills)
PAGE_NONCE_SLOT = "HIVE-CSP-NONCE"
# what `vite build` writes (the boot script, the entry module, a preload, the meta lib/appFrame.ts frameNonce reads)
BUILT_PAGE = (f'<!doctype html><html><head><meta property="csp-nonce" nonce="{PAGE_NONCE_SLOT}">'
              f'<script nonce="{PAGE_NONCE_SLOT}">/* boot */</script>'
              f'<script type="module" crossorigin src="./assets/index-abc.js" nonce="{PAGE_NONCE_SLOT}"></script>'
              f'<link rel="modulepreload" crossorigin href="./assets/vendor-abc.js" nonce="{PAGE_NONCE_SLOT}">'
              '</head><body><div id="root"></div></body></html>')


def nonce_of(answer):
    found = re.findall(r"'nonce-([^']+)'", answer.headers["content-security-policy"])
    assert len(set(found)) == 1, answer.headers["content-security-policy"]
    return found[0]


@pytest.mark.parametrize("base", ["", "/omegadot"])
def test_the_page_carries_a_fresh_nonce_csp_however_it_is_asked_for(hive_at, base):
    hive = hive_at(page=BUILT_PAGE, **({"HIVE_BASE_PATH": base} if base else {}))
    seen = set()
    for path in ("/", "/index.html", "/some/page", "/mind/abc"):
        out = hive.get(base + path)
        assert out.status_code == 200 and out.headers["content-type"].startswith("text/html"), path
        nonce = nonce_of(out)
        assert re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", nonce), nonce
        assert out.headers["content-security-policy"] == app_module.page_csp(nonce)
        # every slot holds this answer's nonce: the meta, the boot script, the entry module and the preload
        assert PAGE_NONCE_SLOT not in out.text and out.text.count(f'nonce="{nonce}"') == 4, path
        assert "no-store" in out.headers["cache-control"], path
        seen.add(nonce)
    assert len(seen) == 4   # one nonce per answer, never reused


def test_the_page_csp_names_what_the_page_and_its_frames_need_and_no_more():
    policy = dict(part.strip().split(" ", 1) for part in app_module.page_csp("0" * 8 + "-0000-0000-0000-" + "0" * 12).split(";"))
    assert policy["script-src"] == "'self' 'nonce-00000000-0000-0000-0000-000000000000'"   # no 'unsafe-inline', no eval
    assert policy["style-src"] == "'self' 'nonce-00000000-0000-0000-0000-000000000000'"
    assert policy["style-src-attr"] == "'unsafe-inline'"   # the frames' apps use style attributes (lib/appFrame.ts)
    assert policy["connect-src"] == policy["frame-src"] == policy["worker-src"] == policy["default-src"] == "'self'"
    assert policy["img-src"] == "'self' data: blob:" and policy["font-src"] == "'self' data:"
    assert policy["object-src"] == policy["base-uri"] == policy["frame-ancestors"] == "'none'"
    assert policy["form-action"] == "'self'"


def test_a_build_without_the_slot_keeps_working_and_is_named(hive_at, caplog):
    caplog.set_level(logging.WARNING, logger="hive")
    hive = hive_at(page="<!doctype html><html><head><script>/* boot */</script></head><body></body></html>")
    out = hive.get("/")
    assert out.headers["content-security-policy"] == app_module.page_csp(None)
    assert "script-src 'self' 'unsafe-inline';" in out.headers["content-security-policy"]
    assert any("without the page nonce slot" in r.getMessage() for r in caplog.records)


def test_only_the_page_carries_the_page_csp(hive_at):
    hive = hive_at(page=BUILT_PAGE)
    asset = hive.get("/assets/index-abc.js")
    assert asset.status_code == 200 and "content-security-policy" not in asset.headers
    missing = hive.get("/api/no-such-route")
    assert missing.status_code == 404 and "content-security-policy" not in missing.headers


def test_the_browser_test_checks_the_policy_the_hive_sends():
    """hive/ui/src/lib/pageCsp.browser.test.ts proves in Chromium that the srcdoc frames run under this policy with the
    page's nonce; it holds the policy as text, so here it must equal what page_csp sends."""
    text = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "src" / "lib" / "pageCsp.browser.test.ts").read_text()
    template = re.search(r"const POLICY = \(nonce: string\) => `([^`]+)`", text).group(1)
    assert template.replace("${nonce}", "n-0") == app_module.page_csp("n-0")


def test_the_build_writes_the_slot_the_hive_fills():
    """hive/ui/vite.config.ts and hive/core/app.py name the same slot: a build would otherwise ship a word the hive
    never replaces, and every frame would fall back to a nonce the page's CSP does not name."""
    config = (pathlib.Path(__file__).resolve().parents[1] / "ui" / "vite.config.ts").read_text()
    assert re.search(r"const PAGE_NONCE_SLOT = '([^']+)'", config).group(1) == PAGE_NONCE_SLOT == app_module.PAGE_NONCE_SLOT
    assert "cspNonce: PAGE_NONCE_SLOT" in config
