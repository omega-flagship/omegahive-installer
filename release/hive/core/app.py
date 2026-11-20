# Purpose: the hive's HTTP app: every route, the lifespan that starts and stops the hive's loops, and the wiring
# between them.
"""FastAPI application: REST + live events for the UI, agent hub, LLM gateway."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import hashlib
import json
import math
import logging
import os
import pathlib
import re
import secrets
import sqlite3
import threading
import time
import uuid
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from . import keyview
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from ..supervisor.drivers import Supervisor
from .ask import TRACE_ENTRY
from .config import FREE, Settings, is_free, load_settings
from .db import now
from .feedback import ERROR_ID_HEADER, SEND_MAX_BYTES as FEEDBACK_MAX_BYTES, RecentRequests
from . import session_launch
from . import assets as assets_mod
from . import views as views_mod
from .collab import artifact_command
from .gateway import Gateway, GatewayError, billable as gateway_billable, reported_cost, split_model
from .refusals import again as refused_again, spoken
from .hive import Hive, HiveError, token_hash
from .health import people_frame
from .providers import ProviderError, ProviderStore
from .sso import SSO, AccountAttempts, PublicGate
from .session_ref import SessionRefs
from .me_decisions import MeDecisions, Person, human_session
from .people import OAUTH_COOKIE, SIGNIN_COOKIE, TEST_ACCOUNT_EMAIL, People, SignInError
from .google_connector import GoogleConnector, GoogleConnectorError
from .ui_prefs import StalePrefs, UiPrefs, UiPrefsError
from .services import ServiceError
from .proposal_tests import SERVICE_BODY_MAX
from .code import Code, CodeError
from .code_mind_proof import member_request, note_host_denial
from .roles import RoleError
from .mcp import McpError
from fastapi.responses import Response
from fastapi.responses import RedirectResponse


ACT_MAX_BODY = 28 * 1024 * 1024   # one app action with a 20 MB file, base64, plus its envelope (Surface G2)
GOOGLE_CONNECTOR_COOKIE = "hive_google_connector"
GOOGLE_CONNECTOR_BODY_MAX = 4096
UI_DIST = pathlib.Path(__file__).resolve().parents[1] / "ui" / "dist"
# The page's nonce slot: `vite build` (hive/ui/vite.config.ts, html.cspNonce) writes this word into every script, style
# and preload tag of index.html and into its csp-nonce meta, and each answer for the page puts a fresh nonce in its place.
PAGE_NONCE_SLOT = "HIVE-CSP-NONCE"


def page_csp(nonce: str | None) -> str:
    """The app document's Content-Security-Policy. The srcdoc frames the page makes (Create's apps and plan previews,
    Code's page, Flow's studio) inherit it on top of their own, so it allows what they need as well: their inline
    scripts and styles carry the page's nonce (hive/ui/src/lib/appFrame.ts frameNonce), their style attributes need
    style-src-attr (an attribute can restyle but fetch nothing beyond img-src and font-src), and their inlined assets are
    data: and blob:. Connections, frames and workers are the hive's own; nothing may frame the page, plugins are off and
    no <base> can move it. frame-src 'self' also keeps an artifact view's sandboxed frame from navigating itself to
    another site: Chromium, Firefox and WebKit check a frame's own navigation against this policy before the request
    leaves (hive/ui/src/features/views/ViewFrame.tsx). A build made before the nonce slot (`nonce` None) keeps working: its inline boot script and
    its frames' own nonces need 'unsafe-inline', which a nonce in the same directive would switch off."""
    inline = f"'nonce-{nonce}'" if nonce else "'unsafe-inline'"
    return ("default-src 'self'; "
            f"script-src 'self' {inline}; style-src 'self' {inline}; style-src-attr 'unsafe-inline'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self'; "
            "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


def _bearer(value):
    value = value or ""
    return value[7:].strip() if value.lower().startswith("bearer ") else ""


MAX_EMBED_INPUTS = 256
MIN_EMBED_TOKENS_PER_ITEM = 8

# A browser leaving is routine: normal close, going away, no status, abnormal drop, service restart.
EXPECTED_WS_CLOSE_CODES = frozenset({1000, 1001, 1005, 1006, 1012})
# The events socket closes a page that fell behind with "Try Again Later" (IANA WebSocket close code registry): the page
# reconnects and reads what it holds again, since frames were dropped for it (events.py EventBus.lost).
EVENTS_BEHIND_CLOSE = 1013

try:   # starlette >= 1.0 raises this RuntimeError subclass for I/O on a closed socket
    from starlette.websockets import WebSocketDisconnected as _StarletteClosedSocket
except ImportError:   # older starlette raised a plain RuntimeError
    _StarletteClosedSocket = None

# The exact closed-socket messages starlette raises from send/receive (starlette/websockets.py, 1.7.0;
# older releases raise the same strings as plain RuntimeError):
#   'Cannot call "receive" once a disconnect message has been received.'
#   'Cannot call "send" once a close message has been sent.'
#   'WebSocket is not connected. Need to call "accept" first.'
_STARLETTE_CLOSED_SOCKET_MESSAGES = frozenset({
    'Cannot call "receive" once a disconnect message has been received.',
    'Cannot call "send" once a close message has been sent.',
    'WebSocket is not connected. Need to call "accept" first.',
})


class _PeerGone(Exception):
    """The browser has gone: raised only by _ws_send/_ws_receive, so no other code's error can look like one."""


def _peer_gone(exc) -> bool:
    if isinstance(exc, WebSocketDisconnect):
        if exc.code not in EXPECTED_WS_CLOSE_CODES:
            logging.getLogger("hive").warning("events websocket closed with code %s", exc.code)
        return True
    if _StarletteClosedSocket is not None and isinstance(exc, _StarletteClosedSocket):
        return True
    return type(exc) is RuntimeError and str(exc) in _STARLETTE_CLOSED_SOCKET_MESSAGES


async def _ws_send(ws, text):
    try:
        await ws.send_text(text)
    except Exception as exc:
        if _peer_gone(exc):
            raise _PeerGone() from exc
        raise


async def _ws_receive(ws):
    try:
        return await ws.receive_text()
    except Exception as exc:
        if _peer_gone(exc):
            raise _PeerGone() from exc
        raise


def create_app(settings: Settings | None = None, supervisor=None, reconcile_seconds=5.0, confidential_factory=None,
               newhive_extractor=None) -> FastAPI:
    from .code_aggregate import _CodeAggregate
    settings = settings or load_settings()
    aggregate = _CodeAggregate(settings)
    try:
        return _create_app(settings, supervisor, reconcile_seconds, confidential_factory,
                           newhive_extractor, _code_aggregate=aggregate)
    except BaseException as primary:
        # The original traceback retains this local owner/partial attempt. A
        # cleanup/projection failure cannot replace the construction primary.
        aggregate.retire(primary)
        raise


def _create_app(settings: Settings | None = None, supervisor=None, reconcile_seconds=5.0, confidential_factory=None,
                newhive_extractor=None, *, _code_aggregate) -> FastAPI:
    settings = settings or load_settings()
    from . import code_local_enrolment, localowner
    from . import newhive as newhive_mod
    local_mode = localowner.enabled()   # J1 installers: everything local-owner is inert unless HIVE_LOCAL_OWNER=1
    # new-hive R1a (plan r1.1 §1/§3): a data folder with the required-feature marker is a new installation and must
    # match it; a marker refuses without HIVE_LOCAL_OWNER=1. No marker (every hive today): None, nothing changes.
    marker = newhive_mod.check_startup(settings.data_dir)
    if local_mode:
        localowner.check_environment()                # r4.1 K-3, r2 B: refuse a second sign-in path or a public address
        localowner.check_data_dir(settings.data_dir)  # r2 C: the data folder is this account's alone
        from . import redact
        redact.enable()                               # r2 F: one redactor for logs and provider errors
    if not settings.admin_password:
        password_file = settings.data_dir / "admin-password"
        if not password_file.exists():
            password_file.write_text(secrets.token_urlsafe(12))
            password_file.chmod(0o600)
        settings.admin_password = password_file.read_text().strip()
    # Restart prepare (Jon 2026-10-18): a fresh one-time token each start, readable by this account only; none when off.
    restart_token_file = settings.data_dir / "restart-prepare.token"
    if settings.restart_prepare:
        fd = os.open(restart_token_file, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        os.chmod(restart_token_file, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(32))
    else:
        with contextlib.suppress(FileNotFoundError):
            restart_token_file.unlink()
    _code_aggregate.start()  # before any constructor can start a worker
    supervisor = supervisor if supervisor is not None else Supervisor(settings)
    hive = Hive(settings, supervisor=supervisor)
    hive._code_aggregate = _code_aggregate  # original private startup owner, never posted
    session_refs = SessionRefs(settings.data_dir)
    if supervisor:
        supervisor.attach(hive)
    gateway = Gateway(settings.providers)
    gateway.authorize_agent = hive.person_apps.authorize_agent   # P2's require_current, then P14's own-key context rule
    from .cost_reservations import (BudgetExhausted, Reservations, SpendRateLimited, exhausted_limit, host_budget_snapshot,
                                    host_subjects, host_use_check, reservable_micros)
    cost_reservations = Reservations(hive.db)
    gateway.free_unreconciled = cost_reservations.free_unknown   # sol R2 P1: no further $0 call past an unknown one

    def hold_unknown(reservation, exc=None):
        """Keep a call's worst case held as an unknown liability; never raises (used where the caller already has an answer).
        exc, the call's failure if any: a refusal whose body reports a charge settles at that charge (recorded as usage for
        the reserving mind); a refusal guaranteed unbilled (gateway.unbilled: provider allowlist, no charge evidence) is
        released. Returns True if the hold was settled or released (no longer held), else False. A hold left unknown
        records why (gateway.held_cause), so the person resolving it reads the reason beside it."""
        from .gateway import held_cause, refusal_charge, unbilled
        charge = refusal_charge(exc) if exc is not None else None
        if charge is not None:
            with contextlib.suppress(Exception):
                meta = (cost_reservations.details(reservation) or {}).get("metadata") or {}
                cost_reservations.settle(reservation, charge, lambda: held_usage(meta, charge), overrun_flag)
                return True
        elif exc is not None and unbilled(exc):
            with contextlib.suppress(Exception):
                if cost_reservations.release_unbilled(reservation, exc.status):
                    return True
        model = None
        with contextlib.suppress(Exception):
            model = ((cost_reservations.details(reservation) or {}).get("metadata") or {}).get("model")
        with contextlib.suppress(Exception):
            cost_reservations.unknown(reservation, held_cause(exc, model))
        return False

    def held_usage(meta, usd, **fields):
        """A held call's settled cost recorded as usage, from what was recorded when it was reserved: its mind, model,
        key and payer. The one recorder for a refusal that reports its charge, a person's settle, Settle all, the
        expiry's estimate and a person's correction of it (fields: estimated, reservation and created_at, as
        Hive.record_usage reads them). A mind deleted since still has its row, so the cost still counts against its
        team, its payer, its key and the hive."""
        row = hive.db.one("SELECT * FROM agents WHERE id = ?", (meta["agent"],)) if meta.get("agent") else None
        if row:
            mind = row if row["deleted"] else hive.agent(row["id"])
            hive.record_usage(mind, meta.get("model") or mind["model"],
                              {"prompt_tokens": 0, "completion_tokens": 0, "cost_usd": usd, "key_id": meta.get("key"), **fields},
                              None, meta.get("payer"))

    def overrun_flag(info):
        """An actual cost above what was held: tell people and mark the mind (recorded in cost_overruns as well)."""
        hive.events.publish("budget.overrun", **info)
        # media r2 P1-2: a media charge above its hold also opens the mind's media breaker (an admin resets it)
        from .media import overrun_trips
        if overrun_trips(hive.db, info):
            hive.events.publish("media.breaker_tripped", agent=info.get("agent"), agent_id=info.get("agent"),
                                reservation=info.get("reservation"), reason="overrun")
        if info.get("agent"):
            hive.db.execute("UPDATE agents SET last_error = ? WHERE id = ?",
                            (f"budget overrun: ${info['actual_usd']:.4f} against ${info['held_usd']:.4f} held ({info['reservation']})", info["agent"]))
            hive.emit_agent(info["agent"])

    def estimated_flag(info):
        """What one expiry pass settled at its worst case (cost_reservations.estimated_summary): one live event for open
        screens, admins only (visibility.py), in place of a notice per call; people read the day's line instead."""
        hive.events.publish("budget.estimated", **info)

    def estimated_lines_pass():
        """The day's line about estimates (cost_reservations.estimated_lines) for every current person, each on their own
        local day as their notice settings give it. Time: one read of the people, then estimated_lines."""
        from .cost_reservations import estimated_lines
        people = hive.db.all("SELECT p.id, p.role, COALESCE(n.tz, 'UTC') AS tz FROM people p LEFT JOIN notice_prefs n "
                             "ON n.principal = 'user:' || p.id WHERE p.disabled = 0 AND p.role IN ('admin', 'member')")
        return estimated_lines(hive.db, [("user:" + p["id"], p["role"] == "admin", p["tz"]) for p in people],
                               hive.notices.from_hive)
    from .mind_gateway import MindTokens
    hive.mind_tokens = MindTokens(hive)   # gateway r1c: the mind tokens (inert with HIVE_MIND_GATEWAY unset)
    from .mind_idempotency import MindIdempotency
    hive.mind_idempotency = MindIdempotency(hive)   # gate A r1.1: the Idempotency-Key (nothing made with the flag unset)
    hive.mind_idempotency.sweep_quietly()          # stored answers past their hour go at startup, whatever the flag
    from .mind_checkpoint import MindCheckpoints
    hive.mind_checkpoints = MindCheckpoints(hive)   # gateway gate A: the freshness head (no table with the flag unset)
    from .conductor import Conductor
    # Ask is ready on a fresh install; HIVE_ASK_CONDUCTOR=0 selects the legacy route. It keeps no memory of its own.
    hive.ask.conductor = Conductor(hive, gateway, cost_reservations, host_budget_snapshot, hold_unknown, overrun_flag)
    from .studio_sessions import StudioSessions
    # J3 host R2 (G1): the studio.session intent kind's admission and session record (studio_sessions.py)
    hive.studio = StudioSessions(hive, gateway, cost_reservations, host_budget_snapshot)
    from .studio_makers import StudioMakers
    # J3 host R7: every member's own Studio maker, on their own key, made and attached by the host (studio_makers.py)
    hive.studio_makers = StudioMakers(hive)
    # ask-limits r1: Ask threads from an earlier build stop holding their mind's rule. r1.1 (Kimi P2): at every boot, not
    # only with the conductor on then; a turn the mind itself answers moves its own thread back under the mind's rule.
    moved = hive.sessions.adopt_ask_threads()
    if moved:
        logging.getLogger("hive").info("ask: %d active Ask thread(s) moved to their own spend cap", len(moved))
    providers = ProviderStore(settings, gateway.client)
    hive.providers = providers
    gateway.keyring = providers
    hive.keyring = providers   # who owns which key (personal spend views)
    sso = SSO(settings)
    people = People(hive, gateway.client)
    hive.people = people
    person_role = lambda principal: role_of({"kind": "sso", "principal": principal})   # noqa: E731  (a principal's current role)
    hive.person_role = person_role   # Hive.grows_vocabulary: whose mind may add words to a vocabulary by publishing
    hive.google_connector = GoogleConnector(hive, settings, person_role=person_role)
    local = None
    if local_mode:   # J1 r3 K1 / r4 KM3: the local owner exists, and owns the hive, before anything else reads the owner
        local = localowner.LocalOwner(settings, hive)
        local.ensure_owner()
        hive.local_owner = local
        if marker is not None:   # new-hive R1a: binding, startup sweep of helper sessions, the coding barrier
            hive.newhive = newhive_mod.NewHive(settings, hive, local, marker, extractor=newhive_extractor)
    hive.ownhive.ensure_owner()   # own hive H1: an existing hive's first admin becomes its stored owner (no access changes)
    try:
        hive.ownhive.backfill_hold_scopes()   # H1.2: open holds from before the upgrade count under key limits made later
    except Exception:   # noqa: BLE001  (H1.3: never stops the hive starting; per-row failures are handled inside)
        logging.getLogger("hive").exception("own hive: key-limit scope upgrade failed; open holds counted against every scope")
        with contextlib.suppress(Exception):
            hive.ownhive.count_open_holds_everywhere()
    gateway.own_key_for = hive.ownhive.own_key_for   # a guest or public visitor with no grant pays with their own key
    from .subscription_cli import SubscriptionGate
    gateway.subscription_gate = SubscriptionGate(hive)   # every subscription instance: the owner's own private minds only, a day cap each
    from .free_inference import FreeGate
    gateway.free_gate = FreeGate(hive)   # free inference: the deploy's key, for every person, their calls a day each
    hive.gateway = gateway   # read-only use: Budgets.settlement works out who pays with the gateway's own paying_key
    hive.reconcile_removed_keys()   # keyview: tombstones of removed keys no mind names any more (orphans from before)
    from .research import Research
    hive.research = Research(hive)   # research.request and the Research swarm's reports (research.py); before Foundation
    from .foundation import HiveFoundation
    hive.foundation = HiveFoundation(hive)
    hive.foundation.ensure_quietly()   # host-owned records only; no mind/provider starts
    hive.personal.backfill()   # once at startup: every named person has a personal mind (asleep; nothing starts)
    try:                       # J3 R7, Studio on only: no binding to a deleted mind, no maker of a person without access
        hive.studio_makers.sweep()
    except Exception:   # noqa: BLE001  (never stops the hive starting)
        logging.getLogger("hive").exception("studio makers: startup sweep failed")
    ui_prefs = UiPrefs(hive.db)
    from .onboarding import Onboarding
    hive.onboarding = Onboarding(hive, gateway)   # First Light R1a: progress, the setup list, the first hello
    PASSWORD_SESSION_SECONDS = 30 * 86400
    member_attempts = AccountAttempts()   # uniform counters for every typed identifier

    async def warm_catalog():
        """Fetch the OpenRouter catalogue so prices are known before the first call; True when it brought one."""
        if not settings.providers["openrouter"].api_key or settings.offline:
            return False
        try:
            await providers.models()
        except Exception:   # noqa: BLE001  (a failed fetch leaves the prices as they were; the hive keeps starting)
            return False
        return True

    # The Create · Code offer follows its inputs (hive/core/offer_refresh.py): the catalogue, then the foundation's ensure
    # after every key change and every Code service change, when the reconcile pass finds a Code service answering that
    # the last ensure found down, after every change to who may own the hive (a person made an admin or no longer one,
    # an owner claim), since the foundation's swarms are bound to the owner, and at start only when the catalogue brought
    # prices, since ensure_quietly above has just run.
    from .offer_refresh import OfferRefresh
    offer_refresh = OfferRefresh(warm_catalog, lambda: run_in_threadpool(hive.foundation.ensure_quietly))

    installed_map = newhive_mod.InstalledMapCoordinator(hive)
    hive.installed_map = installed_map
    from .repomap_seed import RepoMapSeed
    hive.repo_map_seed = RepoMapSeed(hive, data_dir=settings.data_dir)   # the pinned map set, loaded by the host at start
    from .repomap_live import LiveMaps
    hive.repo_map_live = LiveMaps(hive)   # 1.2: stored files and artifacts mapped as they change (events)

    async def prepare_installed_map():
        try:
            await asyncio.to_thread(installed_map.run_once)
        except asyncio.CancelledError:
            installed_map.stop()  # cancelling a future never proves its thread stopped
            raise
        except Exception:
            installed_map.worker_failed()
            logging.getLogger("hive").warning("installed source map: worker_failed")

    async def seed_repo_maps(after):
        """After the self-map job (whatever its outcome), load every pinned revision that is missing (repomap_seed.py)."""
        if after is not None:
            await asyncio.wait({after})
        try:
            await asyncio.to_thread(hive.repo_map_seed.run_once)
            seed = hive.repo_map_seed   # slice 1.1: then keep the tracked maps current, on its own thread
            threading.Thread(target=seed.sources.loop, args=(lambda: seed.revisions,), name="repo-map-sources",
                             daemon=True).start()
            if os.environ.get("HIVE_REPO_MAP_LIVE", "on").strip().lower() not in ("0", "off", "false", "no"):
                hive.repo_map_live.mark_all()
                hive.repo_map_live.start()
        except asyncio.CancelledError:
            hive.repo_map_seed.stop()
            raise
        except Exception:   # noqa: BLE001  (never stops the hive)
            logging.getLogger("hive").warning("repo map seed: worker_failed")

    @_code_aggregate.lifespan
    @contextlib.asynccontextmanager
    async def lifespan(app):
        hive.events.bind(asyncio.get_running_loop())
        if local is not None:
            # J1 r4 ST3 / r4.1: the real sandbox paths are proven before any mind is restored; a failure refuses every
            # mind and tool for this process (sandbox.refuse), never runs one unsandboxed. Then the control socket.
            from ..supervisor import preflight
            local.preflight = await run_in_threadpool(preflight.run_and_record, settings.data_dir)
            await local.start()
        # #111: minds run in the OS sandbox unless HIVE_MIND_SANDBOX=0. Before any mind is restored, one trivial launch
        # through the minds' own wrap() finds whether that works on this host, and the hive says what it found, once.
        import sys
        from ..supervisor import sandbox as mind_sandbox
        found = await run_in_threadpool(mind_sandbox.probe_minds, settings.data_dir,
                                        local.preflight if local is not None else None)
        print(f"[hive] {mind_sandbox.describe(found, settings.default_driver)}",
              file=sys.stdout if found["state"] == "on" else sys.stderr, flush=True)
        await hive.restore()
        task = asyncio.create_task(reconcile()) if supervisor and reconcile_seconds else None
        offer_refresh.schedule(changed=False)   # the catalogue; ensure again only if it brought prices
        nh = getattr(hive, "newhive", None)   # new-hive r1.4-int: test doubles of Hive may not carry it
        watch = asyncio.create_task(nh.watch()) if nh is not None else None
        app_ask_watch = asyncio.create_task(app_ask_expiry())
        if hive.code_controller.enabled():
            hive.code_controller.ensure_watch()   # resumes open controller runs; wakes on goal/request events only
        if hive.create_plans.enabled():
            hive.create_plans.ensure_watch()      # resumes open plans; wakes on goal events and the person's routes only
        try:   # research.py: open research requests get their researcher (or its undelivered brief) back
            await hive.research.recover()
        except Exception:   # noqa: BLE001  (never stops the hive starting)
            logging.getLogger("hive").exception("research: startup recovery failed")
        # gate A r1.3: the stored-answer sweep's backstop, on its own thread (not the pool, not the reconcile loop)
        answers_stop = threading.Event()
        answers = threading.Thread(target=hive.mind_idempotency.sweeper, args=(answers_stop,), name="mind-answer-sweeper",
                                   daemon=True)
        answers.start()
        self_map_job = None
        seed_job = None
        shutdown_primary = None
        try:
            try:
                self_map_job = asyncio.create_task(prepare_installed_map(), name="installed-repository-map")
                hive._installed_map_job = self_map_job  # retain ownership through a slow shutdown
                seed_job = asyncio.create_task(seed_repo_maps(self_map_job), name="repo-map-seed")
                async with code_local_enrolment.running(hive), session_launch.running(hive, settings):
                    yield
            except BaseException as exc:
                shutdown_primary = exc
            try:
                hive.repo_map_seed.stop()
                hive.repo_map_live.stop()
                if seed_job is not None and not seed_job.done():
                    done, _ = await asyncio.wait({seed_job}, timeout=5)
                    if seed_job not in done:
                        logging.getLogger("hive").warning("repo map seed: shutdown still pending")
            except BaseException as exc:   # noqa: BLE001
                shutdown_primary = shutdown_primary or exc
            try:
                installed_map.stop()
                if self_map_job is not None:
                    done, _ = await asyncio.wait({self_map_job}, timeout=5)
                    if self_map_job in done:
                        with contextlib.suppress(asyncio.CancelledError):
                            await self_map_job
                    else:
                        logging.getLogger("hive").warning("installed source map: shutdown still pending")
            except BaseException as exc:
                if shutdown_primary is None:
                    shutdown_primary = exc
                else:
                    with contextlib.suppress(BaseException):
                        logging.getLogger("hive").warning("installed source map: shutdown also failed; original failure retained")
        finally:
            # A self-map wait failure/cancellation cannot skip the pre-existing
            # owned cleanup tail. Keep its original primary if the tail also fails.
            try:
                answers_stop.set()
                answers.join(5)
                app_ask_watch.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await app_ask_watch
                # The run in progress, the start-up one or one a key or service route started, ends before the parts of
                # the hive its ensure reads stop; no run starts after this.
                await offer_refresh.aclose()
                hive.code_controller.close()   # the watcher and the reducer's scratch folder
                hive.create_plans.close()
                if watch is not None:
                    watch.cancel()
                if task:
                    task.cancel()
                if supervisor:
                    # A reconcile pass already on a worker thread is not stopped by cancel(): it must not restart a mind these
                    # shutdown stops end (they keep desired=awake for the next restore).
                    shutdown = getattr(supervisor, "shutdown", None)
                    if callable(shutdown):
                        shutdown()
                    failed_stops = []
                    for row in hive.db.all("SELECT id FROM agents WHERE deleted = 0"):
                        try:
                            await run_in_threadpool(supervisor.stop, row["id"])
                        except Exception as exc:
                            failed_stops.append(row["id"])
                            logging.getLogger("hive").warning("shutdown could not confirm mind %s stopped (%s); tracking retained",
                                                               row["id"], type(exc).__name__)
                    if failed_stops:
                        logging.getLogger("hive").warning("shutdown left %d unresolved mind stops", len(failed_stops))
                conductor = getattr(hive.ask, "conductor", None)
                if conductor is not None:   # Ask conductor loops stop and their cut-off calls settle first, within a short grace
                    try:
                        await conductor.aclose()
                    except Exception as exc:   # never silent: the settle-before-close guarantee did not hold this time
                        logging.getLogger("hive").warning("ask conductor: shutdown drain failed (%s)", type(exc).__name__)
                await gateway.client.aclose()
                if local is not None:
                    await local.stop()
            except BaseException:
                if shutdown_primary is None:
                    raise
                with contextlib.suppress(BaseException):
                    logging.getLogger("hive").warning("shutdown cleanup also failed; original failure retained")
        if shutdown_primary is not None:
            raise shutdown_primary

    async def app_ask_expiry():
        # Independent of the supervisor/reconcile switch; a dead frame cannot strand a turn.
        # A transient read/DB failure must not end this only proactive lease watchdog. Retry at the same
        # bounded cadence without renewing any lease; report only the exception type, at most once per30s.
        warn_after = 0.0
        while True:
            await asyncio.sleep(0.25)
            try:
                await run_in_threadpool(hive.app_ask.sweep)
            except asyncio.CancelledError:
                raise   # normal lifespan shutdown remains cancellable
            except Exception as exc:
                stamp = time.monotonic()
                if stamp >= warn_after:
                    warn_after = stamp + 30.0
                    logging.getLogger("hive").warning("app Ask expiry sweep failed (%s); retrying", type(exc).__name__)

    async def reconcile():
        while True:
            await asyncio.sleep(reconcile_seconds)
            await reconcile_once()

    # The #89 review asked for a per-pass limit on the OpenRouter record lookups: at most this many each pass, read at
    # once, so a backlog of held calls costs a pass one lookup timeout (Gateway.GENERATION_LOOKUP_TIMEOUT_S), not one per
    # call; the cursor is the last row number a pass took, so the next pass goes on from there round all of them. The
    # estimates OpenRouter's record can still correct take the lookups the unknown calls leave (estimates_with_records).
    PROVIDER_RECORD_LOOKUPS_PER_PASS = 10
    provider_record_cursor = [0]

    async def reconcile_once():
        """One pass of the reconcile coroutine (exposed as app.state.reconcile_once for tests that drive the production
        pass). J3 host R3 (handoff spec r2.4 §1): the Studio sweep runs right after supervisor.check(), outside any mind
        lock; it writes short DB transactions and dispatches worker jobs, never awaiting them."""
        # gate A r1.2: stored model answers past their hour are erased first, outside the pass's shared try (it never
        # raises), so no other step's failure can skip it (the mind-answer-sweeper thread is the backstop)
        await run_in_threadpool(hive.mind_idempotency.sweep_quietly)
        try:
            await run_in_threadpool(hive.supervisor.check)
            await run_in_threadpool(hive.refresh_all_beliefs)   # each mind's last save, linked into its swarm's view
            try:
                await hive.studio.tick()
            except Exception as exc:   # one Studio pass failing never stops the rest of the reconcile pass
                print(f"[hive] studio sweep error: {exc}")
            await hive.scheduler.tick()
            await hive.goals.expire()
            await hive.flows.reconcile()
            await hive.shares.expire()
            await hive.agreements.expire()
            await hive.app_attachments.reconcile()
            await run_in_threadpool(hive.health.check_unconnected)
            await hive.health.deliver()
            await hive.health.idle.run()   # notice idle minds and ask each one question (never sleeps a mind)
            await run_in_threadpool(hive.archive.rotate_logs)
            await hive.delegation.reconcile()
            hive.ask.expire()   # Ask turns past their deadline close as timed_out (or spend_limit)
            hive.personal_inbox.sweep()   # held copies the browser never collected go after 7 days
            hive.mind_tokens.sweep()      # gateway r1c: expired or orphaned mind tokens leave the redactor
            await run_in_threadpool(hive.notices.sweep)   # G2: a person's held notices go as one digest when due
            await hive.minds.reconcile()
            await run_in_threadpool(hive.research.retire_finished)   # research.py: a retire a restart cut off
            await run_in_threadpool(hive.sleep_idle_minds)
            # The Create · Code offer follows its Code service (hive/core/offer_refresh.py). The service never calls
            # the hive, so one the last ensure found registered and funded but not answering is probed here, and the
            # offer is derived again once it answers.
            if await run_in_threadpool(hive.foundation.code_answers_again):
                offer_refresh.schedule()
        except Exception as exc:  # keep reconciling
            print(f"[hive] reconcile error: {exc}")
        # an unknown OpenRouter answer settles at the cost OpenRouter's own record of it reports, before any worst case,
        # and an estimate of one is corrected to its record when the record comes after the hour; each pass reads at most
        # PROVIDER_RECORD_LOOKUPS_PER_PASS records, all at once, unknown calls first, going round the held calls
        from .cost_reservations import correct, estimates_with_records, from_provider_records, record_asked, settle_from_record
        try:
            pending = await run_in_threadpool(from_provider_records, cost_reservations, provider_record_cursor[0],
                                              PROVIDER_RECORD_LOOKUPS_PER_PASS)
        except Exception as exc:
            pending = []
            print(f"[hive] provider record read error: {exc}")
        if pending:
            provider_record_cursor[0] = pending[-1][0]
        asked = time.time()
        room = PROVIDER_RECORD_LOOKUPS_PER_PASS - len(pending)
        try:
            estimates = await run_in_threadpool(estimates_with_records, cost_reservations, asked, reconcile_seconds,
                                                room) if room > 0 else []
        except Exception as exc:
            estimates = []
            print(f"[hive] estimate record read error: {exc}")
        lookups = [(rid, key_id, generation, meta, False) for _, rid, key_id, generation, meta in pending] + \
            [(rid, key_id, generation, meta, True) for rid, key_id, generation, meta in estimates]
        costs = await asyncio.gather(*(gateway.generation_cost(key_id, generation) for _, key_id, generation, _, _ in lookups),
                                     return_exceptions=True)
        for (rid, key_id, generation, meta, estimate), cost in zip(lookups, costs):
            if isinstance(cost, BaseException):
                print(f"[hive] provider record lookup error for {generation}: {cost!r}")
                cost = None
            if cost is None:
                # no record yet, or none to read: an unknown call is asked again next pass, the expiry staying the
                # backstop; an estimate once its age has doubled
                if estimate:
                    try:
                        await run_in_threadpool(record_asked, cost_reservations, rid, asked)
                    except Exception as exc:
                        print(f"[hive] provider record ask not noted for {rid}: {exc!r}")
                continue
            reason = f"OpenRouter's record of {generation} reports ${cost:.6f}"
            try:
                if estimate:
                    await run_in_threadpool(correct, cost_reservations, rid, "settle", reason, "hive:provider-record", cost,
                                            held_usage, overrun_flag, source="provider-record")
                else:
                    await run_in_threadpool(settle_from_record, cost_reservations, rid, cost, reason,
                                            lambda usd, meta=meta: held_usage(meta, usd), overrun_flag)
            except ValueError:
                pass   # settled, released or corrected by someone else meanwhile (NotCorrectable is a ValueError)
        try:   # an unknown outcome expires after an hour at its worst case, as an estimate (never lost, never waiting forever)
            from .cost_reservations import expire_unknown
            await run_in_threadpool(expire_unknown, cost_reservations, held_usage, estimated_flag)
        except Exception as exc:
            print(f"[hive] reservation expiry error: {exc}")
        try:
            await run_in_threadpool(estimated_lines_pass)
        except Exception as exc:
            print(f"[hive] estimated line error: {exc}")

    # With a base path the hive is wrapped below, and the wrapper owns the lifespan (Starlette does
    # not run a mounted app's lifespan).
    app = FastAPI(title="OmegaHive", version="0.1.0", lifespan=None if settings.base_path else lifespan)
    app.state.hive = hive
    app.state.member_attempts = member_attempts
    app.state.gateway = gateway
    app.state.reconcile_once = reconcile_once
    app.state.offer_refresh = offer_refresh   # tests that drive a pass wait for the offer run it starts
    def own_origins():
        """§G.2: the one set of origins this hive serves its page at, fixed when the app is built, from its own address
        settings: the origins of HIVE_PUBLIC_BASE (if set) and of settings.public_url (HIVE_PUBLIC_URL; the cloud's
        SSH-tunnel address), plus loopback on HIVE_PORT, and on a local-owner hive every loopback origin its boundary
        answers (HIVE_LOCAL_BROWSER_PORT's as well, the page reached through an SSH tunnel). Each one that is set must be
        an http(s) URL with a host, or the build fails. CORS and every Origin check below read this one set."""
        from urllib.parse import urlsplit
        raw_port = os.environ.get("HIVE_PORT", "8700").strip()
        if not re.fullmatch(r"[0-9]{1,5}", raw_port) or not 1 <= int(raw_port) <= 65535:
            raise RuntimeError(f"HIVE_PORT is not an integer from 1 to 65535: {raw_port!r}")
        port = int(raw_port)
        out = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
        for name, raw in (("HIVE_PUBLIC_BASE", os.environ.get("HIVE_PUBLIC_BASE", "")),
                          ("HIVE_PUBLIC_URL", settings.public_url or "")):
            raw = raw.strip()
            if not raw:
                continue
            try:
                base = urlsplit(raw)
                ok = base.scheme in ("http", "https") and bool(base.hostname) and " " not in raw
                base.port                                  # a malformed port raises
            except ValueError:
                ok = False
            if not ok:
                raise RuntimeError(f"{name} is set but is not an http(s) URL with a host: {raw!r}")
            out.add(f"{base.scheme}://{base.netloc}")
        if local is not None:
            out |= local.origins
        return frozenset(out)

    G_ORIGINS = own_origins()
    # CORS answers this hive's own origins and no others. Its page calls it from one of them (same-origin, where CORS
    # never applies), the installer only opens that page, MCP clients and minds are not browsers, and every frame talks
    # to the page by postMessage; a page on any other origin must not read what the hive answers.
    app.add_middleware(CORSMiddleware, allow_origins=sorted(G_ORIGINS), allow_methods=["*"], allow_headers=["*"],
                       expose_headers=["X-Hive-Person-Swarm-Consent-Required", ERROR_ID_HEADER])
    # each answer says where in the live stream it was read, so the page can tell what to read again (events.py)
    from .events import StreamPositionHeader
    app.add_middleware(StreamPositionHeader, bus=hive.events)
    # each request the hive's routes answer is kept with whoever made it, for the logs a person exports (feedback.py)
    app.add_middleware(RecentRequests, feedback=hive.feedback, who=lambda session: _who(session))

    def error_answer(request: Request, status: int, error: dict, exc: BaseException | None = None, headers: dict | None = None):
        """Every error answer carries an id in its X-Hive-Error-Id header, which the hive keeps with the person who met
        it (feedback.py), so a report can name what failed by id, code and route. The body stays as it was: two answers
        that must read alike (an unknown thing and a hidden one) still do. The person is the session the request already
        carries (operator() attaches it before the visibility check, so a hidden thing's 404 has it too); the error path
        looks no session up itself, so a refusal decided before any lookup (an origin refused) stays one, and a 401 has
        none. An answer to a mind on its gateway (request.state.answers_a_mind) carries no id: no person's page met it,
        and the gateway's X-Hive-* headers are money, on a 200 only (mind_gateway.py).
        headers are the answer's own beside the id, such as a 429's Retry-After."""
        if getattr(request.state, "answers_a_mind", False):
            return JSONResponse({"error": error}, status_code=status, headers=headers)
        session = getattr(request.state, "hive_session", None)
        principal = _who(session) if session else None
        error_id = hive.feedback.noted(request, principal, status, str(error.get("code", "")), str(error.get("message", "")), exc)
        return JSONResponse({"error": error}, status_code=status, headers={**(headers or {}), ERROR_ID_HEADER: error_id})

    @app.exception_handler(HiveError)
    async def hive_error(request: Request, exc: HiveError):
        error = {"code": exc.code, "message": exc.message}
        if getattr(exc, "details", None):
            error.update(exc.details)
        # a refusal that says when to come back (a 429 spend_rate) says it in the header HTTP clients read too
        retry = error.get("retry_after")
        headers = {"Retry-After": str(int(retry))} if isinstance(retry, int) and not isinstance(retry, bool) else None
        return error_answer(request, exc.status, error, headers=headers)

    async def domain_error(request: Request, exc):
        # a refusal that knows its wait says it as RFC 9110's Retry-After, in whole seconds, as providers do to the hive
        wait = getattr(exc, "retry_after", None)
        headers = {"Retry-After": str(max(1, math.ceil(wait)))} if wait is not None else None
        return error_answer(request, exc.status, {"code": exc.code, "message": exc.message}, headers=headers)

    # the other errors the hive raises on purpose each carry a status, a code and a message
    for kind in (GatewayError, ProviderError, McpError, RoleError, CodeError, ServiceError, SignInError, GoogleConnectorError):
        app.add_exception_handler(kind, domain_error)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_answer(request, exc.status_code, {"code": "http_error", "message": str(exc.detail)})

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        """An error the hive did not expect: the page gets its id, never its insides, and the hive's log the whole
        traceback under the same id, so a person's report points at it."""
        answer = error_answer(request, 500, {"code": "internal_error", "message": "The hive hit an error it did not expect."}, exc)
        logging.getLogger("hive").error("unexpected error %s on %s %s", answer.headers[ERROR_ID_HEADER], request.method,
                                        request.url.path, exc_info=exc)
        return answer

    # ---- auth ---------------------------------------------------------------------------

    def session_for(token, public):
        """The operator session behind a token, honouring expiry and where the request came from."""
        if not token:
            return None
        row = hive.db.one("SELECT * FROM sessions WHERE token_hash = ?", (token_hash(token),))
        if row is None or (row.get("expires_at") and row["expires_at"] <= time.time()):
            return None
        if row.get("kind") == "member_password" and (local is not None or role_of(row) != "member"):
            return None
        if public and not public_session_allowed(row):
            return None  # from outside this machine only a sign-in session counts
        if row.get("kind") == newhive_mod.BOOTSTRAP_KIND:
            return None  # new-hive R1a (r1.1 §3): a setup helper session is never an ordinary session anywhere
        return row

    def member_password_outside(person):
        """Whether this person's member password counts from outside: only with HIVE_PUBLIC_PASSWORD=1, and once
        Google sign-in is set up (HIVE_GOOGLE_*) only for the test account, never an admin; everyone else continues with
        Google (T-101, people.py). ``person`` is their people row, or None for an email that has none."""
        return sso.public_password and (not people.google_ready or bool(
            person and person.get("test_account") and person.get("role") != "admin"))

    def member_password_offered_outside():
        """Whether the sign-in card offers member passwords from outside: when they count for someone there."""
        return sso.public_password and (not people.google_ready or people.outside_test_account())

    def public_session_allowed(row):
        if row.get("kind") != "member_password":
            return row.get("kind") == "sso"
        principal = row.get("principal") or ""
        person = hive.db.one("SELECT test_account, role FROM people WHERE id = ?", (principal[5:],)) \
            if principal.startswith("user:u_") else None
        return member_password_outside(person)

    hive.mind_tokens.public_session_allowed = public_session_allowed

    def bootstrap_session(header_token, request: Request):
        """new-hive R1a: a sso-bootstrap session, only on its four allow-listed routes (NewHive.admit), or None."""
        if hive.newhive is None or not header_token:
            return None
        row = hive.db.one("SELECT * FROM sessions WHERE token_hash = ? AND kind = ?",
                          (token_hash(header_token), newhive_mod.BOOTSTRAP_KIND))
        if row is None or not row.get("expires_at") or row["expires_at"] <= time.time():
            return None
        return hive.newhive.admit(row, request, header_token)

    def operator(request: Request, *, check_path=True):
        # The session token comes in the Authorization header only. A token in a URL is kept by proxy logs, browser
        # history and Referer headers; the events WebSocket is the one place that takes ?token=, since a browser
        # cannot set a header there (API.md, Auth).
        header_token = _bearer(request.headers.get("authorization"))
        row = session_for(header_token, request.scope.get("hive_public", False))
        if row is None:
            row = bootstrap_session(header_token, request)
            if row is not None:
                request.state.hive_session = row   # keyview: the response leaves projected for this caller
                return row
            raise HiveError(401, "unauthorized", "log in first")
        # attached before the visibility check, so the 404 it may raise is kept with this person (error_answer)
        request.state.hive_session = row
        if check_path:
            hive.visibility.check_path(viewer(row), request.path_params)   # R13: private/shared/public
        if request.query_params.get("include") == "personal":
            # admin audit of other people's personal minds and swarms on any default list (Visibility.hide_others_personal)
            if role_of(row) != "admin":
                raise HiveError(403, "admin_only", "only a hive admin can do that")
            row = dict(row, include_personal=True)
        request.state.hive_session = row   # keyview: the response leaves projected for this caller
        return row

    def viewer(session):
        from .visibility import Viewer
        return Viewer(session.get("principal") or "user:operator", role_of(session) == "admin",
                      audit=bool(session.get("include_personal")))

    def hidden_researcher(session, agent_id):
        """research.py: a researcher of another person's personal research is read by id (messages, traces, the trace
        archive, logs, memory) only in an admin's explicit audit (?include=personal); otherwise the same 404 as a mind
        that is not there."""
        if hive.visibility.hides(viewer(session), agent_id) and agent_id in hive.research.child_ids_all():
            raise HiveError(404, "not_found", "no such mind")

    def audit_viewer(session):
        """A by-id read keeps admin audit: other people's personal minds are not hidden from it."""
        from .visibility import Viewer
        return Viewer(session.get("principal") or "user:operator", role_of(session) == "admin", audit=True)

    def role_of(session):
        principal = session.get("principal") or "user:operator"
        if session.get("kind") == "member_password" and not principal.startswith("user:u_"):
            return None
        if session.get("kind") == "password" or principal == "user:operator":
            return "admin"  # the hive password is only usable on the hive's own machine
        if principal.startswith("user:u_"):
            person = hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
            if not person or person["disabled"]:
                return None
            # a member password session is never admin, even for a row an admin promoted later (T-101)
            return "member" if session.get("kind") == "member_password" else person["role"]
        return "admin" if principal[5:] in sso.allowed else None  # family sign-in (HIVE_SSO_USERS)

    def admin(request: Request):
        session = operator(request)
        if role_of(session) != "admin":
            raise HiveError(403, "admin_only", "only a hive admin can do that")
        return session

    def policy_writer(session):
        """host-identity r1: who may change approval rules, however they are written (policy routes, roles): a hive
        admin or the hive's owner while they act as owner (ownhive.py: still an enabled admin, so never a demoted owner)."""
        return role_of(session) == "admin" or hive.ownhive.acts_as_owner(viewer(session))

    def control_refusal(session, row):
        """Why a route that acts on this mind refuses this caller, as (status, code, message), or None. A mind the person
        does not see is not found, as everywhere; one they see but neither own nor administer is 403. The rule is
        Viewer.controls (visibility.py's notes say what acting covers). Every route that acts on a mind refuses
        through this, and the may_control and may_sleep flags are exactly "this is None", so a flag cannot drift from
        its route."""
        v = viewer(session)
        if row is None or not v.sees(row):
            return 404, "not_found", "no such mind"
        if not v.controls(row):
            return 403, "owner_only", "only this mind's owner or a hive admin can do that"
        return None

    def require_control(session, agent_id):
        """The live mind row a route acts on, once control_refusal lets this caller act on it."""
        row = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        refused = control_refusal(session, row)
        if refused:
            raise HiveError(*refused)
        return row

    def wakeup_principal(session):
        """G1 checks every user namespace against any directly matching disabled-person row."""
        return hive.visibility.wakeup_principal(session.get("principal"))

    def wakeup_reader(session, agent_id):
        """Text is for the current mind owner or admin; hive ownership alone grants writes only."""
        return hive.visibility.wakeup_text_reader(viewer(session), agent_id)

    def wakeup_access(session, *, agent_id=None, wakeup_id=None, write=False):
        """G1: resolve the stored mind before authorising wakeup reads or operator changes.

        Scheduling may spend the mind owner's money, even when the mind is public. The same
        not-found response covers unknown, invisible and non-writable wakeups.
        """
        principal = wakeup_principal(session)
        if wakeup_id is not None:
            wakeup = hive.db.one("SELECT agent_id FROM wakeups WHERE id = ?", (wakeup_id,))
            agent_id = wakeup["agent_id"] if wakeup else None
        mind = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if mind is None:
            raise HiveError(404, "not_found", "no such wakeup")
        reads_text = wakeup_reader(session, agent_id)
        writes = reads_text or hive.ownhive.acts_as_owner(viewer(session))   # the owner acting as owner, never demoted
        if (write and not writes) or (not write and not reads_text and not viewer(session).sees(mind)):
            raise HiveError(404, "not_found", "no such wakeup")
        return reads_text

    def wakeup_notice(current_session, text):
        """Apply current text authority to wakeup updates/messages and owner/admin-only fire cadence."""
        try:
            event = json.loads(text)
        except ValueError:
            return text
        if not isinstance(event, dict):
            return text
        scheduled = event.get("type") == "message" and isinstance(event.get("message"), dict) and event["message"].get("sender") == "hive:schedule"
        fired = event.get("type") == "wakeup.fired"
        if event.get("type") != "wakeup.updated" and not scheduled and not fired:
            return text
        wakeup = event.get("wakeup")
        if not scheduled and not fired and (not isinstance(wakeup, dict) or not isinstance(wakeup.get("id"), str) or not wakeup["id"]):
            logging.getLogger("hive").warning("Dropped malformed wakeup.updated event")
            return None
        if fired and (not isinstance(event.get("wakeup_id"), str) or not event["wakeup_id"] or not isinstance(event.get("agent_id"), str) or not event["agent_id"]):
            return None
        session = current_session()
        if session is None:
            return None
        try:
            if scheduled:
                wakeup_principal(session)
                if not hive.visibility.event_visible(viewer(dict(session, include_personal=False)), text):
                    return None
                return json.dumps(dict(event, message=hive.visibility.project_person_message(viewer(session), event["message"])))
            if fired:
                if not wakeup_reader(session, event["agent_id"]):
                    return None
                privileged = True
            else:
                privileged = wakeup_access(session, wakeup_id=wakeup["id"])
        except HiveError:
            return None
        if not hive.visibility.event_visible(viewer(dict(session, include_personal=False)), text):
            return None
        if privileged:
            return text
        return json.dumps(dict(event, wakeup=dict(wakeup, text="text hidden")))

    def key_permit(session):
        """OI-13: which assigned keys (options.key) this caller may put on a mind; the key decides whose money pays
        (Hive.payer_for). None: any key (a hive admin or the hive's owner). Otherwise a check, applied only to a key that
        changes (Hive.check_key_use): the caller's own key, or what GET /api/keys offers them from the hive (its
        environment keys, a hive-held provider default; never to a guest or public visitor); never another person's key."""
        if policy_writer(session):
            return None
        me = session.get("principal") or "user:operator"
        hosted = hive.ownhive.access(me) not in ("guest", "public")

        def may_use(key):
            if key.startswith("env:"):
                return hosted
            record = providers.ring["keys"].get(key)
            if record is None:
                # not a key here (sol on f4bb6907): never visible, so its id is never shown or echoed to anyone else; its
                # former owner alone still recognises their own deleted key (Kimi on bef0f01b: providers' tombstone). A
                # changed key naming it is still refused as unknown (check_key_use), exactly as a refused one is
                return providers.removed_by(key, me)   # its tombstone: live records were checked first, just above
            holder = hive.ownhive.key_person(key)   # the same "is this a hive key" predicate billing uses (key_owner)
            if holder is not None:
                return holder == me
            return hosted and providers.ring["defaults"].get(record.get("provider")) == key
        return may_use

    def key_seer(session):
        """keyview (sol on 6dc7a837): which key references this caller may see, by GET /api/keys's own policy
        (key_permit), or None for everything (a hive admin or the hive's owner)."""
        return key_permit(session) if session is not None else None

    def provider_key(name):
        """The key a provider's status describes: its default stored key, else its environment key."""
        return (providers.ring.get("defaults") or {}).get(name) or f"env:{name}"

    def key_seer_for(principal):
        """The key policy for a person outside a request (an Ask turn's frames, built for their asker): as key_seer for
        their own signed-in session; none visible for no one."""
        # as they are now (Kimi on 593fde34): a disabled or unknown person sees no key at all, and a guest is judged
        # by key_permit as a guest
        if not principal or hive.ownhive.access(principal) is None:
            return lambda key: False
        return key_seer({"principal": principal, "kind": "sso"})
    hive.key_seer_for = key_seer_for

    def provider_keys_seen(name, may_see):
        """How many of a provider's keys this caller may see (its stored keys, and its environment key when that holds a
        usable secret). Inventory only: whether they can pay is pay_route's answer, never this count. The free route's key
        is the deploy's, never one anyone holds or sees, so it is never counted."""
        if is_free(name):
            return 0
        stored = sum(1 for r in (providers.ring.get("keys") or {}).values() if r["provider"] == name and may_see(r["id"]))
        env = providers.provider(name).key_env if name in providers.providers else ""
        return stored + (1 if env and os.environ.get(env, "").strip() and may_see(f"env:{name}") else 0)

    def pay_route(name, me):
        """keyview R10 (sol on 26e22ed0, Dot): the key a call by THIS person's own mind on provider `name` would be paid
        with, or None when the gateway would refuse it. The call path's own lookups, read-only (no dispatch, no
        reservation): Gateway.paying_key (with OwnHive.own_key_for), Hive.payer_for, then OwnHive.person_key_check and
        use_check, so active grants, own keys and the owner's public hive-key terms admit exactly as they admit a call.
        Payment entitlement, not visibility: a member granted another person's default key, or a guest on the hive's key,
        can pay with a key they may not see. Reads only, with one inherited exception: Hive.payer_for and use_check read
        OwnHive.owner(), whose ensure_owner stores the first admin as the owner on a hive's first use (once, idempotent,
        the same migration any request reaching it makes)."""
        gw = getattr(hive, "gateway", None)
        if gw is None or name not in providers.providers:
            return None
        proposed = {"id": "", "name": "your mind", "owner": me, "model": f"{name}/", "options": {}}
        if is_free(name):
            # the free route pays with the deploy's key for every named person it admits (free_inference.FreeGate), whatever
            # they have used today: the route, never a key, so it names no key id
            try:
                gw.free_gate.person_for(proposed, principal=me)
            except (GatewayError, AttributeError):
                return None
            return FREE if gw.free_gate.offered() else None
        try:
            key_id, secret = gw.paying_key(proposed, name)
        except GatewayError:
            return None
        if not secret or not str(secret).strip():
            return None   # nothing would pay: an unset or empty secret is refused on the call path too
        key_owner = ((providers.ring.get("keys") or {}).get(key_id) or {}).get("owner")
        payer, _own = hive.payer_for(proposed, key_owner)
        try:
            hive.ownhive.person_key_check(proposed, key_id, user=me)
            hive.ownhive.use_check(proposed, key_id, payer, user=me)
        except HiveError:
            return None
        return key_id

    def session_person(session):
        return (session or {}).get("principal") or "user:operator"

    def on_default_route(session, name):
        """Whether this caller's view of a provider's default-route evidence (readiness, the catalogue's fetch state and
        fetching it) is theirs: an admin or the hive's owner, or someone whose pay_route is that default route."""
        return key_seer(session) is None or pay_route(name, session_person(session)) == provider_key(name)

    def provider_view(session):
        """provider_for for this caller (keyview R10): "can pay" (pay_route) decides connected, configured and models;
        "can see" (key_permit) decides key details (hint, account, source, the keys count). Readiness and the OpenRouter
        catalogue's fetch state describe the hive's default paying configuration: kept only when that is the route this
        caller pays by, else unverified / not shown."""
        me = session_person(session)

        def provider_for(status, may_see):
            name = status["name"]
            seen = provider_keys_seen(name, may_see)
            if is_free(name):
                # the deploy's route, offered to this caller only where the free gate admits them (pay_route); to anyone
                # else (a public visitor where the deploy hasn't opted visitors in) it reads unconfigured, so nothing
                # offers it to them
                return {"keys": seen} if pay_route(name, me) is not None else {"keys": seen, "connected": False,
                                                                                "configured": False}
            if status.get("local") or name == "mock" or not status.get("needs_key", True):
                return {"keys": seen}
            route = pay_route(name, me)
            usable = route is not None
            source = None
            if usable and may_see(route):
                source = "stored" if route in (providers.ring.get("keys") or {}) else "env"
            out = {"keys": seen, "connected": usable, "configured": usable, "source": source}
            if route != provider_key(name):   # readiness was measured on the default route, not theirs
                out.update({"readiness": "unverified", "answer_ready": False})
                if isinstance(status.get("catalog"), dict):
                    out["catalog"] = {"count": status["catalog"].get("count", 0), "fetched_at": None, "error": None}
            return out
        return provider_for

    def keys_projected(session, value):
        """What leaves for this caller (HTTP and events): every key reference they may not see removed (keyview)."""
        may_see = key_seer(session)
        return value if may_see is None else keyview.project(value, may_see, provider_key, provider_for=provider_view(session))

    class KeyViewResponses:
        """keyview over HTTP, at the one boundary every answer crosses (plain ASGI: no task of its own, unlike
        BaseHTTPMiddleware, so a route's context and timing are exactly as without it).
        - Refusals (any JSON answer with status >= 400), for every caller but a hive admin, agent-token and signed-out
          callers included: every string in it (no field exempt: codes are never ids, so they come out as they went) through
          keyview.redact_error, one regex pass by the shared key-id grammar, so no key id, key:<id> budget scope or other
          person's principal reaches someone the key policy (key_permit) does not let see that exact key. A caller with no
          session sees none. Key labels are not matched at all: no refusal names one (keyview R7).
          Internal logs keep the full detail; only the answer is projected.
        - Other JSON answers for a session operator() resolved: an answer whose text names a key-bearing field
          ("options", "key_hint") is parsed and projected (keyview.project); others pass byte for byte. A route that
          projects its own answer (GET /api/agents) marks the request done and its answer passes unheld.
        A held answer is at most LIMIT; past it, or unreadable when it had to be read, it is refused, never sent raw."""

        LIMIT = 8 * 1024 * 1024

        def __init__(self, app):
            self.app = app

        @staticmethod
        def refused(code, message, status=500):
            body = json.dumps({"error": {"code": code, "message": message}}).encode("utf-8")
            return ({"type": "http.response.start", "status": status,
                     "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]},
                    {"type": "http.response.body", "body": body, "more_body": False})

        async def __call__(self, scope, receive, send):
            if scope["type"] != "http":
                return await self.app(scope, receive, send)
            held = {"start": None, "chunks": [], "size": 0, "pass": False, "over": False, "error": False, "text": False}

            async def through(message):
                if held["pass"]:
                    return await send(message)
                if message["type"] == "http.response.start":
                    state = scope.get("state") or {}
                    session = state.get("hive_session")
                    kind = dict(message.get("headers") or []).get(b"content-type", b"")
                    admin_caller = session is not None and role_of(session) == "admin"   # reads the person only
                    error = int(message.get("status") or 200) >= 400
                    json_answer = kind.startswith(b"application/json")
                    text_error = error and kind.startswith(b"text/")   # sol on 04875179: a plain or HTML refusal too
                    if (not json_answer and not text_error) or admin_caller or \
                            (not error and (session is None or state.get("hive_keyview_done"))):
                        held["pass"] = True
                        return await send(message)
                    held["start"], held["error"], held["text"] = message, error, text_error
                    return None
                if message["type"] != "http.response.body":
                    return await send(message)
                if held["over"]:
                    return None   # the refusal was already sent; the rest of the answer is dropped
                held["chunks"].append(message.get("body", b""))
                held["size"] += len(held["chunks"][-1])
                if held["size"] > self.LIMIT:
                    held["over"], held["chunks"] = True, []
                    for part in self.refused("response_too_large", "This answer is too large to send here."):
                        await send(part)
                    return None
                if message.get("more_body"):
                    return None
                body = b"".join(held["chunks"])
                session = (scope.get("state") or {}).get("hive_session")
                text = body.decode("utf-8", "replace")
                try:
                    if held["error"]:
                        may_see = key_seer(session) if session is not None else (lambda key: False)   # no session: none
                        if may_see is not None:
                            me = (session or {}).get("principal")
                            if held["text"]:   # the whole text describes the refusal
                                body = keyview.redact_text(text, may_see, me).encode("utf-8")
                            else:
                                body = json.dumps(keyview.redact_error(json.loads(text), may_see, me)).encode("utf-8")
                    elif keyview.mentions_keys(text) and key_seer(session) is not None:
                        body = json.dumps(keys_projected(session, json.loads(text))).encode("utf-8")
                except Exception:   # fail closed, and always finish: an answer that cannot be projected is never sent,
                    # and the held start is never left open (a fixed 500 instead; sol on 593fde34)
                    logging.getLogger("hive").exception("keyview: an answer could not be projected")
                    for part in self.refused("response_unreadable", "This answer could not be prepared."):
                        await send(part)
                    return None
                start = held["start"]
                headers = [(k, v) for k, v in (start.get("headers") or []) if k.lower() != b"content-length"]
                await send({**start, "headers": headers + [(b"content-length", str(len(body)).encode("latin-1"))]})
                await send({"type": "http.response.body", "body": body, "more_body": False})

            return await self.app(scope, receive, through)

    app.add_middleware(KeyViewResponses)
    from .credentials import RestrictedCredentialGate
    app.add_middleware(RestrictedCredentialGate, hive=hive)   # R2.8 W-a: restricted bridged credentials only reach /mcp

    def agent_from(request: Request):
        agent = hive.authenticate_agent(_bearer(request.headers.get("authorization")), surface="rest")
        if agent is None:
            raise HiveError(401, "unauthorized", "invalid agent token")
        return agent

    async def body(request: Request):
        try:
            data = await request.json()
        except Exception:
            raise HiveError(400, "bad_request", "expected a JSON body")
        if not isinstance(data, dict):
            raise HiveError(400, "bad_request", "expected a JSON object")
        return data

    async def bounded_body(request: Request, limit: int):
        """A JSON object body read as a stream with a running cap: a missing or false Content-Length, or a chunked
        body, cannot get past ``limit`` bytes."""
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit:
                size = f"{limit // 1048576} MB" if limit >= 1048576 else f"{max(1, limit // 1024)} KB"
                raise HiveError(413, "request_too_large", f"this request is limited to {size}")
            chunks.append(chunk)
        try:
            data = json.loads(b"".join(chunks) or b"null")
        except ValueError:
            raise HiveError(400, "bad_request", "expected a JSON body")
        if not isinstance(data, dict):
            raise HiveError(400, "bad_request", "expected a JSON object")
        return data

    async def optional_body(request: Request):
        return await body(request) if await request.body() else {}

    # The refusal of a password sign-in from outside where it may not happen: PublicGate gives it to every login
    # without HIVE_PUBLIC_PASSWORD=1, and the routes below to the operator always and to a member once that flag is off.
    LOCAL_ONLY = {"error": {"code": "password_login_local_only", "message": "sign in with your Google account"}}

    @app.post("/api/auth/login")
    async def login(request: Request):
        if local is not None:   # J1b r1.1 (stand-in r1.0 P2-3): a local-owner hive has no password and no operator session
            raise HiveError(403, "password_signin_off",
                            "this hive signs in only through the OmegaHive app on this computer; open OmegaHive again")
        data = await body(request)
        if str(data.get("email") or "").strip():
            return await member_login(request, data)
        # The operator's session never counts from outside (sso.py), and #82 asked to keep the operator refused there,
        # so from outside the login is refused before the password is read, HIVE_PUBLIC_PASSWORD=1 included: no guess
        # at the hive password is answered or counted from outside.
        if request.scope.get("hive_public", False):
            return JSONResponse(LOCAL_ONLY, status_code=403)
        try:
            password = str(data.get("password", "")).encode("utf-8")
        except UnicodeEncodeError:
            matches = False
        else:
            matches = hmac.compare_digest(password, settings.admin_password.encode("utf-8"))
        if not matches:
            raise HiveError(401, "unauthorized", "wrong password")
        token = secrets.token_urlsafe(32)
        hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "password",
                                    "principal": "user:operator", "expires_at": time.time() + PASSWORD_SESSION_SECONDS})
        return {"token": token}

    # From outside once Google is on, every refused member login gets these words, whether the email is unknown, its
    # password is wrong, or it belongs to someone who is not the test account: the answer never tells which it was.
    WRONG_OR_GOOGLE = "wrong email or password; people in this hive sign in with Google"

    def member_attempt_key(email):
        # Bound retained state by both entry count and identifier size, without looking up membership.
        return hashlib.sha256(email.encode("utf-8", "surrogatepass")).hexdigest()

    async def member_login(request, data):
        """Email + password -> a member_password session for that person (T-101). Every failure is the same 401, and
        from outside wrong guesses wait per typed email. From outside once Google is on, only the test account signs in
        (member_password_outside): anyone else's right password fails like a wrong one."""
        public = request.scope.get("hive_public", False)
        if public and not sso.public_password:
            return JSONResponse(LOCAL_ONLY, status_code=403)   # the same body PublicGate gives the operator's
        wrong = WRONG_OR_GOOGLE if public and people.google_ready else "wrong email or password"
        email, password = people.normal_email(data.get("email")), str(data.get("password", ""))
        attempt_key = member_attempt_key(email)
        if public:
            wait = member_attempts.wait(attempt_key)
            if wait is None:
                raise HiveError(429, "password_login_closed", "too many wrong passwords from outside for this account: "
                                "sign in on the hive's own machine, or ask an admin to reset the password")
            if wait > 0:
                seconds = math.ceil(wait)
                return JSONResponse({"error": {"code": "too_many_attempts", "retry_after_seconds": seconds,
                                               "message": f"too many wrong passwords, try again in {seconds} s"}},
                                    status_code=429, headers={"Retry-After": str(seconds)})
            member_attempts.failed(attempt_key)   # counted before the slow check, so concurrent guesses wait too
        person = await asyncio.to_thread(people.member_for_password, email, password)
        if person is None or (public and not member_password_outside(person)):
            if public:
                logging.getLogger("hive").warning("member password refused from outside")
            raise HiveError(401, "unauthorized", wrong)
        # Verification ran in a worker: a reset/removal/disable may have committed while it was in flight.
        # Recheck the exact verified credential and issue its session in one short transaction, without awaiting.
        with hive.db.transaction():
            current = hive.db.one("SELECT * FROM people WHERE id = ?", (person["id"],))
            if (current is None or current["disabled"] or current["role"] not in ("admin", "member")
                    or current.get("password_hash") != person.get("password_hash")
                    or (public and not member_password_outside(current))):
                raise HiveError(401, "unauthorized", wrong)
            token = secrets.token_urlsafe(32)
            hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "member_password",
                                        "principal": f"user:{person['id']}", "expires_at": time.time() + PASSWORD_SESSION_SECONDS})
            hive.db.update("people", person["id"], {"last_seen_at": now()})
        member_attempts.clear(attempt_key)   # only a still-current right password reopens the account
        return {"token": token}

    @app.get("/api/auth/methods")
    async def auth_methods(request: Request):
        public = request.scope.get("hive_public", False)
        prefix = request.scope.get("root_path", "") or ""
        own = (prefix or "") + "/api/auth/google/start" if people.google_ready else None
        family = sso.login_location((prefix or "") + "/") if sso.enabled else None
        # Everyday sign-in uses the family sign-in when there is one (its Google callback is registered); the hive's
        # own Google flow carries invitations (its callback must be registered in Google for colleagues to join).
        # The hive's own Google flow is offered first whenever it is set up: only it checks the Google subject a person
        # is bound to (and hd), and the family sign-in refuses every bound person, so offering the family login to them
        # would loop. A family session already in the browser is still used by POST /api/auth/sso on page load.
        primary = own or family
        # ``password``: the operator's hive password counts here, which is never from outside (sso.py), so the card
        # offers that way in only on the hive's own machine; ``member_password``: members' passwords count here for
        # someone, from outside the test account once Google is on.
        out = {"password": not public, "public": public,
               "member_password": (not public) or member_password_offered_outside(),
               "sso": {"enabled": bool(own) or sso.enabled, "provider": "google",
                       "login_url": primary, "invite_login_url": own,
                       "invites": people.google_ready}}
        if local is not None:   # J1: the Welcome page signs in through the app's one-time link, never a password
            out["local_owner"] = True
            out["member_password"] = False
            out["password"] = False   # J1b r1.1: and the login route refuses
        return out

    if local is not None:   # J1 r2 A/B5: the static sign-in page, its script, the code exchange, the Welcome status
        localowner.install_routes(app, local, hive, run_in_threadpool, operator)

    def _signin_cookie_attrs(request: Request):
        """The hive's sign-in cookies' attributes (hive_signin, and the hive_oauth state binding): one source for setting
        and expiring each (Google start/callback, logout), so the browser treats both as the same cookie. Host-only
        (no Domain), HttpOnly, SameSite=Lax, Secure on https or behind the public prefix."""
        prefix = request.scope.get("root_path", "") or ""
        return {"path": prefix + "/", "httponly": True, "samesite": "lax",
                "secure": request.headers.get("x-forwarded-proto", request.url.scheme) == "https" or bool(prefix)}

    @app.get("/api/auth/google/start")
    async def google_start(request: Request, invite: str = ""):
        browser = secrets.token_urlsafe(32)
        response = RedirectResponse(people.start(invite or None, browser), status_code=303)
        response.set_cookie(OAUTH_COOKIE, browser, max_age=900, **_signin_cookie_attrs(request))
        return response

    @app.get("/api/auth/google/callback")
    async def google_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        prefix = request.scope.get("root_path", "") or ""
        home = (prefix or "") + "/"

        def done(response):   # the browser binding is single-use: cleared on every outcome
            response.delete_cookie(OAUTH_COOKIE, **_signin_cookie_attrs(request))
            return response

        if error:
            error_code = "google_cancelled" if error == "access_denied" else "google_refused"
            return done(RedirectResponse(f"{home}?signin_error={error_code}", status_code=303))
        try:
            person, token = await people.callback(code, state, request.cookies.get(OAUTH_COOKIE, ""))
        except SignInError as exc:
            return done(RedirectResponse(f"{home}?signin_error={exc.code}", status_code=303))
        except Exception:   # anything unexpected still ends this sign-in attempt and clears its browser binding
            logging.getLogger("hive").exception("google sign-in callback failed")
            return done(RedirectResponse(f"{home}?signin_error=signin_failed", status_code=303))
        await run_in_threadpool(hive.personal.ensure_quietly, f"user:{person['id']}")   # first sign-in: their mind, asleep
        response = RedirectResponse(home, status_code=303)
        response.set_cookie(SIGNIN_COOKIE, token, max_age=people.signin_ttl, **_signin_cookie_attrs(request))
        return done(response)

    # ---- person-owned Google connector: separate from Google identity sign-in -------------------

    def google_session(request, expected=None):
        session = operator(request)
        if not session.get("principal") or role_of(session) is None:
            raise HiveError(401, "unauthorized", "log in first")
        if expected is not None and (session.get("token_hash") != expected.get("token_hash") or
                                     session["principal"] != expected["principal"]):
            raise HiveError(401, "identity_changed", "the signed-in person changed; try again")
        return session

    async def google_body(request, required):
        data = await bounded_body(request, GOOGLE_CONNECTOR_BODY_MAX)
        if set(data) != set(required):
            raise HiveError(400, "bad_request", "unexpected or missing Google connector fields")
        return data

    def google_cookie_attrs(request):
        attrs = _signin_cookie_attrs(request)
        # Consent always returns to the configured public callback, even when
        # the person started on another supported path alias of this hive.
        callback = hive.google_connector.redirect_uri
        attrs["path"] = (urlsplit(callback).path if callback else
                         (request.scope.get("root_path", "") or "") + "/api/connectors/google/callback")
        return attrs

    def google_top_level(request):
        # The host returns a URL for top-level consent; an app frame never receives Google credentials.
        if request.headers.get("sec-fetch-dest", "") in ("iframe", "frame", "fencedframe"):
            raise HiveError(403, "top_level_required", "open Google consent in the top-level browser")

    @app.get("/api/connectors/google")
    async def google_connector_status(request: Request):
        session = google_session(request)
        result = await run_in_threadpool(hive.google_connector.status, session["principal"])
        google_session(request, session)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/connectors/google/config")
    async def google_connector_config(request: Request):
        admin(request)
        data = await google_body(request, ("client_id", "client_secret"))
        if not all(isinstance(data[key], str) and 0 < len(data[key]) <= 2048 for key in data):
            raise HiveError(400, "bad_request", "Google client fields must be bounded nonempty strings")
        # Re-read authentication after reading the body, before the private configuration write.
        admin(request)
        return await run_in_threadpool(hive.google_connector.configure_client, data["client_id"], data["client_secret"])

    @app.post("/api/connectors/google/start")
    async def google_connector_start(request: Request):
        google_top_level(request)
        session = google_session(request)
        await google_body(request, ())
        browser = secrets.token_urlsafe(32)
        result = await run_in_threadpool(hive.google_connector.start, google_session(request, session), browser)
        google_session(request, session)
        response = JSONResponse(result, headers={"Cache-Control": "no-store"})
        response.set_cookie(GOOGLE_CONNECTOR_COOKIE, browser, max_age=900, **google_cookie_attrs(request))
        return response

    @app.get("/api/connectors/google/callback")
    async def google_connector_callback(request: Request, code: str = "", state: str = "", error: str = ""):
        home = (request.scope.get("root_path", "") or "") + "/"

        def done(suffix):
            response = RedirectResponse(home + suffix, status_code=303)
            response.headers["Cache-Control"] = "no-store"
            response.delete_cookie(GOOGLE_CONNECTOR_COOKIE, **google_cookie_attrs(request))
            return response

        try:
            google_top_level(request)
            if error:
                return done("?google_connector_error=cancelled")
            if not code or not state or len(code) > 4096 or len(state) > 256:
                return done("?google_connector_error=connection_failed")
            # Top-level navigation has no bearer header. Only complete()'s saved live session/person,
            # one-use state and HttpOnly browser binding authorize completion; no attribution field does.
            await run_in_threadpool(hive.google_connector.complete, state, code,
                                    request.cookies.get(GOOGLE_CONNECTOR_COOKIE, ""))
        except Exception:
            # Neither provider error strings nor authorization codes/state enter redirects or logs.
            return done("?google_connector_error=connection_failed")
        return done("?google_connector=connected")

    @app.put("/api/connectors/google/minds/{agent_id}")
    async def google_connector_mind(agent_id: str, request: Request):
        session = google_session(request)
        data = await google_body(request, ("allowed",))
        if type(data["allowed"]) is not bool:
            raise HiveError(400, "bad_request", "allowed must be a boolean")
        result = await run_in_threadpool(hive.google_connector.grant_mind,
                                        google_session(request, session), agent_id, data["allowed"])
        google_session(request, session)
        return result

    @app.post("/api/connectors/google/disconnect")
    async def google_connector_disconnect(request: Request):
        session = google_session(request)
        await google_body(request, ())
        result = await run_in_threadpool(hive.google_connector.disconnect, google_session(request, session))
        google_session(request, session)
        return result

    async def google_calendar_query(request):
        data = await bounded_body(request, GOOGLE_CONNECTOR_BODY_MAX)
        required = {"op", "time_min", "time_max"}
        if not required <= set(data) or not set(data) <= required | {"limit"}:
            raise HiveError(400, "bad_request", "unexpected or missing Google connector fields")
        if data["op"] != "calendar.read":
            raise HiveError(400, "unsupported_operation", "only calendar.read is available")
        return {"time_min": data["time_min"], "time_max": data["time_max"], "limit": data.get("limit", 20)}

    @app.post("/api/connectors/google/operations")
    async def google_connector_operation(request: Request):
        session = google_session(request)
        query = await google_calendar_query(request)
        result = await run_in_threadpool(hive.google_connector.calendar_read,
                                        google_session(request, session), query)
        google_session(request, session)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @app.post("/api/agent/connectors/google/operations")
    async def agent_google_connector_operation(request: Request):
        agent_from(request)
        query = await google_calendar_query(request)

        def current_allowed():
            agent = agent_from(request)
            if not hive.google_connector.mind_allowed(agent):
                raise HiveError(403, "connector_owner_consent_required", "this mind needs its owner's Google consent")
            if hive.policy.decide(agent, "calendar-read")[0] != "allow":
                raise HiveError(403, "policy_denied", "calendar-read is not allowed by this mind's policy")
            return agent

        def read():
            agent = current_allowed()
            result = hive.google_connector.calendar_read(agent["owner"], query, agent_id=agent["id"])
            # The core also fences ownership/grant changes around upstream work. The route rechecks current
            # authentication and any policy tightening before publishing a result to the calling mind.
            current = current_allowed()
            if current["id"] != agent["id"] or current.get("owner") != agent.get("owner"):
                raise HiveError(403, "connector_owner_changed", "this mind's owner changed; try again")
            return result

        return JSONResponse(await run_in_threadpool(read), headers={"Cache-Control": "no-store"})

    @app.get("/api/auth/invite/{token}")
    async def invite_preview(token: str):
        return people.invite_preview(token)

    # ---- registered services, capabilities, grants, exact approvals (hive/core/services.py) ----

    services = hive.services

    def service_from(request: Request):
        row = services.authenticate(_bearer(request.headers.get("authorization")))
        if row is None:
            raise HiveError(401, "unauthorized", "invalid service token")
        return row

    @app.post("/api/services/enrol")
    async def services_enrol(request: Request):
        session = admin(request)
        data = await body(request)
        return services.enrol(data.get("name"), by=session.get("principal") or "user:operator", ttl_minutes=data.get("ttl_minutes", 15))

    @app.post("/api/services/register")
    async def services_register(request: Request):
        if request.scope.get("hive_public"):
            raise HiveError(403, "local_only", "services register from this machine only")
        data = await body(request)
        return services.register(_bearer(request.headers.get("authorization")), data,
                                 request.client.host if request.client else "")

    @app.post("/api/services/operations/{operation_id}/ack")
    async def services_operation_ack(operation_id: str, request: Request):
        if request.scope.get("hive_public"):
            raise HiveError(403, "local_only", "services register from this machine only")
        acknowledged = services.acknowledge(operation_id, _bearer(request.headers.get("authorization")))
        offer_refresh.schedule()   # an enrolled service may change what Create · Code offers
        return acknowledged

    @app.get("/api/services/operations/{operation_id}")
    async def services_operation(operation_id: str, request: Request):
        if request.scope.get("hive_public"):
            raise HiveError(403, "local_only", "services register from this machine only")
        return services.operation(operation_id, _bearer(request.headers.get("authorization")))

    @app.post("/api/local/restart-prepare")
    async def restart_prepare(request: Request):
        """The Mac restart script's one try (Jon 2026-10-18): ask each awake mind, residents in keep aside, to sleep
        once. No retry, no stop, no force; what refused is reported and the script then decides not to restart."""
        if not settings.restart_prepare:
            raise HiveError(404, "not_found", "not found")
        if request.scope.get("hive_public"):
            raise HiveError(403, "local_only", "restart prepare answers this machine only")
        try:
            expected = restart_token_file.read_text().strip()
        except OSError:
            expected = ""
        given = _bearer(request.headers.get("authorization"))
        if not expected or not given or not hmac.compare_digest(given.encode(), expected.encode()):
            raise HiveError(401, "unauthorized", "restart prepare needs this start's token")
        data = await body(request) if (await request.body()).strip() else {}
        if set(data) - {"keep"}:
            raise HiveError(400, "bad_request", f"unknown fields: {sorted(set(data) - {'keep'})}")
        keep = data.get("keep", [])
        if not (isinstance(keep, list) and len(keep) <= 100 and all(isinstance(k, str) for k in keep)):
            raise HiveError(400, "bad_request", "keep must be a list of at most 100 mind ids")
        return await run_in_threadpool(hive.sleep_for_restart, keep)

    @app.get("/api/services")
    async def services_list(request: Request):
        admin(request)
        return services.list()

    @app.post("/api/services/{service_id}/enable")
    async def services_enable(service_id: str, request: Request):
        admin(request)
        enabled = services.set_enabled(service_id, True)
        offer_refresh.schedule()
        return enabled

    @app.post("/api/services/{service_id}/disable")
    async def services_disable(service_id: str, request: Request):
        admin(request)
        disabled = services.set_enabled(service_id, False)
        offer_refresh.schedule()
        return disabled

    @app.delete("/api/services/{service_id}")
    async def services_remove(service_id: str, request: Request):
        admin(request)
        removed = services.remove(service_id)
        offer_refresh.schedule()
        return removed

    @app.post("/api/services/heartbeat")
    async def services_heartbeat(request: Request):
        return services.view(service_from(request))

    @app.get("/api/services/capabilities/{capability_id}")
    async def services_capability(capability_id: str, request: Request):
        return services.capability_status(service_from(request), capability_id)

    @app.delete("/api/services/capabilities/{capability_id}")
    async def services_capability_revoke(capability_id: str, request: Request):
        admin(request)
        return services.revoke_capability(capability_id)

    # ---- linkage slice 4 (r3.6 §b.5, §b.6, §b.6.1): the proposal-test service routes. Code's service token only (Bearer
    # header), never a browser route, 16 KB bodies (§G rule 6); every answer is minds.canonical bytes, replays byte for byte.

    def _canonical_answer(answer):
        status, data = answer
        return Response(content=data, status_code=status, media_type="application/json")

    @app.post("/api/services/proposal-tests/{test_id}/preparation")
    async def proposal_test_preparation(test_id: str, request: Request):
        service = service_from(request)
        data = await bounded_body(request, SERVICE_BODY_MAX)
        return _canonical_answer(hive.proposal_tests.bind(service, test_id, data))

    @app.post("/api/services/proposal-tests/{test_id}/sandbox-runs")
    async def proposal_test_sandbox_run(test_id: str, request: Request):
        # Registered Code service only; this dedicated cap does not widen any
        # ordinary hold/status route or create a browser execution endpoint.
        from .code_project_tests import read_body, launch
        service = service_from(request)
        data = await read_body(hive, request)
        return _canonical_answer(await launch(hive, service, test_id, data))

    @app.get("/api/services/proposal-tests/{test_id}/sandbox-runs/{launch_key}")
    async def proposal_test_sandbox_result(test_id: str, launch_key: str, request: Request):
        from .code_project_tests import read_result
        return _canonical_answer(read_result(hive, service_from(request), test_id, launch_key))

    @app.post("/api/services/proposal-tests/{test_id}/holds")
    async def proposal_test_hold(test_id: str, request: Request):
        service = service_from(request)
        data = await bounded_body(request, SERVICE_BODY_MAX)
        return _canonical_answer(hive.proposal_tests.admit(service, test_id, data))

    @app.get("/api/services/proposal-tests/{test_id}/holds")
    async def proposal_test_hold_by_key(test_id: str, request: Request, launch_key: str = ""):
        service = service_from(request)
        if set(request.query_params) != {"launch_key"} or len(request.query_params.getlist("launch_key")) != 1:
            raise HiveError(400, "bad_request", "the read by key takes exactly one launch_key")
        return _canonical_answer(hive.proposal_tests.read_by_key(service, test_id, launch_key))

    @app.get("/api/services/proposal-tests/{test_id}/holds/{hold_id}")
    async def proposal_test_hold_read(test_id: str, hold_id: str, request: Request):
        return _canonical_answer(hive.proposal_tests.read(service_from(request), test_id, hold_id))

    @app.post("/api/services/proposal-tests/{test_id}/holds/{hold_id}/settle")
    async def proposal_test_hold_settle(test_id: str, hold_id: str, request: Request):
        service = service_from(request)
        data = await bounded_body(request, SERVICE_BODY_MAX)
        return _canonical_answer(hive.proposal_tests.settle(service, test_id, hold_id, data))

    @app.post("/api/code/capability")
    async def code_capability_human(request: Request):
        """A person's capability on a task: needs an active collaborator grant for them (admins only for now)."""
        session = admin(request)
        data = await body(request)
        principal = session.get("principal") or "user:operator"
        grant_id = data.get("grant_id")
        if grant_id:
            grant = hive.db.one("SELECT * FROM goal_grants WHERE id = ?", (grant_id,))
            if grant is None or grant["principal"] != principal or grant["goal_id"] != data.get("task_id") \
                    or grant["revoked_at"] or grant["expires_at"] <= time.time():
                raise HiveError(403, "grant_invalid", "no active collaborator grant for you on that task")
        svc = services.by_name(str(data.get("service", "omegacode")))
        if svc["name"] == "omegacode":
            hive.code.require_intended_release()
        goal = hive.db.one("SELECT swarm_id FROM goals WHERE id = ?", (data.get("task_id"),)) if data.get("task_id") else None
        return services.issue(svc["id"], actor=principal, kind="human", task_id=data.get("task_id"),
                              swarm_id=goal["swarm_id"] if goal else data.get("swarm_id"),
                              repository_id=str(data.get("repository_id", "")), actions=data.get("actions") or ["read", "search", "events"],
                              paths=data.get("paths"), argv_prefixes=data.get("argv_prefixes"),
                              ttl_seconds=data.get("ttl_seconds", 900), grant_id=grant_id, by=principal)

    @app.post("/api/agent/code/capability")
    async def code_capability_agent(request: Request):
        """A mind's capability on a goal it holds, bound to its own token."""
        agent = agent_from(request)
        data = await body(request)
        purposes = [k for k in ("delegated", "proposal_test", "copy_apply") if isinstance(data, dict) and k in data]
        if len(purposes) > 1:     # linkage r3.6 §b / copy-apply seam §2: the three purpose branches are mutually exclusive
            raise HiveError(400, "purpose_exclusive", f"one purpose per capability, not {purposes}")
        if "copy_apply" in data:  # slice 3 (copy-apply seam §2): the request controller's one-proposal copy capability
            if not hive.settings.copy_apply_claims:
                raise HiveError(503, "copy_apply_off", "copy_apply capabilities are off on this hive (HIVE_COPY_APPLY_CLAIMS)")
            hive.code.require_intended_release()
            return hive.minds.issue_copy_apply(agent, _bearer(request.headers.get("authorization")), data)
        if "proposal_test" in data:  # slice 4 (linkage r3.6 §b.1): the request controller's proposal-test stage claim
            if not hive.settings.proposal_test_claims:
                raise HiveError(503, "proposal_tests_off", "proposal_test capabilities are off on this hive (HIVE_PROPOSAL_TEST_CLAIMS)")
            hive.code.require_intended_release()
            return hive.proposal_tests.issue(agent, _bearer(request.headers.get("authorization")), data)
        if "delegated" in data:   # r2.13.1: a child's host-issued delegated capability on its instruction's origin task
            svc = services.by_name(str(data.get("service") or "omegacode"))
            if svc["name"] == "omegacode":
                hive.code.require_intended_release()
            return hive.minds.issue_delegated(agent, _bearer(request.headers.get("authorization")), data)
        goal = hive.db.one("SELECT * FROM goals WHERE id = ?", (data.get("task_id"),))
        if goal is None or goal["claimed_by"] != agent["id"] or goal["status"] != "claimed" or goal["swarm_id"] != agent["swarm_id"]:
            raise HiveError(403, "goal_not_owned", "a mind gets a coding capability only for a task it holds")
        # Security fix (2026-10-04, found by OmegaCode): requested paths used to be dropped, so a request narrowed
        # to one file became a whole-repository capability.  Narrowing is now kept, and unknown fields refuse.
        unknown = set(data) - {"task_id", "service", "repository_id", "actions", "paths", "argv_prefixes", "ttl_seconds"}
        if unknown:
            raise HiveError(400, "bad_request", f"unknown fields: {sorted(unknown)}")
        paths = data.get("paths")
        if paths is not None:
            if not isinstance(paths, list) or len(paths) > 200 or not all(
                    isinstance(p, str) and p and len(p) <= 512 and not p.startswith("/") and ".." not in p.split("/")
                    for p in paths):
                raise HiveError(400, "bad_paths", "paths are up to 200 relative paths inside the repository")
        svc = services.by_name(str(data.get("service", "omegacode")))
        if svc["name"] == "omegacode":
            hive.code.require_intended_release()
        return services.issue(svc["id"], actor=agent["id"], kind="agent", task_id=goal["id"], swarm_id=goal["swarm_id"],
                              repository_id=str(data.get("repository_id", "")), actions=data.get("actions") or [],
                              paths=paths, argv_prefixes=data.get("argv_prefixes"), ttl_seconds=min(int(data.get("ttl_seconds", 900)), 3600),
                              member_token=_bearer(request.headers.get("authorization")), by=f"agent:{agent['id']}")

    @app.get("/api/agent/approvals/{approval_id}")
    async def agent_approval(approval_id: str, request: Request):
        token = _bearer(request.headers.get("authorization"))
        service = services.authenticate(token)
        row = hive.db.one("SELECT * FROM approvals WHERE id = ?", (approval_id,))
        if service is None:
            agent = hive.authenticate_agent(token, surface="rest")
            if agent is None:
                raise HiveError(401, "unauthorized", "invalid token")
            if row is None or row["agent_id"] != agent["id"]:
                raise HiveError(404, "not_found", f"no approval {approval_id}")
        if row is None:
            raise HiveError(404, "not_found", f"no approval {approval_id}")
        return services.approval_view(row)

    @app.post("/api/agent/approvals/{approval_id}/redeem")
    async def agent_approval_redeem(approval_id: str, request: Request):
        service = service_from(request)
        if service["name"] == "omegacode":
            hive.code.require_local_enrolment()
        data = await body(request)
        return services.redeem(approval_id, data.get("binding"))

    @app.get("/api/goals/{goal_id}/grants")
    async def goal_grants(goal_id: str, request: Request):
        token = _bearer(request.headers.get("authorization"))
        if services.authenticate(token) is None:
            agent = hive.authenticate_agent(token, surface="rest")
            goal = hive.db.one("SELECT claimed_by FROM goals WHERE id = ?", (goal_id,))
            if agent is None or goal is None or goal["claimed_by"] != agent["id"]:
                operator(request)
        return services.grants(goal_id)

    @app.post("/api/goals/{goal_id}/grants")
    async def goal_grant_add(goal_id: str, request: Request):
        session = admin(request)
        data = await body(request)
        principal = data.get("principal") or session.get("principal") or "user:operator"
        return services.grant(goal_id, principal, data.get("scope", "edit"), data.get("workspace_id"),
                              data.get("ttl_minutes", 120), by=session.get("principal") or "user:operator")

    @app.delete("/api/goals/{goal_id}/grants/{grant_id}")
    async def goal_grant_remove(goal_id: str, grant_id: str, request: Request):
        admin(request)
        return services.revoke_grant(goal_id, grant_id)

    # ---- harnesses: invite codes and the MCP endpoint (hive/core/mcp.py) -----------------------

    harnesses = hive.harnesses

    def public_base(request: Request):
        prefix = request.scope.get("root_path", "") or (settings.base_path.split(",")[0] if settings.base_path else "")
        base = os.environ.get("HIVE_PUBLIC_BASE", "").rstrip("/") or settings.public_url.rstrip("/")
        return base + prefix

    @app.post("/api/harness-invites")
    async def harness_invite(request: Request):
        session = admin(request)
        data = await body(request)
        view, code = await run_in_threadpool(harnesses.invite, str(data.get("harness", "")), data.get("name"), str(data.get("swarm_id", "")),
                                             data.get("role_id"), data.get("ttl_minutes", 60), session.get("principal") or "user:operator",
                                             data.get("billing"))
        from .mcp import join_steps
        mcp_url = public_base(request) + "/mcp"
        return view | {"code": code, "mcp_url": mcp_url, "local_url": settings.public_url.rstrip("/") + "/mcp",
                       "setup": join_steps(view["harness"], mcp_url, code)}

    @app.get("/api/harnesses")
    async def harness_catalogue(request: Request):
        """The supported outside CLIs and how each joins ({url} and {code} unfilled); any signed-in caller."""
        operator(request)
        from .mcp import catalogue
        return {"harnesses": catalogue()}

    @app.get("/api/harness-invites")
    async def harness_invites(request: Request):
        admin(request)
        return harnesses.list()

    @app.get("/api/harness-invites/refused")
    async def harness_invites_refused(request: Request):
        """Refused connections to /mcp, newest first, so the invitation screen can say a try failed and why."""
        admin(request)
        return harnesses.refused()

    @app.get("/api/harness-invites/{invite_id}")
    async def harness_invite_status(invite_id: str, request: Request):
        admin(request)
        return harnesses.get(invite_id)

    @app.delete("/api/harness-invites/{invite_id}")
    async def harness_invite_revoke(invite_id: str, request: Request):
        admin(request)
        return await run_in_threadpool(harnesses.revoke, invite_id)

    @app.api_route("/mcp", methods=["GET", "POST", "DELETE"])
    async def mcp_endpoint(request: Request):
        if request.method != "POST":
            return Response(status_code=405, headers={"Allow": "POST"})  # JSON responses only; no server-sent stream
        member_credential = _bearer(request.headers.get("authorization"))
        # This first authentication excludes invite-redemption identities from proof eligibility;
        # do not fold it into harnesses.member, which preserves ordinary MCP join behavior.
        proof_arrival_member = await run_in_threadpool(lambda: hive.authenticate_agent(member_credential, surface="mcp"))
        # R2.8: a bridged-session credential's restriction (pending, mixed context), read from its own row
        bridge = (await run_in_threadpool(hive.credentials.context, member_credential)
                  if member_credential and member_credential.startswith("ohb1_") else None)
        proof_arrival_tasks = frozenset(row["id"] for row in hive.db.all(
            "SELECT id FROM goals WHERE claimed_by = ? AND swarm_id = ? AND status = 'claimed'",
            (proof_arrival_member["id"], proof_arrival_member["swarm_id"]))) if proof_arrival_member else frozenset()
        agent = await run_in_threadpool(harnesses.member, member_credential)
        if agent is None:
            await run_in_threadpool(harnesses.refuse, member_credential)
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32001, "message": "invalid, used or expired code"}},
                                status_code=401, headers={"WWW-Authenticate": "Bearer"})
        if not harnesses.rate_ok(agent["id"]):
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32002, "message": "slow down: too many calls"}}, status_code=429)
        proof_eligible = bool(proof_arrival_member and proof_arrival_member["id"] == agent["id"]
                              and proof_arrival_member["swarm_id"] == agent["swarm_id"]
                              and proof_arrival_member["token_hash"] == agent["token_hash"])
        proof_owned_tasks = proof_arrival_tasks if proof_eligible else frozenset()
        raw = await request.body()
        if len(raw) > 256 * 1024:
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "request too large"}}, status_code=413)
        try:
            message = json.loads(raw)
        except ValueError:
            return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}, status_code=400)
        hive.db.update("agents", agent["id"], {"last_active_at": now()})
        with member_request(app, hive, agent, member_credential, eligible=proof_eligible, owned_tasks=proof_owned_tasks):
            if isinstance(message, list):
                replies = []
                for m in message[:20]:   # a batch's whoami activates the credential for the calls after it
                    r = await (harnesses.handle(agent, m, credential=bridge) if bridge is not None else harnesses.handle(agent, m))
                    if bridge is not None and bridge["status"] == "pending":
                        bridge = await run_in_threadpool(hive.credentials.context, member_credential) or bridge
                    if r is not None:
                        replies.append(r)
                return JSONResponse(replies) if replies else Response(status_code=202)
            reply = await (harnesses.handle(agent, message, credential=bridge) if bridge is not None
                           else harnesses.handle(agent, message))
            return JSONResponse(reply) if reply is not None else Response(status_code=202)

    # ---- roles (hive/core/roles.py) ----------------------------------------------------------

    @app.get("/api/roles")
    async def roles_list(request: Request):
        operator(request)
        return hive.roles.list()

    @app.post("/api/roles")
    async def roles_create(request: Request):
        admin(request)
        return await run_in_threadpool(hive.roles.create, await body(request))

    @app.patch("/api/roles/{role_id}")
    async def roles_update(role_id: str, request: Request):
        session = admin(request)
        return await run_in_threadpool(hive.roles.update, role_id, await body(request), session.get("principal") or "user:operator")

    @app.post("/api/roles/{role_id}/duplicate")
    async def roles_duplicate(role_id: str, request: Request):
        admin(request)
        return await run_in_threadpool(hive.roles.duplicate, role_id)

    @app.delete("/api/roles/{role_id}")
    async def roles_remove(role_id: str, request: Request):
        session = admin(request)
        return await run_in_threadpool(hive.roles.remove, role_id, session.get("principal") or "user:operator")

    # ---- R2: edit what runs in the hive (hive/core/code.py) -----------------------------------

    code = Code(hive, gateway.client)
    hive.code = code

    @app.api_route("/api/agent/code/relay/{path:path}", methods=["GET", "POST"])
    async def code_relay_agent(path: str, request: Request):
        """A mind's Code call through the hive: the mind authenticates with its member token (X-Hive-Token), presents
        the hc1 capability it was issued, and the hive forwards it on a proved connection (Code R1.4+)."""
        member = request.headers.get("x-hive-token", "")
        if not member or hive.authenticate_agent(member, surface="code-relay") is None:
            raise HiveError(401, "unauthorized", "invalid agent token")
        chunks, total = [], 0
        async for chunk in request.stream():   # the raw bytes, capped: Code binds the proof to their exact digest
            total += len(chunk)
            if total > 4 * 1024 * 1024:
                raise HiveError(413, "request_too_large", "this request is limited to 4 MB")
            chunks.append(chunk)
        try:
            status, content, ctype = await code.relay_agent(member, _bearer(request.headers.get("authorization")),
                                                            request.method, "/" + path, request.url.query, b"".join(chunks))
        except CodeError as exc:
            note_host_denial(request.scope, exc)
            raise
        return Response(content=content, status_code=status, media_type=ctype.split(";")[0])

    @app.get("/api/agent/code/helper-instruction")
    async def code_helper_instruction(request: Request):
        """A request helper's own request instruction (Minds.helper_instruction); no request id is accepted."""
        return hive.minds.helper_instruction(agent_from(request))

    @app.get("/api/agent/code/review-packet")
    async def code_review_packet(request: Request):
        """A second-opinion mind's own held reviews' packets (CodeControllerEngine.review_packet_for); no goal id is
        accepted."""
        from .code_controller_engine import EngineError
        try:
            return await hive.code_controller.review_packet_for(agent_from(request))
        except EngineError as exc:
            raise HiveError(exc.status, exc.code, str(exc))

    @app.post("/api/agent/code/test-context")
    async def code_test_context_agent(request: Request):
        """The request controller's own proposal-test references for one retained proposal (code_test_intents)."""
        agent = agent_from(request)
        if not hive.settings.proposal_test_claims:
            raise HiveError(503, "proposal_tests_off", "proposal_test capabilities are off on this hive (HIVE_PROPOSAL_TEST_CLAIMS)")
        hive.code.require_intended_release()
        data = await body(request)
        from .code_test_intents import controller_lookup
        return await controller_lookup(hive.ask.intents, agent, data)

    @app.get("/api/agent/code/repositories")
    async def code_repositories_for_minds(request: Request):
        agent_from(request)
        return await run_in_threadpool(code.repositories)

    @app.get("/api/code/targets")
    async def code_targets(request: Request):
        admin(request)
        return await run_in_threadpool(code.targets)

    @app.get("/api/code/targets/{target_id}/tree")
    async def code_tree(target_id: str, request: Request):
        admin(request)
        return await run_in_threadpool(code.tree, target_id)

    @app.post("/api/code/open")
    async def code_open(request: Request):
        session = admin(request)
        data = await body(request)
        return await code.open(str(data.get("target", "")), session.get("principal") or "user:operator")

    @app.post("/api/code/attach")
    async def code_attach(request: Request):
        session = admin(request)
        data = await body(request)
        return await code.attach(str(data.get("task_id", "")), str(data.get("workspace_id", "")),
                                 str(data.get("repository_id", "")), session.get("principal") or "user:operator")

    @app.post("/api/code/select")
    async def code_select(request: Request):
        session = admin(request)
        data = await body(request)
        return await run_in_threadpool(code.select_target, str(data.get("task_id", "")), str(data.get("repository_id", "")),
                                       session.get("principal") or "user:operator")

    @app.api_route("/api/code/proxy/{path:path}", methods=["GET", "POST"])
    async def code_proxy(path: str, request: Request):
        session = admin(request)
        query = [(k, v) for k, v in request.query_params.multi_items() if k not in ("task_id", "grant_id", "repository_id", "token")]
        status, content, ctype = await code.proxy(session.get("principal") or "user:operator", request.method, "/" + path,
                                                  query, await request.body(), request.query_params.get("task_id", ""),
                                                  request.query_params.get("grant_id") or None,
                                                  request.query_params.get("repository_id", ""))
        return Response(content=content, status_code=status, media_type=ctype.split(";")[0])

    # ---- people and invitations (admins) ---------------------------------------------------

    @app.get("/api/people")
    async def people_list(request: Request):
        admin(request)
        return {"people": people.list(), "invites": people.invites(), "google_ready": people.google_ready, "member_passwords": local is None}

    @app.post("/api/invites")
    async def invites_create(request: Request):
        session = admin(request)
        data = await body(request)
        view, token = people.invite(data.get("email"), data.get("name", ""), data.get("role", "member"),
                                    data.get("days", 7), by=session.get("principal") or "user:operator",
                                    kind=data.get("kind", "member"), limit_usd=data.get("limit_usd"), terms=data.get("terms"))
        prefix = request.scope.get("root_path", "") or ""
        base = os.environ.get("HIVE_PUBLIC_BASE", "").rstrip("/")
        path = os.environ.get("HIVE_INVITE_PATH", "/omegahive/") if not prefix else prefix + "/"
        return view | {"link": f"{base}{path}?invite={token}"}

    @app.delete("/api/invites/{invite_id}")
    async def invites_revoke(invite_id: str, request: Request):
        admin(request)
        return people.revoke_invite(invite_id)

    def member_password_enabled():
        if local is not None:
            raise HiveError(403, "password_signin_off", "this hive signs in through its one-time link")

    def no_test_account_mark(data):
        """The one test account comes from the environment (people.py): a request that tries to set the mark is refused,
        whatever the value, so a client that still sends it learns why."""
        if "test_account" in data:
            raise HiveError(400, "bad_request", f"the test account comes from {TEST_ACCOUNT_EMAIL}, not from "
                            "this request")

    SHOWN_ONCE = "Shown once: pass it to the member now; the hive keeps only a hash and cannot show it again."

    @app.post("/api/people/members")
    async def people_add_member(request: Request):
        member_password_enabled()
        session = admin(request)
        data = await body(request)
        no_test_account_mark(data)
        view, password = people.add_member(data.get("email"), data.get("name", ""), by=_who(session))
        return JSONResponse({"person": view, "password": password, "note": SHOWN_ONCE}, status_code=201)

    @app.get("/api/people/{person_id}")
    async def people_get(person_id: str, request: Request):
        admin(request)
        return people.view(people.get(person_id))

    @app.post("/api/people/{person_id}/password")
    async def people_reset_password(person_id: str, request: Request):
        member_password_enabled()
        session = admin(request)
        view, password, ended = people.reset_password(person_id, by=_who(session))
        member_attempts.clear(member_attempt_key(view["email"]))   # an admin's reset opens a closed account
        return {"person": view, "password": password, "ended_sessions": ended, "note": SHOWN_ONCE}

    @app.delete("/api/people/{person_id}/password")
    async def people_remove_password(person_id: str, request: Request):
        member_password_enabled()
        session = admin(request)
        view, ended = people.remove_password(person_id, by=_who(session))
        return {"person": view, "ended_sessions": ended}

    # ---- own hive H1 (hive/core/ownhive.py): the owner, limits on your own keys, use invites, asking for a limit ------

    @app.get("/api/hive/own")
    async def own_hive(request: Request):
        return await run_in_threadpool(hive.ownhive.view, viewer(operator(request)))

    @app.put("/api/hive/own")
    async def own_hive_set(request: Request):
        v = viewer(operator(request))
        hive.ownhive.require_owner(v)   # route level, before the body (H1.1); set_settings checks again
        return await run_in_threadpool(hive.ownhive.set_settings, v, await body(request))

    @app.post("/api/hive/own/claim")
    async def own_hive_claim(request: Request):
        v = viewer(operator(request))
        out = await run_in_threadpool(hive.ownhive.claim, v, await body(request))
        offer_refresh.schedule()   # the foundation's swarms move to the new owner now, not at the next restart
        return out

    @app.get("/api/me/key-limits")
    async def my_key_limits(request: Request):
        return await run_in_threadpool(hive.ownhive.mine, viewer(operator(request)))

    # ---- app platform P2: a person's consent to an app's swarm template ----------------------------------------------

    def _app_swarm_person(request):
        v = viewer(operator(request))
        hive.ownhive.require_person_or_owner(v)
        return v.principal

    @app.get("/api/me/app-swarms/{program_id}/{template_id}")
    async def my_app_swarm_card(program_id: str, template_id: str, request: Request):
        """The consent card: exactly what the app would set up, and what consent binds."""
        return await run_in_threadpool(hive.person_swarms.card, _app_swarm_person(request), program_id, template_id)

    @app.post("/api/me/app-swarms/{program_id}/{template_id}/consent")
    async def my_app_swarm_consent(program_id: str, template_id: str, request: Request):
        principal = _app_swarm_person(request)
        return await run_in_threadpool(hive.person_swarms.consent, principal, program_id, template_id, await body(request))

    @app.post("/api/me/app-swarms/{program_id}/{template_id}/withdraw")
    async def my_app_swarm_withdraw(program_id: str, template_id: str, request: Request):
        return await run_in_threadpool(hive.person_swarms.withdraw, _app_swarm_person(request), program_id, template_id)

    # ---- app platform P14: a person app opens in the person's own context; install is the admin review ---------------

    @app.post("/api/programs/{program_id}/person-context")
    async def person_app_open(program_id: str, request: Request):
        """Open a person app: its person's own context, the P2 card, or the host key card. Never spends or wakes."""
        return await run_in_threadpool(hive.person_apps.open, _app_swarm_person(request), program_id)

    @app.post("/api/programs/{program_id}/person-context/reset")
    async def person_app_reset(program_id: str, request: Request):
        """"Set up again": the one host action out of a bad binding."""
        return await run_in_threadpool(hive.person_apps.reset, _app_swarm_person(request), program_id)

    @app.put("/api/me/key-limits/self")
    async def my_key_limit_self(request: Request):
        v = viewer(operator(request))
        hive.ownhive.require_person_or_owner(v)
        data = await body(request)
        if isinstance(data, dict) and "expected_month_usd" in data:   # only if it is still the total they were shown
            return await run_in_threadpool(hive.ownhive.set_total_if, v, data)
        return await run_in_threadpool(hive.ownhive.set_limit, v, "self", data)

    @app.post("/api/me/key-limits/grants")
    async def my_key_limit_grant(request: Request):
        v = viewer(operator(request))
        hive.ownhive.require_person_or_owner(v)
        data = await body(request)
        return await run_in_threadpool(hive.ownhive.set_limit, v, data.get("grantee"), data)

    @app.delete("/api/me/key-limits/{limit_id}")
    async def my_key_limit_revoke(limit_id: str, request: Request):
        hive.ownhive.require_person_or_owner(viewer(operator(request)))
        return await run_in_threadpool(hive.ownhive.revoke_limit, viewer(operator(request)), limit_id)

    def p4b_person(request: Request):
        # A positive preflight prevents generic bootstrap/fallback/include handling from turning a nonhuman
        # credential into either a person or a non-401 result. Existing operator transport checks still run.
        token = _bearer(request.headers.get("authorization"))   # the header only, as operator()
        def positive(row):
            if (not isinstance(row, dict) or row.get("kind") not in ("password", "sso", "member_password")
                    or (row.get("principal") is not None and not isinstance(row["principal"], str))
                    or (request.scope.get("hive_public", False) and not public_session_allowed(row))):
                raise HiveError(401, "unauthorized", "a current signed-in person is required")
            # Validate expiry before session_for's inherited numeric comparison can encounter malformed storage.
            return human_session(hive, row, lambda: role_of(row))
        raw = hive.db.one("SELECT * FROM sessions WHERE token_hash = ?", (token_hash(token),)) if token else None
        positive(raw)
        try:
            session = operator(request)
            named = positive(session)
        except (TypeError, ValueError, AttributeError):
            # A concurrent malformed session/principal is not allowed to escape the dedicated human401 gate.
            raise HiveError(401, "unauthorized", "a current signed-in person is required") from None
        return Person(viewer(session), named)

    @app.get("/api/me/decisions")
    async def me_decisions(request: Request):
        reads = MeDecisions(hive, lambda: p4b_person(request))
        return await run_in_threadpool(reads.decisions, list(request.query_params.multi_items()))

    @app.get("/api/me/studio-sessions")
    async def me_studio_sessions(request: Request):
        reads = MeDecisions(hive, lambda: p4b_person(request))
        return await run_in_threadpool(reads.studio_sessions, list(request.query_params.multi_items()))

    @app.get("/api/me/studio-recent")
    async def me_studio_recent(request: Request):
        from .studio_recent import recent_creations
        who = viewer(operator(request))
        return await run_in_threadpool(recent_creations, hive, who)

    @app.get("/api/me/limit-requests")
    async def my_limit_requests(request: Request):
        return await run_in_threadpool(hive.ownhive.requests, viewer(operator(request)))

    @app.post("/api/me/limit-requests")
    async def my_limit_request_create(request: Request):
        v = viewer(operator(request))
        return await run_in_threadpool(hive.ownhive.ask, v, await body(request))

    @app.post("/api/me/limit-requests/{request_id}/decide")
    async def my_limit_request_decide(request_id: str, request: Request):
        v = viewer(operator(request))
        return await run_in_threadpool(hive.ownhive.decide, v, request_id, await body(request))

    @app.patch("/api/people/{person_id}")
    async def people_update(person_id: str, request: Request):
        session = admin(request)
        data = await body(request)
        no_test_account_mark(data)
        view = people.update(person_id, data.get("role"), data.get("disabled"), by=session.get("principal"),
                           clear_google=data.get("clear_google_identity") is True)
        if data.get("disabled"):
            member_attempts.clear(member_attempt_key(view["email"]))   # disabling drops the password, and its count with it
        if data.get("role") is not None or data.get("disabled") is not None:
            # The hive's owner is its first admin until a claim (ownhive.owner), and the foundation's swarms follow the
            # owner only when the foundation's ensure runs. A hive whose first admin is made here after it started kept
            # Research bound to the operator, refusing every hand-over as no_researcher, until it restarted.
            offer_refresh.schedule()
        return view

    @app.post("/api/auth/sso")
    async def auth_sso(request: Request):
        signin = request.cookies.get(SIGNIN_COOKIE, "")
        own = people.person_for_signin(signin)
        if own is not None:
            row, expires = own
            token = secrets.token_urlsafe(32)
            hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                        "principal": f"user:{row['id']}", "expires_at": float(expires),
                                        "signin_hash": people.signin_hash(signin)})
            if hive.personal.mind_row(f"user:{row['id']}") is None:
                await run_in_threadpool(hive.personal.ensure_quietly, f"user:{row['id']}")
            return {"token": token, "user": {"id": row["id"], "email": row["email"], "name": row["name"] or row["email"],
                                             "role": row["role"]}, "expires_at": expires}
        person = sso.person(request.headers.get("cookie", ""))
        if person is None:
            prefix = request.scope.get("root_path", "") or ""
            raise HiveError(401, "sso_required", "sign in with your Google account",
                            {"login_url": sso.login_location(prefix + "/") if sso.enabled else None})
        # The family sign-in verified this Google address (linked account): if it is an enabled named person here, the
        # session is that person, so person-only surfaces (Flow, reviews) work. Jon approved this mapping 2026-10-04.
        # Bound people, and people who need the Workspace check, sign in through the hive's Google flow: this path
        # carries no Google sub or hd and cannot verify a Google subject. The decision is made before any write, and
        # the decision, any invitation acceptance and the session commit together (one transaction).
        try:
            with hive.db.transaction():
                named = people.family_person(person.get("email"), person.get("name") or "")
                if named is not None:
                    token = secrets.token_urlsafe(32)
                    hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                                "principal": f"user:{named['id']}", "expires_at": float(person["expires"])})
        except SignInError as exc:
            prefix = request.scope.get("root_path", "") or ""
            raise HiveError(exc.status, exc.code, exc.message,
                            {"login_url": (prefix + "/api/auth/google/start") if people.google_ready else None}) from None
        if named is not None:
            if hive.personal.mind_row(f"user:{named['id']}") is None:   # a family sign-in mapped to a named person
                await run_in_threadpool(hive.personal.ensure_quietly, f"user:{named['id']}")
            return {"token": token, "user": {"id": named["id"], "email": named["email"], "name": named["name"] or person["name"],
                                             "role": named["role"]}, "expires_at": person["expires"]}
        if not person.get("allowed"):
            raise HiveError(403, "not_invited", "this account has not been invited to this hive; ask an admin for an invitation")
        token = secrets.token_urlsafe(32)
        hive.db.insert("sessions", {"token_hash": token_hash(token), "created_at": now(), "kind": "sso",
                                    "principal": f"user:{person['username']}", "expires_at": float(person["expires"])})
        return {"token": token, "user": {"username": person["username"], "name": person["name"], "role": person["role"]},
                "expires_at": person["expires"]}

    @app.post("/api/auth/logout")
    async def auth_logout(request: Request):
        token = _bearer(request.headers.get("authorization"))
        # The hive's own Google sign-in (hive_signin): revoke it and every bearer exchanged from it, whether the
        # request carries the cookie, a bearer that came from it, or both; then expire the HttpOnly cookie, which the
        # browser cannot clear itself. (The family webhost's omega_session is read-only to the hive: sso.py.)
        # Independent fence BEFORE waiting for any DB/turn teardown. The token hash stays host-only.
        if token:
            hive.app_ask.mark_session(token_hash(token))
        hive.app_ask.mark_signin(people.signin_hash(request.cookies.get(SIGNIN_COOKIE, "")))
        leaving = set()   # host-identity r1: whose work ends with this sign-out
        with hive.db.transaction():
            own = hive.db.one("SELECT signin_hash, principal, kind FROM sessions WHERE token_hash = ?", (token_hash(token),)) if token else None
            if (own or {}).get("kind") == newhive_mod.BOOTSTRAP_KIND:
                # new-hive R1a (r1.2.1 §B): a setup helper never signs its person out or ends their work; the launcher
                # retires its own bearer over the control socket (bootstrap-retire), exactly
                raise HiveError(403, "bootstrap_session_restricted", "this setup session cannot sign out")
            if (own or {}).get("principal"):
                leaving.add(own["principal"])
            if token:
                hive.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash(token),))
            for signin_hash in {people.signin_hash(request.cookies.get(SIGNIN_COOKIE, "")), (own or {}).get("signin_hash")}:
                signin = hive.db.one("SELECT person_id FROM signins WHERE token_hash = ?", (signin_hash,)) if signin_hash else None
                if signin:
                    leaving.add(f"user:{signin['person_id']}")
                people.end_signin(signin_hash)
        for principal in leaving:
            await run_in_threadpool(hive.app_ask.fence_person, principal)
        kept = []
        for principal in leaving - {"user:operator"}:   # the machine's own password login is not one person's work
            kept += await run_in_threadpool(hive.sessions.end_for, principal)
        response = JSONResponse({"ok": True, "sessions_kept": len(kept)})   # r1.1: sessions that refused to end (end_for)
        response.delete_cookie(SIGNIN_COOKIE, **_signin_cookie_attrs(request))
        return response

    @app.get("/api/auth/me")
    async def auth_me(request: Request):
        row = operator(request)
        # Attribution only: keyed per deployment, domain-separated, and bound to the verified session (session_ref.py).
        auth_session_ref = session_refs.ref(row["token_hash"])
        principal = row.get("principal") or "user:operator"
        person = None
        if principal.startswith("user:u_"):
            p = hive.db.one("SELECT * FROM people WHERE id = ?", (principal[5:],))
            person = {"id": p["id"], "email": p["email"], "name": p["name"] or p["email"]} if p else None
        elif principal != "user:operator":
            person = {"id": principal[5:], "email": None, "name": principal[5:].capitalize()}
        local = (row.get("kind") or "password") == "password" or principal == "user:operator"
        return {"principal": principal, "auth_session_ref": auth_session_ref, "kind": row.get("kind") or "password", "expires_at": row.get("expires_at"),
                "role": role_of(row), "person": person,
                # the same identity the host gives apps (program_actions.person_viewer), for frames' context (Surface)
                "person_kind": "operator" if local else "person", "local_operator": local}

    # ---- per-person app drafts (Surface Studio slice 2): never shared, never published -----------------------------

    def _draft_scope(request, swarm_id):
        session = operator(request)
        hive.visibility.check_path(viewer(session), {"swarm_id": str(swarm_id or "")})
        return session.get("principal") or "user:operator"

    @app.put("/api/apps/{program_id}/drafts/{draft_key}")
    async def app_draft_save(program_id: str, draft_key: str, request: Request):
        data = await body(request)
        swarm_id = str((data or {}).get("swarm_id") or "")
        principal = _draft_scope(request, swarm_id)
        return await run_in_threadpool(hive.app_drafts.save, program_id, swarm_id, principal, draft_key, data)

    @app.get("/api/apps/{program_id}/drafts")
    async def app_draft_list(program_id: str, request: Request, swarm_id: str = ""):
        return hive.app_drafts.list(program_id, swarm_id, _draft_scope(request, swarm_id))

    @app.get("/api/apps/{program_id}/drafts/{draft_key}")
    async def app_draft_read(program_id: str, draft_key: str, request: Request, swarm_id: str = ""):
        return hive.app_drafts.read(program_id, swarm_id, _draft_scope(request, swarm_id), draft_key)

    @app.delete("/api/apps/{program_id}/drafts/{draft_key}")
    async def app_draft_delete(program_id: str, draft_key: str, request: Request, swarm_id: str = ""):
        return hive.app_drafts.delete(program_id, swarm_id, _draft_scope(request, swarm_id), draft_key)

    # ---- your look and layout (Surface v1): one validated variant per person, data only -------------------------

    def _ui_base_rev(request):
        """The revision a conditional look write was made against (X-UI-Base-Rev: <rev>), or None for an unconditional
        write. A dedicated header, not If-Match: this is a revision number, not an entity tag."""
        values = request.headers.getlist("x-ui-base-rev")
        if not values:
            return None
        value = values[0].strip()
        if len(values) != 1 or not value.isascii() or not value.isdigit() or len(value) > 18:
            raise HiveError(400, "bad_request", "X-UI-Base-Rev must be one look revision (a non-negative integer)")
        return int(value)

    def _ui_write(write):
        try:
            return write()
        except StalePrefs as e:
            raise HiveError(409, "stale_ui_prefs", str(e), {"current": e.current})

    @app.get("/api/me/ui")
    async def me_ui(request: Request):
        return ui_prefs.get(operator(request).get("principal") or "user:operator")

    @app.put("/api/me/ui")
    async def me_ui_put(request: Request):
        principal = operator(request).get("principal") or "user:operator"
        from .ui_prefs import MAX_BODY_BYTES
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            raise HiveError(413, "too_large", f"look preferences are limited to {MAX_BODY_BYTES} bytes")
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise HiveError(413, "too_large", f"look preferences are limited to {MAX_BODY_BYTES} bytes")
        try:
            data = json.loads(raw or b"null")
        except ValueError:
            raise HiveError(400, "bad_request", "expected a JSON body")
        if not isinstance(data, dict):
            raise HiveError(400, "bad_request", "expected a JSON object")
        base_rev = _ui_base_rev(request)
        try:
            return _ui_write(lambda: ui_prefs.put(principal, data, base_rev))
        except UiPrefsError as e:
            raise HiveError(400, "invalid_ui_variant", str(e))

    @app.delete("/api/me/ui")
    async def me_ui_reset(request: Request):
        principal = operator(request).get("principal") or "user:operator"
        base_rev = _ui_base_rev(request)
        return _ui_write(lambda: ui_prefs.reset(principal, base_rev))

    # ---- hive, models, swarms ---------------------------------------------------------------

    # ---- Settings: one admin summary of how this hive is configured (no secrets), and password rotation ----------

    @app.get("/api/settings")
    async def settings_summary(request: Request):
        admin(request)
        import shutil as _shutil
        from ..supervisor import sandbox as mind_sandbox

        def _json_env(name, default):
            try:
                return json.loads(os.environ.get(name, "") or "null") or default
            except ValueError:
                return default
        disk = _shutil.disk_usage(settings.data_dir)
        data_bytes = 0
        for p in settings.data_dir.rglob("*"):
            try:
                if p.is_file() and not p.is_symlink():
                    data_bytes += p.stat().st_size
            except OSError:
                pass
        paths = ["/" + p.strip("/") for p in (settings.base_path or "").split(",") if p.strip("/")]
        prefix = request.scope.get("root_path", "") or (paths[0] if paths else "")
        return {
            "hive": {"name": hive.name, "build": hive.updates.running_build, "release": hive.updates.running_release,
                     "started_at": hive.updates.started_at, "supervised": hive.updates.supervised, "base_paths": paths},
            "signin": {"password": True, "password_from_env": bool(os.environ.get("HIVE_ADMIN_PASSWORD")),
                       "family_google": bool(sso.enabled),
                       "hive_google": {"configured": bool(people.google_ready),
                                       "callback_path": prefix + "/api/auth/google/callback",
                                       "note": "a Google client is set; its callback must also be registered in Google Cloud"}},
            "disk": {"free_bytes": disk.free, "total_bytes": disk.total, "hive_data_bytes": data_bytes},
            "apps": {"homes": _json_env("HIVE_APP_HOMES", {}),
                     "sandbox_apps": [a for a in os.environ.get("HIVE_SANDBOX_RUN_APPS", "").split(",") if a.strip()],
                     "sandbox_runtimes": sorted(_json_env("HIVE_SANDBOX_RUNTIMES", {}).keys()),
                     "local_only_swarms": _json_env("HIVE_LOCAL_ONLY_SWARMS", [])},
            "mind_sandbox": mind_sandbox.report(settings.default_driver),   # what this process found at start (#111)
        }

    @app.post("/api/settings/password/rotate")
    async def rotate_password(request: Request):
        """A new operator password, shown once to the admin who asked; every password session ends. Never logged."""
        admin(request)
        if os.environ.get("HIVE_ADMIN_PASSWORD"):
            raise HiveError(409, "password_from_env", "this hive's password is set by HIVE_ADMIN_PASSWORD; change it there")
        new = secrets.token_urlsafe(18)
        path = settings.data_dir / "admin-password"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(new)
        tmp.chmod(0o600)
        tmp.replace(path)
        settings.admin_password = new
        ended = hive.db.execute("DELETE FROM sessions WHERE kind = 'password'").rowcount
        return {"password": new, "ended_password_sessions": ended,
                "note": "Shown once. Password sign-ins (including this browser if it used the password) must sign in again."}

    @app.get("/api/hive")
    async def hive_summary(request: Request):
        session = operator(request)
        out = await run_in_threadpool(hive.summary, viewer(session))
        out["installed_map"] = await run_in_threadpool(installed_map.status)  # DB synchronization stays off the event loop
        out["code_resources"] = _code_aggregate.status()  # bounded diagnostic DATA, no admission
        return out

    # ---- feedback and bug reports: what the hive adds to a report, and the hand-off to a report service (feedback.py;
    # the page that builds and shows the report: hive/ui/src/features/feedback) ----

    @app.get("/api/feedback")
    async def feedback_context(request: Request):
        """For any signed-in person: the hive's version, which hive it is, where reports go (the board says whether it is
        public yet), and the error answers this person met most recently, each with its id."""
        session = operator(request)
        return await run_in_threadpool(hive.feedback.context, _who(session))

    @app.get("/api/feedback/logs")
    async def feedback_logs(request: Request):
        """For any signed-in person: what the hive puts in the logs file they save from the feedback area (feedback.py
        logs), their own recent requests and error answers, or for an admin the whole hive's with its own log lines."""
        session = operator(request)
        return await run_in_threadpool(hive.feedback.logs, _who(session), role_of(session) == "admin")

    @app.post("/api/feedback/send")
    async def feedback_send(request: Request):
        """Hand a report to the report service HIVE_FEEDBACK_TO names. The page sends it only after the person has
        seen all of it and pressed Send; the hive passes it on as it is, the requests, errors and log lines it may
        carry cleaned once more, with the service's token when HIVE_FEEDBACK_TOKEN_FILE names one."""
        operator(request)
        report = await bounded_body(request, FEEDBACK_MAX_BYTES)
        try:
            return await run_in_threadpool(hive.feedback.send, report)
        except LookupError as e:
            raise HiveError(409, "no_report_service", str(e))
        except ValueError as e:
            raise HiveError(400, "bad_report", str(e))
        except RuntimeError as e:
            raise HiveError(502, "report_not_delivered", str(e))

    @app.post("/api/feedback/drafts", status_code=201)
    async def feedback_draft(request: Request):
        """A mind drafts a report for its person (hive-report-problem): kept in that person's feedback area until they
        dismiss or use it, and sent nowhere from here. A person's own report goes through the area, so a person's
        session is refused here."""
        agent = hive.authenticate_agent(_bearer(request.headers.get("authorization")), surface="rest")
        if agent is None:
            operator(request)   # no credentials or a stale one: its own 401
            raise HiveError(403, "mind_only", "a mind drafts reports here; a person writes theirs in the feedback area")
        data = await body(request)
        return await run_in_threadpool(hive.feedback_drafts.draft, agent, data)

    @app.get("/api/feedback/drafts")
    async def feedback_drafts(request: Request):
        """The drafts minds left in this person's feedback area, newest first; never another person's."""
        session = operator(request)
        return await run_in_threadpool(hive.feedback_drafts.list, _who(session))

    @app.delete("/api/feedback/drafts/{draft_id}", status_code=204)
    async def feedback_draft_delete(draft_id: str, request: Request):
        """The person dismisses a draft or has used it; another person's draft is not found, as an unknown one is."""
        session = operator(request)
        await run_in_threadpool(hive.feedback_drafts.delete, _who(session), draft_id)
        return Response(status_code=204)

    @app.get("/api/models")
    async def models(request: Request):
        session = operator(request)
        may_see = key_seer(session)
        if may_see is None:
            return hive.models()
        # keyview R10: only the providers this caller could pay with (pay_route: the gateway's own admission), whether or
        # not they may see the key that pays
        me = session_person(session)
        return hive.models(can_pay=lambda name: pay_route(name, me) is not None)

    # ---- providers: keys, the OpenRouter catalogue, per-model routing (hive/core/providers.py) ----

    @app.get("/api/providers")
    async def providers_list(request: Request):
        session = operator(request)
        return keys_projected(session, providers.list())

    @app.get("/api/providers/{name}")
    async def provider_status(name: str, request: Request):
        session = operator(request)
        # keyview R13 (sol on d15396ca): refreshing the default key's account verifies with that credential, so only an
        # admin or a caller on its route may cause it (as the catalogue and endpoints); seeing the key is not enough.
        # What the answer shows is still the key policy's (keys_projected). POST /api/keys/{id}/refresh stays on
        # visibility (key_permit): an explicit check of a key the listing shows this caller, by that policy.
        if name in providers.providers and on_default_route(session, name):
            await providers.account(name)
        return keys_projected(session, providers.status(name))

    @app.put("/api/providers/{name}/key")
    async def provider_set_key(name: str, request: Request):
        admin(request)
        data = await body(request)
        status = await providers.set_key(name, data.get("key", ""))
        keys_changed()   # the one place a key change is announced: providers, Create · Code's offer, held refusals
        return status

    @app.delete("/api/providers/{name}/key")
    async def provider_remove_key(name: str, request: Request, force: int = 0):
        session = admin(request)
        providers.provider(name)
        key_id = providers.ring["defaults"].get(name)
        if key_id:
            await remove_stored_key(key_id, session, force)
        else:
            keys_changed()
        return providers.status(name)

    @app.get("/api/subscriptions/status")
    async def subscriptions_status(request: Request):
        """What is left of each attached plan (subscription_cli.subscription_status): the provider's own reading from its
        bridge beside the hive's day guard. The plan name and credit balance are the owner's own data, so only the hive
        owner sees any line; anyone else gets an empty list (nothing about the plans, not even which are attached)."""
        session = operator(request)
        gate = getattr(hive.gateway, "subscription_gate", None)
        if gate is None or not hive.ownhive.is_owner(session_person(session)):
            return {"subscriptions": []}
        from .config import SUBSCRIPTIONS
        from .subscription_cli import subscription_status
        names = [n for n in SUBSCRIPTIONS if n in settings.providers]
        rows = await run_in_threadpool(lambda: [subscription_status(gate, n) for n in names])
        return {"subscriptions": rows}

    # ---- spending limits at every level (hive/core/budgets.py) ------------------------------------

    @app.get("/api/budgets")
    async def budgets_list(request: Request):
        session = operator(request)
        from .limits_view import scope_visible
        who = viewer(session)
        rows = await run_in_threadpool(hive.budgets.overview)   # a member sees no row about a team or mind hidden from them
        return [r for r in rows if scope_visible(hive, who, r["scope"])]

    @app.get("/api/budgets/limits")
    async def budgets_limits(request: Request):
        """The Limits page (limits_view.limits): the hive cap, each person's allowance, the caps someone set and the old
        form defaults that can be removed. Admins only, as setting limits is; rows still pass the viewer's visibility
        (defence in depth)."""
        session = admin(request)
        from .limits_view import limits
        return await run_in_threadpool(limits, hive.budgets, viewer(session))

    @app.post("/api/budgets")
    async def budgets_add(request: Request):
        admin(request)
        data = await body(request)
        rule = hive.budgets.set(str(data.get("scope", "")), str(data.get("period", "month")), data.get("limit_usd"), str(data.get("note", "")))
        hive.events.publish("budgets.updated", budgets=hive.budgets.overview())
        return rule

    @app.delete("/api/budgets/{rule_id}")
    async def budgets_remove(rule_id: str, request: Request):
        admin(request)
        result = hive.budgets.remove(rule_id)
        hive.events.publish("budgets.updated", budgets=hive.budgets.overview())
        return result

    # ---- keys: many per provider, owned by a person, assigned to minds ------------------------------

    def keys_listing():
        return providers.keys(usage=hive.key_usage(), minds_by_key=hive.minds_by_key())

    def keys_changed():
        hive.events.publish("providers.updated", providers=providers.list())
        offer_refresh.schedule()   # a key may fund or stop funding Create · Code
        hive.model_refusal_rekeyed()   # a mind whose calls now go out with another key asks its provider again; no other

    async def remove_stored_key(key_id, session, force=0):
        me = session.get("principal") or "user:operator"
        holder = hive.ownhive.key_person(key_id)
        if not policy_writer(session) and (holder is None or holder != me):   # app platform P3a: members remove their own keys
            raise HiveError(403, "admin_only", "only a hive admin or the key's owner can remove a key")
        rows = []
        for row in hive.db.all("SELECT id, options FROM agents WHERE deleted = 0"):
            options = json.loads(row["options"] or "{}")
            if options.get("key") == key_id:
                rows.append((row["id"], options))
        locked = [agent_id for agent_id, options in rows if options.get("key_locked")]
        if locked and not (force and holder == me):
            raise HiveError(409, "locked_minds", "minds locked to this key would stop; their owner can remove it anyway",
                            {"minds": locked})
        providers.remove_key_id(key_id)
        unassigned = 0
        for agent_id, options in rows:
            if options.get("key_locked"):
                continue   # a locked mind keeps the key id and stops (402 key_unavailable), never moves to another payer
            if await run_in_threadpool(hive.unassign_stored_key, agent_id, key_id, by=me):
                unassigned += 1
        hive.forget_removed_key_if_unused(key_id)   # keyview: a tombstone only while some mind still names the key
        keys_changed()
        return {"ok": True, "unassigned": unassigned}

    @app.get("/api/keys")
    async def keys_list(request: Request):
        session = operator(request)
        listing = keys_listing()
        may_use = key_permit(session)
        if may_use is not None:   # OI-13 r1.1: a member is offered exactly the keys they may assign (never others' keys;
            listing = [k for k in listing if may_use(k["id"])]   # a guest never sees the host's keys, own hive H1)
        return listing

    @app.post("/api/keys")
    async def keys_add(request: Request):
        session = operator(request)
        data = await body(request)
        owner = session.get("principal") or "user:operator"
        if role_of(session) != "admin" and data.get("default"):
            raise HiveError(403, "admin_only", "only a hive admin can set the hive's default key")
        # gateway r1a (plan §2.6, r1.2): an optional month_usd is the key owner's ONE total monthly limit on all their
        # keys (grantee self, key *), written with the key. r1ab.3 (Dot's ruling on the stand-in r1ab.2 P1): no write is
        # ever undone, so a failed or concurrent request can only leave the cap the same or lower:
        # - a total that narrows the live one (no end, and no higher) is written FIRST, before the key; r1ab.5: decided
        #   and written in one transaction (ownhive.write_total), so a total someone set meanwhile is never overwritten
        #   by a stale decision; if anything after it fails, the lower cap stays (the safe direction);
        # - any other total (higher, the first one, or over a total with an end) raises, and is written LAST, after the
        #   key is stored and the default switched, and only if the live total is still the one this request first
        #   read: a total set meanwhile stands, and the 200 says monthly_total_applied false with the one that governs;
        # - the key is stored as a non-default first and the default switched afterwards (explicit, or the first key of
        #   a provider), so removing it never loses the previous default (r1ab.1, providers._commit). Only a key this
        #   request added is ever removed (r1ab.5, Kimi r1ab.4 #3);
        # - r1ab.4 (Dot's T-KEY1 ruling): a raise that fails before its commit is 503 limit_not_raised, retryable (a
        #   committed write is never reported failed: its notices cannot raise here); the same person sending the same
        #   provider's key again (their own stored key, providers.own_key) carries on from where it stopped instead of
        #   409 duplicate_key, under the same order.
        # month_usd and the retry are read only with HIVE_MIND_GATEWAY=1 (r1ab.2); unset, as on 56b2dbfc.
        from .ask import gateway_enabled
        gw = gateway_enabled()
        month = data.get("month_usd") if gw and "month_usd" in data else None
        make_default = data["default"] if isinstance(data.get("default"), bool) else None
        if role_of(session) != "admin":
            # a member's key is never the hive default, not even the first key of a provider: a missing `default`
            # would otherwise make it the default, and every mind without a key would pay with it (Dot on #459)
            make_default = False
        provider_name = str(data.get("provider", ""))
        existing = providers.own_key(provider_name, data.get("key", ""), owner) if gw else None
        written = applied = False
        # The starting limit (Jon 2026-11-09, HIVE_START_LIMIT_MONTH_USD, $50): a key an admin or the hive's owner adds
        # while nothing would govern a paid call yet brings a month limit, so a fresh install's first paid call is
        # admitted (Budgets.paid_without_cap) and still bounded. Never for a member, never over a limit that exists.
        # - gateway on: the request names no month_usd and the owner has no live all-keys total; it then goes through the
        #   month_usd path below unchanged (check_total, then write_total last, only if still unchanged), with the
        #   starting figure as the amount. A retry that found the key stored gets it only while there is still no total.
        # - gateway off: after the key is stored, the hive month total, set only while the hive has none (one
        #   transaction, Budgets.seed_start_total, the Limits page's own write).
        start_usd = hive.budgets.start_limit()
        may_start = start_usd > 0 and policy_writer(session)
        start_own = False
        if (gw and month is None and may_start and hive.ownhive.total_row(owner) is None
                and not hive.budgets.start_blocked_by()):   # never over an operator's cap (as gateway off)
            try:
                hive.ownhive.check_total(owner, start_usd, viewer(session))
            except HiveError:
                pass   # this owner may not hold an all-keys total: no starting limit, the key is added as before
            else:
                month, start_own = start_usd, True
        if month is not None:
            hive.ownhive.check_total(owner, month, viewer(session))   # every authorization before any write
            written, seen = await run_in_threadpool(hive.ownhive.write_total, viewer(session), month)
            applied = written
        if existing is not None:
            view, added = providers.key_view(providers.key_record(existing)), False
        else:
            try:
                view = await providers.add_key(provider_name, data.get("key", ""), data.get("label", ""), owner=owner,
                                               make_default=False if month is not None else make_default)
            except ProviderError as exc:
                # own-key one-step (sol on b7de1e5b): the refusal stays 409 duplicate_key, flag on or off, but says when
                # the stored key is exactly the caller's own (providers.own_key: the same provider, owner and secret,
                # compared in constant time), with its id and never the secret, so a retry after a lost answer is
                # recognised exactly; anyone else's copy gets no such detail
                mine = providers.own_key(provider_name, data.get("key", ""), owner) if exc.code == "duplicate_key" else None
                if mine is None:
                    raise
                raise HiveError(409, "duplicate_key", exc.message, {"own": True, "key_id": mine}) from None
            added = True

        def governing():
            row = hive.ownhive.total_row(owner)
            return round(float(row["month_usd"]), 6) if row else None

        if month is not None or not added:
            try:
                if make_default is True or (month is not None and make_default is None
                                            and not providers.has_default(view["provider"])):
                    providers.update_key(view["id"], default=True)
            except BaseException as exc:
                try:
                    if added:   # a key this request only found is never removed
                        providers.remove_key_id(view["id"])
                        hive.forget_removed_key_if_unused(view["id"])   # just added, so no mind names it: no tombstone
                except BaseException as undo:   # Kimi r1ab.2 #3: the cause stays attached
                    raise undo from exc
                finally:
                    keys_changed()
                raise
            if month is not None and not written:
                try:
                    applied, _ = await run_in_threadpool(hive.ownhive.write_total, viewer(session), month, seen)
                except (sqlite3.Error, OSError, HiveError) as exc:   # before the commit (Kimi r1ab.4 #5)
                    if not start_own and isinstance(exc, HiveError):
                        raise   # a HiveError passes as is for a total the request asked for
                    if not start_own:
                        keys_changed()   # the key and its default stand; the old cap governs them
                        raise HiveError(503, "limit_not_raised",
                                        "The key was added, but your monthly limit was not raised. Try again.",
                                        {"key_id": view["id"], "provider": view["provider"],
                                         "monthly_total_usd": governing()}) from exc
                    # a limit this request was not asked for: the key stands with none (its paid calls stay refused)
                    logging.getLogger("hive").warning("starting limit not set with key %s: %s", view["id"], exc)
                    applied = False
        starting = None
        if start_own and applied:
            starting = {"usd": start_usd, "scope": "own"}
        elif not gw and added and may_start:
            try:   # always the setting: month_usd stays ignored with the gateway off (it means the person's own keys)
                seeded = await run_in_threadpool(hive.budgets.seed_start_total)
            except (sqlite3.Error, OSError) as exc:   # the key stands; with no total its paid calls stay refused
                logging.getLogger("hive").warning("starting limit not set with key %s: %s", view["id"], exc)
                seeded = None
            if seeded is not None:
                hive.events.publish("budgets.updated", budgets=hive.budgets.overview())   # as POST /api/budgets does
                starting = {"usd": float(seeded["limit_usd"]), "scope": "hive"}
        keys_changed()
        out = next(k for k in keys_listing() if k["id"] == view["id"])
        if starting is not None:   # the client says "Your monthly limit starts at $50. Change it on Limits."
            out = {**out, "starting_limit": starting}
        if month is not None and not start_own:   # r1ab.5: whether this request's total is the one that governs now, and that total
            now_usd = governing()
            out = {**out, "monthly_total_applied": applied or now_usd == round(float(month), 6),
                   "monthly_total_usd": now_usd}
        return out

    @app.patch("/api/keys/{key_id}")
    async def keys_update(key_id: str, request: Request):
        admin(request)
        data = await body(request)
        providers.update_key(key_id, data.get("label"), data.get("default") if isinstance(data.get("default"), bool) else None)
        keys_changed()
        return next(k for k in keys_listing() if k["id"] == key_id)

    @app.post("/api/keys/{key_id}/refresh")
    async def keys_refresh(key_id: str, request: Request):
        session = operator(request)
        # keyview R13: deliberately on visibility, not the paying route (unlike GET /api/providers/{name}'s implicit refresh):
        # an explicit check of a key this caller is shown. sol on 7b40fdfe: only a key GET /api/keys shows this caller (its own policy, key_permit: everything for an
        # admin or the hive's owner) may be refreshed or described. Anyone else's key and a key that does not exist get
        # the same 404 before any lookup or provider call, so nothing says whether another person's key exists
        may_use = key_permit(session)
        listed = next((k for k in keys_listing() if k["id"] == key_id), None)
        if listed is None or (may_use is not None and not may_use(key_id)):
            raise HiveError(404, "not_found", "no such key")
        await providers.refresh_account(key_id)
        return next((k for k in keys_listing() if k["id"] == key_id), None) or {"id": key_id, "account": providers.accounts.get(key_id)}

    @app.delete("/api/keys/{key_id}")
    async def keys_remove(key_id: str, request: Request, force: int = 0):
        return await remove_stored_key(key_id, operator(request), force)

    @app.get("/api/providers/openrouter/catalog")
    async def openrouter_catalog(request: Request, refresh: int = 0):
        """keyview R11 (sol on 4a542223): the catalogue is fetched with the default OpenRouter credential, so only a
        caller who pays by that route (provider_view's comparison), or an admin, may fetch it (a stale or empty cache,
        or refresh=1) or read its fetch state. Anyone else reads the cached list as it is, never causing a fetch, with
        fetched_at and error not shown; refresh=1 from them is refused."""
        session = operator(request)
        if on_default_route(session, "openrouter"):
            return {**await providers.models(refresh=bool(refresh)), "can_refresh": True}
        if refresh:
            raise HiveError(403, "refresh_not_allowed", "only someone who pays by the hive's OpenRouter key can refresh "
                                                        "the catalogue")
        return {**providers.catalog, "fetched_at": None, "error": None, "can_refresh": False}

    @app.get("/api/providers/openrouter/endpoints/{model_id:path}")
    async def openrouter_endpoints(model_id: str, request: Request, refresh: int = 0):
        """keyview R12 (sol on 81359cdf): as the catalogue. A fetch (a cache miss, a stale entry, refresh=1) is made with
        the default OpenRouter credential and its outcome ("OpenRouter answered 401") describes that key, so only an
        admin or a caller on the default route may cause one. Anyone else reads what is cached (any age; an empty list
        and known: false when nothing is), never an outcome, and is refused refresh=1."""
        session = operator(request)
        if on_default_route(session, "openrouter"):
            return {"model": model_id, "endpoints": await providers.model_endpoints(model_id, refresh=bool(refresh)),
                    "known": True, "can_refresh": True}
        if refresh:
            raise HiveError(403, "refresh_not_allowed", "only someone who pays by the hive's OpenRouter key can refresh "
                                                        "a model's upstreams")
        cached = providers.endpoints.get(model_id)
        return {"model": model_id, "endpoints": list(cached[1]) if cached else [], "known": cached is not None,
                "can_refresh": False}

    def swarm_refusal(session, row):
        """Why a route that acts on this swarm refuses this caller, as (status, code, message), or None. Acting on a swarm
        is its owner's, its person's or a hive admin's (Viewer.controls; visibility.py's notes say what acting covers).
        Sight is checked before this, by operator()'s check_path, so a swarm the caller does not see is already not
        found. may_control on swarm views is exactly "this is None", so the flag cannot drift from its route."""
        if row is None:
            return 404, "not_found", "no such swarm"
        if not viewer(session).controls(row):
            return 403, "owner_only", "only this swarm's owner or a hive admin can do that"
        return None

    def swarm_flags(session, view):
        """A swarm view with this viewer's may_control, a hint for the UI: the routes still enforce."""
        return dict(view, may_control=swarm_refusal(session, view) is None)

    @app.get("/api/swarms")
    async def swarms(request: Request, archived: int = 0):
        session = admin(request) if archived else operator(request)   # retired swarms: admin sight only
        listed = [s for s in hive.swarms() if archived or not s.get("archived_at")]   # archived swarms only on request
        return [swarm_flags(session, s) for s in hive.visibility.swarms(viewer(session), listed)]

    @app.post("/api/swarms/{swarm_id}/archive")
    async def archive_swarm(swarm_id: str, request: Request):
        session = admin(request)
        return await run_in_threadpool(hive.archive_swarm, swarm_id, (session or {}).get("principal") or "user:operator")

    @app.post("/api/swarms/{swarm_id}/restore")
    async def restore_swarm(swarm_id: str, request: Request):
        admin(request)
        return await run_in_threadpool(hive.restore_swarm, swarm_id)

    @app.post("/api/swarms")
    async def create_swarm(request: Request):
        session = operator(request)
        data = await body(request)
        return hive.create_swarm(data.get("name", ""), data.get("description", ""), data.get("hue"),
                                 owner=session.get("principal") or "user:operator",
                                 visibility=data.get("visibility", "private"), shared_with=data.get("shared_with"))

    @app.patch("/api/swarms/{swarm_id}")
    async def update_swarm(swarm_id: str, request: Request):
        admin(request)
        data = await body(request)
        if "messages_per_hour" in data:   # how many messages the swarm's minds may send other minds an hour, together
            hive.swarm(swarm_id)
            hive.throughput.set_limit(f"swarm:{swarm_id}", data.pop("messages_per_hour"))
            if not data:
                hive.events.publish("swarm.updated", swarm=hive.swarm(swarm_id))
                return hive.swarm(swarm_id)
        return hive.update_swarm(swarm_id, data)

    @app.get("/api/hive/throughput")
    async def hive_throughput(request: Request):
        """The hive's defaults for mind-to-mind messages an hour: per mind and per swarm (throughput.py)."""
        operator(request)
        return hive.throughput.view()

    @app.patch("/api/hive/throughput")
    async def set_hive_throughput(request: Request):
        admin(request)
        return hive.throughput.set_defaults(await body(request))

    @app.delete("/api/swarms/{swarm_id}")
    async def delete_swarm(swarm_id: str, request: Request):
        session = admin(request)
        data = await body(request) if (await request.body()).strip() else {}
        if data.get("with_minds") is True:   # Jon 2026-10-07: one step, behind the swarm's exact name
            return await run_in_threadpool(hive.delete_swarm_with_minds, swarm_id, data.get("confirm"),
                                           (session or {}).get("principal") or "user:operator")
        return await run_in_threadpool(hive.delete_swarm, swarm_id)

    @app.get("/api/swarms/{swarm_id}/delete-preview")
    async def swarm_delete_preview(swarm_id: str, request: Request):
        """What DELETE with {with_minds: true} would do now; writes nothing (Surface, r3)."""
        admin(request)
        return await run_in_threadpool(hive.delete_preview, swarm_id)

    @app.get("/api/swarms/{swarm_id}")
    async def swarm(swarm_id: str, request: Request):
        session = operator(request)
        return swarm_flags(session, hive.swarm(swarm_id))

    @app.get("/api/swarms/{swarm_id}/beliefs")
    async def beliefs(swarm_id: str, request: Request):
        session = operator(request)   # a mind's linked beliefs show only to those who may see the mind (Jon on #354)
        return await run_in_threadpool(hive.beliefs, swarm_id, viewer(session))

    @app.get("/api/swarms/{swarm_id}/beliefs/detail")
    async def belief_detail(swarm_id: str, statement: str, request: Request):
        session = operator(request)
        return await run_in_threadpool(lambda: hive.belief(swarm_id, statement, viewer=viewer(session)))

    @app.get("/api/swarms/{swarm_id}/vocab")
    async def vocab(swarm_id: str, request: Request):
        operator(request)
        hive.swarm(swarm_id)
        return await run_in_threadpool(hive.spaces.vocab, swarm_id)

    @app.post("/api/swarms/{swarm_id}/vocab")
    async def add_vocab(swarm_id: str, request: Request):
        session = operator(request)
        # A term decides which statements the commons admits (hive-publish! quarantines one with a symbol outside the
        # vocabulary, hive/spaces/lib_hive.metta), so adding one acts on the swarm; seeing the swarm is not enough.
        refused = swarm_refusal(session, hive.db.one("SELECT * FROM swarms WHERE id = ?", (swarm_id,)))
        if refused:
            raise HiveError(*refused)
        data = await body(request)
        try:
            return await run_in_threadpool(hive.spaces.add_vocab, swarm_id, list(data.get("terms", [])))
        except ValueError as exc:
            raise HiveError(400, "bad_term", str(exc))

    # ---- agents ---------------------------------------------------------------------------------

    # Screen blocks a screen asked for that nothing draws yet: one task each in the Code swarm (screens_missing.py)
    from .screens_missing import ScreensMissing
    screens_missing = ScreensMissing(hive)

    @app.post("/api/screens/missing")
    async def screens_missing_report(request: Request):
        session = operator(request)
        data = await body(request)
        # every signed-in person's report counts; only an admin's files a task (and sees task ids)
        return await screens_missing.report(session.get("principal") or "user:operator", data.get("items"),
                                            admin=role_of(session) == "admin")

    @app.get("/api/screens/missing")
    async def screens_missing_list(request: Request):
        admin(request)
        return {"items": await run_in_threadpool(screens_missing.list)}

    @app.get('/api/tools')
    async def tools_catalogue(request: Request):
        operator(request)
        # A hive with no Tools app at all, none found and none pinned, has no tools, which the page says in its own words
        # ("No tools yet"). An app that is there but cannot be admitted (unpinned, pinned elsewhere, disabled, drifted)
        # needs its admin, so that stays a 409 naming why.
        if 'omega-tools' not in hive.programs.programs:
            return {'items': [], 'offline_candidate': settings.offline}
        from .tools import ToolRegistry
        try:
            return {'items': ToolRegistry(settings.core_root, hive.programs).catalogue(), 'offline_candidate': settings.offline}
        except (ValueError, KeyError, OSError) as exc:
            raise HiveError(409, 'tools_review_required', str(exc)) from exc

    @app.get("/api/agents")
    async def agents(request: Request):
        session = operator(request)
        out = hive.visibility.agents(viewer(session), hive.agents())
        rows = {a["id"]: a for a in hive.db.all("SELECT * FROM agents WHERE deleted = 0")}
        for a in out:
            if isinstance(a, dict) and a.get("id") in rows:
                a["coffee"] = hive.rooms.coffee_status(rows[a["id"]])
        # projected here, before serialization (sol on 59dfe1ff P2): the answer is final, so the response wrapper
        # sends it as it is, unheld, whatever its size
        request.state.hive_keyview_done = True
        return keys_projected(session, with_flags(session, out, rows))   # is_mine, may_remind, may_sleep, may_control

    @app.post("/api/agents")
    async def create_agent(request: Request):
        session = operator(request)
        data = await body(request)
        fresh_approval_actor(request, session)
        privileged = policy_writer(session)
        if data.get("role_id") and not privileged and hive.roles.carries_rules(data["role_id"]):
            # host-identity r1.1: a role's approval rules are policy; anyone else may give a new mind only a prompt-only role
            # (the fast refusal; r1.2: Hive.create_agent checks again under the roles lock through the insert)
            raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can give a mind a role that carries approval rules")
        from .providers import clean_options
        try:
            new_options = clean_options(data.get('options'))
            if new_options.get('tools'): admin(request)
        except ValueError as exc:
            raise HiveError(400, 'bad_options', str(exc)) from exc
        hive.check_key_use(new_options.get('key'), key_permit(session))   # OI-13: never another person's key
        me = session.get("principal") or "user:operator"
        hive.check_key_lock(me, {}, new_options, me)   # app platform P3a: a locked new mind runs on its creator's own key
        if new_options.get("approvals") == "owner_only":
            fresh_approval_actor(request, session, setting=True)
        if data.get("swarm_id"):
            hive.visibility.check_path(viewer(session), {"swarm_id": data["swarm_id"]})
        return await run_in_threadpool(
            hive.create_agent, data.get("name", ""), data.get("kind", "omega"), data.get("swarm_id"),
            data.get("model"), data.get("persona", ""), data.get("hue"), data.get("budget_usd", 0),
            data.get("options"), data.get("role_id"), session.get("principal") or "user:operator",
            data.get("visibility", "private"), data.get("shared_with"), by=me, privileged=privileged,
            approval_guard=(lambda: fresh_approval_actor(request, session, setting=True)) if new_options.get("approvals") == "owner_only" else None,
        )

    @app.put("/api/agents/{agent_id}/visibility")
    async def agent_visibility(agent_id: str, request: Request):
        session = operator(request)
        data = await body(request)
        # a mind's link follows its visibility (Jon on #354), under the mind's lock, so in the threadpool
        await run_in_threadpool(hive.set_mind_visibility, agent_id, viewer(session), data.get("visibility"),
                                data.get("shared_with"), data.get("pays"))
        agent = hive.agent(agent_id)
        hive.events.publish("agent.updated", agent=agent)
        result = agent
        hive._coffee_sync()   # a mind or swarm made private leaves the Coffee Room at once
        return result

    @app.put("/api/swarms/{swarm_id}/visibility")
    async def swarm_visibility(swarm_id: str, request: Request):
        session = operator(request)
        data = await body(request)
        hive.visibility.set("swarms", swarm_id, viewer(session), data.get("visibility"), data.get("shared_with"), data.get("pays"))
        swarm = hive.swarm(swarm_id)
        hive.events.publish("swarm.updated", swarm=swarm)
        result = swarm
        hive._coffee_sync()   # a mind or swarm made private leaves the Coffee Room at once
        return result

    @app.get("/api/agents/{agent_id}")
    async def agent(agent_id: str, request: Request):
        session = operator(request)
        row = hive._agent_row(agent_id)
        return {**hive.agent_view(row), **mind_flags(session, row)}   # idle-minds r2.4 flags (never personal_of)

    @app.patch("/api/agents/{agent_id}")
    async def update_agent(agent_id: str, request: Request):
        session = operator(request)
        require_control(session, agent_id)   # before the body is read: seeing a mind is not editing it
        data = await body(request)
        actor = fresh_approval_actor(request, session)
        may_see = key_seer(session)
        if may_see is not None and isinstance(data.get("options"), dict) and "key" not in data["options"]:
            # keyview: the options this caller was shown leave out a key they may not see; sending them back keeps it
            # (an edit never moves someone else's mind onto another payer by omission)
            stored = hive.db.one("SELECT options, model FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            hidden = (json.loads(stored["options"] or "{}") if stored else {}).get("key")
            if isinstance(hidden, str) and hidden and not may_see(hidden):
                # checked here first, in words that name nothing (sol on f06f2915): Hive._options would refuse a model on
                # another provider naming the key's label and provider, and an error string leaves unprojected
                record = (providers.ring.get("keys") or {}).get(hidden)
                hidden_provider = hidden[4:] if hidden.startswith("env:") else (record or {}).get("provider")
                target = str(data.get("model") or stored["model"] or "").partition("/")[0]
                if hidden_provider and target and hidden_provider != target:
                    raise HiveError(400, "key_provider_mismatch", "This mind's key is for another provider; its owner "
                                    "can change the key or the model.")
                data["options"] = {**data["options"], "key": hidden}
        # Refuse an unauthorized policy transition before unrelated coffee/role/options side effects.
        if "options" in data:
            from .providers import clean_options
            try:
                new_approval_options = clean_options(data["options"])
            except ValueError as exc:
                raise HiveError(400, "bad_options", str(exc)) from exc
            mind = hive.db.one("SELECT owner, options FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
            if mind is None:
                raise HiveError(404, "not_found", "no such agent")
            old_approval_options = json.loads(mind.get("options") or "{}")
            if old_approval_options.get("approvals") != new_approval_options.get("approvals"):
                fresh_approval_actor(request, session, setting=True)
                hive.check_approval_options(mind.get("owner"), old_approval_options, new_approval_options, actor)
        privileged = policy_writer(session)
        if "role_id" in data and not privileged and hive.roles.touches_policy(agent_id, data["role_id"] or None):
            # host-identity r1.1/r1.2: changing a role deletes every role:... rule at the mind's scope and installs the new
            # role's, so it is a policy write when any is there or the new role carries rules. The fast refusal; the binding
            # check runs again inside roles.assign's lock and transaction (Hive._update_agent_locked).
            raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can change a role that carries approval rules")
        if "coffee" in data:   # in or out of the Coffee Room: an admin decision (private swarms are opt-in)
            admin(request)
            if not isinstance(data["coffee"], bool):
                raise HiveError(400, "bad_request", "coffee is true or false")
            await run_in_threadpool(hive.rooms.set_coffee, agent_id, data.pop("coffee"), session.get("principal") or "user:operator")
            if not data:
                return {**hive.agent(agent_id), "coffee": hive.rooms.coffee_status(hive.db.one("SELECT * FROM agents WHERE id = ?", (agent_id,)))}
        if "driver" in data:   # where a mind runs (this host or a container) is an admin decision
            admin(request)
        if "messages_per_hour" in data:   # how many messages the mind may send other minds an hour (throughput.py): admin
            admin(request)
            hive._agent_row(agent_id)
            await run_in_threadpool(hive.throughput.set_limit, f"agent:{agent_id}", data.pop("messages_per_hour"))
            if not data:
                hive.emit_agent(agent_id)
                return hive.agent(agent_id)
        if data.get("swarm_id"):   # the destination comes from the body, so check it too: never into a swarm you can't see
            hive.visibility.check_path(viewer(session), {"swarm_id": str(data["swarm_id"])})
        expected_tools = None
        if 'options' in data:
            from .providers import clean_options
            try:
                expected_tools = hive.agent(agent_id)['options'].get('tools', [])
                if clean_options(data['options']).get('tools', []) != expected_tools:
                    admin(request)
            except ValueError as exc:
                raise HiveError(400, 'bad_options', str(exc)) from exc
        # OI-13: a changed options.key is checked against who is asking, inside the mind's lock (an unchanged key never is)
        return await run_in_threadpool(hive.update_agent, agent_id, data, expected_tools=expected_tools,
                                       by=session.get("principal") or "user:operator", privileged=privileged,
                                       # with a model change too: a kept key the caller may not see is judged in words
                                       # that name nothing (Hive._update_agent_locked); it authorizes nothing more
                                       may_use_key=key_permit(session) if ("options" in data or "model" in data) else None,
                                       approval_guard=(lambda: fresh_approval_actor(request, session, setting=True)) if "options" in data else None)

    @app.delete("/api/agents/{agent_id}")
    async def delete_agent(agent_id: str, request: Request):
        require_control(operator(request), agent_id)
        return await run_in_threadpool(hive.delete_agent, agent_id)

    for action in ("start", "stop", "sleep", "wake"):
        async def lifecycle(agent_id: str, request: Request, action=action):
            require_control(operator(request), agent_id)   # the refusal may_sleep and may_control report
            return await run_in_threadpool(hive.lifecycle, agent_id, action)

        app.post(f"/api/agents/{{agent_id}}/{action}")(lifecycle)

    @app.get("/api/agents/{agent_id}/messages")
    async def messages(agent_id: str, request: Request, conversation_id: str | None = None, limit: int = 200,
                       include: str | None = None):
        """A person reads only their own chats with a mind (mind-chat-identity r1); an admin audits every person's with
        ?include=all. The loopback operator reads the whole stream, as before."""
        session = operator(request)
        principal = session.get("principal") or "user:operator"
        audit = include in ("all", "personal")   # ?include=personal is the same admin audit (operator() checks it too)
        if audit and role_of(session) != "admin":
            raise HiveError(403, "admin_only", "only a hive admin can do that")
        if not audit:
            hidden_researcher(session, agent_id)
        rows = hive.messages(agent_id, conversation_id, limit, principal=None if audit else principal)
        # by id (hide-others r4): the mind is named, so other people's personal minds are not hidden here; which of its
        # messages a person reads is the per-person scoping above
        # project_person_message: the one people projection (scheduled text; Health's verified question untagged)
        return [hive.visibility.project_person_message(viewer(session), row) for row in hive.visibility.filter_items(audit_viewer(session), rows)]

    @app.post("/api/agents/{agent_id}/messages")
    async def post_message(agent_id: str, request: Request):
        """The mind hears the person who sent it (their principal), never user:operator for a named person. A named
        person talks in their own conversation (c_<mind>~<principal>[~suffix]) or in a room they belong to; nobody,
        admins and the loopback operator included, speaks into another person's conversation (audit is read-only)."""
        session = operator(request)
        data = await body(request)
        principal = session.get("principal") or "user:operator"
        conversation_id = data.get("conversation_id")
        if conversation_id is not None and not isinstance(conversation_id, str):
            raise HiveError(400, "bad_request", "conversation_id is text")
        room = hive.rooms.room_for_conversation(conversation_id) if conversation_id and conversation_id != f"c_{agent_id}" else None
        if principal != "user:operator":
            if not conversation_id:
                conversation_id = hive.person_conversation(agent_id, principal)
            elif room is None and not conversation_id.startswith("ask:") and not hive.may_post(agent_id, conversation_id, principal):
                # a chat conversation: only one bound to this person (admins included); rooms by membership, below
                raise HiveError(404, "not_found", "no such conversation")
        if conversation_id and room is None and not conversation_id.startswith("ask:"):
            # one rule for everyone, the loopback operator included: a conversation a person owns (by its id, or a
            # legacy one by its first person speaker) is theirs alone to speak in (r4)
            owner = hive.conversation_owner(agent_id, conversation_id)
            if owner and owner.startswith("user:") and owner != principal:
                raise HiveError(404, "not_found", "no such conversation")
        if room is not None and not hive.rooms.is_coffee(conversation_id) and not hive.rooms.is_team(room):
            # a room's conversation is spoken in by its members only, as POST /api/rooms/{id}/messages decides (the
            # Coffee Room and team rooms are refused by send_to_agent itself)
            hive.rooms.get(viewer(session), room["id"])
            if not hive.rooms._is_member(room["id"], principal):
                raise HiveError(403, "not_member", "join the room to speak in it")
        # Jon, 16 Nov: continuity "regardless of which model you interact", "without needing additional LLM calls to pass
        # through convo". from_ask: the person's Ask exchanges this mind has not heard, which their browser keeps (the
        # conversation's shape, conductor.check_conversation); only in their own chat with the mind, and a mind that isn't
        # theirs keeps only those it answered (conductor.heard_by). The mind reads them with this very message, so no
        # model call is added; the person's chat shows only their words.
        extra = None
        if "from_ask" in data:
            from .conductor import ask_earlier_lines, check_conversation, fence_conversation, heard_by, mind_names
            if not principal.startswith("user:u_") or conversation_id != hive.person_conversation(agent_id, principal) \
                    or not check_conversation(data["from_ask"]):
                raise HiveError(400, "bad_request", "from_ask is the person's own Ask exchanges, sent in their own chat with the mind")
            mind = hive.db.one("SELECT personal_of FROM agents WHERE id = ?", (agent_id,)) or {}
            heard = heard_by(fence_conversation(data["from_ask"]), agent_id, own=mind.get("personal_of") == principal)
            lines = ask_earlier_lines(heard, mind_names(hive, principal, agent_id))
            extra = {"ask_earlier": lines} if lines else None
        return await hive.send_to_agent(agent_id, data.get("text", ""), conversation_id, sender=principal, extra=extra)

    # ---- updates: detected app/platform updates, owner requests, holds, apply (R18, hive/core/updates.py) ----

    def _who(session):
        return session.get("principal") or "user:operator"

    def _person_admin(session):
        return role_of(session) == "admin" and session.get("kind") == "sso" and _who(session) != "user:operator"

    @app.get("/api/updates")
    async def updates_overview(request: Request):
        admin(request)
        return await run_in_threadpool(hive.updates.overview)

    @app.post("/api/updates/requests")
    async def updates_request(request: Request):
        session = admin(request)
        return hive.updates.request(_who(session), await body(request))

    @app.post("/api/updates/holds")
    async def updates_hold(request: Request):
        session = admin(request)
        return hive.updates.hold(_who(session), await body(request))

    @app.delete("/api/updates/holds/{hold_id}")
    async def updates_release(hold_id: str, request: Request):
        session = admin(request)
        return hive.updates.release(_who(session), hold_id, admin=True)

    @app.post("/api/updates/apply")
    async def updates_apply(request: Request):
        session = admin(request)
        data = await body(request)
        return await run_in_threadpool(hive.updates.apply, _who(session), data.get("target"), bool(data.get("override")),
                                       _person_admin(session), data.get("confirm"))

    @app.post("/api/updates/check")
    async def updates_check(request: Request):
        # Check now: the Mac updater's own check at once, its answer for the page (updates.py check)
        admin(request)
        return await run_in_threadpool(hive.updates.check)

    @app.get("/api/agent/updates")
    async def agent_updates(request: Request):
        agent_from(request)
        o = await run_in_threadpool(hive.updates.overview)
        return {"platform": {k: o["platform"][k] for k in ("running_build", "running_release", "source_build", "update_available",
                                                           "commits_waiting")},
                "apps": [{k: a[k] for k in ("target", "loaded_version", "disk_version", "update_available")} for a in o["apps"]],
                "holds": [{k: h[k] for k in ("scope", "reason", "held_by", "until")} for h in o["holds"]]}

    @app.post("/api/agent/updates/apply")
    async def agent_updates_apply(request: Request):
        agent = agent_from(request)
        mode, reason = hive.policy.decide(agent, "hive-update-apply")
        if mode != "allow":
            raise HiveError(403, "not_allowed", reason)
        data = await body(request)
        return await run_in_threadpool(hive.updates.apply, f"agent:{agent['id']}", data.get("target"), False, False, None)

    # ---- explorer: every node, filtered, grouped and paged on the server (R19, hive/core/explore.py) ----

    @app.post("/api/explore")
    async def explore(request: Request):
        v = viewer(operator(request))
        spec = await body(request)
        return await run_in_threadpool(hive.explorer.query, v, spec)

    @app.put("/api/explore/meta/{node_id}")
    async def explore_meta(node_id: str, request: Request):
        return hive.explorer.set_meta(viewer(operator(request)), node_id, await body(request))

    @app.get("/api/explore/groups")
    async def explore_groups(request: Request):
        return hive.explorer.groups(viewer(operator(request)))

    @app.post("/api/explore/groups")
    async def explore_new_group(request: Request):
        return hive.explorer.save_group(viewer(operator(request)), await body(request))

    @app.put("/api/explore/groups/{group_id}")
    async def explore_rename_group(group_id: str, request: Request):
        return hive.explorer.save_group(viewer(operator(request)), await body(request), group_id)

    @app.post("/api/explore/groups/{group_id}/members")
    async def explore_group_members(group_id: str, request: Request):
        data = await body(request)
        return await run_in_threadpool(hive.explorer.group_members, viewer(operator(request)), group_id, data.get("add"), data.get("remove"))

    @app.delete("/api/explore/groups/{group_id}")
    async def explore_delete_group(group_id: str, request: Request):
        return hive.explorer.delete_group(viewer(operator(request)), group_id)

    @app.get("/api/explore/views")
    async def explore_views(request: Request):
        return hive.explorer.views(viewer(operator(request)))

    @app.post("/api/explore/views")
    async def explore_save_view(request: Request):
        return hive.explorer.save_view(viewer(operator(request)), await body(request))

    @app.put("/api/explore/views/{view_id}")
    async def explore_update_view(view_id: str, request: Request):
        return hive.explorer.save_view(viewer(operator(request)), await body(request), view_id)

    @app.delete("/api/explore/views/{view_id}")
    async def explore_delete_view(view_id: str, request: Request):
        return hive.explorer.delete_view(viewer(operator(request)), view_id)

    # ---- rooms: DMs, groups, channels, projects (R15, hive/core/rooms.py) -----------------------------

    @app.get("/api/rooms")
    async def list_rooms(request: Request):
        return hive.rooms.list(viewer(operator(request)))

    @app.post("/api/rooms")
    async def create_room(request: Request):
        return hive.rooms.create(viewer(operator(request)), await body(request))

    @app.get("/api/rooms/{room_id}")
    async def get_room(room_id: str, request: Request):
        v = viewer(operator(request))
        return hive.rooms.view(hive.rooms.get(v, room_id), v)

    @app.patch("/api/rooms/{room_id}")
    async def update_room(room_id: str, request: Request):
        return hive.rooms.update(viewer(operator(request)), room_id, await body(request))

    @app.get("/api/rooms/{room_id}/messages")
    async def room_messages(room_id: str, request: Request, after: int = 0, limit: int = 100):
        session = operator(request)
        return hive.rooms.messages(viewer(session), room_id, after, limit)

    @app.post("/api/rooms/{room_id}/messages")
    async def post_room_message(room_id: str, request: Request):
        v = viewer(operator(request))
        return await hive.rooms.post(v, room_id, (await body(request)).get("text"))

    @app.post("/api/rooms/{room_id}/members")
    async def add_room_members(room_id: str, request: Request):
        data = await body(request)
        return hive.rooms.add_members(viewer(operator(request)), room_id, data.get("members") or [])

    @app.delete("/api/rooms/{room_id}/members/{member}")
    async def remove_room_member(room_id: str, member: str, request: Request):
        return hive.rooms.remove_member(viewer(operator(request)), room_id, member)

    @app.post("/api/rooms/{room_id}/swarm")
    async def room_become_swarm(room_id: str, request: Request):
        data = await body(request)
        return await run_in_threadpool(hive.rooms.become_swarm, viewer(operator(request)), room_id, data.get("move_minds") or [])

    @app.post("/api/swarms/{swarm_id}/team-room/repair")
    async def swarm_team_room_repair(swarm_id: str, request: Request):
        admin(request)
        return await run_in_threadpool(hive.rooms.repair_team, viewer(operator(request)), swarm_id)

    @app.post("/api/swarms/{swarm_id}/room")
    async def swarm_room(swarm_id: str, request: Request):
        v = viewer(operator(request))
        hive.visibility.check_path(v, {"swarm_id": swarm_id})
        return await run_in_threadpool(hive.rooms.swarm_room, v, swarm_id)

    # ---- requests from people: a mind, more allowance, access to a swarm (hive/core/person_requests.py) ----

    @app.get("/api/asks")
    async def list_person_requests(request: Request):
        return hive.person_requests.list(viewer(operator(request)))

    @app.post("/api/asks")
    async def create_person_request(request: Request):
        return await hive.person_requests.create(viewer(operator(request)), await body(request))

    @app.post("/api/asks/{request_id}/decide")
    async def decide_person_request(request_id: str, request: Request):
        """Once, For a time (minutes), Always, No or Never; admins only."""
        session = admin(request)
        data = await body(request)
        return await hive.person_requests.decide(session.get("principal") or "user:operator", request_id,
                                                 str(data.get("decision", "")), data.get("minutes"))

    # ---- Universal Ask, phase 1: a person asks; the swarm's coordinator answers (hive/core/ask.py) ---------------

    from .ask import MAX_BODY as ASK_MAX_BODY, refusal as ask_refusal

    def ask_person(request: Request):
        """A named signed-in admin or member; never the loopback password, a mind's token or a disabled person."""
        session = operator(request)
        principal = session.get("principal") or "user:operator"
        from .program_actions import named_person
        if session.get("kind") == "password" or not named_person(principal) or role_of(session) not in ("admin", "member"):
            raise ask_refusal(hive, "person_required")
        return viewer(session)

    @app.post("/api/ask")
    async def ask_create(request: Request):
        v = ask_person(request)
        try:
            data = await bounded_body(request, ASK_MAX_BODY)
        except HiveError as exc:   # the closed reason set, never the reader's own text
            raise ask_refusal(hive, "too_large" if exc.status == 413 else "invalid") from None
        accepted = await hive.ask.create(v, data)
        if hive.newhive is not None:   # new-hive R1b-2: time to the first accepted Ask turn, apart from code-ready
            hive.newhive.note("first_ask_at")
        return JSONResponse(accepted, status_code=202)

    @app.get("/api/ask")
    async def ask_list(request: Request, limit: int = 50):
        return hive.ask.list(ask_person(request), limit)

    @app.get("/api/ask/audit")
    async def ask_audit(request: Request, limit: int = 100, principal: str = "", before: str = ""):
        """Every person's Ask turns, for admins only (they are not sent other people's Ask frames live)."""
        admin(request)
        return hive.ask.audit(limit, principal or None, before or None)

    @app.get("/api/ask/audit/{turn_id}")
    async def ask_audit_turn(turn_id: str, request: Request, after: int = 0, limit: int = 100):
        admin(request)
        return hive.ask.audit_turn(turn_id, after, limit)

    # ---- linkage r3.6 §(a): an Ask turn's host-owned intents and links (hive/core/ask_intents.py), under §G --------

    G_JSON = re.compile(r"application/json(\s*;\s*charset=utf-8)?", re.IGNORECASE)
    G_RECORD_MAX, G_SMALL_MAX = 48 * 1024, 1024
    # J3 R3: a Studio frame's small bodies (mount, outcome with its app refs) and its piece upload (a 256 KiB UTF-8 body
    # inside JSON, where escaping can grow it)
    STUDIO_BODY_MAX, STUDIO_PIECE_MAX = 16 * 1024, 1024 * 1024

    def g_person(request: Request, mutating: bool, admin_only: bool):
        """§G.1-2 and the person gates: on every mutating method an exact Origin first (before any session lookup, body
        read or side effect), then an Authorization Bearer header only (no ?token=, no cookie), then the Ask person
        gate, and for links the r2.13 named-admin check (record and submit: each intent kind's own gate, g_person_kind)."""
        return g_person_kind(request, mutating, admin_only)[0]

    def g_person_kind(request: Request, mutating: bool, admin_only: bool):
        """g_person, also answering whether the caller passes the r2.13 named-admin check, for a per-kind gate (J3 R2:
        studio.session is any named person's, code.request stays admin-only; ask_intents.KINDS)."""
        if mutating:
            origin = request.headers.get("origin")
            if origin is None:
                raise HiveError(403, "origin_required", "this request needs its Origin")
            if origin not in G_ORIGINS:
                raise HiveError(403, "origin_refused", "this request's Origin is not this hive")
        token = _bearer(request.headers.get("authorization"))
        session = session_for(token, request.scope.get("hive_public", False)) if token else None
        if session is None:
            raise HiveError(401, "unauthorized", "log in first")
        principal = session.get("principal") or "user:operator"
        from .program_actions import named_person
        if session.get("kind") == "password" or not named_person(principal) or role_of(session) not in ("admin", "member"):
            raise HiveError(403, "person_required", "a named, signed-in person does this")
        if admin_only and not _person_admin(session):
            raise HiveError(403, "person_required", "a named, signed-in admin person sends instructions")
        return viewer(session), _person_admin(session)

    async def g_body(request: Request, limit: int, optional: bool = False):
        """§G.3-4: Content-Type application/json (optionally ; charset=utf-8), else 415; the body read with a running cap,
        else 413 request_too_large. optional: a route that takes no body accepts none (or {}), with no Content-Type."""
        ctype = request.headers.get("content-type")
        if ctype is not None and not G_JSON.fullmatch(ctype.strip()):
            raise HiveError(415, "bad_content_type", "send application/json")
        chunks, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > limit:
                raise HiveError(413, "request_too_large", f"this request is limited to {limit} bytes")
            chunks.append(chunk)
        raw = b"".join(chunks)
        if not raw and optional:
            return {}
        if ctype is None:
            raise HiveError(415, "bad_content_type", "send application/json")
        try:
            data = json.loads(raw)
        except ValueError:
            raise HiveError(400, "bad_request", "expected a JSON body") from None
        if not isinstance(data, dict):
            raise HiveError(400, "bad_request", "expected a JSON object")
        if optional and data:
            raise HiveError(400, "bad_request", "this request takes no body")
        return data

    def p1_person(request, mutating=True):
        v, _ = g_person_kind(request, mutating, False)
        return v, token_hash(_bearer(request.headers.get("authorization")))

    async def p1_body(request, empty=False):
        from .app_ask import MAX_BYTES
        try:
            return await g_body(request, MAX_BYTES, optional=empty)
        except HiveError as exc:
            if exc.status == 413:
                raise hive.app_ask.error("too_large", 413) from None
            raise

    # P12/P13: these authenticated parent-only routes share P1's exact Origin,
    # bearer and named-person gates. Public frames have neither this token nor
    # network access. Never forward an exception body through the frame bridge.
    async def app_link_call(fn, *args):
        try:
            return await run_in_threadpool(fn, *args)
        except Exception:
            raise HiveError(409, "not_available", "This app request is unavailable.") from None

    @app.patch("/api/people/{person_id}/profile-kind")
    async def person_profile_kind(person_id: str, request: Request):
        if request.headers.get("origin") not in G_ORIGINS:
            raise HiveError(403, "origin_refused", "this request needs the hive Origin")
        session = admin(request)
        data = await g_body(request, 1024)
        if set(data) != {"profile_kind"}:
            raise HiveError(400, "bad_request", "profile_kind only")
        return await run_in_threadpool(people.set_profile_kind, person_id, data["profile_kind"], session["token_hash"])

    @app.post("/api/programs/{program_id}/app-links/frames")
    async def app_link_frame(program_id: str, request: Request):
        v, session = p1_person(request)
        return await app_link_call(hive.app_links.frame, v, session, program_id, await p1_body(request))

    @app.delete("/api/programs/{program_id}/app-links/frames/{frame_id}")
    async def app_link_close(program_id: str, frame_id: str, request: Request):
        v, session = p1_person(request)
        data = await p1_body(request, True)
        if set(data) - {"handoff"}:
            raise HiveError(400, "bad_request", "handoff only")
        return await app_link_call(hive.app_links.close, v, session, program_id, frame_id, data.get("handoff"))

    @app.post("/api/programs/{program_id}/app-links/frames/{frame_id}/current")
    async def app_link_frame_current(program_id: str, frame_id: str, request: Request):
        v, session = p1_person(request)
        if await p1_body(request, True):
            raise HiveError(400, "bad_request", "empty request only")
        return await app_link_call(hive.app_links.check_frame, v, session, program_id, frame_id)

    @app.post("/api/programs/{program_id}/app-links/frames/{frame_id}/prepare")
    async def app_link_prepare(program_id: str, frame_id: str, request: Request):
        v, session = p1_person(request)
        return await app_link_call(hive.app_links.prepare, v, session, program_id, frame_id, await p1_body(request))

    @app.post("/api/programs/{program_id}/app-links/frames/{frame_id}/reviews/{review_id}/inspect")
    async def app_link_inspect(program_id: str, frame_id: str, review_id: str, request: Request):
        v, session = p1_person(request)
        data = await p1_body(request, True)
        if data:
            raise HiveError(400, "bad_request", "empty request only")
        return await app_link_call(hive.app_links.review, v, session, program_id, frame_id, review_id)

    @app.post("/api/programs/{program_id}/app-links/frames/{frame_id}/reviews/{review_id}/decide")
    async def app_link_decide(program_id: str, frame_id: str, review_id: str, request: Request):
        v, session = p1_person(request)
        return await app_link_call(hive.app_links.decide, v, session, program_id, frame_id, review_id, await p1_body(request))

    @app.post("/api/app-links/entries/{entry_id}/card")
    async def app_link_entry_card(entry_id: str, request: Request):
        v, session = p1_person(request)
        if await p1_body(request, True):
            raise HiveError(400, "bad_request", "empty request only")
        return await app_link_call(hive.app_links.entry_card, v, session, entry_id)

    @app.post("/api/app-links/entries/{entry_id}/presentation-current")
    async def app_link_presentation_current(entry_id: str, request: Request):
        v, session = p1_person(request)
        data = await p1_body(request, True)
        if set(data) - {"consume"} or "consume" in data and type(data["consume"]) is not bool:
            raise HiveError(400, "bad_request", "consume boolean only")
        return await app_link_call(hive.app_links.presentation_current, v, session, entry_id, data.get("consume", False))

    @app.post("/api/app-links/entries/{entry_id}/check")
    async def app_link_check(entry_id: str, request: Request):
        v, session = p1_person(request)
        data = await p1_body(request)
        if set(data) != {"frame_id"} or not isinstance(data["frame_id"], str):
            raise HiveError(400, "bad_request", "frame_id only")
        return await app_link_call(hive.app_links.check_entry, v, session, entry_id, data["frame_id"])

    @app.post("/api/app-links/entries/{entry_id}/redeem")
    async def app_link_redeem(entry_id: str, request: Request):
        v, session = p1_person(request)
        return await app_link_call(hive.app_links.redeem, v, session, entry_id, await p1_body(request))


    @app.get("/api/programs/{program_id}/ask/consent")
    async def program_ask_card(program_id: str, request: Request):
        v, session_hash = p1_person(request, False)
        return await run_in_threadpool(hive.app_ask.card, v, session_hash, program_id)

    @app.post("/api/programs/{program_id}/ask/consent")
    async def program_ask_consent(program_id: str, request: Request):
        v, session_hash = p1_person(request)
        data = await p1_body(request)
        return await run_in_threadpool(hive.app_ask.consent, v, session_hash, program_id, data)

    @app.delete("/api/programs/{program_id}/ask/consent")
    async def program_ask_revoke(program_id: str, request: Request):
        v, session_hash = p1_person(request)
        await p1_body(request, True)
        return await run_in_threadpool(hive.app_ask.revoke, v, session_hash, program_id)

    @app.post("/api/programs/{program_id}/ask/frames")
    async def program_ask_frame(program_id: str, request: Request):
        v, session_hash = p1_person(request)
        data = await p1_body(request)
        return await run_in_threadpool(hive.app_ask.frame, v, session_hash, program_id, data)

    @app.post("/api/programs/{program_id}/ask/frames/{generation}/presence")
    async def program_ask_presence(program_id: str, generation: str, request: Request):
        v, session_hash = p1_person(request)
        await p1_body(request, True)
        return await run_in_threadpool(hive.app_ask.presence, v, session_hash, program_id, generation)

    @app.delete("/api/programs/{program_id}/ask/frames/{generation}")
    async def program_ask_close(program_id: str, generation: str, request: Request):
        v, session_hash = p1_person(request)
        await p1_body(request, True)
        # close marks the generation before it waits on DB or per-turn gates.
        return await run_in_threadpool(hive.app_ask.close, v, session_hash, program_id, generation)

    @app.post("/api/programs/{program_id}/ask/frames/{generation}/ops")
    async def program_ask_op(program_id: str, generation: str, request: Request):
        v, session_hash = p1_person(request)
        data = await p1_body(request)
        return await hive.app_ask.op(v, session_hash, program_id, generation, data)

    @app.get("/api/ask/{operation_id}/presentation")
    async def ask_presentation(operation_id: str, request: Request):
        v, session_hash = p1_person(request, False)
        return await run_in_threadpool(hive.app_ask.presentation, v, operation_id, session_hash)

    @app.post("/api/ask/{operation_id}/presentation")
    async def ask_presentation_change(operation_id: str, request: Request):
        v, session_hash = p1_person(request)
        data = await p1_body(request)
        return await run_in_threadpool(hive.app_ask.host_presentation, v, session_hash, operation_id, data)

    @app.post("/api/ask/{operation_id}/acts/{act_id}/claim")
    async def ask_act_claim(operation_id: str, act_id: str, request: Request):
        from .app_ask import closed
        v, session_hash = p1_person(request)
        data = await p1_body(request)
        if not closed(data, {"owner_epoch"}):
            raise hive.app_ask.error("invalid", 400)
        turn = hive.ask._own(v, operation_id)
        return await run_in_threadpool(hive.app_ask.claim_act, v, turn, act_id, data["owner_epoch"], session_hash=session_hash)

    @app.post("/api/ask/{operation_id}/intents")
    async def ask_intent_record(operation_id: str, request: Request):
        v, is_admin = g_person_kind(request, mutating=True, admin_only=False)
        data = await g_body(request, G_RECORD_MAX)
        status, view = await hive.ask.intents.record_async(v, operation_id, data, admin=is_admin)
        return JSONResponse(view, status_code=status)

    @app.post("/api/ask/intents/{intent_id}/submit")
    async def ask_intent_submit(intent_id: str, request: Request):
        v, is_admin = g_person_kind(request, mutating=True, admin_only=False)
        await g_body(request, G_SMALL_MAX, optional=True)
        return recorded(await hive.ask.intents.submit(v, intent_id, admin=is_admin))

    @app.post("/api/ask/intents/{intent_id}/abandon")
    async def ask_intent_abandon(intent_id: str, request: Request):
        v = g_person(request, mutating=True, admin_only=False)
        await g_body(request, G_SMALL_MAX, optional=True)
        return hive.ask.intents.abandon(v, intent_id)

    @app.post("/api/ask/{operation_id}/links")
    async def ask_link_attach(operation_id: str, request: Request):
        v = g_person(request, mutating=True, admin_only=True)
        data = await g_body(request, G_SMALL_MAX)
        status, view = hive.ask.intents.attach(v, operation_id, data)
        return JSONResponse(view, status_code=status)

    @app.get("/api/ask/intents")
    async def ask_intent_list(request: Request, state: str | None = None, limit: int = 50):
        return hive.ask.intents.list(g_person(request, mutating=False, admin_only=False), state, limit)

    @app.get("/api/ask/intents/{intent_id}")
    async def ask_intent_get(intent_id: str, request: Request):
        return hive.ask.intents.get(g_person(request, mutating=False, admin_only=False), intent_id)

    # research.request reports (research.py): the asker's own, and an admin's (?all=1 lists everyone's)
    @app.get("/api/research")
    async def research_list(request: Request, limit: int = 50):
        v = g_person(request, mutating=False, admin_only=False)
        if request.query_params.get("include") == "personal":   # an admin's explicit audit of personal research
            if not v.admin:
                raise HiveError(403, "admin_only", "only a hive admin can do that")
            from .visibility import Viewer
            v = Viewer(v.principal, True, audit=True)
        return hive.research.list(v, everyone=request.query_params.get("all") in ("1", "true"), limit=limit)

    @app.get("/api/research/{request_id}")
    async def research_get(request_id: str, request: Request):
        return hive.research.get(g_person(request, mutating=False, admin_only=False), request_id)

    @app.get("/api/ask/{operation_id}/links")
    async def ask_turn_links(operation_id: str, request: Request):
        """The turn owner's read of its intents and links (refetched whenever links_rev advances, and on reconnect)."""
        return hive.ask.intents.turn_view(g_person(request, mutating=False, admin_only=False), operation_id)

    @app.post("/api/studio/setup")
    async def studio_setup(request: Request):
        """J3 host R7: the caller's own Studio maker (made on first use, reused, its key re-resolved, attached by the
        host) and, given {request: {title, detail, piece, max_steps, window_minutes, ...}}, the setup card: the full
        studio.session request with the host's consent payload and digest. 404 while Studio is off; 402 own_key_needed
        when they have no key of their own for the maker's provider (nothing made)."""
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, G_RECORD_MAX)            # {} sets up the maker alone
        return await run_in_threadpool(hive.studio_makers.setup, v, data)

    @app.get("/api/studio-sessions/{session_id}")
    async def studio_session_get(session_id: str, request: Request):
        """J3 host R2: the owner's ledger of one studio session (anyone else: 404 not_available)."""
        return hive.studio.ledger(g_person(request, mutating=False, admin_only=False), session_id)

    # ---- J3 host R3 (studio_steps.py): the person's frame (mount, piece, outcome), controls and admin audit ----------

    def g_person_auth(request: Request, mutating: bool):
        """g_person plus the host's own reference to the caller's sign-in (a hash of its sessions row key), which binds a
        Studio mount to that sign-in; never taken from a body."""
        v = g_person(request, mutating=mutating, admin_only=False)
        return v, "sha256:" + hashlib.sha256(("studio-mount:" + token_hash(_bearer(request.headers.get("authorization")))).encode()).hexdigest()

    @app.post("/api/studio-sessions/{session_id}/mount")
    async def studio_mount(session_id: str, request: Request):
        v, auth = g_person_auth(request, True)
        return hive.studio.mount(v, session_id, await g_body(request, STUDIO_BODY_MAX), auth)

    @app.get("/api/studio-sessions/{session_id}/mount")
    async def studio_mount_readback(session_id: str, request: Request, attempt_id: str = ""):
        return hive.studio.mount_readback(g_person(request, mutating=False, admin_only=False), session_id, attempt_id)

    @app.delete("/api/studio-sessions/{session_id}/mount")
    async def studio_unmount(session_id: str, request: Request):
        v, auth = g_person_auth(request, True)
        return hive.studio.unmount(v, session_id, await g_body(request, STUDIO_BODY_MAX), auth)

    @app.post("/api/studio-sessions/{session_id}/mount/heartbeat")
    async def studio_heartbeat(session_id: str, request: Request):
        v, auth = g_person_auth(request, True)
        return hive.studio.heartbeat(v, session_id, await g_body(request, STUDIO_BODY_MAX), auth)

    @app.put("/api/studio-sessions/{session_id}/piece")
    async def studio_piece(session_id: str, request: Request):
        v, auth = g_person_auth(request, True)
        out = hive.studio.upload(v, session_id, await g_body(request, STUDIO_PIECE_MAX), auth)
        await hive.studio.advance(session_id)
        return out

    @app.post("/api/studio-sessions/{session_id}/steps/{n}/outcome")
    async def studio_outcome(session_id: str, n: str, request: Request):
        v, auth = g_person_auth(request, True)
        out = hive.studio.outcome(v, session_id, n, await g_body(request, STUDIO_BODY_MAX), auth)
        await hive.studio.advance(session_id)
        return out

    @app.post("/api/studio-sessions/{session_id}/controls")
    async def studio_controls(session_id: str, request: Request):
        v = g_person(request, mutating=True, admin_only=False)
        out = hive.studio.controls(v, session_id, await g_body(request, STUDIO_BODY_MAX))
        await hive.studio.advance(session_id)
        return out

    @app.post("/api/studio-sessions/{session_id}/admin-controls")
    async def studio_admin_controls(session_id: str, request: Request):
        """J3 host R3 (handoff spec r2.4 §5): an admin's Stop and Finish stopping for any session."""
        v = g_person(request, mutating=True, admin_only=True)
        return hive.studio.controls(v, session_id, await g_body(request, STUDIO_BODY_MAX), admin=True)

    @app.get("/api/studio-sessions/{session_id}/audit")
    async def studio_audit(session_id: str, request: Request):
        """K7: a named admin's read-only audit (no piece body, no direction text); anyone else 404."""
        return hive.studio.audit(g_person(request, mutating=False, admin_only=True), session_id)

    @app.post("/api/ask/{operation_id}/steer")
    async def ask_steer(operation_id: str, request: Request):
        """Words while the turn is open (via: typed|voice, recorded); a closed turn: a fresh turn from those words."""
        v = ask_person(request)
        try:
            data = await bounded_body(request, ASK_MAX_BODY)
        except HiveError as exc:   # the closed reason set, never the reader's own text
            raise ask_refusal(hive, "too_large" if exc.status == 413 else "invalid") from None
        return JSONResponse(await hive.ask.steer(v, operation_id, data), status_code=202)

    @app.get("/api/ask/{operation_id}")
    async def ask_get(operation_id: str, request: Request, after: int = 0, limit: int = 100):
        """Recovery: the turn and its frames in order, after seq `after` (at most 100 per page)."""
        return hive.ask.get(ask_person(request), operation_id, after, limit)

    @app.post("/api/ask/{operation_id}/stop")
    async def ask_stop(operation_id: str, request: Request):
        return hive.ask.stop(ask_person(request), operation_id)

    @app.post("/api/ask/{operation_id}/done")
    async def ask_done(operation_id: str, request: Request):
        """gateway r1b (plan §2.3): the person's browser closes its own browser turn, {outcome}: answered | incomplete |
        spend_cap | failed | stopped. §G person gate (exact Origin, Bearer header only); the owner only; content-free;
        releases nothing; idempotent. With HIVE_MIND_GATEWAY unset the route answers exactly as an unknown path does."""
        from .ask import gateway_enabled
        if not gateway_enabled():
            from starlette.exceptions import HTTPException as StarletteHTTPException
            raise StarletteHTTPException(404)
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, G_SMALL_MAX)
        return hive.ask.done(v, operation_id, data)

    @app.post("/api/ask/{operation_id}/takeover")
    async def ask_takeover(operation_id: str, request: Request):
        """Posted by a page loaded before a turn ran on through the person's own clicks, scrolls and Back (Jon, 17 Nov:
        "Ask should exist above UI - stop shouldn't happen"). Nothing ends: such a page holds the mind's moves of the
        page itself and the turn runs on to its answer. 404 not_available is what that page reads as nothing for the
        host to do, so it never falls back to a stop."""
        ask_person(request)
        raise ask_refusal(hive, "not_available")

    @app.post("/api/ask/{operation_id}/acts/{act_id}/result")
    async def ask_act_result(operation_id: str, act_id: str, request: Request):
        """The page reports what one conductor act did (vocabulary v1 §2; Platform's answers 3): the turn's owner only
        (anyone else: 404), an act the host emitted in that turn, once (409 act_result_recorded), <= 8 KB. The view is
        held in the turn's memory as the act's tool result; it is never stored or logged."""
        from .conductor import MAX_RESULT_BYTES
        v = ask_person(request)
        turn = hive.ask._own(v, operation_id)
        session_hash = None
        if hive.db.one("SELECT 1 FROM app_ask_turns WHERE turn_id = ?", (turn["id"],)):
            v, session_hash = p1_person(request)
        if hive.ask.conductor is None or not turn.get("conductor_model"):
            raise ask_refusal(hive, "not_available")
        try:
            data = await bounded_body(request, MAX_RESULT_BYTES)
        except HiveError as exc:
            raise ask_refusal(hive, "too_large" if exc.status == 413 else "invalid") from None
        return hive.ask.conductor.result(v, turn, act_id, data, session_hash=session_hash)

    @app.delete("/api/ask/threads/{thread_id}")
    async def ask_delete_thread(thread_id: str, request: Request):
        """The person deletes their own Ask thread: it ends, and its text is removed (the turn rows stay for the audit)."""
        return hive.ask.delete_thread(ask_person(request), thread_id)

    @app.get("/api/me/ask")
    async def me_ask(request: Request):
        return hive.ask.prefs(ask_person(request))

    @app.put("/api/me/ask")
    async def me_ask_put(request: Request):
        v = ask_person(request)
        try:
            data = await bounded_body(request, 4096)
        except HiveError as exc:
            raise ask_refusal(hive, "too_large" if exc.status == 413 else "invalid") from None
        return hive.ask.put_prefs(v, data)

    # ---- First Light (hive/core/onboarding.py): the person's own progress, setup list and first hello ----------

    async def _onboarding_body(request: Request):
        from .onboarding import MAX_BODY as ONBOARDING_MAX_BODY
        try:
            return await bounded_body(request, ONBOARDING_MAX_BODY)
        except HiveError as exc:
            if exc.status == 413:
                raise HiveError(413, "too_large", f"onboarding progress is limited to {ONBOARDING_MAX_BODY} bytes") from None
            raise

    @app.get("/api/me/onboarding")
    async def me_onboarding(request: Request):
        return hive.onboarding.get(viewer(operator(request)))

    @app.put("/api/me/onboarding")
    async def me_onboarding_put(request: Request):
        v = viewer(operator(request))
        hive.onboarding.person(v)   # refused before the body is read
        return hive.onboarding.write(v, await _onboarding_body(request), replace=True)

    @app.patch("/api/me/onboarding")
    async def me_onboarding_patch(request: Request):
        v = viewer(operator(request))
        hive.onboarding.person(v)
        return hive.onboarding.write(v, await _onboarding_body(request), replace=False)

    @app.get("/api/me/setup")
    async def me_setup(request: Request):
        return await run_in_threadpool(hive.onboarding.setup, viewer(operator(request)))

    @app.get("/api/me/personal-mind/hello")
    async def me_personal_mind_hello(request: Request):
        return hive.onboarding.hello_get(viewer(operator(request)))

    @app.post("/api/me/personal-mind/hello")
    async def me_personal_mind_hello_post(request: Request):
        return await hive.onboarding.hello(viewer(operator(request)))

    # ---- the person's own personal mind (hive/core/personal.py): owner only, by construction ----------------

    @app.get("/api/me/mind")
    async def me_mind(request: Request):
        return await run_in_threadpool(hive.personal.get, viewer(operator(request)))

    @app.post("/api/me/mind")
    async def me_mind_post(request: Request):
        v = viewer(operator(request))
        data = await bounded_body(request, 4096)
        return await run_in_threadpool(hive.personal.post, v, data)

    # ---- gateway r1c (PLATFORM_PERSONAL_MIND_GATEWAY_R1_PLAN §2.1, §2.2): the mind token and the gateway --------------
    # With HIVE_MIND_GATEWAY unset all three answer exactly as an unknown path does.

    def _gateway_off():
        from .ask import gateway_enabled
        if not gateway_enabled():
            from starlette.exceptions import HTTPException as StarletteHTTPException
            raise StarletteHTTPException(404)

    def _mint_person(request: Request):
        """§G person gate (exact Origin, Bearer header only, a named admin or member, never the password) and an enabled
        person; returns (viewer, the parent session's token hash)."""
        v = g_person(request, mutating=True, admin_only=False)
        if hive.personal.person(v.principal) is None:
            raise HiveError(403, "person_required", "a named, signed-in person does this")
        return v, token_hash(_bearer(request.headers.get("authorization")))

    @app.post("/api/me/mind/session")
    async def me_mind_session(request: Request):
        """Mint a mind token: {} -> 201 {token, expires_at, mind {id}, scope ["chat"]}, no-store. 30 minutes, at most 4
        live per session (a fifth revokes the oldest), stored hashed; accepted only by the gateway below."""
        _gateway_off()
        v, session_hash = _mint_person(request)
        try:
            data = await g_body(request, G_SMALL_MAX, optional=True)
        except HiveError as exc:
            if exc.status == 400:
                raise HiveError(400, "invalid", "this request takes {}") from None
            raise
        if data:
            raise HiveError(400, "invalid", "this request takes {}")
        mind = await run_in_threadpool(hive.personal.ensure, v.principal)
        raw, expires = await run_in_threadpool(hive.mind_tokens.mint, v.principal, mind["id"], session_hash)
        from .ask import _iso
        return JSONResponse({"token": raw, "expires_at": _iso(expires), "mind": {"id": mind["id"]}, "scope": ["chat"]},
                            status_code=201, headers={"Cache-Control": "no-store"})

    @app.delete("/api/me/mind/session")
    async def me_mind_session_revoke(request: Request):
        """Revoke every live mind token of the caller's session: {revoked: n}."""
        _gateway_off()
        _v, session_hash = _mint_person(request)
        n = await run_in_threadpool(hive.mind_tokens.revoke_session, session_hash)
        return JSONResponse({"revoked": n}, headers={"Cache-Control": "no-store"})

    from .mind_gateway import MindGateway
    mind_gateway = MindGateway(hive, gateway, cost_reservations, hold_unknown, overrun_flag)

    @app.post("/api/me/mind/llm/v1/chat/completions")
    async def me_mind_chat(request: Request):
        """One model call of the person's browser turn (mind_gateway.py): the mind token only, X-Mind-Purpose: turn,
        X-Mind-Turn: <turn_id>; the provider's body unchanged with X-Hive-* money headers on 200 only."""
        request.state.answers_a_mind = True   # its refusals carry no person's error id (error_answer)
        _gateway_off()

        async def read(req, limit):
            try:
                return await bounded_body(req, limit)
            except HiveError as exc:
                if exc.status == 400:
                    raise HiveError(400, "invalid", "expected a JSON object") from None
                raise
        return await mind_gateway.chat(request, G_ORIGINS, read)

    @app.get("/api/me/mind/inbox")
    async def me_mind_inbox(request: Request, after: str = "", limit: int = 50):
        return hive.personal_inbox.items(viewer(operator(request)), after or None, limit)

    @app.post("/api/me/mind/inbox/ack")
    async def me_mind_inbox_ack(request: Request):
        v = viewer(operator(request))
        data = await bounded_body(request, 32768)
        return hive.personal_inbox.ack(v, data)

    # ---- gateway gate A (browser-Iter plan r7.7 §8.3, §11): the freshness checkpoint (mind_checkpoint.py) ---------------
    # §G person gate, the owner's own row only; content-blind; PUT and DELETE are compare-and-set on If-Match.
    # With HIVE_MIND_GATEWAY unset all three answer exactly as an unknown path does.

    def _checkpoint_answer(head):
        from .mind_checkpoint import etag
        return JSONResponse(head, headers={"ETag": etag(head["seq"]), "Cache-Control": "no-store"})

    @app.get("/api/me/mind/checkpoint")
    async def me_mind_checkpoint(request: Request):
        _gateway_off()
        v = g_person(request, mutating=False, admin_only=False)
        return _checkpoint_answer(await run_in_threadpool(hive.mind_checkpoints.get, v))

    @app.put("/api/me/mind/checkpoint")
    async def me_mind_checkpoint_put(request: Request):
        from .mind_checkpoint import if_match, invalid
        _gateway_off()
        v = g_person(request, mutating=True, admin_only=False)
        try:
            data = await g_body(request, G_SMALL_MAX)
        except HiveError as exc:
            if exc.status == 400:
                raise invalid() from None
            raise
        return _checkpoint_answer(await run_in_threadpool(hive.mind_checkpoints.put, v, data,
                                                          if_match(request.headers.get("if-match"))))

    @app.delete("/api/me/mind/checkpoint")
    async def me_mind_checkpoint_reset(request: Request):
        from .mind_checkpoint import if_match
        _gateway_off()
        v = g_person(request, mutating=True, admin_only=False)
        return _checkpoint_answer(await run_in_threadpool(hive.mind_checkpoints.reset, v,
                                                          if_match(request.headers.get("if-match"))))

    # ---- sessions: a focused working thread with one mind (hive/core/sessions.py) -----------------------

    @app.get("/api/sessions")
    async def list_sessions(request: Request):
        return hive.sessions.list(viewer(operator(request)))

    @app.post("/api/sessions")
    async def create_session(request: Request):
        v = viewer(operator(request))
        data = await body(request)
        agent = hive.agent(str(data.get("mind") or ""))
        hive.visibility.check_path(v, {"swarm_id": agent.get("swarm_id")})
        return await hive.sessions.create(v, data)

    @app.get("/api/sessions/{session_id}/timeline")
    async def session_timeline(session_id: str, request: Request):
        return hive.sessions.timeline(viewer(operator(request)), session_id)

    @app.get("/api/sessions/{session_id}/workspaces")
    async def session_workspaces(session_id: str, request: Request):
        """Coding workspaces the session's mind opened on its goal (OmegaCode discovery), so the session can open them
        in the Workbench. Each lookup uses a short read grant on the goal, revoked straight after."""
        session = operator(request)
        v = viewer(session)
        s = hive.sessions._row(v, session_id)
        if not s["goal_id"]:
            return {"workspaces": []}
        principal = session.get("principal") or "user:operator"
        found = []
        for repository_id in sorted(code.repos):
            grant = hive.services.grant(s["goal_id"], principal, "read", None, 5, by=principal)
            try:
                status, content, _ = await code.proxy(principal, "GET", f"/v1/tasks/{s['goal_id']}/workspaces", {}, None,
                                                      s["goal_id"], grant["id"], repository_id)
                if status == 200:
                    for w in json.loads(content) or []:
                        if isinstance(w, dict) and w.get("id"):
                            found.append({**w, "repository_id": w.get("repository_id") or repository_id})
            except Exception:
                pass                     # a repository the service cannot answer for is simply not listed
            finally:
                hive.services.revoke_grant(s["goal_id"], grant["id"])
        return {"workspaces": found}

    @app.post("/api/sessions/{session_id}/end")
    async def end_session(session_id: str, request: Request):
        return hive.sessions.end(viewer(operator(request)), session_id)

    @app.get("/api/agent/rooms")
    async def agent_rooms(request: Request):
        return hive.rooms.agent_rooms(agent_from(request)["id"])

    @app.post("/api/agent/rooms/{room_id}/messages")
    async def agent_room_post(room_id: str, request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await hive.rooms.mind_post(agent["id"], room_id, data.get("text"), note=data.get("note") is True)

    # ---- where minds live, and moving them between hives (hive/core/placement.py) ------------------------

    def _owner_or_admin(request, agent_id):
        session = operator(request)
        require_control(session, agent_id)   # moving a mind to another hive is acting on it
        return session

    @app.get("/api/hive/identity")
    async def hive_identity(request: Request):
        operator(request)
        return hive.placement.identity()

    @app.patch("/api/hive/identity")
    async def set_hive_identity(request: Request):
        admin(request)
        data = await body(request)
        return hive.placement.set_identity(data.get("name"), data.get("home"))

    @app.post("/api/agents/{agent_id}/export")
    async def export_mind(agent_id: str, request: Request):
        """The mind as a bundle for another hive. The mind must be stopped; nothing changes here until settle.
        A personal mind's bundle is unscoped only for an admin's explicit audit (?include=all or ?include=personal),
        marked detail.personal_conversations = "included_audited". Its person gets the rows their own transcript shows
        (Hive.reader_scope: their chats, never other people's, the operator's or other people's Ask turns), marked
        "included_person" (stand-in idle-minds r2.3 P1 #1); anyone else gets the rows they may read, marked "excluded"
        (r2.2 P1 #2). A personal mind's bundle imports only back home (placement._refuse_unbound_personal)."""
        session = _owner_or_admin(request, agent_id)
        audit = explicit_audit(request, session)
        principal = session.get("principal") or "user:operator"
        personal = hive._agent_row(agent_id).get("personal_of")
        if not personal:
            reader, mark = None, None
        elif principal == personal:   # their own transcript's rows, not other people's chats (stand-in r2.3 P1 #1)
            reader, mark = principal, "included_person"
        elif audit:
            reader, mark = None, "included_audited"
        else:
            reader, mark = principal, "excluded"
        may_see = key_seer(session)   # keyview: a key this caller may not see never leaves inside the bundle either
        bundle, digest = await run_in_threadpool(lambda: hive.placement.export(agent_id, reader=reader, mark=mark, by=principal,
                                                                               may_see_key=may_see))
        headers = {"X-Manifest-Sha256": digest, "Content-Disposition": f'attachment; filename="{agent_id}.omegamind.tgz"'}
        if mark:
            headers["X-Personal-Conversations"] = mark
        return Response(bundle, media_type="application/gzip", headers=headers)

    @app.post("/api/agents/import")
    async def import_mind(request: Request):
        """Bring a mind here from a bundle (same id, fresh token). A member brings it into a swarm they can see, as its owner."""
        session = operator(request)
        swarm_id = request.query_params.get("swarm_id") or None
        is_admin = role_of(session) == "admin"
        tools_ok = is_admin   # OI-13 r1.1: tools on an imported mind are admin-only, as on create and PATCH
        if not is_admin:
            if not swarm_id:
                raise HiveError(400, "swarm_required", "choose a swarm you can see")
            hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        owner = None if is_admin else session.get("principal")
        return await run_in_threadpool(hive.placement.import_, await request.body(), swarm_id, owner,
                                       session.get("principal") or "user:operator", may_use_key=key_permit(session),
                                       tools_ok=tools_ok)

    @app.post("/api/agents/{agent_id}/settle")
    async def settle_mind(agent_id: str, request: Request):
        """The destination has it: leave a tombstone here."""
        _owner_or_admin(request, agent_id)
        data = await body(request)
        return hive.placement.settle(agent_id, str(data.get("to_hive") or ""), str(data.get("to_name") or ""),
                                     str(data.get("manifest_sha256") or ""))

    @app.get("/api/agents/{agent_id}/moves")
    async def mind_moves(agent_id: str, request: Request):
        operator(request)
        return hive.placement.moves(agent_id)

    @app.post("/api/agents/{agent_id}/convert-native")
    async def convert_native(agent_id: str, request: Request):
        admin(request)
        return hive.convert_to_native(agent_id)

    @app.get("/api/agents/{agent_id}/isolation")
    async def agent_isolation(agent_id: str, request: Request):
        """The boundary the mind's running process actually has (not what is configured). With no process started by
        this hive since it last started there is no boundary to report: ``running`` false says so, so a page never
        calls a mind that is not running "not sandboxed"."""
        operator(request)
        agent = hive.agent(agent_id)
        driver = supervisor.driver(agent) if supervisor else None
        actual = getattr(driver, "isolation", {}).get(agent_id) if driver else None
        return actual or {"environment": "unknown", "os_sandbox": False, "profile": None, "running": False,
                          "note": "not started by this hive process since its last restart"}

    @app.get("/api/agents/{agent_id}/logs")
    async def logs(agent_id: str, request: Request, tail: int = 200):
        hidden_researcher(operator(request), agent_id)
        hive.agent(agent_id)
        lines = await run_in_threadpool(supervisor.logs, agent_id, min(int(tail), 2000)) if supervisor else []
        return {"lines": lines}

    # ---- G2: notices to a person from their own minds; G4: a person's own daily spend ---------------------------------

    def notice_person(request):
        v = viewer(operator(request))
        return hive.notices.require_person(v.principal)

    @app.post("/api/agent/notices")
    async def agent_notice(request: Request):
        agent_from(request)
        data = await bounded_body(request, 4096)
        agent = agent_from(request)   # re-read after the body: a mind deleted or moved meanwhile is judged as it is now
        return await run_in_threadpool(hive.notices.post, agent, data)

    @app.get("/api/me/notices")
    async def my_notices(request: Request, after: int = 0, limit: int = 50):
        return await run_in_threadpool(hive.notices.list, notice_person(request), max(0, after), limit)

    @app.get("/api/me/stage")
    async def my_stage(request: Request, after: int = 0):
        """What minds said to this person's stage after `after`: a page whose socket dropped reads what it missed."""
        return hive.stage.since(viewer(operator(request)).principal, max(0, after))

    @app.get("/api/me/notices/settings")
    async def my_notice_settings(request: Request):
        return hive.notices.prefs(notice_person(request))

    @app.put("/api/me/notices/settings")
    async def my_notice_settings_set(request: Request):
        notice_person(request)
        data = await body(request)
        return await run_in_threadpool(hive.notices.set_prefs, notice_person(request), data)

    @app.post("/api/me/notices/release")
    async def my_notices_release(request: Request):
        """"Show what's waiting": the person asks for their held notices now, as one digest."""
        principal = notice_person(request)
        return {"digest": await run_in_threadpool(hive.notices.release, principal, True)}

    @app.get("/api/me/spend")
    async def my_daily_spend(request: Request, days: str | None = None):
        # the same person gate as the notices: a session that is not a current person reads nothing, never the
        # operator's own rows by default
        return await run_in_threadpool(hive.me_spend.read, notice_person(request), hive.me_spend.days(days))

    @app.get("/api/usage/me")
    async def usage_me(request: Request):
        session = operator(request)
        return await run_in_threadpool(hive.my_spend, session.get("principal") or "user:operator")

    @app.get("/api/usage")
    async def usage(request: Request, agent_id: str | None = None, since: str | None = None):
        session = operator(request)
        out = hive.usage(agent_id, since)
        return hive.visibility.filter_items(viewer(session), out) if isinstance(out, list) else out

    # ---- live events for the UI ---------------------------------------------------------------

    @app.websocket("/api/events")
    async def events(ws: WebSocket):
        event_token = ""

        def event_session(token, public):
            # Keep the handshake's bearer private to this connection so wakeup dispatch can
            # reuse the ordinary auth boundary after queue.get(), including local first-frame auth.
            nonlocal event_token
            row = session_for(token, public)
            if row is not None:
                event_token = token
            return row

        if local is not None:
            # J1 r2 B3, r3 N: no token in the address; the first frame signs in within 5 s, at most 4 KiB, before any
            # subscription (the Origin was already checked by LocalBoundary)
            session = await localowner.events_auth(ws, event_session)
            if session is None:
                return
        else:
            token = ws.query_params.get("token", "")
            session = event_session(token, ws.scope.get("hive_public", False))
            if session is None:
                await ws.close(code=4401)
                return
            await ws.accept()   # each frame is judged for the session as it is then (pump); live audit never exists
        tasks: list[asyncio.Task] = []
        failures: list[BaseException] = []

        from .limits_view import limit_frame

        async def pump():
            try:
                while True:
                    text = await queue.get()
                    if hive.events.lost(queue):
                        # This page fell so far behind that the bus dropped frames for it (events.py): what it holds may
                        # miss them, so it is closed as "try again later" and reconnects, and a reconnect reads again.
                        with contextlib.suppress(Exception):
                            await ws.close(code=EVENTS_BEHIND_CLOSE)
                        return
                    # sol on f06f2915: who this connection is for is read again before every frame, never kept from the
                    # handshake: a signed-out, revoked or expired session closes the socket, and a changed one (role,
                    # access) is judged as it is now
                    current = session_for(event_token, ws.scope.get("hive_public", False)) if event_token else None
                    if current is None:
                        with contextlib.suppress(Exception):
                            await ws.close(code=4401)
                        return
                    now_who = viewer(dict(current, include_personal=False))
                    if hive.visibility.event_visible(now_who, text):   # R13: each person sees only what they may
                        text = people_frame(text)   # Peter on omegahive#50: a verified Health question, untagged
                        text = limit_frame(hive, now_who, text)   # a refusal names its limit only to who may see it
                        if keyview.mentions_keys(text) and key_seer(current) is not None:   # keyview: key refs too
                            text = json.dumps(keys_projected(current, json.loads(text)))
                        projected = wakeup_notice(lambda: session_for(event_token, ws.scope.get("hive_public", False)), text)
                        if projected is not None:
                            await _ws_send(ws, projected)
            except _PeerGone:
                return

        async def listen():
            try:
                while True:
                    frame = await _ws_receive(ws)
                    if local is not None and len(frame.encode("utf-8")) > localowner.EVENTS_FRAME_MAX:
                        with contextlib.suppress(Exception):
                            await ws.close(code=1009)   # J1 r3 N: a local hive's event frames are bounded at 4 KiB
                        return
                    try:
                        message = json.loads(frame)
                    except ValueError:
                        continue                  # a frame that is not JSON is ignored; only decoding is excused
                    if isinstance(message, dict) and message.get("type") == "ping":
                        await _ws_send(ws, json.dumps({"type": "pong", "at": now()}))
            except _PeerGone:
                return

        def failed(exc):                          # unexpected: one concise line, never a silent swallow
            if any(seen is exc for seen in failures):
                return                            # one line per failure, whichever path reports it first
            failures.append(exc)
            logging.getLogger("hive").error("events websocket failed: %s: %s", type(exc).__name__, exc)

        def retrieve(task):
            # Every task's outcome is retrieved as it ends, even if this handler is itself cancelled meanwhile:
            # no "Task exception was never retrieved".
            if not task.cancelled() and task.exception() is not None:
                failed(task.exception())

        # Subscribed before the hello snapshot so no event falls between the two; the finally below always
        # unsubscribes it, whether the summary, the hello send or anything after them fails (Kimi K2).
        queue = hive.events.subscribe()
        # where in the stream this subscription starts, read with no await between: every later frame reaches the queue,
        # and an answer whose Hive-Stream is older than this may miss one (the page then reads it again)
        stream = {"id": hive.events.stream, "at": hive.events.at}
        try:
            hello = json.dumps({"type": "hello", "at": now(), "hive": await run_in_threadpool(hive.summary),
                                "stream": stream})
            await _ws_send(ws, hello)
            tasks = [asyncio.create_task(pump()), asyncio.create_task(listen())]
            for task in tasks:
                task.add_done_callback(retrieve)
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        except _PeerGone:
            pass
        except Exception as exc:
            failed(exc)
        finally:
            try:
                for task in tasks:
                    task.cancel()                 # a no-op on the task that already finished
                if tasks:
                    # Wait for the cancelled task to end (no orphan). asyncio.wait never raises a child's
                    # CancelledError; gather would, and its re-cancel escapes the server's cancel scope.
                    await asyncio.wait(tasks)
                if failures:
                    with contextlib.suppress(Exception):
                        await ws.close(code=1011)
            finally:
                hive.events.unsubscribe(queue)

    # ---- agents: hub, gateway, swarm API ---------------------------------------------------------

    @app.websocket("/agent-hub")
    async def agent_hub(ws: WebSocket):
        try:   # R2.8 W-e: a restricted bridged credential is refused before admission or socket registration
            agent = hive.authenticate_agent(_bearer(ws.headers.get("authorization")), surface="agent-hub")
        except HiveError:
            await ws.close(code=4403)
            return
        if agent is None:
            await ws.close(code=4401)
            return
        agent_id = agent["id"]
        admission = await hive.admit_connection(agent_id)   # stopped or asleep: a late connection never wakes it
        await ws.accept()
        # The registration fence runs after the accept await: a stop, sleep, delete or restart since the admission
        # refuses it, and the socket is closed without entering the receive loop (Review B1).
        if not admission or not await hive.agent_connected(agent_id, ws, admitted=admission):
            with contextlib.suppress(Exception):
                await ws.close(code=4409)
            return
        hive.studio.connected(agent, ws)    # J3 R3 (r1.4 G2): this socket keeps the epoch it authenticated with
        try:
            while True:
                try:
                    text = await ws.receive_text()
                    if hive.connections.get(agent_id) is not ws:
                        break      # withdrawn by a stop that won after registration: no frame of it is handled
                    frame = json.loads(text)
                except ValueError:
                    await ws.send_text(json.dumps({"type": "error", "code": "bad_json", "message": "frames are JSON"}))
                    continue
                kind = frame.get("type")
                if kind == "resume":
                    await hive.replay(agent_id, frame.get("last_seen_seq"))
                elif kind == "prompt_ack" and not hive.minds.is_child(agent_id):
                    pass                     # not a child: no answer, so the frame type confirms nothing (Kimi #6)
                elif kind == "prompt_ack":   # r2.12 §3: the child's own ack of a prompt revision (only this proves receipt)
                    own = frame.get("child_id") in (None, agent_id)    # an ack names this connection's own child, or none
                    status = hive.minds.acknowledge(agent_id, frame.get("rev")) if own else "refused"
                    await ws.send_text(json.dumps({"type": "prompt_ack", "rev": frame.get("rev"),
                                                   "acknowledged": status == "acknowledged", "status": status}))
                elif kind == "agent_message":
                    message = hive.record_agent_message(agent_id, frame)
                    await ws.send_text(json.dumps({"type": "ack", "seq": None, "client_seq": frame.get("client_seq"),
                                                   "message_id": message["id"]}))
                else:
                    await ws.send_text(json.dumps({"type": "error", "code": "unknown_type", "message": str(kind)}))
        except WebSocketDisconnect:
            pass
        finally:
            hive.agent_disconnected(agent_id, ws)

    from .gateway import SEND_GATE
    from .studio_gateway import StudioRefused

    def studio_check(call, check, *args):
        """Hive.check_budget for a paid call; for a Studio maker a 402 also ends its step and pauses its session (§6.5)."""
        try:
            return check(*args)
        except HiveError as exc:
            if call is not None and exc.status == 402:
                hive.studio.gateway_refused(call, ("paused", "budget_exhausted", "refused_budget"))
            raise

    def studio_reserve(call, key, payload, estimate, budgets, meta, subjects):
        """J3 R4: a maker's reservation (StudioGateway.reserve_call): bound to its step and captured epoch, checked in the
        reservation transaction, reserved undispatched; a refusal ends the step and pauses or holds the session."""
        return hive.studio.reserve_call(call, cost_reservations, key, payload, estimate, budgets, meta, subjects)

    # Web tools (hive/core/webtools.py): host-side web search and a vetted https fetch for minds. A mind's model call
    # starts a new web turn (the per-turn caps); HIVE_WEB_TOOLS=off leaves every /api/agent/web and /api/web route absent.
    web_tools = None
    if settings.web_tools:
        from .webtools import WebError, WebTools, BODY_LIMIT as WEB_BODY_LIMIT
        web_tools = WebTools(hive)
        app.state.web_tools = web_tools

        async def web_call(request, method):
            agent = agent_from(request)
            fenced = hive.studio.gateway_fence(agent)   # a Studio maker reaches the web only in its step, as chat does
            if fenced is not None:
                raise fenced
            data = await bounded_body(request, WEB_BODY_LIMIT)
            try:
                return await getattr(web_tools, method)(agent, data)
            except WebError as exc:
                raise HiveError(exc.status, exc.code, exc.message, exc.details) from None

        @app.post("/api/agent/web/search")
        async def agent_web_search(request: Request):
            return await web_call(request, "search")

        @app.post("/api/agent/web/fetch")
        async def agent_web_fetch(request: Request):
            return await web_call(request, "fetch")

        @app.get("/api/web/settings")
        async def web_settings(request: Request):
            admin(request)
            return web_tools.settings()

        @app.put("/api/web/settings")
        async def web_settings_put(request: Request):
            session = admin(request)
            data = await body(request)
            try:
                return web_tools.put_settings(data, session.get("principal", "user:operator"))
            except ValueError as exc:
                raise HiveError(400, "bad_request", str(exc)) from None

        @app.get("/api/web/audit")
        async def web_audit(request: Request):
            admin(request)
            try:
                return web_tools.audit(request.query_params.get("agent_id"), request.query_params.get("limit") or 100)
            except ValueError as exc:
                raise HiveError(400, "bad_request", str(exc)) from None

        @app.get("/api/web/breakers")
        async def web_breakers(request: Request):
            admin(request)
            return [dict(r) for r in hive.db.all("SELECT * FROM web_breakers ORDER BY agent_id")]

        @app.post("/api/web/breakers/{agent_id}/reset")
        async def web_breaker_reset(agent_id: str, request: Request):
            session = admin(request)
            data = await body(request)
            try:
                row = web_tools.reset(agent_id, session.get("principal", "user:operator"), data.get("reason"))
            except ValueError as exc:
                raise HiveError(400, "bad_request", str(exc)) from None
            hive.events.publish("web.breaker_reset", agent=agent_id, agent_id=agent_id, by=row["reset_by"],
                                reason=row["reset_reason"])
            return row

    @app.post("/llm/v1/chat/completions")
    async def chat_completions(request: Request):
        agent = agent_from(request)
        fenced = hive.studio.gateway_fence(agent)   # J3 R2.2/R3: a Studio maker calls only in its step's own execution
        if fenced is not None:
            raise fenced
        data = await body(request)
        if not (data.get("max_tokens") or data.get("max_completion_tokens")):
            data["max_tokens"] = 4096          # the cap the estimate assumes, so a reservation is a true worst case
        # never more room than the model can give: a mind's retry after a cut-off asks for twice its room
        # (runtime/provider_features.py), and a request over the model's own output limit would be refused outright
        limit = providers.output_limit(agent.get("model"))
        for key in ("max_tokens", "max_completion_tokens"):
            if limit and isinstance(data.get(key), int) and data[key] > limit:
                data[key] = limit
        try:
            paid, estimate = gateway.estimate(agent, data, settings.allow_unpriced)
        except GatewayError as exc:
            if spoken(exc):   # a held $0 model, or the free route refusing it before anything is sent
                hive.note_model_refusal(agent, exc)
            raise
        provider_name = str(agent["model"]).partition("/")[0]
        key_id = gateway.paying_key(agent, provider_name)[0] if paid else None
        key_owner = ((gateway.keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if (key_id and gateway.keyring) else None
        payer, own_key = hive.payer_for(agent, key_owner)
        # J3 R4: a live Studio session's maker is bound to the step admitted now (None for every other mind, and off)
        studio_call = hive.studio.gateway_call(agent) if paid else None
        if limit and studio_call is None and hive.goals.holds_create_step(agent["id"]):
            # a Create step's answer is whole files (a build, the acceptance check) or a whole plan in one reply, and a
            # reply cut off at its room is thrown away whole: a Make run of a tester's tic-tac-toe had eleven replies stop
            # at their 6000-token room. So its first call asks with the model's whole room, as much of it as a new
            # reservation can hold now (cost_reservations.reservable_micros), never less than the mind asked for.
            key = "max_completion_tokens" if data.get("max_completion_tokens") else "max_tokens"
            room = gateway.affordable_room(agent, data, limit,
                                           reservable_micros(hive, agent["id"], key_id, payer, own_key) if paid else None)
            if isinstance(data.get(key), int) and room > data[key]:
                data[key] = room
                paid, estimate = gateway.estimate(agent, data, settings.allow_unpriced)
        studio_check(studio_call, hive.check_budget, agent, paid, estimate, key_id, payer, own_key)
        # after the hive's own checks (a day's cap, a spending limit), which answer first: a refusal kept on this mind still
        # holds, so its provider isn't asked again, and nothing is reserved or sent, until its wait has passed, someone
        # wrote to the mind, or its model or the key its calls go out with changed (Hive.model_refusal_holds)
        kept = hive.model_refusal_holds(agent)
        if kept is not None:
            raise refused_again(kept, kept["until"] - time.monotonic())
        reservation = None
        if paid:
            def current_budgets():
                # host-identity r1: inside the reservation's write transaction, as media.py does: a session or Ask turn
                # that started or ended since admission (a new payer) refuses the call rather than billing the old one.
                if hive.payer_for(hive.agent(agent["id"]), key_owner) != (payer, own_key):
                    raise ValueError("payer changed during admission")
                host_use_check(hive, agent["id"], key_id, payer)   # money port r1.2: access removed since admission
                return host_budget_snapshot(hive, agent["id"], key_id, payer, own_key)
            import uuid
            reservation = str(uuid.uuid4())
            meta = {"agent":agent["id"],"model":agent["model"],"payer":payer,"key":key_id}
            try:
                if studio_call is None:
                    # paced only when no person's live work holds the mind (Hive.present_for): a runaway is a mind alone
                    cost_reservations.reserve(reservation, {"agent": agent["id"], "model": agent["model"], "body": data, "payer": payer, "key": key_id}, estimate, current_budgets, metadata=meta, dispatched=True,
                                              subjects=host_subjects(hive, agent["id"], key_id, payer, own_key),
                                              paced=hive.present_for(agent) is None)
                else:
                    # reserved, not dispatched: SEND_GATE re-reads this reservation's own step before anything is sent
                    studio_reserve(studio_call, reservation, {"agent": agent["id"], "model": agent["model"], "body": data, "payer": payer, "key": key_id},
                                   estimate, current_budgets, meta, host_subjects(hive, agent["id"], key_id, payer, own_key))
            except ValueError as exc:
                if "payer changed" in str(exc):
                    raise hive.error(409, "payer_changed", "who pays for this mind changed meanwhile; ask again") from None
                if isinstance(exc, SpendRateLimited):   # within its limits but faster than this month allows: nothing held
                    raise hive.spend_rate_refusal(agent, exc) from None
                say = None
                if isinstance(exc, BudgetExhausted):   # recorded and announced like Budgets.check's refusal, naming its limit
                    say = hive.note_refusal(agent, "reservation_refused", str(exc), exhausted_limit(exc))
                raise hive.error(402, "reservation_refused", str(exc), {"say": say} if say else None) from None
        if paid:
            hive.note_admitted(agent)   # both checks passed: a pause for spending, if there was one, is over
        hive.thinking(agent["id"], "llm", payer)   # the payer names the Ask turn this call is attributed to, if any
        started = time.monotonic()
        gate_token = SEND_GATE.set(studio_call.gate) if (studio_call is not None and reservation) else None
        # the key this call goes out with (gateway.chat picks the same one before it first awaits): a refusal that comes
        # back after that key changed is the old key's, and holds nothing (Hive.note_model_refusal)
        sent_with = hive.sender_of(agent)
        try:
            response, usage = await gateway.chat(agent, data)
        except StudioRefused as exc:
            # refused at the send gate: the hold was released and nothing was sent
            raise exc.error from None
        except BaseException as exc:
            if studio_call is not None and studio_call.unsent():
                raise                       # r4.1: never reached the send boundary: released, not held unknown
            if reservation: hold_unknown(reservation, exc)   # a refusal with a charge settles; one its provider documents as unbilled is released
            if spoken(exc):   # the provider's refusal, or the free route's: kept on the mind for its chat, Health and its next tries
                hive.note_model_refusal(agent, exc, sent_with=sent_with)
            raise
        finally:
            if gate_token is not None:
                SEND_GATE.reset(gate_token)
            hive.thinking(agent["id"], "idle", payer)
        hive.model_answered(agent["id"])   # an answer ends any refusal kept on the mind
        if web_tools is not None:
            web_tools.new_turn(agent["id"])   # only a model call that returned starts a new web turn
        if studio_call is not None and reservation:
            studio_call.made()
        if not reservation:
            hive.last_llm[agent["id"]] = (int((time.monotonic() - started) * 1000),
                                          usage["prompt_tokens"] + usage["completion_tokens"])
            resolved = response.get("model") if isinstance(response, dict) else None
            await run_in_threadpool(hive.record_usage, agent, agent["model"], usage, resolved, payer)
            return response
        # The provider call succeeded: nothing below may raise to the caller.  Any failure holds the liability.
        try:
            observation = {"usage_origin":"usage-unverified"}
            if isinstance(response, dict):
                for field, target in (("id","response_id"),("model","resolved_model")):
                    if isinstance(response.get(field),str): observation[target] = response[field][:200]
            cost_reservations.observe(reservation, observation)
            if not gateway_billable(response, usage):
                # Content can still be delivered, but absent usage is not zero cost.
                hold_unknown(reservation)
                return response
            counted = isinstance(response, dict) and isinstance(response.get("usage"), dict) and type(response["usage"].get("prompt_tokens")) is int
            observation["usage_origin"] = "provider-token-counters-rate-derived" if counted else "provider-usage-cost"
            cost_reservations.observe(reservation, observation)
            hive.last_llm[agent["id"]] = (int((time.monotonic() - started) * 1000),
                                          usage["prompt_tokens"] + usage["completion_tokens"])
            resolved = response.get("model") if isinstance(response, dict) else None   # the provider's own report
            await run_in_threadpool(cost_reservations.settle, reservation, usage["cost_usd"],
                                    lambda: hive.record_usage(agent, agent["model"], usage, resolved, payer), overrun_flag)
        except asyncio.CancelledError:
            hold_unknown(reservation)
            raise
        except Exception:
            hold_unknown(reservation)
        return response

    if settings.media_route:
        # P1 (hive/core/media.py): one metered image route on the chat route's payer, key, caps and Reservations. Absent
        # (404) unless the operator sets HIVE_MEDIA_ROUTE=on.
        from .media import MediaError, MediaRoute, BODY_LIMIT as MEDIA_BODY_LIMIT
        media_route = MediaRoute(hive, gateway, cost_reservations, host_budget_snapshot, hold_unknown, overrun_flag)
        app.state.media = media_route

        @app.post("/llm/v1/media")
        async def media(request: Request):
            agent = agent_from(request)
            fenced = hive.studio.gateway_fence(agent)   # J3 R4 (r1.4 G2): the same door as chat; None with Studio off
            if fenced is not None:
                raise fenced
            data = await bounded_body(request, MEDIA_BODY_LIMIT)
            try:
                return await media_route.handle(agent, data)
            except MediaError as exc:
                raise HiveError(exc.status, exc.code, exc.message, exc.details) from None
            except GatewayError as exc:
                raise HiveError(exc.status, exc.code, exc.message) from None

        # media r2: what admins see and do. Billed-but-refused results are listed plainly; a mind's breaker opens on
        # repeated refusals or an overrun and only an admin closes it, with a reason.
        @app.get("/api/media/results")
        async def media_results(request: Request):
            admin(request)
            billing = request.query_params.get("billing")
            rows = hive.db.all("SELECT * FROM media_results" + (" WHERE billing = ?" if billing else "") +
                               " ORDER BY created_at DESC LIMIT 200", (billing,) if billing else ())
            return [dict(r) for r in rows]

        @app.get("/api/media/breakers")
        async def media_breakers(request: Request):
            admin(request)
            return [dict(r) for r in hive.db.all("SELECT * FROM media_breakers ORDER BY agent_id")]

        @app.post("/api/media/breakers/{agent_id}/reset")
        async def media_breaker_reset(agent_id: str, request: Request):
            session = admin(request)
            data = await body(request)
            from .media import reset as media_reset
            try:
                row = media_reset(hive.db, agent_id, session.get("principal", "user:operator"), data.get("reason"))
            except ValueError as exc:
                raise HiveError(400, "bad_request", str(exc)) from None
            hive.events.publish("media.breaker_reset", agent=agent_id, agent_id=agent_id, by=row["reset_by"], reason=row["reset_reason"])
            return row

    @app.post("/llm/v1/embeddings")
    async def embeddings(request: Request):
        agent = agent_from(request)
        fenced = hive.studio.gateway_fence(agent)   # J3 R4 (r1.4 G2): the same door as chat; None with Studio off
        if fenced is not None:
            raise fenced
        data = await body(request)
        provider_name, model = split_model(settings.embedding_model)
        gateway.enforce_egress(agent, provider_name)
        provider = gateway.provider(provider_name)
        if provider.local or provider_name == "mock":
            return await gateway.embeddings(settings.embedding_model, data, agent=agent)
        # Embeddings are paid calls like any other (they used to bypass every budget). As chat (sol R2 P1): unpriced is
        # never admitted, whatever HIVE_ALLOW_UNPRICED says, and $0 needs this model's own entry.
        if not provider.priced(model):
            raise HiveError(402, "unpriced_model", f"no price is configured for {settings.embedding_model}, so its cost "
                                                   "can't be reserved; add one to the providers file")
        inputs = data.get("input", "")
        inputs = inputs if isinstance(inputs, list) else [inputs]
        if len(inputs) > MAX_EMBED_INPUTS:
            raise HiveError(400, "too_many_inputs", f"at most {MAX_EMBED_INPUTS} inputs per embeddings call")
        # Per-item floor, and bytes rather than characters, so many tiny or multi-byte inputs cannot under-reserve.
        tokens = sum(max(MIN_EMBED_TOKENS_PER_ITEM, (len(str(t).encode("utf-8")) + 2) // 3) for t in inputs)
        estimate = gateway.cost(provider, model, tokens, 0)
        # OI-13 r1.2: embeddings are paid by the provider default (gateway.embeddings sends provider.api_key), so that
        # resolved key and its owner are carried through payer, use and limit checks (a grant's own limit included),
        # the reservation and the recorded usage, exactly as the chat route carries its key
        defaults = (gateway.keyring.ring.get("defaults") or {}) if gateway.keyring else {}
        key_id = defaults.get(provider_name) or f"env:{provider_name}"
        # J3 R7.3 (stand-in R7.1 P1): a person's own Studio maker embeds (its runtime's recall, before any chat) on that
        # person's own key for the embedding provider, as its chat does; with none, on the hive's no-cost embedder
        # (mock/hash: local, unpaid, nothing reserved or billed), so recall never pays with the hive's key nor ends a step.
        # Every other mind keeps OI-13's provider-default rule exactly.
        makers = getattr(hive, "studio_makers", None)
        bound = makers.person_of(agent["id"]) if makers is not None else None
        locked_opts = gateway._options(agent)
        send_key = None
        if locked_opts.get("key_locked"):   # every key-locked mind, a bound Studio maker included
            # app platform P3a: only its assigned key pays (checked by paying_key: present, the owner's); a key for another
            # provider means the free embedder; a gone or foreign key stops the call (never another of the owner's keys)
            record = ((gateway.keyring.ring.get("keys") if gateway.keyring else None) or {}).get(locked_opts.get("key")) or {}
            if record and record.get("provider") != provider_name:
                return await gateway.embeddings("mock/hash", data, agent=agent)
            try:
                key_id, _secret = gateway.paying_key(agent, provider_name)
            except GatewayError as exc:
                raise HiveError(exc.status, exc.code, exc.message) from None
            send_key = key_id
        if bound is not None and not locked_opts.get("key_locked"):
            own = makers.own_key(bound, provider_name)
            if own is None:
                logging.getLogger("hive").info("studio maker %s: no own %s key; recall embeds on the no-cost embedder",
                                               agent["id"], provider_name)
                return await gateway.embeddings("mock/hash", data, agent=agent)
            key_id = send_key = own
        if estimate <= 0:
            try:
                estimate = gateway.free_reserve(provider, model, settings.embedding_model)
            except GatewayError as exc:
                raise HiveError(exc.status, exc.code, exc.message) from None
        key_owner = ((gateway.keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if gateway.keyring else None
        payer, own_key = hive.payer_for(agent, key_owner)
        studio_call = hive.studio.gateway_call(agent) if estimate > 0 else None   # J3 R4: None unless a live maker
        if bound is not None:
            # R7.3: a refusal here (its own key's limits) skips that recall; it never pauses the session (chat and media
            # keep studio_check's pause exactly as before)
            hive.check_budget(agent, True, estimate, key_id, payer, own_key)
        else:
            studio_check(studio_call, hive.check_budget, agent, True, estimate, key_id, payer, own_key)   # use_check too
        import uuid
        reservation = str(uuid.uuid4())
        if estimate > 0:
            def current_budgets():
                # as the chat route: a session or Ask turn that started or ended since admission refuses the call
                if hive.payer_for(hive.agent(agent["id"]), key_owner) != (payer, own_key):
                    raise ValueError("payer changed during admission")
                host_use_check(hive, agent["id"], key_id, payer)   # money port r1.2: access removed since admission
                return host_budget_snapshot(hive, agent["id"], key_id, payer, own_key)
            meta = {"agent": agent["id"], "model": settings.embedding_model, "payer": payer, "key": key_id, "kind": "embeddings"}
            payload = {"agent": agent["id"], "model": settings.embedding_model, "input": data.get("input"), "key": key_id}
            try:
                if studio_call is None:
                    cost_reservations.reserve(reservation, payload, estimate, current_budgets, metadata=meta,
                                              dispatched=True, subjects=host_subjects(hive, agent["id"], key_id, payer, own_key),
                                              paced=hive.present_for(agent) is None)   # as the chat route
                else:
                    studio_reserve(studio_call, reservation, payload, estimate, current_budgets, meta,
                                   host_subjects(hive, agent["id"], key_id, payer, own_key))
            except ValueError as exc:
                if "payer changed" in str(exc):
                    raise hive.error(409, "payer_changed", "who pays for this mind changed meanwhile; ask again") from None
                if isinstance(exc, SpendRateLimited):   # within its limits but faster than this month allows: nothing held
                    raise hive.spend_rate_refusal(agent, exc) from None
                if isinstance(exc, BudgetExhausted):
                    say = hive.note_refusal(agent, "reservation_refused", str(exc), exhausted_limit(exc))
                    raise HiveError(402, "reservation_refused", str(exc), {"say": say}) from None
                raise HiveError(402, "reservation_refused", str(exc)) from None
        hive.note_admitted(agent)   # both checks passed: a pause for spending, if there was one, is over
        # J3 R4.1: a maker's call passes the send gate at the transport's send-header boundary (as chat), never before
        gate_token = SEND_GATE.set(studio_call.gate) if studio_call is not None else None
        try:
            response = await gateway.embeddings(settings.embedding_model, data, agent=agent,
                                                **({"key_id": send_key} if send_key else {}))   # R7.3: personal makers only
        except StudioRefused as exc:
            raise exc.error from None       # refused at the send gate: released, nothing sent
        except BaseException as exc:
            if studio_call is not None and studio_call.unsent():
                raise                       # never reached the send boundary: released, not held unknown
            if estimate > 0:
                hold_unknown(reservation, exc)   # a refusal with a charge settles; one its provider documents as unbilled is released
            raise
        finally:
            if gate_token is not None:
                SEND_GATE.reset(gate_token)
        if studio_call is not None:
            studio_call.made()
        # The provider call succeeded: nothing below may raise to the caller.
        try:
            reported_usage = (response.get("usage") or {}) if isinstance(response, dict) else {}
            used = reported_usage.get("prompt_tokens") if isinstance(reported_usage, dict) else None
            charged = reported_cost(reported_usage)
            if (type(used) is not int or used < 0) and charged is None:
                if estimate > 0:
                    hold_unknown(reservation)
                return response
            used = used if type(used) is int and used >= 0 else 0
            # a charge the provider reports is never hidden behind the configured rate (sol R2 P1, as chat)
            usage = {"prompt_tokens": used, "completion_tokens": 0, "key_id": key_id,
                     "cost_usd": max(gateway.cost(provider, model, used, 0), charged or 0.0)}
            if estimate > 0:
                await run_in_threadpool(cost_reservations.settle, reservation, usage["cost_usd"],
                                        lambda: hive.record_usage(agent, settings.embedding_model, usage, None, payer), overrun_flag)
            else:
                await run_in_threadpool(hive.record_usage, agent, settings.embedding_model, usage, None, payer)
        except asyncio.CancelledError:
            if estimate > 0:
                hold_unknown(reservation)
            raise
        except Exception:
            if estimate > 0:
                hold_unknown(reservation)
        return response

    @app.get("/api/budgets/reservations")
    async def list_reservations(request: Request):
        admin(request)
        from .cost_reservations import outstanding
        return outstanding(cost_reservations)

    @app.get("/api/budgets/overruns")
    async def list_overruns(request: Request):
        admin(request)
        from .cost_reservations import overruns
        return overruns(cost_reservations)

    @app.get("/api/budgets/reservations/estimated")
    async def list_estimated(request: Request):
        """The calls the expiry settled at their worst case that a person may still correct, newest first
        (cost_reservations.estimated)."""
        admin(request)
        from .cost_reservations import estimated
        return await run_in_threadpool(estimated, cost_reservations)

    @app.post("/api/budgets/reservations/{reservation_id}/correct")
    async def correct_reservation(reservation_id: str, request: Request):
        """A person corrects an estimate with the cost the provider billed ({action: "settle", actual_usd, reason}) or
        with nothing billed ({action: "release", reason}), within 30 days of it; usage keeps the estimate and gets an
        adjusting row (cost_reservations.correct). 409 not_correctable when the call is no estimate that can be
        corrected now: never estimated, corrected already, or estimated more than 30 days ago."""
        session = admin(request)
        data = await body(request)
        from .cost_reservations import NotCorrectable, correct
        try:
            return await run_in_threadpool(correct, cost_reservations, reservation_id, data.get("action"), data.get("reason"),
                                           session.get("principal", "user:operator"), data.get("actual_usd"), held_usage,
                                           overrun_flag)
        except NotCorrectable as exc:
            raise HiveError(409, "not_correctable", str(exc)) from None
        except ValueError as exc:
            raise HiveError(400, "bad_request", str(exc)) from None

    @app.post("/api/budgets/reservations/correct")
    async def correct_reservations(request: Request):
        """Correct all: every estimate a person listed, kept as billed or corrected to nothing billed, as one decision with
        one reason (cost_reservations.correct_all). 409 not_correctable, with nothing changed, when one of them can no
        longer be corrected: the person reads the estimates again and confirms the new total. A held call is never in it:
        nobody settles a held call by hand (cost_reservations.outstanding says how each settles itself)."""
        session = admin(request)
        data = await body(request)
        from .cost_reservations import NotCorrectable, correct_all
        try:
            return await run_in_threadpool(correct_all, cost_reservations, data.get("ids"), data.get("action"), data.get("reason"),
                                           session.get("principal", "user:operator"), held_usage, overrun_flag)
        except NotCorrectable as exc:
            raise HiveError(409, "not_correctable", str(exc)) from None
        except ValueError as exc:
            raise HiveError(400, "bad_request", str(exc)) from None

    @app.post("/api/agent/publish")
    async def agent_publish(request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await run_in_threadpool(hive.publish, agent["id"], data.get("statement", ""),
                                       data.get("f", 1.0), data.get("c", 0.9), data.get("evidence"),
                                       bool(data.get("new_evidence")))

    @app.post("/api/agent/query")
    async def agent_query(request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await run_in_threadpool(hive.query, agent["id"], data.get("pattern", ""))

    @app.get("/api/agent/belief")
    async def agent_belief(statement: str, request: Request):
        agent = agent_from(request)
        return await run_in_threadpool(hive.agent_belief, agent["id"], statement)

    # ---- phase 2: policy and approvals ----------------------------------------------------------

    @app.get("/api/policy")
    async def policy_rules(request: Request, view: str = "ordinary"):
        operator(request)
        if view == "ordinary":
            return hive.policy.rules()
        if view == "infrastructure":
            return hive.policy.infrastructure_rules()
        if view == "all":
            return hive.policy.rule_views()
        raise HiveError(400, "bad_request", "policy view is ordinary, infrastructure or all")

    def policy_admin(request: Request):
        """host-identity r1: hive policy rules are written by a hive admin or the hive's owner (ownhive.py), nobody else."""
        session = operator(request)
        if not policy_writer(session):
            raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can change policy rules")
        return session

    def policy_rule_session(request: Request, expected=None):
        try:
            session = operator(request)  # fresh token row, expiry/revocation/public-route checks
        except (TypeError, ValueError, AttributeError):  # malformed stored authority must not reach a mutation
            raise HiveError(401, "unauthorized", "a current signed-in person is required") from None
        principal = session.get("principal") or "user:operator"
        identity = (principal, session.get("kind"), session.get("token_hash"))
        if expected is not None and identity != expected:
            raise HiveError(401, "unauthorized", "the signed-in session changed; reload and try again")
        current_host_role = role_of(session)
        if current_host_role not in ("admin", "member"):
            raise HiveError(401, "unauthorized", "a current signed-in person is required")
        person = None
        if isinstance(principal, str) and principal.startswith("user:"):
            person = hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
            if person is not None and person.get("disabled"):
                raise HiveError(401, "unauthorized", "a current signed-in person is required")
        from .me_decisions import human_session
        current_role = current_host_role if session.get("kind") == "member_password" else person["role"] if person is not None else current_host_role
        human_session(hive, session, current_role)
        return session, identity

    def policy_member_principal(request: Request, expected):
        from .me_decisions import human_session
        session, _ = policy_rule_session(request, expected)
        principal = session.get("principal")
        if not isinstance(principal, str) or not principal.startswith("user:") or not principal[5:]:
            raise HiveError(403, "member_only", "a current member session is required")
        person = hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
        if person is None or person.get("disabled") or person.get("role") != "member":
            raise HiveError(403, "member_only", "a current member session is required")
        # The actual people row supplies the member role, including suffixes without u_.
        # Positive personhood rejects password/service/bootstrap/unknown/expired or malformed SSO sessions.
        human_session(hive, session, "member")
        return principal

    @app.post("/api/policy")
    async def add_policy_rule(request: Request):
        session, identity = policy_rule_session(request)
        privileged = policy_writer(session)
        if not privileged:
            policy_member_principal(request, identity)  # authorize before reading client input
        data = await body(request) if privileged else await bounded_body(request, 64 * 1024)
        if privileged:
            session, _ = policy_rule_session(request, identity)  # re-read after the body await
            if not policy_writer(session):
                raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can change policy rules")
            return hive.policy.add_rule(data.get("scope", ""), data.get("skill", ""), data.get("mode", ""), data.get("note", ""),
                                        granted_by=session.get("principal") or "user:operator")
        if set(data) - {"scope", "skill", "mode", "note"}:
            raise HiveError(400, "bad_request", "member rules accept only scope, skill, mode and note")
        return hive.policy.member_add_rule(data.get("scope", ""), data.get("skill", ""), data.get("mode", ""), data.get("note", ""),
                                           authenticate=lambda: policy_member_principal(request, identity))

    @app.delete("/api/policy/{rule_id}")
    async def delete_policy_rule(rule_id: str, request: Request):
        session, identity = policy_rule_session(request)
        if policy_writer(session):
            session, _ = policy_rule_session(request, identity)
            if not policy_writer(session):
                raise HiveError(403, "admin_only", "only a hive admin or the hive's owner can change policy rules")
            return hive.policy.delete_rule(rule_id)
        return hive.policy.member_delete_rule(rule_id, authenticate=lambda: policy_member_principal(request, identity))

    @app.get("/api/approvals")
    async def approvals(request: Request, status: str | None = None):
        session = operator(request)
        items = hive.visibility.filter_items(viewer(session), hive.policy.approvals(status))
        # a hint for the page; the answer routes still decide through answer_refusal. The answer depends on the mind,
        # this person and whether the approval is a permission request (kind grant: admins only), so each pair is judged
        # once. Time: 2 keyed reads per distinct mind and kind listed (<= 500 rows).
        answers = {}
        for item in items:
            key = (item["agent_id"], item.get("kind") == "grant")
            if key not in answers:
                answers[key] = answer_refusal(session, item) is None
            item["may_answer"] = answers[key]
        return items

    def seen_approval(session, approval_id):
        """The approval, if this person sees its mind (the GET list's own filter, with admin audit as on any by-id
        route); one they cannot see is not found."""
        row = hive.policy.approval(approval_id)
        if not hive.visibility.filter_items(audit_viewer(session), [row]):
            raise HiveError(404, "not_found", f"no approval {approval_id}")
        return row

    def answer_refusal(session, row):
        """Why this person may not answer this approval (of a mind they see), as (status, code, message), or None; the
        list's may_answer is exactly "this is None". Answering is acting on the mind, once or for good, yes or no, so it
        is control_refusal's rule (Viewer.controls: its owner or a hive admin); a mind set to owner_only approvals is
        answered by its owner alone (Policy.require_approval_owner, checked again under the mind's lock)."""
        mind = hive.db.one("SELECT * FROM agents WHERE id = ?", (row["agent_id"],))
        if not viewer(session).controls(mind):
            return 403, "owner_only", "only this mind's owner or a hive admin answers its approvals"
        if row.get("kind") == "grant" and role_of(session) != "admin":
            # a mind's request for a skill its rules refuse (policy.grantable): yes writes an allow rule, an admin's call
            return 403, "admin_only", "only a hive admin answers a mind's request for a permission"
        try:
            hive.policy.require_approval_owner(row, session.get("principal") or "user:operator")
        except HiveError as exc:
            return exc.status, exc.code, exc.message
        return None

    def answerable(session, approval_id):
        """host-identity r1 and flagship #111: the approval this person may answer, else not found (they do not see
        its mind) or answer_refusal's refusal."""
        row = seen_approval(session, approval_id)
        refused = answer_refusal(session, row)
        if refused:
            raise HiveError(*refused)
        return row

    def fresh_approval_actor(request, expected, approval_id=None, *, setting=False):
        """P3b current host authority, re-used at the synchronous write boundary; never client identity."""
        current = operator(request)
        identity = lambda row: (row.get("principal") or "user:operator", row.get("kind"), row.get("token_hash"))
        if identity(current) != identity(expected):
            raise HiveError(401, "unauthorized", "the signed-in authority changed")
        principal = current.get("principal") or "user:operator"
        owner_only = False
        if approval_id is not None:
            row = answerable(current, approval_id)
            owner_only = hive.policy.require_approval_owner(row, principal)
        if setting or owner_only:
            current_role = role_of(current)
            if current_role not in ("admin", "member"):
                raise HiveError(401, "unauthorized", "a current signed-in person is required")
            person = None
            if current.get("kind") in ("sso", "member_password"):
                # Every matching people namespace, not only generated u_ IDs, has an enabled-person guard.
                person = hive.db.one("SELECT role, disabled FROM people WHERE id = ?", (principal[5:],))
                if person and (person["disabled"] or person["role"] not in ("admin", "member")):
                    raise HiveError(401, "unauthorized", "a current signed-in person is required")
            human_session(hive, current, current_role if current.get("kind") == "member_password" else person["role"] if person else current_role)
        return principal

    @app.post("/api/approvals/{approval_id}/approve")
    async def approve(approval_id: str, request: Request):
        session = operator(request)
        answerable(session, approval_id)   # before the body is read
        try:
            data = await request.json()
        except Exception:
            data = {}
        remember = bool((data or {}).get("remember"))
        guard = lambda: fresh_approval_actor(request, session, approval_id)
        actor = guard()   # after the request-body await, before any decision effects
        return await hive.policy.decide_approval(approval_id, True, operator=actor, remember=remember, guard=guard)

    @app.get("/api/approvals/{approval_id}/track-record")
    async def approval_track_record(approval_id: str, request: Request):
        """How people have answered this mind and skill before: the count and the NAL-revised belief. A read, for
        anyone who sees the approval's mind (else 404), whether or not they may answer it."""
        session = operator(request)
        from .governance_evidence import approval_statement
        row = seen_approval(session, approval_id)
        return hive.governance.track_record(approval_statement(row["agent_id"], row["skill"]))

    @app.post("/api/approvals/{approval_id}/decide")
    async def decide_approval(approval_id: str, request: Request):
        """Once, For a time (minutes), Always, No or Never."""
        session = operator(request)
        answerable(session, approval_id)   # before the body is read
        data = await body(request)
        guard = lambda: fresh_approval_actor(request, session, approval_id)
        actor = guard()
        return await hive.policy.answer(approval_id, str(data.get("decision", "")), operator=actor,
                                        minutes=data.get("minutes"), guard=guard)

    @app.post("/api/approvals/{approval_id}/deny")
    async def deny(approval_id: str, request: Request):
        session = operator(request)
        guard = lambda: fresh_approval_actor(request, session, approval_id)
        actor = guard()
        return await hive.policy.decide_approval(approval_id, False, operator=actor, guard=guard)

    @app.post("/api/hive/stop-all")
    async def stop_all(request: Request):
        # it acts on every mind, so it needs what acting on each needs from everyone at once: an admin, as power off does
        session = admin(request)
        return await run_in_threadpool(hive.stop_all, _who(session))

    @app.get("/api/hive/power")
    async def power_state(request: Request):
        return hive.power.view(role_of(operator(request)) == "admin")

    @app.post("/api/hive/power")
    async def power_set(request: Request):
        """Off (snapshot the awake minds, then Stop all) or On (wake that snapshot); idempotent on operation_id."""
        session = admin(request)
        data = await body(request)
        return await run_in_threadpool(hive.power.set, data.get("state"), data.get("operation_id"), _who(session))

    # ---- the Lab: tests and benchmarks --------------------------------------------------------------

    @app.get("/api/lab/suites")
    async def lab_suites(request: Request):
        session = operator(request)
        may_run = role_of(session) == "admin"   # admin()'s own test: start and cancel refuse anyone else
        return [dict(s, may_run=may_run) for s in await run_in_threadpool(hive.lab.suites)]

    @app.get("/api/lab/runs")
    async def lab_runs(request: Request, suite: str = "", limit: int = 50):
        operator(request)
        return hive.lab.runs(suite or None, min(200, max(1, limit)))

    @app.post("/api/lab/runs")
    async def lab_start(request: Request):
        admin(request)   # a run uses the hive's machine and its whole environment, keys included (lab.py _env)
        data = await body(request)
        return await run_in_threadpool(hive.lab.start, str(data.get("suite", "")))

    @app.get("/api/lab/runs/{run_id}")
    async def lab_run(run_id: str, request: Request):
        operator(request)
        return hive.lab.run(run_id)

    @app.post("/api/lab/runs/{run_id}/cancel")
    async def lab_cancel(run_id: str, request: Request):
        admin(request)
        return hive.lab.cancel(run_id)

    @app.get("/api/lab/scorecard")
    async def lab_scorecard(request: Request):
        operator(request)
        return await run_in_threadpool(hive.lab.scorecard)

    @app.get("/api/lab/history/{suite}")
    async def lab_history(suite: str, request: Request, limit: int = 30):
        operator(request)
        return hive.lab.history(suite, min(100, max(1, limit)))

    @app.get("/flow-studio/")
    @app.get("/flow-studio/{asset}")
    async def flow_studio(request: Request, asset: str = "index.html"):
        if asset not in {"index.html","app.js","style.css"}:
            raise HiveError(404,"not_found","no such flow studio asset")
        return FileResponse(pathlib.Path(__file__).resolve().parents[1]/"flow_studio"/asset,
            headers={"Content-Security-Policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'","X-Content-Type-Options":"nosniff"})

    @app.get("/api/agent/flows")
    async def agent_flows(request: Request):
        return hive.flows.agent_skills(agent_from(request))

    @app.get("/api/agent/flows/drafts")
    async def agent_flow_drafts(request: Request):
        return hive.flows.agent_drafts(agent_from(request))

    @app.post("/api/agent/flows/skills")
    async def agent_flow_publish(request: Request):
        return hive.flows.register_skill(agent_from(request), await body(request))

    @app.post("/api/agent/flows/skills/{name}/retire")
    async def agent_flow_retire(name: str, request: Request):
        data=await body(request)
        if data!={}:raise HiveError(400,'invalid_params','retirement requires empty body')
        return await hive.flows.retire_skill(agent_from(request), name)

    @app.post("/api/agent/flows/skills/{name}/runs")
    async def agent_flow_run(name: str, request: Request):
        return hive.flows.agent_start(agent_from(request), name, await body(request))

    @app.get("/api/agent/flow-runs/{rid}")
    async def agent_flow_run_get(rid: str, request: Request):
        return hive.flows.agent_run_get(agent_from(request), rid)

    @app.post("/api/agent/flow-runs/{rid}/cancel")
    async def agent_flow_run_cancel(rid: str, request: Request):
        data=await body(request)
        if data!={}:raise HiveError(400,'invalid_params','cancellation requires empty body')
        return await hive.flows.agent_cancel(agent_from(request), rid)

    @app.post("/api/agent/flows")
    async def agent_flow_draft(request: Request):
        return hive.flows.agent_draft(agent_from(request), await body(request))

    @app.post("/api/agent/flows/{artifact_id}/revisions")
    async def agent_flow_revise(artifact_id: str, request: Request):
        return hive.flows.agent_draft(agent_from(request), await body(request), artifact_id)

    @app.get("/api/agent/flows/{artifact_id}/revisions/{n}")
    async def agent_flow_read(artifact_id: str, n: int, request: Request):
        return hive.flows.agent_read(agent_from(request), artifact_id, n)

    @app.get("/api/flows/example")
    async def flow_example(request: Request):
        operator(request)
        from ..flow_ir.examples.garden import garden
        return {"body":garden(),"layout":{}}

    @app.get("/api/flows/templates")
    async def flow_templates(request: Request):
        operator(request)
        from ..flow_ir.examples.templates import catalogue
        return {"templates": catalogue()}

    @app.post("/api/flows/validate")
    async def flow_validate(request: Request):
        operator(request)
        from ..flow_ir import revision,check_structure,project
        from ..flow_ir.admission import prepare
        value=await body(request)
        try:r=revision(value["body"],value.get("layout",{}))
        except (ValueError,TypeError,KeyError,RecursionError) as exc:
            raise HiveError(400,"invalid_flow",str(exc)) from None
        preflight=prepare(r["body"])
        for element in r["body"]["elements"]:
            if element["kind"]=="transition" and element["action"]["kind"]!="goal":
                preflight["findings"].append({"code":"unsupported-host-action","element":element["id"]})
        preflight["structurally_eligible"]=not preflight["findings"]
        preflight["host_supported_actions"]=["goal"]
        return {"revision":r,"check":check_structure(r["body"]),"atoms":project(r["body"]),"preflight":preflight}

    @app.get("/api/swarms/{swarm_id}/flows")
    async def flow_list(swarm_id: str,request: Request):
        return hive.flows.list(operator(request),swarm_id)

    # ---- OmegaFlow candidate: named-person authoring and bounded goal runs ----

    @app.post("/api/swarms/{swarm_id}/flows")
    async def flow_publish(swarm_id: str, request: Request):
        return hive.flows.publish(operator(request), swarm_id, await body(request))

    @app.get("/api/flows/{artifact_id}/revisions/{n}")
    async def flow_read(artifact_id: str, n: int, request: Request):
        return hive.flows.read(operator(request), artifact_id, n)

    @app.put("/api/flows/{artifact_id}/revisions/{n}/layout")
    async def flow_layout(artifact_id: str, n: int, request: Request):
        return hive.flows.layout(operator(request), artifact_id, n, await body(request))

    @app.post("/api/flows/{artifact_id}/revisions/{n}/adopt")
    async def flow_adopt(artifact_id: str, n: int, request: Request):
        return hive.flows.adopt(operator(request), artifact_id, n, await body(request))

    @app.delete("/api/flows/{artifact_id}/revisions/{n}/adoption")
    async def flow_revoke(artifact_id: str, n: int, request: Request):
        session=operator(request)
        out=hive.flows.revoke(session, artifact_id, n)
        await hive.flows.reconcile()
        return out

    @app.post("/api/flows/{artifact_id}/revisions/{n}/runs")
    async def flow_start(artifact_id: str, n: int, request: Request):
        session=operator(request)
        out=hive.flows.start(session, artifact_id, n, await body(request))
        await hive.flows.reconcile()
        return hive.flows.get(session,out["id"])

    @app.get("/api/flow-runs/{run_id}")
    async def flow_run(run_id: str, request: Request):
        return hive.flows.get(operator(request), run_id)

    @app.post("/api/flow-runs/{run_id}/cancel")
    async def flow_cancel(run_id: str, request: Request):
        return await hive.flows.cancel(operator(request), run_id)

    # ---- phase 2: goals ----------------------------------------------------------------------------

    @app.get("/api/swarms/{swarm_id}/goals")
    async def goals(swarm_id: str, request: Request):
        session = operator(request)
        hive.swarm(swarm_id)
        # the Research swarm: an admin's default list hides tasks asked from another person's personal mind
        return hive.research.hide_personal_tasks(viewer(session), swarm_id, hive.goals.list(swarm_id))

    @app.post("/api/swarms/{swarm_id}/goals")
    async def create_goal(swarm_id: str, request: Request):
        session = operator(request)
        data = await body(request)
        return await hive.goals.create(swarm_id, data.get("title", ""), data.get("detail", ""),
                                       data.get("priority", 0.5), data.get("parent_id"),
                                       assignee=data.get("assignee"), binding=data.get("binding"),
                                       deadline_minutes=data.get("deadline_minutes"),
                                       created_by=session.get("principal") or "user:operator")

    @app.get("/api/goals/{goal_id}")
    async def get_goal(goal_id: str, request: Request):
        operator(request)
        return hive.goals.view_full(hive.goals.get(goal_id))

    @app.post("/api/goals/{goal_id}/review")
    async def review_goal(goal_id: str, request: Request):
        """R17: a named person accepts a submitted result (done) or returns it with notes."""
        session = operator(request)
        data = await body(request)
        if session.get("kind") not in ("sso", "member_password") or (session.get("principal") or "user:operator") == "user:operator":
            raise HiveError(403, "person_required", "a named signed-in person reviews work; the hive password cannot")
        reviewer = {"kind": "person", "principal": session["principal"], "admin": role_of(session) == "admin"}
        return await hive.goals.review(goal_id, reviewer, data.get("decision"), data.get("notes", ""))

    @app.post("/api/agent/goals/{goal_id}/review")
    async def agent_review_goal(goal_id: str, request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await hive.goals.review(goal_id, {"kind": "agent", "agent": agent}, data.get("decision"), data.get("notes", ""))

    @app.get("/api/goals/{goal_id}/reviews")
    async def goal_reviews(goal_id: str, request: Request):
        operator(request)
        return hive.goals.reviews(goal_id)

    @app.get("/api/goals/{goal_id}/attempts")
    async def goal_attempts(goal_id: str, request: Request):
        """Every done-result attempt on a goal with a result schema, verbatim, valid or not."""
        operator(request)
        return hive.goals.attempts(goal_id)

    @app.patch("/api/goals/{goal_id}")
    async def update_goal(goal_id: str, request: Request):
        operator(request)
        goal = hive.goals.update(goal_id, await body(request))
        if goal["status"] == "cancelled":
            await hive.goals.notify_cancelled(goal_id)
        return goal

    # ---- phase 2: traces, wakeups, memory ------------------------------------------------------

    @app.get("/api/agents/{agent_id}/traces")
    async def traces(agent_id: str, request: Request, limit: int = 100):
        hidden_researcher(operator(request), agent_id)
        return hive.traces(agent_id, limit)

    @app.get("/api/agents/{agent_id}/traces/archive")
    async def trace_archive(agent_id: str, request: Request):
        hidden_researcher(operator(request), agent_id)
        hive._agent_row(agent_id)
        return {"days": hive.archive.trace_days(agent_id), "logs": hive.archive.logs(agent_id)}

    @app.get("/api/agents/{agent_id}/traces/archive/{day}")
    async def trace_archive_day(agent_id: str, day: str, request: Request, limit: int = 500, offset: int = 0):
        hidden_researcher(operator(request), agent_id)
        hive._agent_row(agent_id)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            raise hive.error(400, "bad_request", "day is YYYY-MM-DD")
        return hive.archive.read_day(agent_id, day, min(max(int(limit), 1), 2000), max(int(offset), 0))

    @app.get("/api/agents/{agent_id}/wakeups")
    async def wakeups(agent_id: str, request: Request):
        session = operator(request, check_path=False)
        privileged = wakeup_access(session, agent_id=agent_id)
        rows = hive.scheduler.list(agent_id)
        return rows if privileged else [dict(row, text="text hidden") for row in rows]

    @app.post("/api/agents/{agent_id}/wakeups")
    async def create_wakeup(agent_id: str, request: Request):
        session = operator(request, check_path=False)
        wakeup_access(session, agent_id=agent_id, write=True)
        data = await body(request)
        session = operator(request, check_path=False)
        reads_text = wakeup_access(session, agent_id=agent_id, write=True)
        row = hive.scheduler.create(agent_id, data.get("cron"), data.get("at"), data.get("tz") or "UTC", data.get("text", ""))
        return row if reads_text else dict(row, text="text hidden")

    @app.patch("/api/wakeups/{wakeup_id}")
    async def update_wakeup(wakeup_id: str, request: Request):
        session = operator(request, check_path=False)
        wakeup_access(session, wakeup_id=wakeup_id, write=True)
        data = await body(request)
        session = operator(request, check_path=False)
        reads_text = wakeup_access(session, wakeup_id=wakeup_id, write=True)
        row = hive.scheduler.update(wakeup_id, data)
        return row if reads_text else dict(row, text="text hidden")

    @app.delete("/api/wakeups/{wakeup_id}")
    async def delete_wakeup(wakeup_id: str, request: Request):
        session = operator(request, check_path=False)
        wakeup_access(session, wakeup_id=wakeup_id, write=True)
        return hive.scheduler.delete(wakeup_id)

    @app.get("/api/agents/{agent_id}/belief-link")
    async def belief_link(agent_id: str, request: Request):
        """Which of the mind's beliefs its swarm sees: domains null for its default, "all", a list for those about each,
        [] for none (Jon on #334: a mind's beliefs are seen through permissions, not passed around). Who may read and
        change it is Hive.LINK_RIGHTS, the one table every link route and view consults (Jon on #354)."""
        session = operator(request)
        return await run_in_threadpool(hive.belief_link, agent_id, viewer(session))

    @app.put("/api/agents/{agent_id}/belief-link")
    async def set_belief_link(agent_id: str, request: Request):
        session = operator(request)
        data = await body(request)
        return await run_in_threadpool(hive.set_belief_link, agent_id, data, viewer(session))

    @app.get("/api/agents/{agent_id}/memory")
    async def memory(agent_id: str, request: Request):
        hidden_researcher(operator(request), agent_id)
        return await run_in_threadpool(hive.memory_spaces, agent_id)

    @app.get("/api/agents/{agent_id}/memory/{space}")
    async def memory_atoms(agent_id: str, space: str, request: Request, q: str | None = None, limit: int = 200):
        hidden_researcher(operator(request), agent_id)
        return await run_in_threadpool(hive.memory_atoms, agent_id, space, q, limit)

    @app.post("/api/agents/{agent_id}/memory/{space}/retire")
    async def retire(agent_id: str, space: str, request: Request):
        require_control(operator(request), agent_id)
        data = await body(request)
        return await run_in_threadpool(hive.retire_atom, agent_id, space, data.get("atom", ""))

    @app.post("/api/agents/{agent_id}/memory/reset")
    async def reset_memory(agent_id: str, request: Request):
        require_control(operator(request), agent_id)
        return hive.queue_control(agent_id, {"op": "reset"})

    # ---- phase 2: agent-facing -----------------------------------------------------------------

    @app.get("/api/health")
    async def health_overview(request: Request, swarm_id: str | None = None):
        session = operator(request)
        out = await run_in_threadpool(hive.health.overview, swarm_id)
        out["minds"] = hive.visibility.filter_items(viewer(session), out["minds"])
        return out

    @app.get("/api/health/mind")
    async def health_mind(request: Request):
        operator(request)
        return {"agent_id": hive.health.mind_id()}

    @app.put("/api/health/mind")
    async def set_health_mind(request: Request):
        session = admin(request)
        return hive.health.set_mind((await body(request)).get("agent_id"), session.get("principal") or "user:operator")

    @app.get("/api/agent/health")
    async def agent_health_overview(request: Request):
        """Only the hive's health mind reads the health overview."""
        agent = agent_from(request)
        if agent["id"] != hive.health.mind_id():
            raise HiveError(403, "not_the_health_mind", "only the hive's health mind reads health across minds")
        return await run_in_threadpool(hive.health.overview, None)

    @app.get("/api/agents/{agent_id}/health")
    async def agent_health(agent_id: str, request: Request):
        operator(request)
        return await run_in_threadpool(lambda: hive.health.mind(hive.agent(agent_id)))

    @app.get("/api/agents/{agent_id}/limits")
    async def agent_limits(agent_id: str, request: Request):
        """Every limit the mind's next paid call is admitted against, least room first (Budgets.call_limits): the first
        is what stops the mind next, with the spend and the held worst cases counted against it. A row about something
        this viewer may not see (another person's allowance or key spending: limits_view.scope_visible) keeps its place
        with no numbers and nothing about whose it is (unseen_limit), so a page can say a limit it can't change stops it."""
        from .limits_view import scope_visible, unseen_limit
        session = operator(request)
        row = hive._agent_row(agent_id)
        out = await run_in_threadpool(hive.budgets.call_limits, row)
        who = viewer(session)
        out["limits"] = [limit if scope_visible(hive, who, limit["scope"]) else unseen_limit(limit) for limit in out["limits"]]
        return out

    # ---- idle minds (Health noticing; shapes in PLATFORM_IDLE_MINDS_R1_SHAPES.md) ----------
    # Read by an admin or the mind's owner (its creator). A personal mind's idle record is its person's alone (its Health
    # question and the mind's answer sit in its person's own conversation: idle-minds r2), whatever its visibility: making
    # it public or sharing it never grants another admin, the loopback operator or a member its record (stand-in r2.2
    # P1). An admin reads it only by explicit audit (?include=all or ?include=personal), read-only: a Remind on a
    # personal mind is its person's alone.

    def explicit_audit(request, session):
        """An admin's explicit ?include=all or ?include=personal; anyone else asking for it is refused."""
        if request.query_params.get("include") not in ("all", "personal"):
            return False
        if role_of(session) != "admin":
            raise HiveError(403, "admin_only", "only a hive admin can do that")
        return True

    def idle_reader(session, row, audit=False):
        principal = session.get("principal") or "user:operator"
        if row.get("personal_of"):
            return principal == row["personal_of"] or (audit and role_of(session) == "admin")
        return viewer(session).controls(row)

    def idle_row(session, agent_id, audit=False):
        row = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        if row is None or not idle_reader(session, row, audit):
            raise HiveError(404, "not_found", "no such mind")   # not 'forbidden': existence is not revealed
        return row

    # ---- per-viewer hints for the UI (idle-minds r2.4): is_mine, may_remind, may_sleep, may_control ---------------
    # ONE source: the Remind route refuses through remind_refusal, and Sleep with every other route that acts on a mind
    # through control_refusal; the flags are exactly "that refusal is None", so a flag and its route cannot drift apart.
    # may_sleep is the Sleep route's answer, so it equals may_control. The flags are hints; the routes still enforce.

    def remind_refusal(session, row, audit=False):
        """Why POST /api/agents/{id}/health/remind refuses this caller, as (status, code, message), or None. An explicit
        audit changes only which refusal a personal mind's Remind gets (403 instead of 404), never whether it refuses."""
        principal = session.get("principal") or "user:operator"
        if row is None or not idle_reader(session, row, audit):
            return 404, "not_found", "no such mind"   # not 'forbidden': existence is not revealed
        if row.get("personal_of") and principal != row["personal_of"]:
            return 403, "personal_mind", "only its person asks their personal mind; audit is read-only"
        if row["status"] != "awake":   # Health never wakes a mind: an asleep one is not spending
            return 409, "not_awake", f"{row['name']} is {row['status']}; Health asks only awake minds"
        return None

    def mind_flags(session, row):
        principal = session.get("principal") or "user:operator"
        may_control = control_refusal(session, row) is None   # no status rule: sleeping a mind not awake is accepted
        return {"is_mine": bool(row.get("personal_of")) and row["personal_of"] == principal,
                "may_remind": remind_refusal(session, row) is None,
                "may_sleep": may_control, "may_control": may_control}

    def with_flags(session, items, rows=None):
        """Add the viewer's flags to agent-shaped dicts (id); rows: agents rows by id, read here when not given."""
        if rows is None:
            rows = {r["id"]: r for r in hive.db.all("SELECT * FROM agents WHERE deleted = 0")}
        for item in items:
            if isinstance(item, dict) and item.get("id") in rows:
                item.update(mind_flags(session, rows[item["id"]]))
        return items

    @app.get("/api/health/idle")
    async def health_idle_overview(request: Request):
        session = operator(request)
        audit = explicit_audit(request, session)
        minds = await run_in_threadpool(hive.health.idle.overview)
        if role_of(session) == "admin":
            minds = hive.visibility.agents(audit_viewer(session) if audit else viewer(session), minds)
        rows = {r["id"]: r for r in hive.db.all("SELECT * FROM agents WHERE deleted = 0")}
        minds = with_flags(session, [m for m in minds if m["id"] in rows and idle_reader(session, rows[m["id"]], audit)], rows)
        w = hive.health.idle
        return {"minds": minds, "generated_at": now(),
                "window": {"notice_after_s": w.NOTICE_S, "ask_quiet_s": w.ASK_QUIET_S, "counts_over_s": w.DAY_S}}

    @app.get("/api/agents/{agent_id}/health/idle")
    async def agent_health_idle(agent_id: str, request: Request):
        session = operator(request)
        row = idle_row(session, agent_id, audit=explicit_audit(request, session))
        view = await run_in_threadpool(lambda: hive.health.idle.view(row, history=True))
        return {**view, **mind_flags(session, row)}

    @app.post("/api/agents/{agent_id}/health/remind")
    async def agent_health_remind(agent_id: str, request: Request):
        """Send the mind its Health question now (an admin or its owner). The mind decides; nothing is enforced."""
        session = operator(request)
        audit = explicit_audit(request, session)
        row = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (agent_id,))
        refused = remind_refusal(session, row, audit)
        if refused:
            raise HiveError(*refused)
        await hive.health.idle.remind(agent_id, session.get("principal") or "user:operator")
        row = hive._agent_row(agent_id)
        view = await run_in_threadpool(lambda: hive.health.idle.view(row, history=True))
        return {**view, **mind_flags(session, row)}

    # ---- S4: per-mind tool inventory (boot receipt in, owner/admin view out) ----------------------

    @app.post("/api/agent/inventory")
    async def agent_inventory_receipt(request: Request):
        agent = agent_from(request)
        return await run_in_threadpool(hive.inventory.record, agent, await body(request))

    @app.get("/api/agent/inventory/nonce")
    async def agent_inventory_nonce(request: Request):
        """The nonce of this mind's current hub connection; its boot receipt must echo it (OmegaReview 2026-10-04)."""
        agent = agent_from(request)
        nonce = hive.boot_nonce.get(agent["id"])
        if not nonce:
            raise HiveError(409, "not_connected", "connect to the hub first; the nonce belongs to a live connection")
        return {"boot_nonce": nonce}

    @app.get("/api/agent/inventory")
    async def agent_inventory_self(request: Request):
        agent = agent_from(request)
        return await run_in_threadpool(hive.inventory.view, agent["id"])

    def owner_or_admin(request: Request, agent_id: str):
        session = operator(request)   # a mind the person may not see is "not found"
        if not viewer(session).controls(hive._agent_row(agent_id)):   # whoever acts on the mind reads what it can do
            raise HiveError(403, "owner_or_admin", "only this mind's owner or a hive admin can read its inventory")

    @app.get("/api/agents/{agent_id}/inventory")
    async def agent_inventory(agent_id: str, request: Request):
        owner_or_admin(request, agent_id)
        return await run_in_threadpool(hive.inventory.view, agent_id)

    @app.get("/api/agents/{agent_id}/inventory/activity")
    async def agent_reasoning_activity(agent_id: str, request: Request, cycles: int = 30):
        owner_or_admin(request, agent_id)
        return await run_in_threadpool(hive.inventory.activity, agent_id, cycles)

    @app.post("/api/agent/authorize")
    async def authorize(request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await run_in_threadpool(hive.policy.authorize, agent, data.get("command", ""))

    @app.post("/api/agent/replies/rest")
    async def agent_reply_rest(request: Request):
        """A mind stopped calling its model (turns spent or a wait chosen) while it may owe a person an answer: the hive
        reminds it once, then tells the person (replies.py). in_flight: conversations its answers are still queued for."""
        agent = agent_from(request)
        data = await body(request)
        queued = data.get("in_flight")
        queued = [c for c in queued if isinstance(c, str)] if isinstance(queued, list) else []
        return await hive.replies.rest(agent, queued)

    @app.get("/api/agent/replies/owed")
    async def agent_replies_owed(request: Request):
        """The people's messages this mind has not answered, newest first (replies.py), for hive-goals."""
        agent = agent_from(request)
        return {"owed": await run_in_threadpool(hive.replies.owed, agent["id"])}

    @app.post("/api/agent/skills/decisions")
    async def skill_decisions(request: Request):
        """Read-only: how the gate would decide each named skill for this mind (its prompt lists only usable skills)."""
        agent = agent_from(request)
        data = await body(request)
        return await run_in_threadpool(hive.policy.decisions, agent, data.get("skills"))

    @app.post("/api/agent/trace")
    async def agent_trace(request: Request):
        agent = agent_from(request)
        entry = hive.ask.trace_entry(agent["id"])   # the sending execution, pinned before any await or thread hop
        try:
            return await run_in_threadpool(hive.record_trace, agent, await body(request))
        finally:
            TRACE_ENTRY.reset(entry)                 # always, the body read or the record raising included

    @app.get("/api/agent/control")
    async def agent_control(request: Request):
        agent = agent_from(request)
        return hive.take_control(agent["id"])

    @app.get("/api/agent/studio-sessions/{session_id}/context")
    async def agent_studio_context(session_id: str, request: Request, execution_id: str = "", after_dir: int = 0):
        """J3 R3: the bound maker's context (the epoch captured by agent_from on arrival is what counts)."""
        return hive.studio.context(agent_from(request), session_id, execution_id or None, after_dir)

    @app.post("/api/agent/studio-sessions/{session_id}/steps/{n}/done")
    async def agent_studio_done(session_id: str, n: str, request: Request):
        agent = agent_from(request)
        return await hive.studio.done(agent, session_id, n, await body(request))

    @app.get("/api/agent/inbox")
    async def agent_inbox(request: Request, after: int = 0):
        agent = agent_from(request)
        return hive.inbox(agent["id"], after)

    @app.post("/api/agent/messages")
    async def agent_message(request: Request):
        agent = agent_from(request)
        data = await body(request)
        return hive.record_agent_message(agent["id"], data)

    @app.get("/api/agent/goals")
    async def agent_goals(request: Request, status: str | None = "open"):
        agent = agent_from(request)
        if not agent["swarm_id"]:
            return []
        # a researcher child lists its own research task only (research.py)
        return hive.research.visible_goals(agent, hive.goals.list(agent["swarm_id"], status or None))

    @app.get("/api/agent/goals/history")
    async def agent_goal_history(request: Request, q: str = "", offset: int = 0):
        return hive.goals.history(agent_from(request), q, offset)

    @app.post("/api/agent/goals/{goal_id}/continue")
    async def agent_goal_continue(goal_id: str, request: Request):
        agent = agent_from(request)
        data = await body(request)
        return await hive.goals.continue_goal(agent, goal_id, data.get("instruction"))

    @app.get("/api/agent/goals/{goal_id}/output")
    async def agent_goal_output(goal_id: str, request: Request, offset: int = 0):
        return hive.goals.output(agent_from(request), goal_id, offset)

    @app.post("/api/agent/create")
    async def agent_create_offer(request: Request):
        # hive-create: a mind offers its person a Create build; only the person's press starts a plan (create_offers.py)
        status, view = hive.create_offers.offer(agent_from(request), await body(request))
        return JSONResponse(view, status_code=status)

    @app.post("/api/agent/goals")
    async def agent_create_goal(request: Request):
        agent = agent_from(request)
        if not agent["swarm_id"]:
            raise HiveError(400, "no_swarm", "agent is not in a swarm")
        data = await body(request)
        return await hive.goals.create(agent["swarm_id"], data.get("title", ""), data.get("detail", ""),
                                       data.get("priority", 0.5), data.get("parent_id"), created_by=f"agent:{agent['id']}")

    @app.post("/api/agent/goals/{goal_id}/claim")
    async def agent_claim(goal_id: str, request: Request):
        agent = agent_from(request)
        return hive.goals.claim(agent, goal_id)

    @app.post("/api/agent/goals/{goal_id}/heartbeat")
    async def agent_goal_heartbeat(goal_id: str, request: Request):
        return hive.goals.heartbeat(agent_from(request), goal_id)

    @app.post("/api/agent/goals/{goal_id}/files")
    async def agent_goal_file(goal_id: str, request: Request):
        """hive-goal-file: one whole file staged on a goal the mind holds, for the goal's answer (Goals.stage_file)."""
        data = await body(request)
        return hive.goals.stage_file(agent_from(request), goal_id, data.get("path"), data.get("text"))

    @app.post("/api/agent/goals/{goal_id}/result")
    async def agent_result(goal_id: str, request: Request):
        agent = agent_from(request)
        data = await body(request)
        goal = await hive.goals.result(agent, goal_id, data.get("status", "done"), data.get("result", ""), data.get("data"))
        await hive.goals.notify_parent(goal)
        return goal

    @app.get("/api/agent/goals/{goal_id}")
    async def agent_goal(goal_id: str, request: Request):
        return hive.goals.for_agent(agent_from(request), goal_id)

    @app.post("/api/agent/goals/{goal_id}/cancel-ack")
    async def agent_goal_cancel_ack(goal_id: str, request: Request):
        return hive.goals.cancel_ack(agent_from(request), goal_id)

    # ---- timed sharing of private memory between minds ---------------------------------------------

    @app.get("/api/agent/shares")
    async def agent_shares(request: Request):
        return hive.shares.mine(agent_from(request))

    @app.post("/api/agent/shares/request")
    async def agent_share_request(request: Request):
        agent, data = agent_from(request), await body(request)
        return await hive.shares.request(agent, data.get("owner"), data.get("space"), data.get("minutes"),
                                         data.get("filter") or data.get("pattern"), data.get("reason", ""))

    @app.post("/api/agent/shares/offer")
    async def agent_share_offer(request: Request):
        agent, data = agent_from(request), await body(request)
        return await hive.shares.offer(agent, data.get("grantee"), data.get("space"), data.get("minutes"),
                                       data.get("filter") or data.get("pattern"), data.get("note", ""))

    @app.post("/api/agent/shares/{share_id}/grant")
    async def agent_share_grant(share_id: str, request: Request):
        agent, data = agent_from(request), await optional_body(request)
        return await hive.shares.grant(agent, share_id, data.get("minutes"))

    @app.post("/api/agent/shares/{share_id}/deny")
    async def agent_share_deny(share_id: str, request: Request):
        agent, data = agent_from(request), await optional_body(request)
        return await hive.shares.deny(agent, share_id, data.get("reason", ""))

    @app.post("/api/agent/shares/{share_id}/revoke")
    async def agent_share_revoke(share_id: str, request: Request):
        return await hive.shares.revoke(share_id, by_agent=agent_from(request))

    @app.get("/api/agent/shares/{share_id}/atoms")
    async def agent_share_read(share_id: str, request: Request, q: str = "", limit: int = 200, offset: int = 0):
        agent = agent_from(request)
        return await run_in_threadpool(hive.shares.read, agent, share_id, q, limit, offset)

    @app.post("/api/agent/exhibits")
    async def agent_exhibit(request: Request):
        agent, data = agent_from(request), await body(request)
        return await hive.shares.exhibit(agent, data.get("title", ""), data.get("to", "swarm"), data.get("minutes"),
                                         data.get("body", ""), data.get("atoms"), data.get("space"),
                                         data.get("filter") or data.get("pattern"))

    @app.post("/api/agent/stage")
    async def agent_stage(request: Request):
        """A mind's Show, Recall or Compare to its person's stage (stage.py)."""
        agent = agent_from(request)
        pin = hive.ask.pin(agent["id"])   # the sending execution, pinned at authentication, before any await or thread hop
        data = await body(request)
        agent = agent_from(request)       # re-read after the body: a mind deleted or moved meanwhile is judged as it is now
        return await run_in_threadpool(lambda: hive.stage.say(agent, data, hive.stage.audience(agent, pin)))

    @app.get("/api/shares")
    async def shares(request: Request, status: str = "", agent_id: str = ""):
        session = operator(request)
        return hive.shares.list(status or None, agent_id or None, viewer=viewer(session))

    @app.get("/api/shares/{share_id}/reads")
    async def share_reads(share_id: str, request: Request):
        session = operator(request)
        return hive.shares.reads(share_id, viewer=viewer(session))

    @app.post("/api/shares/{share_id}/revoke")
    async def share_revoke(share_id: str, request: Request):
        session = operator(request)
        # unseen shares are not found and not revocable; checked inside revoke, atomically with the write
        return await hive.shares.revoke(share_id, by_person=session.get("principal") or "user:operator", viewer=viewer(session))

    # ---- mind programs (hive/PROGRAMS.md) --------------------------------------------------------------

    @app.get("/api/programs")
    async def programs(request: Request):
        session = operator(request)
        admin = role_of(session) == "admin"
        rows = hive.programs.list(admin=admin)   # pin refusal detail: admins only (Kimi K2)
        if admin:
            return rows
        # Ask-and-apps contract R1 §3: a member outside a person app's audience does not learn the app exists
        from .my_apps import in_audience
        principal = session.get("principal") or "user:operator"
        return [r for r in rows if r.get("placement") != "person" or in_audience(hive, principal, r["id"])]

    @app.get("/api/me/apps")
    async def me_apps(request: Request):
        """The apps this person can open (awake state of every look): discoverable and openable only; no side effects."""
        session = operator(request)
        from .my_apps import MyApps
        return await run_in_threadpool(MyApps(hive).list, viewer(session), session.get("principal") or "user:operator")

    @app.post("/api/programs/reload")
    async def programs_reload(request: Request):
        admin(request)   # re-reads every app folder; uninstall leaves the files, so it would also bring an app back
        return await run_in_threadpool(hive.programs.reload)

    @app.get("/api/programs/{program_id}")
    async def program(program_id: str, request: Request):
        session = operator(request)
        return hive.programs.detail(program_id, admin=role_of(session) == "admin")

    @app.delete("/api/programs/{program_id}")
    async def program_uninstall(program_id: str, request: Request):
        session = admin(request)
        return await run_in_threadpool(hive.programs.uninstall, program_id,
                                       by=session.get("principal") or "user:operator")

    @app.post("/api/programs/{program_id}/enable")
    async def program_enable(program_id: str, request: Request):
        session = admin(request)   # managing an app is an admin's, as installing, activating and uninstalling are
        return await run_in_threadpool(hive.programs.set_enabled, program_id, True, session.get("principal"))

    @app.post("/api/programs/{program_id}/disable")
    async def program_disable(program_id: str, request: Request):
        session = admin(request)
        return await run_in_threadpool(hive.programs.set_enabled, program_id, False, session.get("principal"))

    @app.post("/api/programs/{program_id}/grants/revoke")
    async def program_grants_revoke(program_id: str, request: Request):
        session = operator(request)
        return hive.programs.revoke_grants(program_id, hive.program_actions.person_viewer(session, role_of(session), ""))

    @app.post("/api/programs/{program_id}/grants/restore")
    async def program_grants_restore(program_id: str, request: Request):
        session = operator(request)
        return hive.programs.restore_grants(program_id, hive.program_actions.person_viewer(session, role_of(session), ""))

    @app.get("/api/programs/{program_id}/ui")
    async def program_ui(program_id: str, request: Request):
        operator(request)
        return await run_in_threadpool(hive.programs.ui_bundle, program_id)

    @app.get("/api/programs/{program_id}/homes")
    async def program_homes(program_id: str, request: Request):
        session = operator(request)
        who = viewer(session)
        visible = {s["id"] for s in hive.swarms() if who.sees(s) and not hive.visibility.hides(who, s["id"])}
        return {"program": program_id, "homes": hive.programs.homes(program_id, visible, getattr(who, "principal", None))}

    def app_input(data, host_keys):
        """What a person's act or confirm hands the app, for the named-mind check: every field but the host's own and a
        file's bytes (its name is the app's input too)."""
        out = [{k: v for k, v in data.items() if k not in host_keys and k != "file"}]
        if isinstance(data.get("file"), dict):
            out.append({k: v for k, v in data["file"].items() if k != "content_base64"})
        return out

    @app.post("/api/programs/{program_id}/view")
    async def program_view(program_id: str, request: Request):
        session = operator(request)
        data = await body(request)
        if set(data) - {"swarm_id", "focus", "stage", "untrusted_intent"}:
            raise HiveError(400, "bad_request", "view accepts swarm, focus and stage only; the host sets the viewer")
        swarm_id = str(data.get("swarm_id", ""))
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        hive.visibility.check_named_minds(viewer(session), data.get("focus"), data.get("stage"))   # r16: before the app runs
        who = hive.program_actions.person_viewer(session, role_of(session), swarm_id)
        return await hive.programs.view(program_id, swarm_id, data.get("focus"), data.get("stage"), viewer=who, untrusted_intent=data.get("untrusted_intent"))

    @app.post("/api/programs/{program_id}/read")
    async def program_read(program_id: str, request: Request):
        session = operator(request)
        data = await bounded_body(request, 1024 * 1024)    # read params are small; a streamed body cannot grow past this
        if set(data) - {"swarm_id", "query", "params"}:
            raise HiveError(400, "bad_request", "read accepts swarm, query and params only; the host sets the viewer")
        swarm_id = str(data.get("swarm_id", ""))
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        hive.visibility.check_named_minds(viewer(session), data.get("query"), data.get("params"))   # r16: before the app runs
        who = hive.program_actions.person_viewer(session, role_of(session), swarm_id)
        return await hive.programs.read(program_id, swarm_id, str(data.get("query", "")), data.get("params"), viewer=who)

    @app.post("/api/programs/{program_id}/act")
    async def program_act(program_id: str, request: Request, response: Response):
        session = operator(request)
        data = await bounded_body(request, ACT_MAX_BODY)   # streamed and capped, whatever the headers say (Kimi next9 #3)
        swarm_id = str(data.get("swarm_id", ""))
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        # r16.1 (Kimi r16 #1): an act reaches the same app with the same params, so it names only minds the person sees
        hive.visibility.check_named_minds(viewer(session), *app_input(data, ("swarm_id", "confirm_token")))
        # the person choosing a swarm here is normal; naming who acts is not
        # the host's own confirm token (§9d) is not an app credential; it never reaches the app
        hive.program_actions.refuse_identity(hive, {k: v for k, v in data.items() if k not in ("swarm_id", "params", "confirm_token")},
                                             data.get("params"))
        actor = hive.program_actions.person_actor(session, role_of(session), swarm_id)
        consent_required = False
        def noticed_person_swarm_consent():
            nonlocal consent_required
            consent_required = True
        result = await hive.program_actions.person_act(
            actor, program_id, swarm_id, data, session_hash=session["token_hash"],
            _on_person_swarm_consent_required=noticed_person_swarm_consent)
        # Advisory host-only transport: no JSON field, app status or Context flag
        # can mint this. The app's result body and status enum remain unchanged.
        if consent_required:
            response.headers["X-Hive-Person-Swarm-Consent-Required"] = "1"
        return result

    @app.post("/api/programs/{program_id}/confirm")
    async def program_confirm(program_id: str, request: Request):
        """The host mints a single-use confirm token after the person confirms an act in its DecisionDialog (§9d).
        A person session only: a mind's token is no session here (401)."""
        session = operator(request)
        data = await bounded_body(request, 5 * 1024 * 1024)   # a 2 MB canonical payload, even if the request escapes more
        swarm_id = str(data.get("swarm_id", ""))
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        hive.visibility.check_named_minds(viewer(session), data.get("action"), *app_input(payload, ()))   # r16.1 (Kimi r16 #1)
        actor = hive.program_actions.person_actor(session, role_of(session), swarm_id)
        return hive.program_actions.mint_confirm(actor, session["token_hash"], program_id, swarm_id, data)

    # ---- reviewed app lifecycle (candidate; no worker start) -----------------------------

    def app_admin(request, swarm=""):
        session = admin(request)
        actor = hive.program_actions.person_actor(session, role_of(session), swarm)
        hive.app_attachments.admin(actor)
        return actor

    @app.get("/api/programs/{program_id}/install")
    async def app_install_status(program_id: str, request: Request):
        session = operator(request)
        return await run_in_threadpool(hive.person_apps.status, program_id, role_of(session) == "admin",
                                       session.get("principal"))

    @app.post("/api/programs/{program_id}/install")
    async def app_install(program_id: str, request: Request):
        """P14: installing is the review, by a named signed-in admin (the local operator is refused)."""
        actor, data = app_admin(request), await body(request)
        return await run_in_threadpool(hive.person_apps.review, actor, program_id, data)

    @app.put("/api/programs/{program_id}/install/person-allow")
    async def app_install_restrict(program_id: str, request: Request):
        actor, data = app_admin(request), await body(request)
        return await run_in_threadpool(hive.person_apps.restrict, actor, program_id, data)

    @app.delete("/api/programs/{program_id}/install")
    async def app_install_revoke(program_id: str, request: Request):
        return await run_in_threadpool(hive.person_apps.revoke, app_admin(request), program_id)

    @app.get("/api/programs/{program_id}/activations")
    async def app_activations(program_id: str, request: Request):
        session = operator(request)
        rows = [{"program": r["program"], "swarm_id": r["swarm"], "active": bool(r["active"])} for r in hive.db.all("SELECT * FROM app_activations WHERE program=?", (program_id,))]
        return hive.visibility.filter_items(viewer(session), rows)

    @app.post("/api/programs/{program_id}/activations")
    async def app_activate(program_id: str, request: Request):
        data = await body(request)
        return await hive.app_attachments.activate(app_admin(request), program_id, str(data.get("swarm_id", "")))

    @app.delete("/api/programs/{program_id}/activations/{swarm_id}")
    async def app_deactivate(program_id: str, swarm_id: str, request: Request):
        return await hive.app_attachments.deactivate(app_admin(request), program_id, swarm_id)

    @app.post("/api/programs/{program_id}/offers")
    async def app_offer(program_id: str, request: Request):
        return await hive.app_attachments.offer(app_admin(request), program_id, str((await body(request)).get("mind_id", "")))

    @app.post("/api/programs/{program_id}/attachments")
    async def app_attach(program_id: str, request: Request):
        return await hive.app_attachments.attach(app_admin(request), program_id, await body(request))

    @app.get("/api/programs/{program_id}/attachments")
    async def app_attachments(program_id: str, request: Request):
        session = operator(request)
        rows = [hive.app_attachments.view(row) for row in hive.db.all("SELECT * FROM app_attachments WHERE program=?", (program_id,))]
        return hive.visibility.filter_items(viewer(session), rows)

    @app.delete("/api/programs/{program_id}/attachments/{attachment_id}")
    async def app_detach(program_id: str, attachment_id: str, request: Request):
        actor = app_admin(request)
        if hive.app_attachments.row(attachment_id)["program"] != program_id:
            raise HiveError(404, "not_found", "attachment not in program")
        return await hive.app_attachments.revoke(actor, attachment_id)

    # ---- cross-swarm requests, artifacts, findings (hive/core/collab.py) ----------------------------

    @app.put("/api/swarms/{swarm_id}/services")
    async def set_swarm_services(swarm_id: str, request: Request):
        session = admin(request)
        data = await body(request)
        return hive.collab.set_services(swarm_id, data.get("kinds") or [], session.get("principal") or "user:operator",
                                        data.get("connection_only_kinds"))

    @app.get("/api/swarms/{swarm_id}/services")
    async def swarm_services(swarm_id: str, request: Request):
        operator(request)
        return {"swarm_id": swarm_id, "kinds": hive.collab.services(swarm_id),
                "connection_only_kinds": hive.collab.connection_services(swarm_id)}

    @app.get("/api/swarms/{swarm_id}/artifacts")
    async def swarm_artifacts(swarm_id: str, request: Request, kind: str = "", limit: int = 200):
        """Candidate (Studio picker): exact references to this swarm's artifacts, metadata only, for a viewer who sees it."""
        session = operator(request)
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        return hive.collab.swarm_artifacts(swarm_id, kind or None, limit)

    @app.get("/api/artifacts")
    async def creations(request: Request, limit: int = 200, kind: str = "", saved: bool = False):
        """The Artifacts page: every artifact of the swarms this person sees (as GET /api/swarms lists them), saved or
        not yet, metadata only. The maker is named as mind_id only when it is a mind GET /api/agents shows this person;
        a person who made one is never named. The optional kind and saved filters apply before the limit."""
        session = operator(request)
        who = viewer(session)
        seen = hive.visibility.swarms(who, [s for s in hive.swarms() if not s.get("archived_at")])
        rows = hive.collab.creations([s["id"] for s in seen], limit, kind=kind, saved=saved)
        minds = seen_minds(session)
        for r in rows:
            r["mind_id"] = mind_named(r.pop("created_by"), minds)
        return rows

    def seen_minds(session):
        """The ids of the minds GET /api/agents shows this person."""
        return {a["id"] for a in hive.visibility.agents(viewer(session), hive.agents())}

    def mind_named(created_by, minds):
        """An artifact's maker as a mind id, only when it is one of `minds` (seen_minds); a person who made one is
        never named."""
        by = str(created_by or "")
        return by[6:] if by.startswith("agent:") and by[6:] in minds else None

    def shown_artifact(session, artifact_id):
        """The artifact row when this person sees the swarm that owns it, the same swarms GET /api/artifacts lists for
        them, else None: whoever is shown an artifact may read it and open its view, and anyone else is answered as if
        it did not exist."""
        art = hive.db.one("SELECT * FROM artifacts WHERE id = ?", (artifact_id,))
        seen = art is not None and bool(hive.visibility.swarms(
            viewer(session), [s for s in hive.swarms() if s["id"] == art["owner_swarm"] and not s.get("archived_at")]))
        return art if seen else None

    @app.get("/api/artifacts/{artifact_id}")
    async def creation(artifact_id: str, request: Request):
        """One artifact as GET /api/artifacts lists it, for a person shown it (shown_artifact): a mind names what it
        made by id, and the page shows that id as the artifact's title and opens it from there. Anyone else, and an
        id that names nothing, gets 404."""
        session = operator(request)
        row = hive.collab.creation(artifact_id) if shown_artifact(session, artifact_id) else None
        if row is None:
            raise HiveError(404, "not_found", "no such artifact")
        row["mind_id"] = mind_named(row.pop("created_by"), seen_minds(session))
        return row

    @app.get("/api/artifacts/{artifact_id}/revisions/{n}")
    async def creation_text(artifact_id: str, n: int, request: Request):
        """The Artifacts page's reader: one saved revision of an artifact, its text included, for a person shown that
        artifact (shown_artifact)."""
        session = operator(request)
        art = shown_artifact(session, artifact_id)
        row = hive.db.one("SELECT n, digest, body, created_at FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                          (artifact_id, n)) if art else None
        if row is None:
            raise HiveError(404, "not_found", "no such artifact revision")
        return {"artifact_id": art["id"], "kind": art["kind"], "title": art["title"], "swarm_id": art["owner_swarm"],
                "revision": row["n"], "digest": row["digest"], "body": row["body"], "created_at": row["created_at"]}

    view_tickets = views_mod.Tickets()
    view_grants = views_mod.Grants(hive.db, now)

    def own_hosts(request: Request):
        """Every name this hive answers at: the address this request used, and the configured public ones."""
        return {request.url.hostname or "", urlsplit(settings.public_url or "").hostname or "",
                urlsplit(os.environ.get("HIVE_PUBLIC_BASE", "")).hostname or ""}

    def shown_view(session, artifact_id, revision):
        """(artifact, revision row, view) for a person shown that artifact: the named revision, or the latest. 404 for
        anyone else or a revision that does not exist; 415 not_a_view when the revision holds no view, with the reason
        when it was meant as one."""
        art = shown_artifact(session, artifact_id)
        row = None
        if art is not None:
            row = hive.db.one("SELECT n, digest, body, created_at FROM artifact_revisions WHERE artifact_id = ? AND n = ?",
                              (artifact_id, revision)) if revision is not None else \
                hive.db.one("SELECT n, digest, body, created_at FROM artifact_revisions WHERE artifact_id = ? "
                            "ORDER BY n DESC LIMIT 1", (artifact_id,))
        if row is None:
            raise HiveError(404, "not_found", "no such artifact revision")
        try:
            view = views_mod.view_of(art["kind"], row["body"])
        except views_mod.NotAView as exc:
            raise HiveError(415, "not_a_view", str(exc))
        if view is None:
            raise HiveError(415, "not_a_view", "this artifact's text is not a view")
        return art, row, view

    @app.get("/api/artifacts/{artifact_id}/view")
    async def artifact_view(artifact_id: str, request: Request, revision: int | None = None):
        """One saved revision of an artifact as an interactive view (hive/core/views.py), for a person shown that
        artifact, with that person's consent to it (``grant``: ran, reach). A view written in MeTTa (carrier ``metta``)
        comes as its text, which the person's browser composes; an HTML view comes as its MCP UI resource (ui:// name,
        MIME type, the domains and permissions the hive grants it), the domains it declares that wait on the person
        (``asks``), what the hive refused of what it declared, and the short-lived address of its document. The text
        and the document come only once the person has asked the view to run (POST …/view/grants), and the document
        reaches its declared domains only once they allowed them for this revision. Without ``revision``, the latest
        saved one."""
        session = operator(request)
        art, row, view = shown_view(session, artifact_id, revision)
        grant = view_grants.of(art["id"], row["n"], session.get("principal") or "user:operator", view.carrier)
        common = {"artifact_id": art["id"], "kind": art["kind"], "title": art["title"], "swarm_id": art["owner_swarm"],
                  "mind_id": mind_named(art.get("created_by"), seen_minds(session)),
                  "revision": row["n"], "digest": row["digest"], "created_at": row["created_at"], "carrier": view.carrier,
                  "grant": grant}
        if isinstance(view, views_mod.MettaView):
            return {**common, "source": view.source if grant["ran"] else None}
        hosts = own_hosts(request)
        granted = views_mod.policy(view.meta if grant["reach"] else views_mod.without_domains(view.meta), hosts)
        ui = {"csp": granted.csp, "permissions": granted.permissions}
        if isinstance(view.meta.get("prefersBorder"), bool):
            ui["prefersBorder"] = view.meta["prefersBorder"]
        return {**common,
                "resource": {"uri": views_mod.resource_uri(art["id"], row["n"]), "mimeType": views_mod.MCP_APP_MIME,
                             "_meta": {"ui": ui}},
                "asks": {} if grant["reach"] else views_mod.declared_domains(view.meta, hosts),
                "allow": granted.allow, "refused": views_mod.policy(view.meta, hosts).refused,
                "document": f"/api/views/{view_tickets.mint(art['id'], row['n'], grant['reach'])}" if grant["ran"] else None}

    @app.post("/api/artifacts/{artifact_id}/view/grants")
    async def view_grant(artifact_id: str, request: Request):
        """The person's consent to one revision of a view shown to them, given by their own click: that they ran it,
        and with ``reach`` true that it may reach the domains it declares (an HTML view only; a MeTTa view reaches
        none). It covers only the person who gave it. Anyone not shown the artifact gets 404. → {ran, reach}."""
        session = operator(request)
        data = await body(request)
        if not isinstance(data, dict) or set(data) - {"revision", "reach"} or isinstance(data.get("revision"), bool) \
                or not isinstance(data.get("revision"), int) or not isinstance(data.get("reach", False), bool):
            raise HiveError(400, "bad_request", "a grant names the revision that was run, and reach true or false")
        art, row, view = shown_view(session, artifact_id, data["revision"])
        if data.get("reach") and isinstance(view, views_mod.MettaView):
            raise HiveError(400, "bad_request", "a view written in MeTTa reaches no domain")
        principal = session.get("principal") or "user:operator"
        view_grants.give(art["id"], row["n"], principal, data.get("reach", False))
        return view_grants.of(art["id"], row["n"], principal, view.carrier)

    @app.get("/api/views/{ticket}")
    async def view_document(ticket: str, request: Request):
        """A view's document, under the ticket GET /api/artifacts/{id}/view minted, with the CSP its resource earns. No
        session: the ticket is the whole permission and names one revision, and whether its person allowed that
        revision's declared domains: until they did, the CSP keeps none of them (connect-src 'none'). Served sandboxed
        with an opaque origin, so it never runs as the hive, even opened directly in a tab."""
        got = view_tickets.redeem(ticket)
        art = hive.db.one("SELECT * FROM artifacts WHERE id = ?", (got[0],)) if got else None
        row = hive.db.one("SELECT body FROM artifact_revisions WHERE artifact_id = ? AND n = ?", got[:2]) if art else None
        try:
            view = views_mod.view_of(art["kind"], row["body"]) if row else None
        except views_mod.NotAView:
            view = None
        if not isinstance(view, views_mod.View):   # no view, or one written in MeTTa, which has no document
            return Response(views_mod.EXPIRED_PAGE, status_code=404, media_type="text/html; charset=utf-8",
                            headers={**views_mod.DOCUMENT_HEADERS, "Content-Security-Policy": views_mod.EXPIRED_CSP})
        granted = views_mod.policy(view.meta if got[2] else views_mod.without_domains(view.meta), own_hosts(request))
        return Response(views_mod.document(view.html), media_type="text/html; charset=utf-8",
                        headers={**views_mod.DOCUMENT_HEADERS, "Content-Security-Policy": granted.header})

    @app.get("/api/swarms/{swarm_id}/artifacts/{artifact_id}/subscription")
    async def artifact_subscription(swarm_id: str, artifact_id: str, request: Request):
        session = operator(request)
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})   # the viewer must see the frame's swarm
        return hive.collab.subscription_access(swarm_id, artifact_id)

    @app.get("/api/match/catalogue")
    async def match_catalogue(request: Request, scope: str = ""):
        actor = hive.authenticate_agent(_bearer(request.headers.get("authorization")), surface="rest")
        if actor is not None:
            requester = actor.get("swarm_id")
            if not requester:
                raise HiveError(403, "swarm_required", "catalogue discovery requires swarm membership")
            if scope and scope != requester:
                raise HiveError(403, "requester_scope_mismatch", "catalogue scope must match your swarm")
        else:
            session = operator(request)
            if not scope:
                raise HiveError(400, "scope_required", "choose a requester swarm")
            requester = scope
            row = hive.db.one("SELECT * FROM swarms WHERE id = ?", (requester,))
            person_view = viewer(session)
            if row is None or not person_view.sees(row) or (not person_view.admin and row.get("owner") != person_view.principal):
                raise HiveError(404, "not_found", "no requester swarm")
        return hive.collab.capability_catalogue(requester)

    @app.get("/api/agent/service-catalogue")
    async def agent_service_catalogue(request: Request):
        actor = agent_from(request)
        if not actor.get("swarm_id"):
            raise HiveError(403, "swarm_required", "service discovery requires swarm membership")
        return hive.collab.service_catalogue(actor["swarm_id"])

    @app.get("/api/agent/services/{swarm_id}")
    async def agent_swarm_services(swarm_id: str, request: Request):
        actor = agent_from(request)
        return {"swarm_id": swarm_id, "kinds": hive.collab.visible_services(actor["swarm_id"], swarm_id)}

    def named_admin(request):
        """A signed-in admin person (never the loopback operator password)."""
        session = admin(request)
        if session.get("kind") != "sso" or (session.get("principal") or "user:operator") == "user:operator":
            raise HiveError(403, "person_admin_required", "a signed-in admin person must do this")
        return session

    # ---- assets: binary files, local and cloud stores, verified transfer (hive/core/assets.py) ------------

    async def spooled_body(request, store="local", limit=None):
        """An upload streamed to disk in chunks and hashed as it arrives (assets.Spool), never held whole in memory. The
        store's limit (none for the local store unless the operator set one) applies to the declared length up front and
        to the running total. A disconnect, a refusal or any other failure removes the temp file before it propagates."""
        declared = request.headers.get("content-length") or ""
        spool = hive.assets.spool(store, int(declared) if declared.isdigit() else 0)   # the free-space floor, up front
        if limit and (spool.limit is None or limit < spool.limit):
            spool.limit, spool.too_large = limit, (lambda: HiveError(413, "too_large", "file too large"))
        try:
            if declared.isdigit() and spool.limit is not None and int(declared) > spool.limit:
                raise spool.too_large()
            async for chunk in request.stream():
                spool.write(chunk)
            spool.finish()
        except BaseException:
            spool.abort()
            raise
        return spool

    def asset_response(*, sha, name_for):
        """A download: small files are read and verified whole before a byte is sent (a tampered copy is a 500); a file
        over assets.STREAM_FROM bytes in the local store streams in chunks, its size checked first and its hash at the end."""
        from fastapi.responses import Response as RawResponse, StreamingResponse
        row = hive.assets.row(sha)
        if row["bytes"] > assets_mod.STREAM_FROM:
            streamed = hive.assets.stream(sha)
            if streamed is not None:
                row, size, chunks = streamed
                return row, lambda: StreamingResponse(chunks, headers=dict(hive.assets.headers(row, name_for(row)), **{"Content-Length": str(size)}))
        row, data = hive.assets.read(sha)
        return row, lambda: RawResponse(content=data, headers=hive.assets.headers(row, name_for(row)))

    def asset_visible(session, row):
        owners = sorted(hive.assets.owners(row["sha256"]))   # the same bytes may belong to several swarms: any one suffices
        failure = None
        for owner in owners:
            try:
                hive.visibility.check_path(viewer(session), {"swarm_id": owner})
                return
            except HiveError as exc:
                failure = exc
        if failure:
            raise failure

    @app.get("/api/asset-stores")
    async def asset_stores(request: Request):
        operator(request)
        return hive.assets.store_info()

    @app.get("/api/assets")
    async def list_assets(request: Request, swarm_id: str | None = None):
        session = operator(request)
        rows = hive.db.all("SELECT * FROM assets" + (" WHERE owner_swarm = ? OR sha256 IN (SELECT sha256 FROM asset_owners WHERE owner_swarm = ?)" if swarm_id else "")
                           + " ORDER BY created_at DESC LIMIT 500", (swarm_id, swarm_id) if swarm_id else ())
        who = viewer(session)
        views = [hive.assets.view_for(who, r) for r in rows]   # any visible owner admits it; hidden owners are redacted
        return [v for v in views if v is not None]

    @app.post("/api/assets")
    async def upload_asset(request: Request, swarm_id: str = "", name: str = "", local_only: bool = False, store: str = "local"):
        session = admin(request)
        if swarm_id:
            hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        bootstrap = session.get("kind") == newhive_mod.BOOTSTRAP_KIND
        spool = await spooled_body(request, store, limit=assets_mod.MEMORY_MAX_BYTES if bootstrap else None)
        try:
            if bootstrap:   # new-hive R1a: only the attempt's exact receipt/envelope (checked on the streamed hash)
                hive.newhive.check_upload_digest(session, spool.digest, request.headers.get("content-type"))
            out = hive.assets.put_spooled(spool, request.headers.get("content-type"), session.get("principal") or "user:operator",
                                          swarm_id or None, name, local_only, store)
        finally:
            spool.abort()
        # the answer follows the list's rule: a duplicate of another person's hidden personal file is not revealed
        shown = hive.assets.view_for(viewer(session), hive.assets.row(out["sha256"]))
        shown = dict(shown, name=out["name"]) if shown else {k: out[k] for k in ("sha256", "mime", "bytes", "name", "local_only")}
        # the swarm's minds hear of it once, by name, type and size, never its contents (mind_files.py)
        await hive.mind_files.asset_stored(out, swarm_id or None, session.get("principal") or "user:operator")
        return shown

    @app.get("/api/assets/{sha}")
    async def download_asset(sha: str, request: Request):
        session = operator(request)
        asset_visible(session, hive.assets.row(sha))   # visibility before any byte is read
        _, respond = asset_response(sha=sha, name_for=lambda row: hive.assets.download_name(viewer(session), row))
        return respond()

    @app.post("/api/assets/{sha}/transfer")
    async def transfer_asset(sha: str, request: Request):
        session = admin(request)
        data = await body(request)
        return hive.assets.transfer(sha, str(data.get("to") or ""), session.get("principal") or "user:operator", bool(data.get("move")))

    @app.post("/api/assets/{sha}/cleanup")
    async def cleanup_asset(sha: str, request: Request):
        session = admin(request)
        return await asyncio.to_thread(hive.assets.cleanup, sha, session.get("principal") or "user:operator")

    @app.delete("/api/assets/{sha}")
    async def delete_asset(sha: str, request: Request):
        session = admin(request)
        return await asyncio.to_thread(hive.assets.delete, sha, session.get("principal") or "user:operator", viewer(session))

    @app.post("/api/agent/assets")
    async def agent_upload_asset(request: Request, name: str = "", local_only: bool = False):
        agent = agent_from(request)
        if not agent.get("swarm_id"):
            raise HiveError(400, "no_swarm", "a mind in a swarm uploads assets")
        spool = await spooled_body(request, limit=hive.settings.mind_upload_max_bytes)   # minds: 2 GiB by default
        return hive.assets.put_spooled(spool, request.headers.get("content-type"), f"agent:{agent['id']}", agent["swarm_id"], name, local_only)

    @app.get("/api/agent/assets/{sha}")
    async def agent_download_asset(sha: str, request: Request, artifact: str | None = None, revision: int | None = None):
        agent = agent_from(request)
        # the minds' rule (Assets.agent_may_read), and for a person's own mind its person's rule too (mind_files.py)
        name = hive.mind_files.may_read(agent, sha, artifact, revision)
        if name is None:
            raise HiveError(404, "not_found", "no such asset for you")
        _, respond = asset_response(sha=sha, name_for=lambda row: name)
        return respond()

    @app.get("/api/lifecycle/delegations")
    async def list_delegations(request: Request):
        session = operator(request)
        return hive.visibility.hide_others_personal(viewer(session), hive.delegation.delegations(),
                                                    lambda d: [d["coordinator_id"], d["specialist_id"]])

    @app.put("/api/lifecycle/delegations/{coordinator_id}")
    async def set_delegations(coordinator_id: str, request: Request):
        session = named_admin(request)
        return hive.delegation.set_delegation(coordinator_id, (await body(request)).get("specialist_ids") or [], session["principal"])

    @app.post("/api/lifecycle/leases")
    async def issue_lease(request: Request):
        session = named_admin(request)
        return hive.delegation.issue(await body(request), session["principal"])

    @app.post("/api/agent/lifecycle/{action}")
    async def agent_lifecycle(action: str, request: Request):
        agent = agent_from(request)
        lease = (await body(request)).get("lease")
        if action == "start":
            return await hive.delegation.start(agent, lease)
        if action == "stop":
            return await hive.delegation.stop(agent, lease)
        if action == "status":
            return await hive.delegation.status(agent, lease)
        raise HiveError(404, "not_found", "lifecycle actions are start, stop and status")

    # ---- mind control, phase one (r2.12, r2.12.1, r2.13, r2.13.1; hive/core/minds.py) ----------------------

    def recorded(out):
        """A write's recorded status and body, byte for byte (a replay returns exactly these bytes)."""
        status, content = out
        return Response(content=content, status_code=status, media_type="application/json")

    @app.get("/api/agent/minds/templates")
    async def mind_templates(request: Request, team_id: str | None = None):
        return hive.minds.templates_for(agent_from(request), team_id)

    @app.get("/api/agent/minds/status")
    async def mind_status(request: Request, child_id: str | None = None, team_id: str | None = None,
                          request_id: str | None = None, cursor: str | None = None):
        return hive.minds.status(agent_from(request), child_id, team_id, request_id, cursor)

    @app.post("/api/agent/minds")
    async def mind_spawn(request: Request):
        agent = agent_from(request)
        return recorded(await hive.minds.spawn(agent, await body(request)))

    @app.post("/api/agent/minds/{child_id}/prompt")
    async def mind_prompt(child_id: str, request: Request):
        agent = agent_from(request)
        return recorded(await hive.minds.prompt(agent, child_id, await body(request)))

    @app.post("/api/agent/minds/{child_id}/control")
    async def mind_control(child_id: str, request: Request):
        agent = agent_from(request)
        return recorded(await hive.minds.control(agent, child_id, await body(request)))

    def instruction_person(request):
        """r2.13: a named, signed-in admin person; never the local operator password and never a mind."""
        session = operator(request)
        if not _person_admin(session):
            raise HiveError(403, "person_required", "a named, signed-in admin person submits an instruction")
        return session

    @app.post("/api/requests")
    async def person_instruction(request: Request):
        session = instruction_person(request)
        data = await body(request)
        op = data.get("operation_id")
        if isinstance(op, str) and op.startswith("ask."):   # linkage r3.6 R1: an Ask intent's key, host-derived only
            raise HiveError(400, "operation_reserved", "operation ids beginning 'ask.' belong to Ask intents")
        return recorded(await hive.minds.instruct(session["principal"], data))

    @app.get("/api/teams/{swarm_id}/children")
    async def team_children(swarm_id: str, request: Request, cursor: str | None = None):
        who = viewer(operator(request))                  # operator() refuses a team this person may not see (as not found)
        return hive.minds.team_children(who, swarm_id, cursor)

    @app.get("/api/teams/{swarm_id}/templates")
    async def team_templates(swarm_id: str, request: Request):
        # linkage r3.6 §G (Platform ruling): Bearer header only, a named signed-in person; then a team this person may not
        # see is the same 404 as one that does not exist (check_path), like the team children read
        v = g_person(request, mutating=False, admin_only=False)
        hive.visibility.check_path(v, {"swarm_id": swarm_id})
        return hive.minds.team_templates(swarm_id)

    @app.post("/api/teams/{swarm_id}/children/{child_id}/control")
    async def team_child_control(swarm_id: str, child_id: str, request: Request):
        # The person gate runs before any look at the team (Kimi kimi-mind-control-p1 #1): who may not act learns nothing
        # about whether the team exists; a team this person cannot see, or one that does not exist, is the same 404.
        session = session_for(_bearer(request.headers.get("authorization")), request.scope.get("hive_public", False))
        if session is None:
            raise HiveError(401, "unauthorized", "log in first")
        principal = session.get("principal") or "user:operator"
        if session.get("kind") not in ("sso", "member_password") or principal == "user:operator" or role_of(session) is None:
            raise HiveError(403, "person_required", "a signed-in person cleans up a swarm's children")
        hive.visibility.check_path(viewer(session), {"swarm_id": swarm_id})
        return recorded(await hive.minds.team_control(principal, role_of(session) == "admin", swarm_id, child_id, await body(request)))

    @app.post("/api/connections")
    async def create_connection(request: Request):
        session = admin(request)
        return await hive.agreements.create(await body(request), session.get("principal") or "user:operator")

    @app.get("/api/connections")
    async def list_connections(request: Request, swarm_id: str | None = None):
        session = operator(request)
        return hive.visibility.filter_items(viewer(session), hive.agreements.list(swarm_id))

    @app.get("/api/connections/{cid}")
    async def get_connection(cid: str, request: Request):
        session = operator(request)
        view = hive.agreements.view(hive.agreements.get(cid))
        if not hive.visibility.filter_items(audit_viewer(session), [view]):    # by id: admin audit; same rule as the list
            raise HiveError(404, "not_found", "no such connection")
        return view

    @app.post("/api/connections/{cid}/{action}")
    async def connection_action(cid: str, action: str, request: Request):
        session = admin(request)
        who, data = session.get("principal") or "user:operator", await body(request)
        if action == "pause":
            return await hive.agreements.pause(cid, who)
        if action == "resume":
            return await hive.agreements.resume(cid, who)
        if action == "revoke":
            return await hive.agreements.revoke(cid, who, str(data.get("reason") or ""))
        if action == "renew":
            return await hive.agreements.renew(cid, who, data.get("days", 7))
        raise HiveError(404, "not_found", "connections can be paused, resumed, revoked or renewed")

    @app.get("/api/agent/connections")
    async def agent_connections(request: Request):
        agent = agent_from(request)
        return [c for c in hive.agreements.list(agent["swarm_id"])]

    @app.get("/api/agent/review-receipts")
    async def agent_review_receipts(request: Request, subject_digest: str):
        """For a reviewing swarm's coordinator: all receipts on one exact subject, with reviewer-of-review decisions."""
        return hive.collab.review_receipts(agent_from(request), subject_digest)

    @app.post("/api/agent/requests")
    async def agent_create_request(request: Request):
        return await hive.collab.create_request(agent_from(request), await body(request))

    @app.get("/api/agent/requests/{request_id}")
    async def agent_read_request(request_id: str, request: Request):
        return hive.collab.readable_request(agent_from(request), request_id)

    @app.get("/api/agent/requests/{request_id}/review-context")
    async def agent_plan_review_context(request_id: str, request: Request, artifact_id: str, revision: int):
        return hive.collab.planner_review_context(agent_from(request), request_id, artifact_id, revision)

    @app.post("/api/agent/requests/{request_id}/cancel")
    async def agent_cancel_request(request_id: str, request: Request):
        return await hive.collab.agent_cancel(agent_from(request), request_id)

    @app.get("/api/requests")
    async def list_requests(request: Request):
        session = operator(request)
        # fill the page with requests this person may see: a LIMIT before the filter shortened pages and pushed visible
        # requests off them (Surface P, as the share list fixed earlier)
        who, out, offset = viewer(session), [], 0
        while len(out) < 200 and offset < 5000:      # bounded: a viewer who sees almost nothing does not scan it all
            batch = hive.db.all("SELECT * FROM requests ORDER BY created_at DESC, id LIMIT 200 OFFSET ?", (offset,))
            out += hive.visibility.filter_items(who, [hive.collab.request_view(r) for r in batch])
            if len(batch) < 200:
                break
            offset += 200
        return out[:200]

    @app.post("/api/requests/{request_id}/proposals/{suggestion_id}/{decision}")
    async def copy_apply_consent(request_id: str, suggestion_id: str, decision: str, request: Request):
        """copy-apply consent r1: the request's own named person, after Accept + confirm (or Reject) on one exact proposal,
        records that decision; the controller's copy_apply capability is issued only against an accept (minds.py). The
        §G person gate (Origin, Bearer, named person; never the operator password), then a request this person may not
        see is the same 404 as one that does not exist, then only the request's person decides."""
        if decision not in ("accept", "decline"):
            raise HiveError(404, "not_found", "a proposal is accepted or declined")
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, G_SMALL_MAX)
        row = hive.db.one("SELECT from_swarm, to_swarm FROM requests WHERE id = ?", (request_id,))
        if row is None or not hive.visibility.filter_items(v, [{"from_swarm": row["from_swarm"], "to_swarm": row["to_swarm"]}]):
            raise HiveError(404, "not_found", f"no request {request_id}")
        return hive.minds.copy_apply_consent(v.principal, request_id, suggestion_id, data, decision)

    @app.get("/api/requests/{request_id}/controller")
    async def request_controller_state(request_id: str, request: Request):
        """Create - Code: the MeTTa coding controller's state for one request (phase, candidate, latest test, next action,
        journal), for a person who may see the request; a request this person may not see is the same 404."""
        session = operator(request)
        row = hive.db.one("SELECT from_swarm, to_swarm FROM requests WHERE id = ?", (request_id,))
        if row is None or not hive.visibility.filter_items(viewer(session), [{"from_swarm": row["from_swarm"],
                                                                              "to_swarm": row["to_swarm"]}]):
            raise HiveError(404, "not_found", f"no request {request_id}")
        state = hive.code_controller.view(request_id)
        if state is None:
            raise HiveError(404, "not_found", "this request is not run by the coding controller")
        return state

    async def _controller_person_action(request_id, request, act, optional=True):
        """Create · Code Apply / Ask for changes / Discard: the request's own person in their own session (the §G person
        gate: Origin, Bearer, a named person; never the operator password and never a mind); a request this person may
        not see is the same 404 as one that does not exist; only the request's person acts."""
        from .code_controller_engine import EngineError
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, 16 * 1024, optional=optional)
        row = hive.db.one("SELECT from_swarm, to_swarm FROM requests WHERE id = ?", (request_id,))
        if row is None or not hive.visibility.filter_items(v, [{"from_swarm": row["from_swarm"], "to_swarm": row["to_swarm"]}]):
            raise HiveError(404, "not_found", f"no request {request_id}")
        try:
            return await act(v.principal, data if isinstance(data, dict) else {})
        except EngineError as exc:
            raise HiveError(exc.status, exc.code, str(exc))

    # ---- Create plans (create_plan_engine.py, MeTTa plan controller R4.0) -------------------------------------------

    def _plan_engine():
        if not hive.create_plans.enabled():
            raise HiveError(404, "not_found", "Create plans are not switched on on this hive")
        return hive.create_plans

    async def _plan_person_action(request, act, optional=True):
        """The plan's own person in their own session (the §G person gate: Origin, Bearer, a named person; never the
        operator password and never a mind). Someone else's plan is the same 404 as no plan."""
        from .code_controller_engine import EngineError
        engine = _plan_engine()
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, 16 * 1024, optional=optional)
        try:
            return _plan_view_for(request, await act(engine, v.principal, data if isinstance(data, dict) else {}))
        except EngineError as exc:
            raise HiveError(exc.status, exc.code, str(exc))

    def _plan_view_for(request, view):
        """A plan view as this caller reads it: each mind the plan waits on carries may_act, exactly "control_refusal is
        None" for this caller, the test the start and wake routes refuse through, so the press the plan offers can't
        drift from its route. Anything that isn't a plan view passes as it is."""
        if isinstance(view, dict) and isinstance(view.get("waiting"), list):
            session = operator(request)
            for row in view["waiting"]:
                mind = hive.db.one("SELECT * FROM agents WHERE id = ? AND deleted = 0", (row.get("mind"),))
                row["may_act"] = control_refusal(session, mind) is None
        return view

    @app.post("/api/create/plans")
    async def create_plan_start(request: Request):
        return await _plan_person_action(request, lambda e, who, data: e.start(who, data.get("sentence")), optional=False)

    @app.get("/api/me/create-offers")
    async def my_create_offers(request: Request, mind: str | None = None):
        v = g_person(request, mutating=False, admin_only=False)
        return hive.create_offers.list_for(v.principal, mind)

    @app.post("/api/create/offers/{offer_id}/start")
    async def create_offer_start(offer_id: str, request: Request):
        # the person's press on a mind's offer: the same §G person gate as POST /api/create/plans, which it then is
        return await _plan_person_action(request, lambda e, who, data: hive.create_offers.start(e, who, offer_id))

    @app.post("/api/create/offers/{offer_id}/dismiss")
    async def create_offer_dismiss(offer_id: str, request: Request):
        v = g_person(request, mutating=True, admin_only=False)
        await g_body(request, 1024, optional=True)
        return hive.create_offers.dismiss(v.principal, offer_id)

    @app.get("/api/create/plans")
    async def create_plan_list(request: Request):
        v = g_person(request, mutating=False, admin_only=False)
        return _plan_engine().list_for(v.principal)

    @app.get("/api/create/plans/{plan_id}")
    async def create_plan_view(plan_id: str, request: Request):
        v = g_person(request, mutating=False, admin_only=False)
        engine = _plan_engine()
        run = engine._run(plan_id)
        if run is None or run["person"] != v.principal:
            raise HiveError(404, "not_found", f"no plan {plan_id}")
        return _plan_view_for(request, engine.view(plan_id))

    @app.get("/api/create/plans/{plan_id}/files")
    async def create_plan_files(plan_id: str, request: Request, path: str | None = None, ckpt: str | None = None):
        from .code_controller_engine import EngineError
        v = g_person(request, mutating=False, admin_only=False)
        try:
            return await _plan_engine().files(plan_id, v.principal, path, ckpt)
        except EngineError as exc:
            raise HiveError(exc.status, exc.code, str(exc))

    def _plan_preview(plan_id, request):
        v = g_person(request, mutating=False, admin_only=False)
        engine = _plan_engine()
        run = engine._run(plan_id)
        if run is None or run["person"] != v.principal:
            raise HiveError(404, "not_found", f"no plan {plan_id}")
        preview = engine.view(plan_id)["preview"]
        if not preview:
            raise HiveError(404, "not_found", "no preview yet")
        return engine, preview

    @app.get("/api/create/plans/{plan_id}/preview")
    async def create_plan_preview(plan_id: str, request: Request):
        """The current preview's pinned UI bundle, verified against its lock, for the canvas's opaque appFrame
        (appDocument): every file a piece built (index.html, style.css, app.js and assets such as icon.svg), each with
        its content type and sha256. Code only, no bridge, no data."""
        engine, preview = _plan_preview(plan_id, request)
        from .create_plan_ports import content_type
        try:
            files = engine.ports.apps.preview_files(preview["ref"])
        except (ValueError, OSError) as exc:
            raise HiveError(409, "preview_unverified", str(exc))
        return {"ref": preview["ref"], "ckpt": preview["ckpt"], "files": files,
                "types": {k: content_type(k) for k in files},
                "digests": {k: "sha256:" + hashlib.sha256(v.encode("utf-8")).hexdigest() for k, v in files.items()}}

    @app.get("/api/create/plans/{plan_id}/preview/file")
    async def create_plan_preview_file(plan_id: str, path: str, request: Request):
        """One file of the current preview's bundle, as its own content type, after its lock digest checks. Served
        sandboxed (CSP sandbox, nothing loads, nosniff): an SVG or HTML file opened directly runs no script."""
        engine, preview = _plan_preview(plan_id, request)
        try:
            got = engine.ports.apps.preview_file(preview["ref"], path)
        except (ValueError, OSError) as exc:
            raise HiveError(409, "preview_unverified", str(exc))
        if got is None:
            raise HiveError(404, "not_found", "the preview has no such file")
        raw, ctype, digest = got
        return Response(raw, media_type=ctype, headers={
            "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "ETag": f'"{digest}"',
            "Cross-Origin-Resource-Policy": "same-origin"})

    @app.post("/api/create/plans/{plan_id}/answers")
    async def create_plan_answer(plan_id: str, request: Request):
        return await _plan_person_action(request, lambda e, who, data: e.answer(plan_id, who, data.get("q"),
                                                                                 data.get("text")), optional=False)

    @app.post("/api/create/plans/{plan_id}/deploy")
    async def create_plan_deploy(plan_id: str, request: Request):
        return await _plan_person_action(request, lambda e, who, data: e.deploy(plan_id, who))

    @app.post("/api/create/plans/{plan_id}/stop")
    async def create_plan_stop(plan_id: str, request: Request):
        return await _plan_person_action(request, lambda e, who, data: e.stop(plan_id, who))

    @app.post("/api/create/plans/{plan_id}/revise")
    async def create_plan_revise(plan_id: str, request: Request):
        # a change to an app the plan made: a new round from the app as it runs now (create_plan_engine, rounds)
        return await _plan_person_action(request, lambda e, who, data: e.revise(who, plan_id, data.get("words")), optional=False)

    @app.post("/api/create/plans/{plan_id}/revert")
    async def create_plan_revert(plan_id: str, request: Request):
        # the app put back to one of its revisions (undo: the one the current revision was built from)
        return await _plan_person_action(request, lambda e, who, data: e.revert(who, plan_id, data.get("round")), optional=False)

    @app.get("/api/me/code-controller")
    async def my_code_controller_prefs(request: Request):
        """The signed-in person's own Code controller setting: review_policy (review-required, the default, or
        review-waivable: a tested proposal may go on unreviewed when no second opinion can run, and the UI says so)."""
        v = g_person(request, mutating=False, admin_only=False)
        return {"review_policy": hive.code_controller.review_policy(v.principal), "applies_to": "new Code requests"}

    @app.put("/api/me/code-controller")
    async def my_code_controller_prefs_put(request: Request):
        from .code_controller_engine import EngineError
        v = g_person(request, mutating=True, admin_only=False)
        data = await g_body(request, G_SMALL_MAX)
        try:
            return hive.code_controller.set_review_policy(v.principal, data.get("review_policy"))
        except EngineError as exc:
            raise HiveError(exc.status, exc.code, str(exc))

    @app.post("/api/requests/{request_id}/controller/apply")
    async def request_controller_apply(request_id: str, request: Request):
        return await _controller_person_action(request_id, request,
                                               lambda who, data: hive.code_controller.apply(request_id, who))

    @app.post("/api/requests/{request_id}/controller/changes")
    async def request_controller_changes(request_id: str, request: Request):
        return await _controller_person_action(request_id, request, lambda who, data: hive.code_controller.request_changes(
            request_id, who, data.get("text")), optional=False)

    @app.post("/api/requests/{request_id}/controller/discard")
    async def request_controller_discard(request_id: str, request: Request):
        return await _controller_person_action(request_id, request,
                                               lambda who, data: hive.code_controller.discard(request_id, who))

    @app.post("/api/requests/{request_id}/cancel")
    async def operator_cancel_request(request_id: str, request: Request):
        """Only the person who issued the request, or an admin (who sees every swarm), cancels it; cancelling also pauses
        its children (mind control). Anyone else: not found if they cannot see the request, else forbidden."""
        session = operator(request)
        who, principal = viewer(session), session.get("principal") or "user:operator"
        row = hive.collab.get_request(request_id)
        if not who.admin and row["from_principal"] != principal:
            if not hive.visibility.filter_items(who, [{"from_swarm": row["from_swarm"], "to_swarm": row["to_swarm"]}]):
                raise HiveError(404, "not_found", f"no request {request_id}")
            raise HiveError(403, "forbidden", "only the person who issued this request, or an admin, cancels it")
        return await hive.collab.cancel_request(request_id, principal)

    @app.post("/api/agent/artifacts")
    async def agent_create_artifact(request: Request):
        agent, data = agent_from(request), await body(request)
        hive.policy.enforce(agent, "hive-artifact-create", artifact_command("hive-artifact-create", None, data))
        return hive.collab.create_artifact(agent, data)

    @app.post("/api/agent/artifacts/{artifact_id}/revisions")
    async def agent_add_revision(artifact_id: str, request: Request):
        agent, data = agent_from(request), await body(request)
        hive.policy.enforce(agent, "hive-revision", artifact_command("hive-revision", artifact_id, data))
        artifact = hive.collab.add_revision(agent, artifact_id, data)
        studio = hive.db.one("SELECT id FROM studio_sessions WHERE proposal_artifact_id = ?", (artifact_id,))
        if studio:
            await hive.studio.advance(studio["id"])
        return artifact

    @app.get("/api/agent/artifacts/{artifact_id}/revisions/{n}")
    async def agent_read_revision(artifact_id: str, n: int, request: Request):
        return hive.collab.read_revision(agent_from(request), artifact_id, n)

    @app.get("/api/agent/artifacts/{artifact_id}/findings")
    async def agent_findings(artifact_id: str, request: Request):
        return hive.collab.findings(agent_from(request), artifact_id)

    @app.post("/api/agent/requests/{request_id}/review-complete")
    async def agent_review_complete(request_id: str, request: Request):
        return await hive.collab.complete_review(agent_from(request), request_id, await body(request))

    @app.post("/api/agent/findings")
    async def agent_raise_finding(request: Request):
        return await hive.collab.raise_finding(agent_from(request), await body(request))

    @app.post("/api/agent/findings/{finding_id}/response")
    async def agent_finding_response(finding_id: str, request: Request):
        return hive.collab.respond(agent_from(request), finding_id, await body(request))

    @app.post("/api/agent/findings/{finding_id}/disposition")
    async def agent_finding_disposition(finding_id: str, request: Request):
        return hive.collab.dispose(agent_from(request), finding_id, await body(request))

    @app.post("/api/agent/programs/{program_id}/act")
    async def agent_program_act(program_id: str, request: Request):
        agent = agent_from(request)
        return await hive.program_actions.agent_act(agent, program_id, await body(request))

    @app.get("/api/program-activity")
    async def program_activity(request: Request, swarm_id: str | None = None, program: str | None = None, limit: int = 100):
        session = operator(request)
        return hive.visibility.filter_items(viewer(session), hive.program_actions.activity(swarm_id, program, limit))

    from .boards import install_routes
    install_routes(app, hive, admin, agent_from, viewer)
    from .motivations import install_routes as install_motivations
    install_motivations(app, hive, operator, agent_from, viewer, body)
    from .repomap import install_routes as install_repo_maps
    install_repo_maps(app, hive, operator, admin, viewer)
    from .repomap_seed import install_routes as install_repo_map_seed
    install_repo_map_seed(app, hive, admin)
    session_launch.install_routes(app, hive, admin)   # R2.8: owner launch tickets, bridges, disconnect
    from .folders import install_routes as install_folders
    install_folders(app, hive, operator, admin, agent_from, viewer)   # linked local folders (local hives only)
    from .mind_files import install_routes as install_mind_files
    install_mind_files(app, hive, agent_from, role_of)   # GET /api/agent/assets and file notices to a swarm's minds
    from .task_stops import install_routes as install_task_stops
    install_task_stops(app, hive, operator, viewer)

    # Host-owned factory installs the confidential boundary before UI catch-all routes.
    # No factory means no private monitoring or report channel is enabled.
    if confidential_factory is not None:
        confidential_factory(app, hive, admin)

    # ---- the web UI ---------------------------------------------------------------------------------

    # Gateway r1d (plan §2.5, r1.1 §B, §L): with HIVE_MIND_GATEWAY=1 the browser mind's frame is served only at its
    # canonical path with its sandbox header; any other spelling of it, or any other .html under mind-iter/, is 404. The
    # decision is on the resolved file identity, and every other file it serves (the page fallback included) is checked
    # at request time for a copy of the frame (r1d.2). hive.mind_frame.available() is the browser_mind capability (§2.4).
    mind_frame = None
    if settings.mind_gateway:
        from .mind_frame import MindFrame
        mind_frame = MindFrame(UI_DIST)
    hive.mind_frame = mind_frame

    # r1c: an unknown path is answered without the path's mind token (a token in a URL is refused, never echoed back
    # in a body a client, proxy or error reporter may keep); scrub_logged is the access log's own redactor.
    from .mind_gateway import scrub_logged

    if UI_DIST.exists():
        index_html = UI_DIST / "index.html"
        if index_html.is_file() and PAGE_NONCE_SLOT not in index_html.read_text("utf-8"):
            logging.getLogger("hive").warning("hive/ui/dist was built without the page nonce slot, so the page's CSP "
                                              "allows inline script and style; build hive/ui again to remove that")

        def page():
            """The app document, however it is asked for: this answer's own nonce in the build's slot, the CSP naming it,
            and never stored (a stored copy would keep an old nonce)."""
            html = index_html.read_text("utf-8")
            nonce = None
            if PAGE_NONCE_SLOT in html:
                nonce = str(uuid.UUID(bytes=secrets.token_bytes(16)))   # 128 random bits, shaped as the frames expect
                html = html.replace(PAGE_NONCE_SLOT, nonce)
            return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache, no-store, must-revalidate",
                                                                   "Content-Security-Policy": page_csp(nonce)})

        # the page and its files, outside the API schema like the page's other routes, so the logs a person exports
        # keep a file that loaded out of the hive's requests (feedback.py RecentRequests)
        @app.get("/{path:path}", include_in_schema=False)
        async def ui(path: str, request: Request):
            if path.split("/", 1)[0] in ("api", "llm", "agent-hub"):
                raise HiveError(404, "not_found", "no route /" + scrub_logged(path))
            target = (UI_DIST / path).resolve()
            if mind_frame is not None and path and target.is_file() and UI_DIST.resolve() in target.parents:
                verdict = mind_frame.decide(request.scope, target)
                if verdict == "deny":
                    raise HiveError(404, "not_found", "no file /" + scrub_logged(path))
                if verdict == "frame":
                    return FileResponse(target, media_type="text/html", headers=mind_frame.headers())
            if path and target.is_file() and UI_DIST.resolve() in target.parents:
                if target == index_html.resolve():
                    return page()   # r1de.4: the page, however asked for, carries its CSP (frame-ancestors 'none' in it)
                # hashed build files never change: cache them for good; anything else revalidates
                immutable = path.startswith("assets/")
                headers = {"Cache-Control": "public, max-age=31536000, immutable" if immutable else "no-cache"}
                if views_mod.VIEW_WORKER_SCRIPT.fullmatch(path):
                    headers["Content-Security-Policy"] = views_mod.VIEW_WORKER_CSP
                return FileResponse(target, headers=headers)
            if path.startswith("assets/") or "." in path.rsplit("/", 1)[-1]:
                # a missing file is a 404, never the page: an old cached page must not run HTML as a script
                raise HiveError(404, "not_found", "no file /" + scrub_logged(path))
            if mind_frame is not None and mind_frame.decide(request.scope, index_html.resolve()) != "pass":
                raise HiveError(404, "not_found", "no file /" + scrub_logged(path))   # r1d.2: the page itself is never a frame copy
            # r1de.3: a stray copy turns the mind off, not the UI; nothing may frame the page (page_csp's frame-ancestors)
            return page()

        @app.api_route("/{path:path}", methods=["POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
        async def ui_other_methods(path: str, request: Request):
            """The UI is GET only, but its catch-all made every other method on an unserved path a 405 (MesTTo: an absent
            POST /llm/v1/media answered 405 only when a UI build was present). The answer is now what it is without
            a build: a path some route serves with other methods keeps its 405, an unknown API path is 404, and any
            other page path is 405 (GET only)."""
            from starlette.routing import Match
            served = any(route.matches(request.scope)[0] == Match.PARTIAL for route in request.app.router.routes
                         if getattr(route, "endpoint", None) not in (ui, ui_other_methods))
            if not served and path.split("/", 1)[0] in ("api", "llm", "agent-hub"):
                raise HiveError(404, "not_found", "no route /" + scrub_logged(path))
            raise HTTPException(405, "Method Not Allowed")

    if settings.base_path:
        outer = FastAPI(title="OmegaHive", version="0.1.0", lifespan=lifespan, openapi_url=None,
                        docs_url=None, redoc_url=None)
        outer.state.hive, outer.state.gateway = hive, gateway
        outer.state.member_attempts = member_attempts
        outer.state.reconcile_once, outer.state.offer_refresh = reconcile_once, offer_refresh
        for prefix in settings.base_path.split(","):
            outer.mount(prefix, app)
        outer.mount("/", app)
        outer.add_middleware(PublicGate, sso=sso)
        return outer

    app.add_middleware(PublicGate, sso=sso)
    if hive.newhive is not None:   # new-hive R1a (r1.2.1 §A): Code routes hold until the installed map is ready
        app.add_middleware(newhive_mod.CodingRoutesBarrier, newhive=hive.newhive)
    if local is not None:   # J1 r2 B1: the Host allowlist is the first thing every request meets
        app.add_middleware(localowner.LocalBoundary, local=local)
    return app
