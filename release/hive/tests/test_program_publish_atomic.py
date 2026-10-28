"""ProgramContext.publish: asset metadata, artifact and revision commit together or not at all (Design diagnostic
2026-10-05; the accepted 2026-10-04 repair). Content-addressed bytes may remain; no metadata row is left behind."""
import threading

import pytest

from hive.core.programs import ProgramContext
from hive.tests.test_core_api import client, make_swarm_and_agents  # noqa: F401  (fixture)


def _ctx(client):
    s, (a, _b) = make_swarm_and_agents(client)
    hive = client.app.state.hive
    ctx = ProgramContext(hive, s["id"], {"id": "publisher", "capabilities": ["artifacts:write"]})
    ctx.actor = {"kind": "mind", "id": a["id"]}
    return hive, ctx


def _counts(hive):
    return tuple(hive.db.one(f"SELECT COUNT(*) AS n FROM {t}")["n"] for t in ("assets", "artifacts", "artifact_revisions"))


def test_a_failed_revision_leaves_no_asset_artifact_or_revision_metadata(client, monkeypatch):
    hive, ctx = _ctx(client)
    before = _counts(hive)
    def boom(*a, **k):
        raise RuntimeError("revision write failed")
    monkeypatch.setattr(hive.collab, "add_revision", boom)
    with pytest.raises(RuntimeError):
        ctx.publish("deck", "Synthetic deck", "synthetic body", assets=[{"data": b"synthetic-bytes", "mime": "image/png", "name": "a.png"}])
    assert _counts(hive) == before


def test_a_successful_publication_records_all_three(client):
    hive, ctx = _ctx(client)
    before = _counts(hive)
    out = ctx.publish("deck", "Synthetic deck", "synthetic body", assets=[{"data": b"synthetic-bytes-2", "mime": "image/png", "name": "b.png"}])
    assert out["revision"] == 1 and len(out["assets"]) == 1
    assert _counts(hive) == (before[0] + 1, before[1] + 1, before[2] + 1)


class _Remote:
    kind = "s3"
    def __init__(self, on_delete=None):
        self.data, self.deleted, self.on_delete = {}, [], on_delete

    @staticmethod
    def failing():
        raise OSError("synthetic remote unavailable")
    def put(self, digest, data):
        self.data[digest] = data
    def get(self, digest):
        return self.data.get(digest)
    def delete(self, digest):
        if self.on_delete:
            self.on_delete()
        self.deleted.append(digest)
        self.data.pop(digest, None)


def _db_lock_free(hive):
    """True if another thread can take the connection lock now (the caller's thread may not hold it)."""
    got = []
    def probe():
        got.append(hive.db._lock.acquire(timeout=0.5))
        if got[0]:
            hive.db._lock.release()
    t = threading.Thread(target=probe)
    t.start(); t.join()
    return got[0]


def test_publication_takes_placement_before_the_database_like_every_asset_write(client, monkeypatch):
    """OmegaReview B1: an asset writer holds placement; a publication waits for it without holding the database."""
    hive, ctx = _ctx(client)
    lock, original = hive.assets._placement, hive.assets._put
    held, publisher_waits, seen, errors = threading.Event(), threading.Event(), {}, []
    class Watched:
        def __enter__(self):
            if threading.current_thread().name == "publication":
                publisher_waits.set()
            if not lock.acquire(timeout=5):
                raise TimeoutError("placement not released")
        def __exit__(self, *a):
            lock.release()
    def paused_put(*a, **kw):
        if threading.current_thread().name == "asset-writer":
            held.set(); assert publisher_waits.wait(5)
            seen["db_free"] = _db_lock_free(hive)
        return original(*a, **kw)
    monkeypatch.setattr(hive.assets, "_placement", Watched()); monkeypatch.setattr(hive.assets, "_put", paused_put)
    def run(name, f):
        def go():
            try:
                f()
            except BaseException as e:
                errors.append(e)
        return threading.Thread(name=name, target=go, daemon=True)
    a = run("asset-writer", lambda: hive.assets.put(b"synthetic-other", "text/plain", "user:synthetic", ctx.swarm_id))
    b = run("publication", lambda: ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-published"}]))
    a.start(); assert held.wait(5); b.start(); a.join(10); b.join(10)
    assert not a.is_alive() and not b.is_alive() and not errors, repr(errors)
    assert seen["db_free"] is True


def _remote_placed(hive, ctx, remote, data, name="remote"):
    hive.assets.stores[name] = remote
    row = hive.assets.put(data, "image/png", "user:synthetic", ctx.swarm_id, "r.png", store=name)
    assert name in row["placements"] and not row["local_only"]
    return row["sha256"]


def _revisions(hive):
    return hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions")["n"]


def test_a_publication_that_tightens_a_remote_asset_deletes_the_remote_copy_only_after_commit(client):
    hive, ctx = _ctx(client)
    state = {}
    def on_delete():
        state["in_transaction"] = hive.db._conn.in_transaction
        state["db_free"] = _db_lock_free(hive)
        state["row"] = hive.db.one("SELECT local_only, placements FROM assets WHERE sha256 = ?", (digest,))
        state["revisions"] = hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions")["n"]
    remote = _Remote(on_delete)
    digest = _remote_placed(hive, ctx, remote, b"synthetic-remote")
    before = hive.db.one("SELECT COUNT(*) AS n FROM artifact_revisions")["n"]
    ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-remote"}])
    assert remote.deleted == [digest] and digest not in remote.data
    assert state["in_transaction"] is False and state["db_free"] is True
    assert state["row"]["local_only"] == 1 and state["row"]["placements"] == '["local", "remote"]' and state["revisions"] == before + 1
    row = hive.assets.view(hive.assets.row(digest))
    assert row["placements"] == ["local"] and row["pending_removal"] == [] and row["history"][-1]["removed"] == ["remote"]


def test_a_rolled_back_publication_never_deletes_the_remote_copy(client, monkeypatch):
    hive, ctx = _ctx(client)
    remote = _Remote()
    digest = _remote_placed(hive, ctx, remote, b"synthetic-remote-2")
    def boom(*a, **k):
        raise RuntimeError("revision write failed")
    monkeypatch.setattr(hive.collab, "add_revision", boom)
    with pytest.raises(RuntimeError):
        ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-remote-2"}])
    assert remote.deleted == [] and digest in remote.data
    row = hive.assets.view(hive.assets.row(digest))
    assert row["placements"] == ["remote"] and not row["local_only"]


def test_a_failed_remote_delete_stays_recorded_and_pending(client):
    """OmegaReview B2: the publication commits, but a copy whose delete failed is never claimed removed."""
    hive, ctx = _ctx(client)
    remote = _Remote(_Remote.failing)
    digest = _remote_placed(hive, ctx, remote, b"synthetic-cleanup-failure")
    ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-cleanup-failure"}])
    row = hive.assets.view(hive.assets.row(digest))
    assert digest in remote.data and remote.deleted == []
    assert row["local_only"] and row["placements"] == ["local", "remote"] and row["pending_removal"] == ["remote"]
    assert row["history"][-1]["event"] == "local_only_cleanup" and row["history"][-1]["removed"] == []
    assert "remote" in row["history"][-1]["failed"]
    with pytest.raises(Exception) as refused:   # still no new remote copy
        hive.assets.put(b"synthetic-cleanup-failure", "image/png", "user:synthetic", ctx.swarm_id, store="remote")
    assert getattr(refused.value, "code", "") == "local_only"


def test_process_loss_after_commit_leaves_a_pending_cleanup_that_a_retry_completes(client, monkeypatch):
    hive, ctx = _ctx(client)
    remote = _Remote()
    digest = _remote_placed(hive, ctx, remote, b"synthetic-process-loss")
    with monkeypatch.context() as m:   # the process dies after the commit, before any after-commit callback runs
        m.setattr(hive.db, "after_commit", lambda fn: None)
        ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-process-loss"}])
    revisions = _revisions(hive)
    row = hive.assets.view(hive.assets.row(digest))
    assert row["local_only"] and row["pending_removal"] == ["remote"] and digest in remote.data
    done = client.post(f"/api/assets/{digest}/cleanup")   # the owner's bounded retry
    assert done.status_code == 200, done.text
    assert done.json()["placements"] == ["local"] and done.json()["pending_removal"] == [] and remote.deleted == [digest]
    assert _revisions(hive) == revisions


def test_a_later_put_retries_a_failed_cleanup_without_a_new_revision(client):
    hive, ctx = _ctx(client)
    remote = _Remote(_Remote.failing)
    digest = _remote_placed(hive, ctx, remote, b"synthetic-retry")
    ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-retry"}])
    revisions = _revisions(hive)
    assert hive.assets.view(hive.assets.row(digest))["pending_removal"] == ["remote"]
    remote.on_delete = None   # the remote store is back
    row = hive.assets.put(b"synthetic-retry", "image/png", "user:synthetic", ctx.swarm_id)
    assert row["placements"] == ["local"] and row["pending_removal"] == [] and digest not in remote.data
    assert row["history"][-1]["removed"] == ["remote"] and _revisions(hive) == revisions


def test_mixed_cleanup_removes_what_it_can_and_keeps_the_rest_pending(client):
    hive, ctx = _ctx(client)
    good, bad = _Remote(), _Remote(_Remote.failing)
    digest = _remote_placed(hive, ctx, good, b"synthetic-mixed", "good")
    _remote_placed(hive, ctx, bad, b"synthetic-mixed", "bad")
    ctx.publish("deck", "Synthetic", "body", assets=[{"data": b"synthetic-mixed"}])
    row = hive.assets.view(hive.assets.row(digest))
    assert good.deleted == [digest] and digest in bad.data
    assert row["placements"] == ["bad", "local"] and row["pending_removal"] == ["bad"]
    assert row["history"][-1]["removed"] == ["good"] and list(row["history"][-1]["failed"]) == ["bad"]
    bad.on_delete = None
    row = hive.assets.cleanup(digest, "user:synthetic")
    assert row["placements"] == ["local"] and row["pending_removal"] == [] and digest not in bad.data
