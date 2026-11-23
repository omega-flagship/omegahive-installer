"""Web tools (hive/core/webtools.py): the PDF reader, which runs inside the hive's OS sandbox (webtools.pdf_text).

Moved out of test_web_tools.py so they can run in the full run's switch shard (scripts/ci/hive-switch-files.txt): the
sandbox cannot start at the machine's restriction 1, where the plain shards run. The fixture, fakes and helpers are
test_web_tools.py's. No network: deny_network, as there."""
import importlib.util

import pytest

from hive.core import run_backends, webtools
from hive.tests.test_web_tools import fetch, w  # noqa: F401  (fixture)


@pytest.fixture(autouse=True)
def _no_network(deny_network):
    yield


# The PDF reader runs inside the hive's sandbox (webtools.pdf_text): these need the OS sandbox the run backend uses.
SANDBOX = pytest.mark.skipif(not run_backends.get().available(), reason="needs the OS sandbox the hive reads PDFs in")


def _pdf_reader():
    for name in ("pypdf", "pymupdf", "fitz"):
        if importlib.util.find_spec(name):
            return name
    return None


@pytest.mark.skipif(_pdf_reader() not in ("pymupdf", "fitz"), reason="needs PyMuPDF to make a PDF")
def test_review7_a_pdf_is_read_in_a_child_process(w):
    try:
        import pymupdf
    except ImportError:
        import fitz as pymupdf
    doc = pymupdf.open()
    doc.new_page().insert_text((72, 72), "Invented PDF words")
    w.site.page("example.org", "/d.pdf", doc.tobytes(), ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and "Invented PDF words" in r.json()["text"]


@SANDBOX
def test_review7_a_slow_pdf_reader_is_killed_at_the_deadline(w, monkeypatch):
    import time as _time
    monkeypatch.setattr(webtools, "TOTAL_SECONDS", 3.0)
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "while True: pass")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    started = _time.monotonic()
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 504 and _time.monotonic() - started < 5


@SANDBOX
def test_rereview2_pdf_output_is_capped_and_the_child_stopped(w, monkeypatch):
    # the reader writes far past its cap: the sandbox's file-size limit stops it there, and the text is cut at the cap
    monkeypatch.setattr(webtools, "PDF_OUTPUT_CAP", 1000)
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "open('text.txt', 'w').write('a' * 10 ** 7)\n")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and r.json()["text"] == "a" * 1000


@SANDBOX
def test_rereview4_the_sandbox_sets_the_pdf_readers_limits(w, monkeypatch):
    import inspect
    # the run backend starts the reader under the sandbox's launcher, which sets its limits; the hive starts no process
    source = inspect.getsource(webtools.pdf_text)
    assert "preexec_fn" not in source and "create_subprocess" not in source and "run_hive_tool" in source
    monkeypatch.setattr(webtools, "PDF_SCRIPT", "import resource\nopen('text.txt', 'w').write(str(resource.getrlimit(resource.RLIMIT_CPU)[0]))\n")
    w.site.page("example.org", "/d.pdf", b"%PDF-1.4 invented", ctype="application/pdf")
    r = fetch(w, "https://example.org/d.pdf")
    assert r.status_code == 200 and r.json()["text"] == str(webtools.PDF_CPU_SECONDS)
