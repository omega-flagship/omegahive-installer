"""A mind shares files only from its files/ folder, as itself; fetched files are checked against their sha256."""
import hashlib
import importlib.util
import io
import json
import os
import pathlib

SRC = pathlib.Path(__file__).resolve().parents[2] / "modules" / "hive" / "src" / "hive_commons.py"
spec = importlib.util.spec_from_file_location("hive_commons_assets", SRC)
hc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hc)


class FakeResponse(io.BytesIO):
    def __init__(self, data, headers=None):
        super().__init__(data)
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_put_only_from_files_folder_and_never_the_token(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HIVE_API_URL", "http://hive")
    monkeypatch.setenv("HIVE_WS_TOKEN", "secret-token")
    (tmp_path / "token").write_text("secret-token")
    (tmp_path / "files").mkdir()
    (tmp_path / "files" / "deck.pptx").write_bytes(b"PK deck bytes")
    os.symlink(tmp_path / "token", tmp_path / "files" / "sneaky")
    sent = {}

    def fake_urlopen(request, timeout=None):
        sent.update(url=request.full_url, data=request.data, type=request.headers.get("Content-type"))
        return FakeResponse(json.dumps({"sha256": hashlib.sha256(request.data).hexdigest(), "mime": "x", "bytes": len(request.data), "name": "deck.pptx"}).encode())
    monkeypatch.setattr(hc.urllib.request, "urlopen", fake_urlopen)
    for bad in ("../token", "sneaky", "/etc/passwd", "missing.png"):
        assert hc.asset_put(bad, "").startswith("HIVE-ERROR"), bad
    assert sent == {}                                                     # nothing left the folder
    out = hc.asset_put("deck.pptx", "Garden deck")
    assert out.startswith("HIVE-ASSET ") and sent["data"] == b"PK deck bytes" and "name=Garden%20deck" in sent["url"]


def test_get_checks_the_sha_and_saves_inside_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("HIVE_API_URL", "http://hive")
    monkeypatch.setenv("HIVE_WS_TOKEN", "t")
    good = b"preview png"
    sha = hashlib.sha256(good).hexdigest()
    monkeypatch.setattr(hc.urllib.request, "urlopen", lambda r, timeout=None: FakeResponse(good, {"Content-Type": "image/png"}))
    assert hc.asset_get(sha, "ar_1 2").startswith("HIVE-ASSET-SAVED files/assets/")
    assert (tmp_path / "files" / "assets" / sha).read_bytes() == good
    monkeypatch.setattr(hc.urllib.request, "urlopen", lambda r, timeout=None: FakeResponse(b"tampered", {}))
    assert "corrupt" in hc.asset_get(sha, "-")
    assert hc.asset_get("nope", "-").startswith("HIVE-ERROR bad_request")
    assert hc.asset_get(sha, "ar_1 x").startswith("HIVE-ERROR bad_request")
