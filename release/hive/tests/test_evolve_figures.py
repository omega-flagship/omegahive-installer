"""lab-figures r1: PNG figures attached to recorded OmegaEvolve reports (hive/core/evolve_figures.py).

Synthetic PNGs generated here, disposable hives from the shared fixture; no real figure, no live hive."""
import base64
import hashlib
import json
import struct
import zlib

import pytest

from hive.core.evolve_figures import MAX_BYTES, FigureError, png_size
from hive.tests.test_core_api import client  # noqa: F401  (fixture)
from hive.tests.test_evolve import contribution
from hive.tests.test_visibility import person


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(w=8, h=6, shade=0x7f, extra=b""):
    raw = b"".join(b"\x00" + bytes([shade]) * (3 * w) for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + extra + chunk(b"IEND", b""))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def figure(data, caption="Cooperation diagnostic (synthetic)", **extra):
    return dict({"sha256": sha(data), "caption": caption, "content_base64": base64.b64encode(data).decode()}, **extra)


def contribute(client, headers, swarm_id, title="Synthetic report"):
    view = client.post("/api/programs/omegaevolve/view", headers=headers, json={"swarm_id": swarm_id}).json()
    done = client.post("/api/programs/omegaevolve/act", headers=headers, json={
        "swarm_id": swarm_id, "action": "contribute", "items": ["objective"], "base_revision": view["revision"],
        "params": {"contribution": dict(contribution(), title=title)}, "idempotency_key": "c-" + title})
    assert done.status_code == 200 and done.json()["status"] == "done", done.text
    return done.json()["detail"]["record_id"]


def url(swarm_id, record_id, digest=None):
    return f"/api/evolve/swarms/{swarm_id}/records/{record_id}/figures" + (f"/{digest}" if digest else "")


@pytest.fixture()
def lab(client):
    """Ann owns a private swarm with one recorded report she contributed; Bob shares her swarm; Carol has her own."""
    ann, bob, carol = person(client, "u_fig_ann"), person(client, "u_fig_bob"), person(client, "u_fig_carol")
    swarm = client.post("/api/swarms", headers=ann, json={"name": "Ann's lab"}).json()
    client.put(f"/api/swarms/{swarm['id']}/visibility", headers=ann, json={"visibility": "shared", "shared_with": ["user:u_fig_bob"]})
    other = client.post("/api/swarms", headers=carol, json={"name": "Carol's lab"}).json()
    record = contribute(client, ann, swarm["id"])
    return {"ann": ann, "bob": bob, "carol": carol, "swarm": swarm["id"], "other": other["id"], "record": record}


# ---- the PNG check ---------------------------------------------------------------------------------

def test_png_size_reads_width_and_height():
    assert png_size(png(31, 17)) == (31, 17)


@pytest.mark.parametrize("data", [
    b"GIF89a" + b"\x00" * 64,                                           # another format renamed .png
    b"<svg xmlns='http://www.w3.org/2000/svg'/>",                       # markup renamed .png
    png()[:40],                                                          # truncated
    png()[:-4] + b"\x00\x00\x00\x00",                                    # IEND checksum broken
    png() + b"trailing",                                                 # bytes after the end
    png().replace(b"IDAT", b"IDAx"),                                     # checksum no longer matches its chunk
    b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 0, 4, 8, 2, 0, 0, 0)) + chunk(b"IDAT", b"x") + chunk(b"IEND", b""),
    b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 3, 2, 0, 0, 0)) + chunk(b"IDAT", b"x") + chunk(b"IEND", b""),
    b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0)) + chunk(b"IEND", b""),   # no image data
    png()[:-12] + chunk(b"IEND", b"payload"),                          # an end chunk that carries data
])
def test_png_size_refuses_what_is_not_a_whole_png(data):
    with pytest.raises(FigureError):
        png_size(data)


# ---- attaching ---------------------------------------------------------------------------------

def test_bad_magic_bad_hash_oversize_and_renamed_files_are_refused(client, lab):
    ann, target = lab["ann"], url(lab["swarm"], lab["record"])
    gif = b"GIF89a" + b"\x00" * 64
    r = client.post(target, headers=ann, json=figure(gif, source_locator="figures/cooperation.png"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "not_png", r.text
    good = png()
    r = client.post(target, headers=ann, json=dict(figure(good), sha256=sha(png(shade=1))))
    assert r.status_code == 400 and r.json()["error"]["code"] == "hash_mismatch", r.text
    r = client.post(target, headers=ann, json=dict(figure(good), sha256="ABC"))
    assert r.status_code == 400 and r.json()["error"]["code"] == "bad_hash", r.text
    big = png(extra=chunk(b"tEXt", b"k\x00" + b"x" * MAX_BYTES))
    r = client.post(target, headers=ann, json=figure(big))
    assert r.status_code == 413, r.text
    hive = client.app.state.hive
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figure_blobs")["n"] == 0
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figures")["n"] == 0


def test_exactly_four_mib_is_accepted(client, lab):
    base = png()
    pad = MAX_BYTES - len(base) - 12 - 2
    data = png(extra=chunk(b"tEXt", b"k\x00" + b"x" * pad))
    assert len(data) == MAX_BYTES
    r = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    assert r.status_code == 200, r.text


def test_attach_needs_a_report_and_its_contributor_or_an_admin(client, lab):
    data = png()
    assert client.post(url(lab["swarm"], "ev_missing"), headers=lab["ann"], json=figure(data)).status_code == 404
    r = client.post(url(lab["swarm"], lab["record"]), headers=lab["bob"], json=figure(data))
    assert r.status_code == 403 and r.json()["error"]["code"] == "not_contributor", r.text
    assert client.post(url(lab["swarm"], lab["record"]), headers=lab["carol"], json=figure(data)).status_code == 404
    assert client.post(url(lab["swarm"], lab["record"]), headers={"Authorization": ""}, json=figure(data)).status_code == 401
    # a report id from another swarm is not found under this swarm
    assert client.post(url(lab["other"], lab["record"]), headers=lab["carol"], json=figure(data)).status_code == 404
    assert client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data)).status_code == 200
    admin = client.post(url(lab["swarm"], lab["record"]), json=figure(png(shade=3), caption="Bounded streaming learning"))
    assert admin.status_code == 200, admin.text
    r = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=dict(figure(data), who="user:u_fig_bob"))
    assert r.status_code == 400


def test_caption_and_locator_are_bounded_plain_text(client, lab):
    target, data = url(lab["swarm"], lab["record"]), png()
    for bad in ({"caption": ""}, {"caption": "x" * 4001}, {"caption": "bell\x07"}, {"caption": 5},
                {"source_locator": "y" * 501}, {"source_locator": "a\x00b"}):
        r = client.post(target, headers=lab["ann"], json=dict(figure(data), **bad))
        assert r.status_code == 400, (bad, r.text)
    ok = client.post(target, headers=lab["ann"], json=figure(data, caption="Line one.\nLine two.", source_locator="archive/x.png"))
    assert ok.status_code == 200 and ok.json()["caption"] == "Line one.\nLine two." and ok.json()["source_locator"] == "archive/x.png"


def test_attaching_never_changes_the_report(client, lab):
    hive = client.app.state.hive
    before_row = hive.db.one("SELECT * FROM evolve_records WHERE id = ?", (lab["record"],))
    graph = client.post("/api/programs/omegaevolve/view", headers=lab["ann"], json={"swarm_id": lab["swarm"]}).json()
    before = next(i for i in graph["items"] if i["id"] == lab["record"])
    assert "figures" not in before
    r = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(png()))
    assert r.status_code == 200, r.text
    assert hive.db.one("SELECT * FROM evolve_records WHERE id = ?", (lab["record"],)) == before_row
    after_graph = client.post("/api/programs/omegaevolve/view", headers=lab["ann"], json={"swarm_id": lab["swarm"]}).json()
    after = next(i for i in after_graph["items"] if i["id"] == lab["record"])
    assert {k: v for k, v in after.items() if k != "figures"} == before
    meta = after["meta"]
    assert meta["state"] == "recorded-claim" and meta["adoption_authorized"] is False
    assert all(e["verified"] is False and e["custody"] == "unresolved" for e in meta["evidence"])
    assert after_graph["revision"] != graph["revision"]          # the view did change: it now lists a figure


def test_reports_list_their_figures_and_old_reports_stay_unchanged(client, lab):
    second = contribute(client, lab["ann"], lab["swarm"], title="Second synthetic report")
    graph = client.post("/api/programs/omegaevolve/view", headers=lab["ann"], json={"swarm_id": lab["swarm"]}).json()
    first, second_data = png(9, 5), png(4, 4, shade=9)
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(first, source_locator="figs/a.png"))
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(second_data, caption="Second"))
    after = client.post("/api/programs/omegaevolve/view", headers=lab["ann"], json={"swarm_id": lab["swarm"]}).json()
    item = next(i for i in after["items"] if i["id"] == lab["record"])
    assert item["figures"] == [
        {"sha256": sha(first), "mime": "image/png", "bytes": len(first), "width": 9, "height": 5,
         "caption": "Cooperation diagnostic (synthetic)", "source_locator": "figs/a.png",
         "read_url": url(lab["swarm"], lab["record"], sha(first))},
        {"sha256": sha(second_data), "mime": "image/png", "bytes": len(second_data), "width": 4, "height": 4,
         "caption": "Second", "read_url": url(lab["swarm"], lab["record"], sha(second_data))}]
    untouched = [i for i in after["items"] if i["id"] == second][0]
    assert untouched == next(i for i in graph["items"] if i["id"] == second)
    listed = client.get(url(lab["swarm"], lab["record"]), headers=lab["bob"]).json()
    assert listed["figures"] == item["figures"]


def test_a_hive_without_figures_keeps_its_view_revision(client, lab):
    """The view's revision pin is exactly the pre-figures one until a figure is attached."""
    from hive.core.evolve import EvolveRegistry
    from hive.core.evolve_preflight import digest
    from hive.core.evolve_seed import seed_plan
    graph = client.post("/api/programs/omegaevolve/view", headers=lab["ann"], json={"swarm_id": lab["swarm"]}).json()
    registry = EvolveRegistry(client.app.state.hive)
    assert graph["revision"] == digest({"research": registry.snapshot(lab["swarm"]), "seed_plan": seed_plan()})


def test_same_bytes_are_stored_once(client, lab):
    second = contribute(client, lab["ann"], lab["swarm"], title="Another")
    data = png()
    a = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    again = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    assert a.status_code == again.status_code == 200 and a.json() == again.json()
    # attach the stored figure to a second report by its hash alone
    b = client.post(url(lab["swarm"], second), headers=lab["ann"], json={"sha256": sha(data), "caption": "Reused"})
    assert b.status_code == 200, b.text
    hive = client.app.state.hive
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figure_blobs")["n"] == 1
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figures")["n"] == 2
    files = [p for p in (hive.settings.data_dir / "evolve_figures").rglob("*") if p.is_file()]
    assert [p.name for p in files] == [sha(data)]
    clash = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data, caption="Other words"))
    assert clash.status_code == 409
    unknown = client.post(url(lab["swarm"], second), headers=lab["ann"], json={"sha256": sha(png(shade=2)), "caption": "x"})
    assert unknown.status_code == 404 and unknown.json()["error"]["code"] == "figure_not_stored"

def stored_files(hive):
    return sorted(p.name for p in (hive.settings.data_dir / "evolve_figures").rglob("*") if p.is_file())


def test_a_hash_alone_never_copies_a_figure_the_caller_cannot_read(client, lab):
    hive, data = client.app.state.hive, png(shade=9)
    assert client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data)).status_code == 200
    # Carol contributes in her own swarm and cannot see Ann's: the hash alone gets the same answer as an unknown hash
    carols = contribute(client, lab["carol"], lab["other"], title="Carol's")
    r = client.post(url(lab["other"], carols), headers=lab["carol"], json={"sha256": sha(data), "caption": "Copied"})
    assert r.status_code == 404 and r.json()["error"]["code"] == "figure_not_stored", r.text
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figures WHERE swarm_id = ?", (lab["other"],))["n"] == 0
    assert client.get(url(lab["other"], carols, sha(data)), headers=lab["carol"]).status_code == 404
    # with the bytes themselves she may attach them: she already holds them
    assert client.post(url(lab["other"], carols), headers=lab["carol"], json=figure(data, caption="Mine")).status_code == 200
    # Bob, who can read Ann's report, may reuse it by hash on a report in his own swarm
    bobs_swarm = client.post("/api/swarms", headers=lab["bob"], json={"name": "Bob's lab"}).json()["id"]
    bobs = contribute(client, lab["bob"], bobs_swarm, title="Bob's")
    r = client.post(url(bobs_swarm, bobs), headers=lab["bob"], json={"sha256": sha(png(shade=9)), "caption": "Reused"})
    assert r.status_code == 200, r.text
    assert stored_files(hive) == [sha(data)]


def test_refused_uploads_leave_no_bytes_behind(client, lab, monkeypatch):
    hive, target = client.app.state.hive, url(lab["swarm"], lab["record"])
    first = png(shade=0)
    for shade in range(16):
        assert client.post(target, headers=lab["ann"], json=figure(png(shade=shade), caption=f"F{shade}")).status_code == 200
    kept = stored_files(hive)
    for shade in (100, 101, 102):                                  # a full report refuses new figures before writing
        r = client.post(target, headers=lab["ann"], json=figure(png(shade=shade)))
        assert r.status_code == 409 and r.json()["error"]["code"] == "too_many_figures", r.text
    assert stored_files(hive) == kept
    # the same attachment again, on the full report, returns the attachment it already has
    again = client.post(target, headers=lab["ann"], json=figure(first, caption="F0"))
    assert again.status_code == 200 and again.json()["sha256"] == sha(first), again.text
    # a store that fails part-way leaves neither a file nor a row
    second = contribute(client, lab["ann"], lab["swarm"], title="Second")

    def broken_put(digest, data):
        tmp = hive.evolve_figures.store._path(digest).with_suffix(".tmp")
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(data[:10])
        raise OSError("disk full")
    monkeypatch.setattr(hive.evolve_figures.store, "put", broken_put)
    with pytest.raises(OSError):
        hive.evolve_figures.attach(lab["swarm"], second, "user:u_fig_ann", lambda report: True, sha(png(shade=200)),
                                   "Lost", data=png(shade=200))
    assert stored_files(hive) == kept
    assert hive.db.one("SELECT 1 FROM evolve_figure_blobs WHERE sha256 = ?", (sha(png(shade=200)),)) is None
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figures WHERE record_id = ?", (second,))["n"] == 0

def test_a_failed_uploads_cleanup_never_deletes_bytes_a_concurrent_attach_committed(client, lab, monkeypatch):
    """Upload A fails and cleans up while upload B of the same bytes attaches to another report. B is held at the
    point between A's check and A's delete; B's committed bytes must survive."""
    import threading
    hive, figs = client.app.state.hive, client.app.state.hive.evolve_figures
    second = contribute(client, lab["ann"], lab["swarm"], title="Second")
    data = png(shade=77)
    real_put, real_delete = figs.store.put, figs.store.delete
    deleting, b_done = threading.Event(), threading.Event()
    calls = {"put": 0}

    def put(digest, blob):
        calls["put"] += 1
        if calls["put"] == 1:
            raise OSError("disk full")                 # A's write fails: its rows roll back and it cleans up
        return real_put(digest, blob)

    def delete(digest):
        deleting.set()                                 # A has decided to delete: let B run now
        b_done.wait(1.0)                               # B finishes here only if cleanup does not hold the lock
        return real_delete(digest)

    monkeypatch.setattr(figs.store, "put", put)
    monkeypatch.setattr(figs.store, "delete", delete)
    out = {}

    def attach_b():
        deleting.wait(5)
        out["b"] = figs.attach(lab["swarm"], second, "user:u_fig_ann", lambda report: True, sha(data), "B", data=data)
        b_done.set()

    b = threading.Thread(target=attach_b)
    b.start()
    with pytest.raises(OSError):
        figs.attach(lab["swarm"], lab["record"], "user:u_fig_ann", lambda report: True, sha(data), "A", data=data)
    b.join(10)
    assert out["b"]["sha256"] == sha(data)
    assert figs.read(lab["swarm"], second, sha(data)) == data          # B's bytes are still there
    assert hive.db.one("SELECT count(*) AS n FROM evolve_figures WHERE sha256 = ?", (sha(data),))["n"] == 1


def test_a_closed_app_refuses_attach_as_not_found(client, lab):
    hive = client.app.state.hive
    hive.programs.disabled.add("omegaevolve")
    try:
        r = client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(png()))
        assert r.status_code == 404, r.text
    finally:
        hive.programs.disabled.discard("omegaevolve")


# ---- reading ---------------------------------------------------------------------------------------

def test_visibility_matrix_follows_the_report(client, lab):
    data = png()
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    read = url(lab["swarm"], lab["record"], sha(data))
    for who, status in ((lab["ann"], 200), (lab["bob"], 200), ({}, 200),        # owner, same swarm, admin (operator)
                        (lab["carol"], 404), ({"Authorization": ""}, 401)):     # other swarm, signed out
        r = client.get(read, headers=who)
        assert r.status_code == status, (who, r.text)
        if status == 200:
            assert r.content == data
        else:
            assert r.content != data
        listed = client.get(url(lab["swarm"], lab["record"]), headers=who)
        assert listed.status_code == status
        view = client.post("/api/programs/omegaevolve/view", headers=who, json={"swarm_id": lab["swarm"]})
        assert view.status_code == status                                       # exactly the report's own gate
    # the figure is reachable only through a report it is attached to
    other_record = contribute(client, lab["carol"], lab["other"], title="Carol's report")
    assert client.get(url(lab["other"], other_record, sha(data)), headers=lab["carol"]).status_code == 404
    assert client.get(url(lab["swarm"], "ev_missing", sha(data)), headers=lab["ann"]).status_code == 404
    assert client.get(f"/api/assets/{sha(data)}", headers=lab["ann"]).status_code == 404   # not a generic asset
    # Bob loses the share: he loses the figure with the report
    client.put(f"/api/swarms/{lab['swarm']}/visibility", headers=lab["ann"], json={"visibility": "private"})
    assert client.get(read, headers=lab["bob"]).status_code == 404
    # the app closed: no report view, no figure
    hive = client.app.state.hive
    hive.programs.disabled.add("omegaevolve")
    try:
        assert client.get(read, headers=lab["ann"]).status_code == 404
    finally:
        hive.programs.disabled.discard("omegaevolve")


def test_read_headers(client, lab):
    data = png()
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    r = client.get(url(lab["swarm"], lab["record"], sha(data)), headers=lab["bob"], follow_redirects=False)
    assert r.status_code == 200
    h = r.headers
    assert h["content-type"] == "image/png"
    assert h["x-content-type-options"] == "nosniff"
    assert "default-src 'none'" in h["content-security-policy"] and "sandbox" in h["content-security-policy"]
    assert h["cache-control"] == "private, no-store"
    assert h["etag"] == f'"{sha(data)}"'
    assert "location" not in h
    again = client.get(url(lab["swarm"], lab["record"], sha(data)), headers=dict(lab["bob"], **{"If-None-Match": h["etag"]}))
    assert again.status_code == 304 and again.content == b""
    assert again.headers["cache-control"] == "private, no-store" and again.headers["etag"] == h["etag"]
    assert client.get(url(lab["swarm"], lab["record"], sha(data)), headers=dict(lab["carol"], **{"If-None-Match": h["etag"]})).status_code == 404


def test_a_corrupted_stored_copy_is_never_served(client, lab):
    data = png()
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    store = client.app.state.hive.evolve_figures.store
    store._path(sha(data)).write_bytes(png(shade=200))
    r = client.get(url(lab["swarm"], lab["record"], sha(data)), headers=lab["ann"])
    assert r.status_code == 500 and r.content != data


def test_loader_attaches_a_file_through_the_route(client, lab, tmp_path):
    from hive.tools.evolve_figures_load import attach_file
    path = tmp_path / "synthetic.png"
    data = png(12, 7)
    path.write_bytes(data)
    out = attach_file(client, lab["swarm"], lab["record"], path, "Synthetic caption", "archive/synthetic.png",
                      expect_sha256=sha(data), headers=lab["ann"])
    assert out["sha256"] == sha(data) and out["width"] == 12 and out["height"] == 7
    with pytest.raises(SystemExit):
        attach_file(client, lab["swarm"], lab["record"], path, "x", None, expect_sha256="0" * 64, headers=lab["ann"])


def test_wire_shape_is_json_serialisable(client, lab):
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(png()))
    json.dumps(client.get(url(lab["swarm"], lab["record"]), headers=lab["ann"]).json())


def test_the_revalidation_path_rechecks_the_gate(client, lab):
    """A browser holding the ETag asks again every time (no-store); after the share is withdrawn or the app closes,
    that conditional request is refused 404, never 304."""
    data = png()
    client.post(url(lab["swarm"], lab["record"]), headers=lab["ann"], json=figure(data))
    read = url(lab["swarm"], lab["record"], sha(data))
    etag = client.get(read, headers=lab["bob"]).headers["etag"]
    assert client.get(read, headers=dict(lab["bob"], **{"If-None-Match": etag})).status_code == 304
    hive = client.app.state.hive
    hive.programs.disabled.add("omegaevolve")
    try:
        closed = client.get(read, headers=dict(lab["ann"], **{"If-None-Match": etag}))
        assert closed.status_code == 404 and "etag" not in closed.headers
    finally:
        hive.programs.disabled.discard("omegaevolve")
    assert client.get(read, headers=dict(lab["ann"], **{"If-None-Match": etag})).status_code == 304
    client.put(f"/api/swarms/{lab['swarm']}/visibility", headers=lab["ann"], json={"visibility": "private"})
    revoked = client.get(read, headers=dict(lab["bob"], **{"If-None-Match": etag}))
    assert revoked.status_code == 404 and "etag" not in revoked.headers
    assert client.get(read, headers=dict(lab["bob"], **{"If-None-Match": etag, "Authorization": ""})).status_code == 401
