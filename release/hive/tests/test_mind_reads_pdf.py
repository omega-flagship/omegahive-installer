# Purpose: tests that a mind fetching a PDF a person added gets its text, read by the hive's PDF tool inside the sandbox
# under the download's own read rule, one read at a time per mind, kept beside the PDF, and that a mind is told plainly
# when a PDF's text cannot be read, the sandbox being unavailable included.
"""A mind reads the PDF a person adds (tester report 11-13).

A tester added a flight-confirmation PDF for her minds to build around, and none of them could read it. A mind that
fetched it with hive-asset-get got "HIVE-ASSET-SAVED ... application/pdf" and nothing more: only a text file's content
was shown, no skill of a mind reads a PDF, and no install shipped a PDF reader, so web-fetch said "this hive cannot read
PDF text yet" too.

Jon's second review (omega-flagship/omegahive#299) found the first version parsing PDFs in an unsandboxed child of the
hive with a hive-wide cap: the run backend now runs the PDF tool inside the sandbox, and the cap is per mind.

Invented lives: Rosa's bakery swarm (minds Juno and Pax) and Wren's orchard; every PDF is made here.
"""
import asyncio

import pytest

from hive.core import run_backends, webtools
from hive.core.run_backends import RunBackend
from hive.tests.test_core_api import agent_headers, client  # noqa: F401  (fixture)
from hive.tests.test_mind_files import RECIPE, bakery, bridge, upload  # noqa: F401  (fixture)


def pdf(*lines):
    """A one-page PDF showing these lines in Helvetica (none: a page with no text, as a scan has), its offsets computed."""
    stream = "BT /F1 14 Tf 72 720 Td " + " ".join(f"({t}) Tj 0 -20 Td" for t in lines) + " ET" if lines else "0 0 1 1 re f"
    objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
               f"<< /Length {len(stream)} >>\nstream\n{stream}\nendstream", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out, offsets = b"%PDF-1.4\n", []
    for n, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{n} 0 obj\n{body}\nendobj\n".encode()
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    return out + f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()


FLIGHT = ("Flight confirmation LX1234", "Lisbon LIS to Zurich ZRH, 14 Nov 2026 09:05", "Booking reference QX7RT2")
SANDBOX = pytest.mark.skipif(not run_backends.get().available(), reason="needs the OS sandbox the hive reads PDFs in")


class Recorder(RunBackend):
    """A run backend that records the hive tools it is asked to run and answers each with the text it was given."""
    name = "recorder"
    OutputLimit = type("RecorderOutputLimit", (RuntimeError,), {})

    def __init__(self, text=b"", error=None, gate=None):
        self.calls, self.text, self.error, self.gate = [], text, error, gate

    async def run_hive_tool(self, name, files, entry, args=(), inputs=None, outputs=(), **limits):
        self.calls.append({"name": name, "files": files, "entry": entry, "args": list(args), "inputs": inputs,
                           "outputs": list(outputs), "limits": limits})
        if self.gate is not None:
            await self.gate.wait()
        if self.error is not None:
            raise self.error
        return {"exit": 0, "outputs": {"text.txt": self.text}, "missing_outputs": []}


@pytest.fixture
def use_backend():
    previous = run_backends.use(None)
    yield run_backends.use
    run_backends.use(previous)


@SANDBOX
def test_a_mind_reads_the_text_of_a_pdf_a_person_added(client, bakery, monkeypatch, tmp_path):
    b = bakery
    up = upload(client, pdf(*FLIGHT), "application/pdf", "flight.pdf", b["bakery"]["id"], b["rosa"])
    hc, calls = bridge(client, monkeypatch, b["juno"], tmp_path)
    out = hc.decode(hc.asset_get(up["sha256"], "-"))
    assert out.startswith(f"HIVE-ASSET-SAVED files/assets/{up['sha256']} ") and "application/pdf" in out
    assert "--- content ---\n" in out, f"no text of the PDF in the result: {out}"
    shown = out.split("--- content ---\n", 1)[1].split("\n--- end of content ---", 1)[0]
    assert all(line in shown for line in FLIGHT), shown
    # the whole text is kept beside the PDF, for read-file once a long PDF's text is cut in the result
    assert all(line in (tmp_path / "files" / "assets" / f"{up['sha256']}.txt").read_text(encoding="utf-8") for line in FLIGHT)
    assert calls == [("GET", f"/api/agent/assets/{up['sha256']}"), ("GET", f"/api/agent/assets/{up['sha256']}/text")]


@SANDBOX
def test_the_text_follows_the_downloads_read_rule_and_only_a_pdf_is_read(client, bakery):
    b = bakery
    up = upload(client, pdf(*FLIGHT), "application/pdf", "flight.pdf", b["bakery"]["id"], b["rosa"])
    got = client.get(f"/api/agent/assets/{up['sha256']}/text", headers=agent_headers(b["pax"]))
    assert got.status_code == 200 and got.json()["sha256"] == up["sha256"] and FLIGHT[0] in got.json()["text"]
    # Wren, in another swarm, may not read the file, so not its text either: the download's own 404
    assert client.get(f"/api/agent/assets/{up['sha256']}/text", headers=agent_headers(b["wren"])).status_code == 404
    recipe = upload(client, RECIPE, "text/plain", "rye-recipe.txt", b["bakery"]["id"], b["rosa"])
    refused = client.get(f"/api/agent/assets/{recipe['sha256']}/text", headers=agent_headers(b["juno"]))
    assert refused.status_code == 415 and refused.json()["error"]["code"] == "not_a_pdf"


def test_a_pdf_whose_text_cannot_be_read_is_said_plainly(client, bakery, monkeypatch, tmp_path):
    b = bakery
    scan = upload(client, pdf(), "application/pdf", "scan.pdf", b["bakery"]["id"], b["rosa"])
    hc, _ = bridge(client, monkeypatch, b["juno"], tmp_path)
    assert "(the PDF holds no text to read: its pages may be scanned images)" in hc.decode(hc.asset_get(scan["sha256"], "-"))

    async def no_reader(data, timeout, reader):
        return None
    monkeypatch.setattr(webtools, "pdf_text", no_reader)
    flight = upload(client, pdf(*FLIGHT), "application/pdf", "flight.pdf", b["bakery"]["id"], b["rosa"])
    out = hc.decode(hc.asset_get(flight["sha256"], "-"))
    assert out.startswith("HIVE-ASSET-SAVED ") and "(its text could not be read: HIVE-ERROR no_pdf_reader: this hive cannot read PDF text yet)" in out


def test_the_run_backend_reads_the_pdf_in_the_sandbox_and_the_hive_starts_no_process(client, bakery, use_backend,
                                                                                     monkeypatch):
    b = bakery
    recorder = Recorder(text=b"Flight confirmation LX1234")
    use_backend(recorder)

    async def no_child(*args, **kwargs):
        raise AssertionError("the hive started a PDF process of its own, outside the sandbox")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_child)
    flight = pdf(*FLIGHT)
    up = upload(client, flight, "application/pdf", "flight.pdf", b["bakery"]["id"], b["rosa"])
    got = client.get(f"/api/agent/assets/{up['sha256']}/text", headers=agent_headers(b["juno"]))
    assert got.status_code == 200 and got.json()["text"] == "Flight confirmation LX1234"
    (call,) = recorder.calls
    assert (call["name"], call["entry"], call["files"]) == ("pdf-reader", "pdf_text.py", {"pdf_text.py": webtools.PDF_SCRIPT})
    assert call["inputs"] == {"in.pdf": flight} and call["outputs"] == ["text.txt"]
    limits = call["limits"]
    assert limits["cpu_seconds"] == webtools.PDF_CPU_SECONDS and limits["memory_bytes"] == webtools.PDF_MEMORY_BYTES
    assert limits["file_bytes"] == limits["artifact_bytes"] == webtools.PDF_OUTPUT_CAP + webtools.PDF_FILE_SLACK
    assert 1 <= limits["timeout"] <= webtools.TOTAL_SECONDS


def test_each_mind_reads_one_pdf_at_a_time_and_no_mind_waits_on_another(use_backend):
    """Its first read still running, a mind's second is refused, while three other minds read at the same time (a
    hive-wide cap of two refused the second mind's read whenever two others were reading)."""
    async def reads():
        recorder = Recorder(text=b"Booking reference QX7RT2", gate=asyncio.Event())
        use_backend(recorder)
        first = asyncio.create_task(webtools.pdf_text(b"%PDF-1.4", 5, "a_juno"))
        await asyncio.sleep(0)
        with pytest.raises(webtools.WebError) as busy:
            await webtools.pdf_text(b"%PDF-1.4", 5, "a_juno")
        others = [asyncio.create_task(webtools.pdf_text(b"%PDF-1.4", 5, mind)) for mind in ("a_pax", "a_wren", "a_ivy")]
        await asyncio.sleep(0)
        running = len(recorder.calls)
        recorder.gate.set()
        texts = [await task for task in (first, *others)]
        again = await webtools.pdf_text(b"%PDF-1.4", 5, "a_juno")   # once its first read ended
        return busy.value, running, texts, again
    busy, running, texts, again = asyncio.run(reads())
    assert busy.status == 503 and busy.code == "pdf_busy" and "already reading a PDF" in busy.message
    assert running == 4 and texts == ["Booking reference QX7RT2"] * 4 and again == "Booking reference QX7RT2"


def test_without_its_sandbox_the_hive_reads_no_pdf_text_and_the_mind_is_told_why(client, bakery, use_backend,
                                                                                  monkeypatch, tmp_path):
    b = bakery
    use_backend(Recorder(error=RuntimeError("sandbox unavailable: refusing to run tools unsandboxed")))
    up = upload(client, pdf(*FLIGHT), "application/pdf", "flight.pdf", b["bakery"]["id"], b["rosa"])
    got = client.get(f"/api/agent/assets/{up['sha256']}/text", headers=agent_headers(b["juno"]))
    assert got.status_code == 503 and got.json()["error"]["code"] == "pdf_unavailable"
    hc, _ = bridge(client, monkeypatch, b["juno"], tmp_path)
    out = hc.decode(hc.asset_get(up["sha256"], "-"))
    assert out.startswith("HIVE-ASSET-SAVED ") and ("(its text could not be read: HIVE-ERROR pdf_unavailable: this hive "
                                                    "reads PDF text only inside its sandbox") in out
