"""P12/P13's closed public data shapes. No consent or navigation authority.

The loader validates related_apps before importing an app. A caller's declaration
is release metadata, never evidence that a target is installed or ready. Child
classification, trusted activation, setup and entry remain host responsibilities.
"""

import re
import contextlib
import copy
import json
import threading
import time
import uuid


PROGRAM_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,40}")
LINK_STATES = frozenset({"ready", "declined", "refused", "needs_grown_up"})
LINK_REASONS = frozenset({"not_available", "not_ready", "rate_limited", "depth", "not_related", "busy"})
MAX_HOST_RECORDS = 512  # bounded live metadata, not an additional P13 call quota


def parse_related_apps(value):
    """A release-reviewed list of at most eight program identifiers.

    Missing declarations retain existing apps' behaviour. Self references are not
    forbidden here: P12 forbids self-setup, while P13 has no self-open ban.
    """
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError("related_apps must be a list of at most 8 program ids")
    if any(not isinstance(item, str) or not PROGRAM_ID.fullmatch(item) for item in value):
        raise ValueError("related_apps entries must be program ids")
    if len(set(value)) != len(value):
        raise ValueError("related_apps entries must be unique")
    return list(value)


def link_result(state, reason=None):
    """Construct state-only output; backend details and target contents never pass.

    This deliberately takes no backend-result dictionary, so extra fields cannot
    accidentally be forwarded. It does not run a setup or establish readiness.
    """
    if not isinstance(state, str) or state not in LINK_STATES:
        raise ValueError("invalid app-link state")
    if reason is not None and (state != "refused" or not isinstance(reason, str) or reason not in LINK_REASONS):
        raise ValueError("invalid app-link refusal reason")
    return {"state": state, **({"reason": reason} if reason is not None else {})}


def contains_untrusted_intent(value):
    """The structured view-only field never enters act/rule parameters."""
    pending, seen = [value], set()
    while pending:
        item = pending.pop()
        if not isinstance(item, (dict, list, tuple)) or id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, dict):
            if "untrusted_intent" in item:
                return True
            pending.extend(item.values())
        else:
            pending.extend(item)
    return False


class AppLinks:
    """Authenticated host orchestration, never a frame SDK or activation lease.

    Host frame/review/entry ids stay in the parent. Public frames receive state
    only. The one process-wide guard serializes redemption across workspaces and
    windows; P2's program/person locks and the DB transaction protect live setup
    bindings. No await occurs under these locks. Raw P1 guards never acquire this
    guard (DB -> guard would invert the admission order). Target Ask revocation
    and helper withdrawal take this guard before their canonical operation, then
    program/person/mind locks and the DB gate. Other raw fences remain lock-free.
    """
    def __init__(self, hive, clock=time.monotonic):
        self.hive, self.clock = hive, clock
        self.guard = threading.RLock()
        self.frames, self.reviews, self.entries, self.first_sessions = {}, {}, {}, {}
        self.sessions_fenced, self.signins_fenced, self.person_epochs, self.limit_epochs, self.app_epochs, self.program_epochs = set(), set(), {}, {}, {}, {}

    def _err(self):
        return self.hive.error(409, "not_available", "This app request is unavailable.")

    def _sweep(self):
        """Under guard; retain active bindings, discard dead control metadata."""
        for rid, review in tuple(self.reviews.items()):
            if review["settled"] or review["until"] <= self.clock() or not review["frame"]["active"]:
                if review["frame"]["pending"] == rid:
                    review["frame"]["pending"] = None
                self.reviews.pop(rid, None)
        # At most512 live entries: resolve their sessions once under the guard,
        # without a separate DB query for each retained presentation record.
        session_ids = sorted({entry["session"] for entry in self.entries.values()})
        sessions = {row["token_hash"]: row for row in self.hive.db.all(
            "SELECT token_hash, expires_at FROM sessions WHERE token_hash IN (" + ",".join("?" for _ in session_ids) + ")",
            tuple(session_ids))} if session_ids else {}
        wall_now = self.hive.app_ask.wall_clock() if session_ids else 0
        for eid, entry in tuple(self.entries.items()):
            session = sessions.get(entry["session"])
            if not session or session["expires_at"] is not None and session["expires_at"] <= wall_now or entry["session"] in self.sessions_fenced or entry["signin"] in self.signins_fenced or entry["person_epoch"] != self.person_epochs.get(entry["principal"], 0):
                entry["fenced"], entry["presentation_open"] = True, False
            if entry["fenced"] or not entry["used"] and entry["until"] <= self.clock():
                if not entry["presentation_open"]:
                    self.entries.pop(eid, None)
                if self.first_sessions.get(entry["consent_id"]) is entry:
                    self.first_sessions.pop(entry["consent_id"], None)
        retained = {e["source_frame"] for e in self.entries.values()} | {e["target_frame"] for e in self.entries.values()}
        for fid, frame in tuple(self.frames.items()):
            if not frame["active"] and fid not in retained and frame["pending"] is None:
                self.frames.pop(fid, None)

    def mark_session(self, session):
        self.sessions_fenced.add(session)

    def mark_signin(self, signin):
        self.signins_fenced.add(signin)

    def fence_person(self, principal):
        self.person_epochs[principal] = object()

    def revoke_app(self, principal, app):
        key = (principal, app)
        self.app_epochs[key] = object()

    def revoke_program(self, app):
        self.program_epochs[app] = object()

    def limits_changed(self, principal):
        self.limit_epochs[principal] = object()

    def _person(self, viewer, session):
        row = self.hive.app_ask._person(viewer, session)
        if session in self.sessions_fenced or row.get("signin_hash") in self.signins_fenced:
            raise self._err()
        p = self.hive.db.one("SELECT profile_kind FROM people WHERE id = ?", (viewer.principal[5:],))
        profile = p.get("profile_kind") if p else None
        if profile not in (None, "child", "adult"):
            raise self._err() # invalid host schema, not an inferred age category
        return row, profile

    def frame(self, viewer, session, app, data):
        if set(data) - {"swarm_id", "frame_slot_id", "entry_id"} or not isinstance(data.get("frame_slot_id"), str) \
                or not re.fullmatch(r"[\w.:-]{1,120}", data["frame_slot_id"]) or not isinstance(data.get("swarm_id"), str):
            raise self._err()
        with self.guard:
            self._sweep()
            if len(self.frames) >= MAX_HOST_RECORDS:
                raise self._err()
            person, _ = self._person(viewer, session)
            release = self.hive.programs.link_manifest(app)
            self.hive.visibility.check_path(viewer, {"swarm_id": data["swarm_id"]})
            origin = data.get("entry_id")
            if origin is not None:
                entry = self.entries.get(origin)
                if not entry or entry["principal"] != viewer.principal or entry["session"] != session \
                        or entry["target"] != app or entry["swarm"] != data["swarm_id"] or entry["fenced"] or entry["used"]:
                    raise self._err()
                self._entry_current(entry, viewer, session)
            # A slot cannot be re-registered to revive a closed document.
            if any(f["session"] == session and f["slot"] == data["frame_slot_id"] for f in self.frames.values()):
                raise self._err()
            fid = str(uuid.uuid4())
            self.frames[fid] = {"id": fid, "principal": viewer.principal, "session": session,
                "signin": person.get("signin_hash"), "person_epoch": self.person_epochs.get(viewer.principal, 0),
                "app": app, "digest": release["release_digest"], "swarm": data["swarm_id"],
                "slot": data["frame_slot_id"], "app_epoch": self.app_epochs.get((viewer.principal, app), 0), "program_epoch": self.program_epochs.get(app, 0), "active": True, "pending": None, "calls": [],
                "handoff": None, "origin": origin}
            if origin is not None:
                self.entries[origin]["target_frame"] = fid
            return {"frame_id": fid}

    def _frame(self, viewer, session, app, fid):
        f = self.frames.get(fid)
        person, profile = self._person(viewer, session)
        if not f or not f["active"] or (f["principal"], f["session"], f["app"]) != (viewer.principal, session, app) \
                or f["signin"] != person.get("signin_hash") \
                or f["person_epoch"] != self.person_epochs.get(viewer.principal, 0) \
                or f["app_epoch"] != self.app_epochs.get((viewer.principal, app), 0) \
                or f["program_epoch"] != self.program_epochs.get(app, 0) \
                or self.hive.programs.link_manifest(app)["release_digest"] != f["digest"]:
            raise self._err()
        self.hive.visibility.check_path(viewer, {"swarm_id": f["swarm"]})
        return f, profile

    def close(self, viewer, session, app, fid, handoff=None):
        with self.guard:
            f = self.frames.get(fid)
            if not f or (f["principal"], f["session"], f["app"]) != (viewer.principal, session, app):
                raise self._err()
            permitted = self.entries.get(handoff) if isinstance(handoff, str) else None
            if permitted and (permitted["source_frame"] != fid or permitted["fenced"] or not permitted["used"] and self.clock() >= permitted["until"]):
                permitted = None
            f["active"], f["handoff"] = False, handoff if permitted else None
            if f["pending"] in self.reviews:
                self.reviews[f["pending"]]["settled"] = link_result("declined")
            for entry in self.entries.values():
                if entry["source_frame"] == fid and entry is not permitted or entry.get("target_frame") == fid:
                    entry["fenced"] = True
            return {"closed": True}

    def _target(self, principal, target):
        release = self.hive.programs.link_manifest(target)
        templates = release["swarm_templates"]
        if len(templates) != 1 or "person_swarm" not in release["capabilities"]:
            raise self._err()
        tid, template = next(iter(templates.items()))
        card = self.hive.person_swarms.card(principal, target, tid)
        if card["template_digest"] != template["digest"] or card["minds"] != template["minds"] or card["rules"] != template["rules"]:
            raise self._err()
        if (card["consent_revision"] or {}).get("withdrawn_at"):
            raise self._err()  # P12 cannot restore a tombstone through another app
        return release, tid, card

    def _ready(self, principal, target, tid, card):
        p2 = self.hive.person_swarms
        _, template = p2.template(target, tid)
        if p2._live_consent(principal, target, tid, template) is None:
            return None
        home = self.hive.db.one("SELECT swarm_id FROM app_person_swarms WHERE principal = ? AND program_id = ? AND template_id = ?",
                                (principal, target, tid))
        minds = self.hive.db.all("SELECT agent_id, finished FROM app_person_minds WHERE principal = ? AND program_id = ? AND template_id = ?",
                                (principal, target, tid))
        if not home or len(minds) != len(card["minds"]) or any(not m["finished"] or p2.current(m["agent_id"])[1] for m in minds):
            return None
        return home["swarm_id"]

    def _cost(self, card):
        lines = []
        for model in sorted({m["model"] for m in card["minds"]}):
            provider_id, _, name = model.partition("/")
            provider = self.hive.settings.providers.get(provider_id)
            if provider and (provider.local or provider_id == "mock"):
                lines.append(f"{model}: local model; no provider token charge")
            elif provider and provider.priced(name):
                incoming, outgoing = provider.price(name)
                lines.append(f"{model}: ${incoming:g} input / ${outgoing:g} output per million tokens")
            else:
                lines.append(f"{model}: host price guide has no price; charges are not estimated")
        return lines

    def prepare(self, viewer, session, app, fid, data):
        if set(data) != {"type", "app"} or data["type"] not in ("app-setup", "app-open") \
                or not isinstance(data["app"], str) or not PROGRAM_ID.fullmatch(data["app"]):
            return {"result": link_result("refused", "not_available")}
        with self.guard:
            f, profile = self._frame(viewer, session, app, fid)
            caller = self.hive.programs.link_manifest(app)
            # This comparison precedes every target lookup: undeclared ids have
            # precisely the same answer whether installed, ready, or absent.
            if data["app"] not in caller["related_apps"]:
                return {"result": link_result("refused", "not_related")}
            if profile == "child":
                return {"result": link_result("needs_grown_up"), "notice": "A grown-up needs to do this bit"}
            if data["type"] == "app-setup":
                f["calls"] = [at for at in f["calls"] if at > self.clock() - 60]
                if len(f["calls"]) >= 3:
                    return {"result": link_result("refused", "rate_limited")}
                f["calls"].append(self.clock())
            old = self.reviews.get(f["pending"])
            if old and not old["settled"]:
                if not self._review_current(old):
                    old["settled"] = link_result("declined")
                    return {"result": link_result("declined")}
                if (old["kind"], old["target"]) == (data["type"], data["app"]):
                    return {"review": copy.deepcopy(old["public"])}
                return {"result": link_result("refused", "busy")}
            if data["type"] == "app-setup" and app == data["app"]:
                return {"result": link_result("refused", "not_available")}
            return self._prepare(viewer, session, f, caller["name"], data["app"], data["type"])

    def _prepare(self, viewer, session, f, caller_name, target, kind):
        failure = "not_ready" if kind == "app-open" else "not_available"
        try:
            self._sweep()
            if len(self.reviews) >= MAX_HOST_RECORDS:
                raise self._err()
            release, tid, card = self._target(viewer.principal, target)
            swarm = self._ready(viewer.principal, target, tid, card)
            if kind == "app-open" and not swarm:
                return {"result": link_result("refused", "not_ready"), "notice": "This app is not ready for you yet."}
            target_app_epoch = self.app_epochs.get((viewer.principal, target), 0)
            ask = self.hive.app_ask.card(viewer, session, target)
            rid = str(uuid.uuid4())
            revision = self.hive.person_swarms._consent_stamp(viewer.principal, target, tid) if kind == "app-setup" else None
            public = {"id": rid, "kind": kind, "caller_name": caller_name, "target_name": release["name"],
                "target": target, "release_digest": release["release_digest"], "version": release["version"],
                "template": card, "approved_revision": revision, "price_guide": self._cost(card) if card else [],
                "session_permission": ask["permission"], "related_apps": release["related_apps"]}
            record = {"id": rid, "frame": f, "target": target, "kind": kind, "template": tid, "card": card,
                "release": release, "ask": ask, "revision": revision, "swarm": swarm, "until": self.clock() + 120,
                "settled": None, "public": public, "limits_epoch": self.limit_epochs.get(viewer.principal, 0),
                "target_app_epoch": target_app_epoch}
            self.reviews[rid], f["pending"] = record, rid
            return {"review": copy.deepcopy(public)}
        except Exception:
            # Only the parent sees this until it has shown its own dismissible
            # notice. No backend error text or readiness is sent to the frame.
            return {"result": link_result("refused", failure), "notice": "This app is unavailable."}

    @staticmethod
    def _release_semantics(release):
        fields = ("id", "name", "release_digest", "version", "related_apps", "capabilities", "swarm_templates")
        if not isinstance(release, dict) or not set(fields) <= set(release):
            raise ValueError("invalid release semantic fields")
        if any(not isinstance(release[key], str) for key in ("id", "name", "release_digest", "version")) \
                or any(not isinstance(release[key], list) or any(not isinstance(value, str) for value in release[key])
                       for key in ("related_apps", "capabilities")) or not isinstance(release["swarm_templates"], dict):
            raise ValueError("invalid release semantic values")
        return {key: release[key] for key in fields}

    @staticmethod
    def _p2_card_semantics(card):
        # Keep all five operative grant fields and the identity/display meaning.
        # consent_current is known advisory metadata, never authority/freshness.
        # Nonprojected Root metadata (including future nonces) is not authority.
        fields = ("program_id", "program_name", "template_id",
            "template_digest", "key_id", "providers", "month_usd", "spend_note",
            "consent_revision", "authority_revision", "minds", "rules")
        if not isinstance(card, dict) or not set(fields) <= set(card):
            raise ValueError("invalid P2 card semantic fields")
        if any(not isinstance(card[key], str) for key in ("program_id", "program_name", "template_id", "template_digest", "spend_note")) \
                or any(card[key] is not None and not isinstance(card[key], str) for key in ("key_id", "authority_revision")) \
                or not isinstance(card["providers"], list) or any(not isinstance(value, str) for value in card["providers"]) \
                or card["month_usd"] is not None and (type(card["month_usd"]) not in (int, float) or not 0 <= card["month_usd"] < float("inf")) \
                or card["consent_revision"] is not None and not isinstance(card["consent_revision"], dict) \
                or any(not isinstance(card[key], list) or any(not isinstance(value, dict) for value in card[key]) for key in ("minds", "rules")):
            raise ValueError("invalid P2 card semantic values")
        return {key: card[key] for key in fields}

    def _review_current(self, record):
        f = record["frame"]
        if f["app_epoch"] != self.app_epochs.get((f["principal"], f["app"]), 0) or f["program_epoch"] != self.program_epochs.get(f["app"], 0):
            return False
        if not f["active"] or record["until"] <= self.clock() or f["person_epoch"] != self.person_epochs.get(f["principal"], 0) or record["limits_epoch"] != self.limit_epochs.get(f["principal"], 0):
            return False
        # A revoke can happen before there is any Ask consent row to advance.
        # Retain that explicit target revocation boundary as well as its DB stamp.
        if record["target_app_epoch"] != self.app_epochs.get((f["principal"], record["target"]), 0):
            return False
        try:
            viewer = type("LinkViewer", (), {"principal": f["principal"]})()
            _, profile = self._person(viewer, f["session"])
            if profile == "child" or self.hive.programs.link_manifest(f["app"])["release_digest"] != f["digest"]:
                return False
            release = self.hive.programs.link_manifest(record["target"])
            if self._release_semantics(release) != self._release_semantics(record["release"]):
                return False
            # Read revision metadata directly: polling a pending review must
            # not mint new host cards or silently bind it to another document's grant.
            shown = record["ask"]
            if shown["release_digest"] != release["release_digest"]:
                return False
            observed = self.hive.app_ask.card_metadata(viewer, f["session"], record["target"])
            if self.hive.app_ask.card_semantics(observed) != self.hive.app_ask.card_semantics(shown):
                return False
            card_current = record["card"] is None or self._p2_card_semantics(
                self.hive.person_swarms.card(f["principal"], record["target"], record["template"])) == self._p2_card_semantics(record["card"])
            return card_current and record["target_app_epoch"] == self.app_epochs.get((f["principal"], record["target"]), 0)
        except Exception:
            return False

    def review(self, viewer, session, app, fid, rid):
        with self.guard:
            self._frame(viewer, session, app, fid)
            r = self.reviews.get(rid)
            if not r or r["frame"]["id"] != fid:
                return {"result": link_result("declined")}
            if not r["settled"] and not self._review_current(r):
                r["settled"] = link_result("declined")
            return {"result": r["settled"]} if r["settled"] else {"review": copy.deepcopy(r["public"])}

    def decide(self, viewer, session, app, fid, rid, data):
        if set(data) != {"approve", "open_now"} or type(data["approve"]) is not bool or type(data["open_now"]) is not bool:
            raise self._err()
        try:
            with self.guard:
                self._frame(viewer, session, app, fid)
                r = self.reviews.get(rid)
                if not r or r["frame"]["id"] != fid or r["settled"]:
                    return {"result": link_result("declined")}
                if not data["approve"] or not self._review_current(r):
                    r["settled"] = link_result("declined")
                    return {"result": r["settled"]}
                p2 = self.hive.person_swarms
                gate = contextlib.ExitStack()
                with gate:
                    if r["template"] is not None:
                        gate.enter_context(p2._program_lock(r["target"]))
                        gate.enter_context(p2._lock(viewer.principal, r["target"]))
                    if not self._review_current(r):
                        r["settled"] = link_result("declined")
                        return {"result": r["settled"]}
                    try:
                        if r["kind"] == "app-setup":
                            p2.consent(viewer.principal, r["target"], r["template"], r["card"], grant_revision=r["revision"])
                            ensured = p2.ensure(viewer.principal, r["target"], r["template"])
                            if ensured.get("status") != "ready":
                                raise self._err()
                            r["swarm"] = ensured["swarm_id"]
                            current = p2.card(viewer.principal, r["target"], r["template"])
                            if current["consent_revision"] != {"granted_at": r["revision"], "withdrawn_at": None}:
                                raise self._err()
                            r["card"] = current
                        elif r["template"] is not None and not self._ready(viewer.principal, r["target"], r["template"], r["card"]):
                            raise self._err()
                        # A host confirmation is consumed once by settling this
                        # review. It never produces an onward activation lease.
                        out = {"result": link_result("ready")}
                        if r["kind"] != "app-setup" or data["open_now"]:
                            out["entry"] = self._mint(viewer, session, r, first_only=r["kind"] == "app-setup")
                        r["settled"] = link_result("ready")
                        return out
                    except Exception:
                        r["settled"] = link_result("refused", "not_available" if r["kind"] == "app-setup" else "not_ready")
                        return {"result": r["settled"]}
        finally:
            self.hive.app_ask.drain_fences()

    def _mint(self, viewer, session, review, first_only):
        token = value = None
        try:
            with self.hive.db.transaction():
                if len(self.entries) >= MAX_HOST_RECORDS or not self._review_current(review):
                    raise self._err()
                ask = self.hive.app_ask.card(viewer, session, review["target"])
                if not self._review_current(review):
                    raise self._err()
                # Every approval remains bound to the displayed release and Ask epoch,
                # including when another document has since granted ordinary consent.
                prior = review["ask"]
                if (ask["release_digest"], ask["consent_epoch"]) != (prior["release_digest"], prior["consent_epoch"]):
                    raise self._err()
                expected_epoch = prior["consent_epoch"]
                if not ask["consented"]:
                    self.hive.app_ask.consent(viewer, session, review["target"], {"card_id": prior["card_id"]}, first_session=first_only, defer_fences=True)
                    # AppAsk.consent validates that exact card and increments its epoch
                    # once. A concurrent later grant must never be selected instead.
                    expected_epoch += 1
                row = self.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? AND epoch = ? AND revoked = 0 ORDER BY epoch DESC, created_at DESC, id DESC LIMIT 1",
                    (viewer.principal, review["target"], review["release"]["release_digest"], expected_epoch))
                if not row or ask["consented"] and row["id"] != prior["consent_id"]:
                    raise self._err()
                token = str(uuid.uuid4())
                person, _ = self._person(viewer, session)
                value = {"id": token, "principal": viewer.principal, "session": session, "signin": person.get("signin_hash"),
                    "person_epoch": review["frame"]["person_epoch"], "limits_epoch": review["limits_epoch"], "target_program_epoch": self.program_epochs.get(review["target"], 0), "target": review["target"],
                    "release": review["release"]["release_digest"], "template": review["template"], "p2": copy.deepcopy(review["card"]),
                    "target_app_epoch": review["target_app_epoch"],
                    "swarm": review["swarm"], "consent_id": row["id"], "consent_epoch": row["epoch"],
                    "source_frame": review["frame"]["id"], "source_app": review["frame"]["app"], "source_swarm": review["frame"]["swarm"],
                    "source_name": self.hive.programs.link_manifest(review["frame"]["app"])["name"],
                    "source_authority": self._presentation_authority(viewer.principal, review["frame"]["app"]),
                    "until": self.clock() + 120, "used": False, "fenced": False, "target_frame": None, "presentation_open": True}
                self._entry_current(value, viewer, session)
                self.entries[token] = value
            return {"id": token, "app": value["target"], "swarm_id": value["swarm"], "name": review["release"]["name"],
                    "back_name": value["source_name"]}
        except BaseException:
            if token is not None and self.entries.get(token) is value:
                self.entries.pop(token, None)
            raise

    def _presentation_authority(self, principal, app):
        """Binding metadata only. The opaque presentation bytes never reach here."""
        release = self.hive.programs.link_manifest(app)
        authority = self.hive.programs._authority(app) or {}
        ask = self.hive.db.one("SELECT id, digest, epoch, revoked FROM app_ask_consents WHERE principal = ? AND app_id = ? ORDER BY epoch DESC, revoked ASC, created_at DESC, id DESC LIMIT 1", (principal, app))
        setups = self.hive.db.all("SELECT template_id, template_digest, key_id, month_usd, granted_at, withdrawn_at FROM app_person_consents WHERE principal = ? AND program_id = ? ORDER BY template_id", (principal, app))
        return {"release": release["release_digest"], "authority": {k: authority.get(k) for k in ("at", "disabled", "grants_revoked", "restored_at")},
                "ask_revoked": bool(ask and ask["revoked"]), "setups": setups, "limits_epoch": self.limit_epochs.get(principal, 0), "app_epoch": self.app_epochs.get((principal, app), 0), "program_epoch": self.program_epochs.get(app, 0)}

    def presentation_current(self, viewer, session, eid, consume=False):
        with self.guard:
            try:
                entry = self.entries.get(eid)
                self._person(viewer, session)
                if not entry or (entry["principal"], entry["session"]) != (viewer.principal, session):
                    return {"current": False}
                open_before = entry["presentation_open"]
                if consume:
                    entry["presentation_open"] = False
                if not open_before or entry["person_epoch"] != self.person_epochs.get(viewer.principal, 0):
                    return {"current": False}
                self.hive.visibility.check_path(viewer, {"swarm_id": entry["source_swarm"]})
                return {"current": self._presentation_authority(viewer.principal, entry["source_app"]) == entry["source_authority"]}
            except Exception:
                return {"current": False}

    def _entry_current(self, entry, viewer, session, used=False):
        person, profile = self._person(viewer, session)
        if not entry or entry["fenced"] or profile == "child" or entry["principal"] != viewer.principal \
                or entry["session"] != session or entry["signin"] != person.get("signin_hash") \
                or entry["person_epoch"] != self.person_epochs.get(viewer.principal, 0) \
                or entry["limits_epoch"] != self.limit_epochs.get(viewer.principal, 0) \
                or entry["target_program_epoch"] != self.program_epochs.get(entry["target"], 0) \
                or entry["target_app_epoch"] != self.app_epochs.get((viewer.principal, entry["target"]), 0) \
                or not used and entry["used"] or (not used or not entry["used"]) and self.clock() >= entry["until"] \
                or self.hive.programs.link_manifest(entry["target"])["release_digest"] != entry["release"]:
            raise self._err()
        if entry["p2"] is not None:
            card = self.hive.person_swarms.card(viewer.principal, entry["target"], entry["template"])
            if self._p2_card_semantics(card) != self._p2_card_semantics(entry["p2"]) or not self._ready(viewer.principal, entry["target"], entry["template"], card):
                raise self._err()
        row = self.hive.db.one("SELECT * FROM app_ask_consents WHERE id = ?", (entry["consent_id"],))
        if not row or row["revoked"] or row["epoch"] != entry["consent_epoch"]:
            raise self._err()
        return row

    def first_session_current(self, consent_id, viewer, session):
        # Raw validation under P1's short DB transaction: never take guard/P2
        # locks here. It observes the same immutable binding and live DB rows.
        entry = self.first_sessions.get(consent_id)
        try:
            self._entry_current(entry, viewer, session, used=True)
            return True
        except Exception:
            return False

    def entry_card(self, viewer, session, eid):
        with self.guard:
            entry = self.entries.get(eid)
            row = self._entry_current(entry, viewer, session)
            release = self.hive.programs.link_manifest(entry["target"])
            from .app_ask import PERMISSION
            return {"app_id": entry["target"], "name": release["name"], "release_digest": release["release_digest"],
                "version": release["version"], "consent_id": row["id"], "consent_epoch": row["epoch"],
                "consented": True, "card_id": None, "permission": PERMISSION}

    def check_entry(self, viewer, session, eid, fid):
        """Parent's per-operation entry guard; no ids or details go to a frame."""
        with self.guard:
            entry = self.entries.get(eid)
            self._entry_current(entry, viewer, session, used=True)
            if not entry["used"] or entry["target_frame"] != fid:
                raise self._err()
            self._frame(viewer, session, entry["target"], fid)
            return {"current": True}

    def check_frame(self, viewer, session, app, fid):
        """Fresh Back/reload uses ordinary current P1 consent, never an old pass."""
        with self.guard:
            _, profile = self._frame(viewer, session, app, fid)
            if profile == "child":
                raise self._err()
            release = self.hive.programs.link_manifest(app)
            consent = self.hive.db.one("SELECT * FROM app_ask_consents WHERE principal = ? AND app_id = ? AND digest = ? ORDER BY epoch DESC, revoked ASC, created_at DESC, id DESC LIMIT 1", (viewer.principal, app, release["release_digest"]))
            if not consent or consent["revoked"] or consent.get("first_session_only"):
                raise self._err()
            if len(release["swarm_templates"]) == 1 and "person_swarm" in release["capabilities"]:
                _, tid, card = self._target(viewer.principal, app)
                if not self._ready(viewer.principal, app, tid, card):
                    raise self._err()
            return {"current": True}

    def redeem(self, viewer, session, eid, data):
        if set(data) != {"release_digest", "frame_slot_id"}:
            raise self._err()
        with self.guard:
            entry = self.entries.get(eid)
            if entry is None:
                raise self._err()
            p2 = self.hive.person_swarms
            with contextlib.ExitStack() as stack:
                if entry["template"] is not None:
                    stack.enter_context(p2._program_lock(entry["target"]))
                    stack.enter_context(p2._lock(viewer.principal, entry["target"]))
                with self.hive.db.transaction():
                    row = self._entry_current(entry, viewer, session)
                    if data["release_digest"] != entry["release"]:
                        raise self._err()
                    candidates = [f for f in self.frames.values() if f["origin"] == eid and f["active"]
                                  and f["slot"] == data["frame_slot_id"] and f["session"] == session
                                  and f["principal"] == viewer.principal and f["app"] == entry["target"]]
                    if len(candidates) != 1:
                        raise self._err()
                    target_frame = candidates[0]
                    # P1 replacement fences every active generation of a consent.
                    # Never let a link document replace another document's lease,
                    # even when their caller-supplied slot strings happen to match.
                    # This host-derived slot is not exposed as frame authority.
                    link_slot = "app-link:" + target_frame["id"]
                    active = self.hive.db.all(
                        "SELECT slot, session_hash FROM app_ask_generations WHERE consent_id = ? AND status = 'active'",
                        (row["id"],))
                    if any(g["slot"] != link_slot or g["session_hash"] != session for g in active):
                        raise self._err()
                    entry["target_frame"] = target_frame["id"]
                    self.first_sessions[row["id"]] = entry
                    try:
                        lease = self.hive.app_ask._frame(viewer, session, entry["target"],
                            dict(data, frame_slot_id=link_slot), entry_consent=row["id"])
                    except Exception:
                        self.first_sessions.pop(row["id"], None)
                        raise
                    entry["used"] = True
                    return lease

