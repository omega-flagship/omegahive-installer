"""Gateway r1d: the frame CSP, decided on file identity (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.5, r1.1 §B, §L).

Synthetic build only: a fixture `dist` with a fixture frame whose meta carries a synthetic bootstrap hash. Requests are
sent as raw ASGI scopes the way uvicorn builds them (`raw_path` as sent, `path` = its percent-decoding, no dot-segment
normalisation), because an HTTP client library would normalise `./` and `../` before the host ever saw them.
"""

import base64
import hashlib
import os
import pathlib
import shutil
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from hive.core import app as app_module
from hive.core.config import load_settings
from hive.tests.test_core_api import PETTA, FakeSupervisor

pytestmark = pytest.mark.skipif(not pathlib.Path(PETTA, "src", "main.pl").exists(), reason="needs PeTTa")

BASE = "/omegahive"
CANONICAL = "mind-iter/mind-frame.html"
# The host note's §2.4 policy, written out here (not imported), so a changed or constant policy in the code fails.
POLICY = ("sandbox allow-scripts; default-src 'none'; script-src {source} 'wasm-unsafe-eval' blob:; worker-src blob:; "
          "connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; "
          "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'")


def _source(script: str) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'"


def frame_html(script: str = "postMessage('synthetic frame one')", sources: list[str] | None = None) -> str:
    srcs = " ".join(sources if sources is not None else [_source(script)])
    return ('<!doctype html>\n<html><head><meta charset="utf-8">\n'
            f'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src {srcs} '
            "'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'\">\n"
            f"<title>mind</title>\n<script>{script}</script></head><body></body></html>\n")


def expected_csp(script: str = "postMessage('synthetic frame one')") -> str:
    return POLICY.format(source=_source(script))


def make_dist(root: pathlib.Path, frame: str | None = None) -> pathlib.Path:
    dist = root / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "mind-iter").mkdir()
    (dist / "index.html").write_text("synthetic UI")
    (dist / "assets" / "app-abc.js").write_text("console.log('synthetic')")
    (dist / "mind-iter" / "worker.js").write_text("// synthetic worker bundle")
    if frame is not False:
        (dist / CANONICAL).write_text(frame if frame is not None else frame_html())
    return dist


class Hive:
    """A started app over a fixture build, plus a raw-ASGI GET/HEAD."""

    def __init__(self, client: TestClient, app, hive):
        self.client, self.app, self.hive = client, app, hive

    def raw(self, raw_path: str, method: str = "GET"):
        scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
                 "method": method, "scheme": "http", "server": ("testserver", 80), "client": ("127.0.0.1", 50000),
                 "root_path": "", "path": unquote(raw_path), "raw_path": raw_path.encode("latin-1"),
                 "query_string": b"", "headers": [(b"host", b"testserver")]}
        out = {"status": None, "headers": {}, "body": b""}

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                out["status"] = message["status"]
                out["headers"] = {k.decode().lower(): v.decode() for k, v in message.get("headers", [])}
            elif message["type"] == "http.response.body":
                out["body"] += message.get("body", b"")

        async def call():
            await self.app(scope, receive, send)

        self.client.portal.call(call)
        return out


@pytest.fixture
def boot(monkeypatch, tmp_path):
    """boot(flag=True, base_path="", frame=None, prepare=None) -> Hive. `prepare(dist)` runs before create_app (boot)."""
    started = []

    def _boot(flag=True, base_path="", frame=None, prepare=None):
        dist = make_dist(tmp_path / f"b{len(started)}", frame)
        if prepare:
            prepare(dist)
        monkeypatch.setattr(app_module, "UI_DIST", dist)
        if flag:
            monkeypatch.setenv("HIVE_MIND_GATEWAY", "1")
        else:
            monkeypatch.delenv("HIVE_MIND_GATEWAY", raising=False)
        settings = load_settings(data_dir=tmp_path / f"data{len(started)}", admin_password="pw", petta_path=PETTA)
        settings.base_path = base_path
        app = app_module.create_app(settings, supervisor=FakeSupervisor(), reconcile_seconds=0)
        client = TestClient(app)
        client.__enter__()
        started.append(client)
        h = Hive(client, app, app.state.hive)
        h.dist = dist
        return h

    yield _boot
    for c in started:
        c.__exit__(None, None, None)


def assert_frame(r, script="postMessage('synthetic frame one')"):
    assert r["status"] == 200, r
    assert r["headers"]["content-security-policy"] == expected_csp(script)
    assert r["headers"]["x-content-type-options"] == "nosniff"
    assert r["headers"]["cache-control"] == "no-cache"
    assert r["headers"]["content-type"].startswith("text/html")


def assert_404(r):
    assert r["status"] == 404, (r["status"], r["headers"])
    assert "content-security-policy" not in r["headers"]


# ---- T-CSP1: the exact header at the canonical path, root and base path, GET and HEAD -----------------------------

@pytest.mark.parametrize("prefix", ["", BASE])
def test_csp1_canonical_path_gets_the_exact_header(boot, prefix):
    h = boot(base_path=BASE if prefix else "")
    r = h.raw(prefix + "/" + CANONICAL)
    assert_frame(r)
    assert r["body"] == (h.dist / CANONICAL).read_bytes()
    assert "sandbox allow-scripts;" in r["headers"]["content-security-policy"]
    assert r["headers"]["content-security-policy"].endswith("frame-ancestors 'self'")
    assert h.hive.mind_frame.available() is True


@pytest.mark.parametrize("prefix", ["", BASE])
def test_csp1_head_never_serves_the_frame_or_an_alias(boot, prefix):
    """Live answers HEAD on every UI path with 405 (the catch-all is GET only; 1f5fc6c9). r1d keeps that: HEAD on the
    frame, an alias, another mind-iter .html or an ordinary asset is the same 405, never a 200 without the header."""
    h = boot(base_path=BASE if prefix else "")
    for raw in ("/" + CANONICAL, "/mind-iter//mind-frame.html", "/mind-iter/mind-frame.html/", "/assets/app-abc.js"):
        r = h.raw(prefix + raw, "HEAD")
        assert r["status"] == 405 and "content-security-policy" not in r["headers"], raw


def test_csp1_other_build_files_are_untouched(boot):
    h = boot()
    assert h.raw("/assets/app-abc.js")["headers"]["cache-control"] == "public, max-age=31536000, immutable"
    worker = h.raw("/mind-iter/worker.js")                    # non-.html under mind-iter/ is an ordinary build file
    assert worker["status"] == 200 and "content-security-policy" not in worker["headers"]
    page = h.raw("/some/page")
    assert page["status"] == 200 and page["body"] == b"synthetic UI"
    assert "content-security-policy" not in page["headers"]


# ---- T-ALIAS: every other spelling of the frame is 404, root and base path ---------------------------------------

SPELLINGS = [
    "/mind-iter//mind-frame.html",
    "/mind-iter/./mind-frame.html",
    "/mind-iter/x/../mind-frame.html",
    "/mind-iter/assets/../mind-frame.html",
    "/./mind-iter/mind-frame.html",
    "/mind-iter%2Fmind-frame.html",
    "/mind-iter%2fmind-frame.html",
    "/mind-iter/%2e/mind-frame.html",
    "/mind-iter/%2E/mind-frame.html",
    "/mind-iter/mind-frame%2Ehtml",
    "/%6Dind-iter/mind-frame.html",
    "/mind-iter/mind-frame.html/",
    "/mind-iter/mind-frame.html//",
    "/assets/../mind-iter/mind-frame.html",
]


@pytest.mark.parametrize("prefix", ["", BASE])
@pytest.mark.parametrize("spelling", SPELLINGS)
def test_alias_spellings_are_404(boot, prefix, spelling):
    h = boot(base_path=BASE if prefix else "")
    r = h.raw(prefix + spelling)
    if prefix and ".." in spelling:
        # under the public prefix the existing PublicGate (sso.py:121-122) refuses any `..` first, with 400 bad_path
        assert r["status"] == 400 and b"bad_path" in r["body"] and "content-security-policy" not in r["headers"]
    else:
        assert_404(r)
    assert_frame(h.raw(prefix + "/" + CANONICAL))     # the canonical path still serves, with its header


def _case_insensitive(directory: pathlib.Path) -> bool:
    probe = directory / "CaseProbe"
    probe.write_text("x")
    try:
        return (directory / "caseprobe").exists()
    finally:
        probe.unlink()


@pytest.mark.parametrize("prefix", ["", BASE])
@pytest.mark.parametrize("spelling", ["/Mind-Iter/Mind-Frame.html", "/mind-iter/MIND-FRAME.HTML", "/MIND-ITER/mind-frame.html"])
def test_alias_case_variants_are_404(boot, tmp_path, prefix, spelling):
    if not _case_insensitive(tmp_path):
        pytest.skip("filesystem is case-sensitive: a case variant cannot reach the frame file here")
    h = boot(base_path=BASE if prefix else "")
    assert_404(h.raw(prefix + spelling))
    assert_frame(h.raw(prefix + "/" + CANONICAL))


def _links(dist: pathlib.Path):
    frame = dist / CANONICAL
    (dist / "alias.html").symlink_to(frame)
    (dist / "assets" / "alias-sym.txt").symlink_to(frame)
    os.link(frame, dist / "hard.html")
    os.link(frame, dist / "assets" / "hard-abc.js")
    (dist / "mi").symlink_to(dist / "mind-iter", target_is_directory=True)


@pytest.mark.parametrize("prefix", ["", BASE])
@pytest.mark.parametrize("alias", ["/alias.html", "/assets/alias-sym.txt", "/hard.html", "/assets/hard-abc.js",
                                   "/mi/mind-frame.html"])
def test_alias_symlinks_and_hard_links_are_404(boot, prefix, alias):
    h = boot(base_path=BASE if prefix else "", prepare=_links)
    assert_404(h.raw(prefix + alias))
    assert_frame(h.raw(prefix + "/" + CANONICAL))
    assert h.hive.mind_frame.available() is True       # links are aliases, refused per request; not a second copy


def test_alias_links_made_after_boot_are_404(boot):
    h = boot()
    _links(h.dist)
    for alias in ("/alias.html", "/hard.html", "/assets/hard-abc.js", "/mi/mind-frame.html"):
        assert_404(h.raw(alias))
    assert_frame(h.raw("/" + CANONICAL))


@pytest.mark.parametrize("prefix", ["", BASE])
def test_alias_any_other_html_under_mind_iter_is_404(boot, prefix):
    def other(dist):
        (dist / "mind-iter" / "other.html").write_text("<script>1</script>")
        (dist / "mind-iter" / "sub").mkdir()
        (dist / "mind-iter" / "sub" / "deep.htm").write_text("<script>2</script>")
    h = boot(base_path=BASE if prefix else "", prepare=other)
    assert_404(h.raw(prefix + "/mind-iter/other.html"))
    assert_404(h.raw(prefix + "/mind-iter/sub/deep.htm"))
    assert_frame(h.raw(prefix + "/" + CANONICAL))


@pytest.mark.parametrize("where", ["assets/copy.html", "copy.html", "mind-iter/sub/copy.txt", "assets/pinned-abc.js"])
def test_alias_a_second_copy_turns_the_frame_off(boot, where):
    def copy(dist):
        target = dist / where
        target.parent.mkdir(parents=True, exist_ok=True)
        if where.endswith(".js"):    # the hash text alone, quoted differently, still counts
            target.write_text('const h = "' + _source("postMessage('synthetic frame one')")[1:-1] + '"')
        else:
            shutil.copyfile(dist / CANONICAL, target)
    h = boot(prepare=copy)
    assert h.hive.mind_frame.available() is False and h.hive.mind_frame.reason == "second_copy"
    assert_404(h.raw("/" + where))
    assert_404(h.raw("/" + CANONICAL))


def test_alias_the_canonical_path_as_a_link_is_refused(boot):
    def relink(dist):
        real = dist / "assets" / "real-frame.bin"
        (dist / CANONICAL).rename(real)
        (dist / CANONICAL).symlink_to(real)
    h = boot(prepare=relink)
    assert h.hive.mind_frame.available() is False
    assert_404(h.raw("/" + CANONICAL))
    assert_404(h.raw("/assets/real-frame.bin"))


# ---- T-CSP: fail closed ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("case", ["missing", "no_meta", "no_hash", "two_hashes", "two_metas"])
def test_csp_fail_closed(boot, case):
    script = "postMessage('synthetic frame one')"
    frame = {"missing": False,
             "no_meta": "<!doctype html><script>" + script + "</script>",
             "no_hash": frame_html(sources=["'self'"]),
             "two_hashes": frame_html(sources=[_source(script), _source("other")]),
             "two_metas": frame_html() + '<meta http-equiv="Content-Security-Policy" content="script-src '
                          + _source("x") + '">'}[case]
    h = boot(frame=frame)
    assert h.hive.mind_frame.available() is False
    assert_404(h.raw("/" + CANONICAL))
    assert_404(h.raw("/mind-iter//mind-frame.html"))


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
def test_csp_unreadable_frame_is_404_and_off(boot):
    h = boot(prepare=lambda dist: os.chmod(dist / CANONICAL, 0))
    try:
        assert h.hive.mind_frame.available() is False and h.hive.mind_frame.reason == "unreadable"
        assert_404(h.raw("/" + CANONICAL))
    finally:
        os.chmod(h.dist / CANONICAL, 0o644)


def test_bootstrap_source_reads_the_single_meta_hash():
    from hive.core.mind_frame import bootstrap_source
    s = _source("a")
    assert bootstrap_source(frame_html("a").encode()) == s
    assert bootstrap_source(frame_html(sources=[s, s]).encode()) == s       # the same hash twice is one source
    assert bootstrap_source(b"<meta http-equiv='content-security-policy' content=\"script-src " + s.encode() + b"\">") == s
    assert bootstrap_source(b"<script>" + s.encode() + b"</script>") is None   # a hash outside the meta is not the source


# ---- T-CSP2: the hash is re-read when the file changes (mtime, size or inode) ----------------------------------------

def _swap(dist: pathlib.Path, html: str, *, in_place=False):
    frame = dist / CANONICAL
    if in_place:
        frame.write_text(html)
    else:
        tmp = dist / "mind-iter" / ".next"
        tmp.write_text(html)
        os.replace(tmp, frame)


@pytest.mark.parametrize("in_place", [False, True])
def test_csp2_swapped_frame_serves_the_new_hash(boot, in_place):
    h = boot()
    assert_frame(h.raw("/" + CANONICAL))
    _swap(h.dist, frame_html("postMessage('synthetic frame two, longer')"), in_place=in_place)
    assert_frame(h.raw("/" + CANONICAL), "postMessage('synthetic frame two, longer')")
    assert h.hive.mind_frame.available() is True
    _swap(h.dist, frame_html(sources=["'self'"]), in_place=in_place)          # the new build has no hash
    assert_404(h.raw("/" + CANONICAL))
    assert h.hive.mind_frame.available() is False
    _swap(h.dist, frame_html(), in_place=in_place)
    assert_frame(h.raw("/" + CANONICAL))


def test_csp2_same_size_rewrite_is_noticed_by_mtime(boot):
    h = boot()
    a, b = "postMessage('synthetic frame AAA')", "postMessage('synthetic frame BBB')"
    _swap(h.dist, frame_html(a), in_place=True)
    st = os.stat(h.dist / CANONICAL)
    assert_frame(h.raw("/" + CANONICAL), a)
    (h.dist / CANONICAL).write_text(frame_html(b))
    os.utime(h.dist / CANONICAL, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    assert os.stat(h.dist / CANONICAL).st_size == st.st_size
    assert_frame(h.raw("/" + CANONICAL), b)


def test_csp2_frame_removed_then_restored(boot):
    h = boot()
    (h.dist / CANONICAL).unlink()
    assert_404(h.raw("/" + CANONICAL))
    assert h.hive.mind_frame.available() is False
    (h.dist / CANONICAL).write_text(frame_html())
    assert_frame(h.raw("/" + CANONICAL))


def test_csp2_a_copy_added_by_a_redeploy_is_found(boot):
    h = boot()
    shutil.copyfile(h.dist / CANONICAL, h.dist / "assets" / "copy.html")
    _swap(h.dist, frame_html())               # a UI deploy rewrites the frame (new inode): the build is rescanned
    assert h.hive.mind_frame.available() is False
    assert_404(h.raw("/assets/copy.html"))
    assert_404(h.raw("/" + CANONICAL))


# ---- r1d.2 (stand-in P1-1, P1-2): any served copy is refused at request time, in every state of the canonical file ---

LATE = {"assets/copy.html": None,                                       # a byte copy of the frame
        "assets/late.htm": None,
        "assets/other-frame.html": frame_html("postMessage('a frame never seen')"),   # the frame's shape, unknown hash
        "assets/copy.svg": None,                                        # any document type the browser runs
        "assets/pinned-late.js": "pin"}                                # the hash text alone, in a non-document


def _plant(dist: pathlib.Path, where: str, how=None):
    target = dist / where
    target.parent.mkdir(parents=True, exist_ok=True)
    if how == "pin":
        target.write_text('const h = "' + _source("postMessage('synthetic frame one')")[1:-1] + '"')
    elif how is not None:
        target.write_text(how)
    else:
        shutil.copyfile(dist / CANONICAL, target)


@pytest.mark.parametrize("where", sorted(LATE))
def test_r1d2_a_copy_added_after_boot_into_an_existing_directory_is_404_and_turns_the_frame_off(boot, where):
    """Stand-in P1-1: the copy changes neither the frame nor the build root, so the October scan never saw it and the
    catch-all served it without the sandbox header (and `immutable` under assets/)."""
    h = boot()
    assert_frame(h.raw("/" + CANONICAL))
    _plant(h.dist, where, LATE[where])
    assert_404(h.raw("/" + where))
    assert h.hive.mind_frame.available() is False and h.hive.mind_frame.reason == "second_copy"
    assert_404(h.raw("/" + CANONICAL))
    (h.dist / where).unlink()                       # the copy is gone: the frame comes back with no restart
    assert h.hive.mind_frame.available() is True
    assert_frame(h.raw("/" + CANONICAL))


def test_r1d2_the_capability_sees_a_late_copy_nobody_has_requested(boot):
    h = boot()
    assert h.hive.mind_frame.available() is True
    _plant(h.dist, "assets/copy.html")
    assert h.hive.mind_frame.available() is False and h.hive.mind_frame.reason == "second_copy"
    assert_404(h.raw("/" + CANONICAL))
    assert_404(h.raw("/assets/copy.html"))


@pytest.mark.parametrize("state", ["missing", "no_hash", "two_hashes", "unreadable", "not_canonical"])
@pytest.mark.parametrize("when", ["boot", "later"])
def test_r1d2_copies_stay_refused_while_the_canonical_file_fails(boot, state, when):
    """Stand-in P1-2: a failed canonical file must not forget, or never learn, the copies that survive it, including a
    hive that boots with the canonical file already missing."""
    if state == "unreadable" and os.geteuid() == 0:
        pytest.skip("root reads any file")

    def plant(dist):
        _plant(dist, "assets/copy.html")
        _plant(dist, "copy.html")

    def fail(dist):
        frame = dist / CANONICAL
        if state == "missing":
            frame.unlink()
        elif state == "no_hash":
            frame.write_text(frame_html(sources=["'self'"]))
        elif state == "two_hashes":
            frame.write_text(frame_html(sources=[_source("a"), _source("b")]))
        elif state == "unreadable":
            os.chmod(frame, 0)
        else:
            real = dist / "assets" / "real-frame.bin"
            frame.rename(real)
            frame.symlink_to(real)

    h = boot(prepare=(lambda d: (plant(d), fail(d))) if when == "boot" else plant)
    try:
        if when == "later":
            assert_404(h.raw("/assets/copy.html"))
            fail(h.dist)
        assert h.hive.mind_frame.available() is False
        for where in ("/assets/copy.html", "/copy.html", "/" + CANONICAL):
            assert_404(h.raw(where))
        assert h.hive.mind_frame.available() is False
    finally:
        if (h.dist / CANONICAL).exists() and not (h.dist / CANONICAL).is_symlink():
            os.chmod(h.dist / CANONICAL, 0o644)


def test_r1d2_the_browser_mind_capability_reads_the_real_frame(boot):
    """r1b's GET /api/me/mind capability reads hive.mind_frame.available() (personal.py), with no stub."""
    h = boot()
    assert h.hive.personal.capabilities()["browser_mind"] is True
    _plant(h.dist, "assets/copy.html")
    assert h.hive.personal.capabilities()["browser_mind"] is False


def test_r1d2_the_page_fallback_is_never_a_frame_copy(boot):
    h = boot()
    shutil.copyfile(h.dist / CANONICAL, h.dist / "index.html")
    for raw in ("/some/page", "/", "/index.html"):
        assert_404(h.raw(raw))
    assert h.hive.mind_frame.available() is False


def test_r1d2_a_rewrite_that_keeps_size_and_mtime_is_noticed_by_ctime(boot):
    h = boot()
    a, b = "postMessage('synthetic frame AAA')", "postMessage('synthetic frame BBB')"
    _swap(h.dist, frame_html(a), in_place=True)
    st = os.stat(h.dist / CANONICAL)
    assert_frame(h.raw("/" + CANONICAL), a)
    (h.dist / CANONICAL).write_text(frame_html(b))
    os.utime(h.dist / CANONICAL, ns=(st.st_atime_ns, st.st_mtime_ns))
    after = os.stat(h.dist / CANONICAL)
    assert (after.st_size, after.st_mtime_ns) == (st.st_size, st.st_mtime_ns)
    assert_frame(h.raw("/" + CANONICAL), b)


def test_r1d2_controls_ordinary_files_stay_untouched(boot):
    """Controls: a document with no CSP hash, and a script that mentions an unknown hash in a meta string, are ordinary
    build files; each is read once per version."""
    h = boot()
    (h.dist / "assets" / "page-abc.html").write_text("<!doctype html><p>synthetic page</p>")
    (h.dist / "assets" / "lib-abc.js").write_text("const t = '" + frame_html("postMessage('elsewhere')").replace("\n", " ")
                                                  .replace("'", "\\'") + "'")
    for raw in ("/assets/page-abc.html", "/assets/lib-abc.js"):
        r = h.raw(raw)
        assert r["status"] == 200 and r["headers"]["cache-control"] == "public, max-age=31536000, immutable", raw
        assert "content-security-policy" not in r["headers"], raw
    assert h.hive.mind_frame.available() is True
    assert_frame(h.raw("/" + CANONICAL))


# ---- r1de.3 (stand-in P1 on r1de.2): one file under two names; the name's part is decided on every request -----------

def _no_canonical(dist):
    (dist / CANONICAL).unlink()


# a surviving frame copy whose bytes do not read as HTML by themselves: only the name it is served under makes it a page
UNSNIFFED = "/* kept */ " + frame_html()


@pytest.mark.parametrize("order", [("/assets/first.js", "/assets/copy.html"), ("/assets/copy.html", "/assets/first.js")])
@pytest.mark.parametrize("when", ["boot", "later"])
def test_r1de3_a_hard_linked_copy_is_refused_under_its_html_name_in_either_order(boot, order, when):
    """The stand-in's sequence: no canonical file at boot, so no hash is known; one copy hard-linked as first.js and
    copy.html. A verdict cached for the .js name must not let the .html name through."""
    def plant(dist):
        (dist / "assets" / "first.js").write_text(UNSNIFFED)
        os.link(dist / "assets" / "first.js", dist / "assets" / "copy.html")
    h = boot(prepare=(lambda d: (_no_canonical(d), plant(d))) if when == "boot" else _no_canonical)
    if when == "later":
        plant(h.dist)
    for raw in order:
        r = h.raw(raw)
        if raw.endswith(".html"):
            assert_404(r)
        else:   # served as a script, it is not a page: the ordinary branch, as for any asset
            assert r["status"] == 200 and r["headers"]["content-type"].startswith("text/javascript"), r["headers"]
    assert_404(h.raw("/assets/copy.html"))                  # and again, now that both names have been seen
    assert h.hive.mind_frame.available() is False


@pytest.mark.parametrize("first", ["target", "alias"])
def test_r1de3_a_symlinked_html_name_for_a_copy_is_refused(boot, first):
    def plant(dist):
        (dist / "assets" / "real.js").write_text(UNSNIFFED)
        (dist / "assets" / "alias.html").symlink_to(dist / "assets" / "real.js")
    h = boot(prepare=lambda d: (_no_canonical(d), plant(d)))
    seq = ["/assets/real.js", "/assets/alias.html"] if first == "target" else ["/assets/alias.html", "/assets/real.js"]
    for raw in seq:
        r = h.raw(raw)
        if raw.endswith(".html"):
            assert_404(r)
        else:
            assert r["status"] == 200
    assert_404(h.raw("/assets/alias.html"))


def test_r1de3_a_copy_that_reads_as_html_is_refused_under_any_name(boot):
    """Bytes a browser would sniff as HTML are a copy whatever the name (a frame copy saved as .js or with no extension)."""
    def plant(dist):
        (dist / "assets" / "frame-abc.js").write_text(frame_html())
        (dist / "assets" / "frame-abc").write_text(frame_html())
    h = boot(prepare=lambda d: (_no_canonical(d), plant(d)))
    assert_404(h.raw("/assets/frame-abc.js"))
    assert_404(h.raw("/assets/frame-abc"))


def test_r1de3_a_stray_copy_turns_the_mind_off_not_the_ui(boot):
    """Kimi r1de.2: the page is served while copies are known, with frame-ancestors 'none'; the copy is 404 and the mind
    frame stays off. With no copy the page carries no CSP (as at the base)."""
    h = boot()
    assert "content-security-policy" not in h.raw("/")["headers"]
    _plant(h.dist, "assets/copy.html")
    assert_404(h.raw("/assets/copy.html"))
    for raw in ("/", "/some/page"):
        r = h.raw(raw)
        assert r["status"] == 200 and r["body"] == b"synthetic UI", raw
        assert r["headers"]["content-security-policy"] == "frame-ancestors 'none'", raw
        assert r["headers"]["cache-control"] == "no-cache, no-store, must-revalidate", raw
    assert h.hive.mind_frame.available() is False
    assert_404(h.raw("/" + CANONICAL))
    (h.dist / "assets" / "copy.html").unlink()
    assert h.hive.mind_frame.available() is True
    assert "content-security-policy" not in h.raw("/")["headers"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads any file")
def test_r1de3_an_unreadable_build_file_is_404_with_the_flag_on(boot):
    """Kimi r1de.2 P3 #1: it cannot be shown not to be a copy, so it is refused; the frame stays on."""
    h = boot()
    os.chmod(h.dist / "assets" / "app-abc.js", 0)
    try:
        assert_404(h.raw("/assets/app-abc.js"))
        assert h.hive.mind_frame.available() is True
        assert_frame(h.raw("/" + CANONICAL))
    finally:
        os.chmod(h.dist / "assets" / "app-abc.js", 0o644)


# ---- r1de.4 (stand-in r1de.3 P2s): a copy found through a link stays known; the page is guarded however it is asked for

def test_r1de4_a_copy_found_through_an_html_link_is_not_forgotten(boot):
    """An unknown-hash copy at real.js, found through alias.html: the next request (for real.js itself) must not prune it,
    so the frame stays off and the page keeps frame-ancestors 'none'."""
    h = boot()
    assert_frame(h.raw("/" + CANONICAL))
    (h.dist / "assets" / "real.js").write_text("/* kept */ " + frame_html("postMessage('a frame never seen')"))
    (h.dist / "assets" / "alias.html").symlink_to(h.dist / "assets" / "real.js")
    assert_404(h.raw("/assets/alias.html"))
    assert h.raw("/assets/real.js")["status"] == 200            # served as a script; it re-checks the known copies
    assert_404(h.raw("/" + CANONICAL))
    assert h.raw("/")["headers"]["content-security-policy"] == "frame-ancestors 'none'"
    assert h.hive.mind_frame.available() is False and h.hive.mind_frame.reason == "second_copy"
    (h.dist / "assets" / "alias.html").unlink()                 # the link is gone: so is the copy, and the frame is back
    (h.dist / "assets" / "real.js").write_text("console.log('synthetic')")
    assert h.hive.mind_frame.available() is True
    assert_frame(h.raw("/" + CANONICAL))


def test_r1de4_a_direct_index_request_carries_frame_ancestors_while_copies_are_known(boot):
    h = boot()
    assert "content-security-policy" not in h.raw("/index.html")["headers"]
    _plant(h.dist, "assets/copy.html")
    assert_404(h.raw("/assets/copy.html"))
    r = h.raw("/index.html")
    assert r["status"] == 200 and r["body"] == b"synthetic UI"
    assert r["headers"]["content-security-policy"] == "frame-ancestors 'none'"
    assert r["headers"]["cache-control"] == "no-cache"           # the file branch's own cache header, as at the base
    assert "content-security-policy" not in h.raw("/assets/app-abc.js")["headers"]   # only the page gains the header


# ---- switch off: identical behaviour (regression) ---------------------------------------------------------------------

@pytest.mark.parametrize("prefix", ["", BASE])
def test_switch_off_is_unchanged(boot, prefix):
    h = boot(flag=False, base_path=BASE if prefix else "", prepare=_links)
    assert getattr(h.hive, "mind_frame", None) is None
    for raw in ("/" + CANONICAL, "/mind-iter//mind-frame.html", "/mind-iter/./mind-frame.html", "/hard.html",
                "/mind-iter/mind-frame.html/"):
        r = h.raw(prefix + raw)
        assert r["status"] == 200 and r["headers"]["cache-control"] == "no-cache", raw
        assert "content-security-policy" not in r["headers"] and "x-content-type-options" not in r["headers"], raw
    assert h.raw(prefix + "/assets/app-abc.js")["headers"]["cache-control"] == "public, max-age=31536000, immutable"
    assert h.raw(prefix + "/some/page")["body"] == b"synthetic UI"
    assert h.raw(prefix + "/mind-iter/nope.html")["status"] == 404
