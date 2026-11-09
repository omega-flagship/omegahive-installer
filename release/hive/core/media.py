"""P1: one host-metered media route, ``POST /llm/v1/media`` (off unless HIVE_MEDIA_ROUTE=on).

A mind asks for one image with its own hive token. Everything that decides cost or authority is the host's:

- the gate is the existing policy under the existing skill names (``generate-image``, ``generate-image-quality``), so
  today's per-mind deny rules stay the on/off switch;
- the model, upstream endpoint, controls, pixel geometry and every price line come from a host-pinned endpoint record
  in the providers file (``Provider.media``), never from the request;
- the payer, key and caps are the chat route's: ``Gateway.paying_key``, ``Hive.payer_for``, ``Hive.check_budget`` and
  ``Reservations.reserve`` over ``host_budget_snapshot``;
- the bytes land in the native asset store, owned by the task's swarm.

Billing and the asset are separate outcomes. The vendor is called only when the reservation is new; the reservation id
is derived from the mind's own (agent, op, operation_id), never from a ProgramActions key. Anything ambiguous after
dispatch holds the worst case as an unknown liability for a person to resolve. Nothing retries.

media r2 (PLATFORM_MEDIA_PIN_R1 stand-in FIX-FIRST, four P1s):

- scope: a mind reaches an op only when the host allowlist names it (``HIVE_MEDIA_ALLOW``, per op; empty = nobody), on
  top of the skill policy, so switching the route on does not open image skills to every funded mind;
- the output is fully validated (in a worker thread) before anything is recorded as an accepted asset. A vendor charge
  for an output the host refuses is still recorded honestly, as ``billed_refused`` with its reason and no asset, and
  told to the mind's people and admins (event ``media.billed_refused``, the mind's last error, ``GET /api/media/results``);
- a per-mind circuit breaker: after ``HIVE_MEDIA_BREAKER_REFUSALS`` (default 2) billed_refused results in a row, or any
  actual charge above the reservation, the route refuses that mind until an admin resets it;
- the reservation is the pinned schedule's worst case, NOT a ceiling on what the vendor charges. The actual cost is
  reconciled from the response's ``usage.cost``; above the hold it is recorded in full, flagged (``budget.overrun``) and
  trips the breaker. The host cannot stop a vendor from overcharging one call; it can only refuse to repeat it;
- the pinned geometry sends every geometry control the endpoint documents (or an exact ``size``), so the vendor is never
  left to pick a size, and JPEG scans are walked to their last block (``jpeg_complete``), since Pillow fills a cut scan.

Image inspection (vision) stays closed: no selected model has a documented bound for every billed unit yet.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import math
import re
import struct
import time
from decimal import Decimal

from . import jpeg_complete
from .cost_reservations import host_use_check
from .db import now

PROVIDER = "openrouter"
OPS = {"image.generate": "generate-image", "image.generate-quality": "generate-image-quality"}
CLOSED_OPS = {"image.inspect": "inspect-image", "image.observe": "observe-image", "video.generate": "generate-video"}
BODY_LIMIT = 64 * 1024
MAX_PROMPT_BYTES = 4096
OPERATION_ID = re.compile(r"[A-Za-z0-9._:-]{8,120}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
BILLABLE = {"output_image", "input_image", "input_reference", "input_text", "input_font"}
UNITS = {"request", "image", "megapixel", "token"}
GEOMETRY_CONTROLS = {"size", "resolution", "aspect_ratio"}
MIME_OK = {"image/png", "image/jpeg", "image/webp"}
DEFAULTS = {"max_references": 0, "max_reference_bytes": 10 * 1024 * 1024, "max_response_bytes": 20 * 1024 * 1024,
            "max_output_bytes": 15 * 1024 * 1024, "timeout_seconds": 180,
            "max_reference_width": 4096, "max_reference_height": 4096, "max_reference_pixels": 16_777_216}
UNKNOWN = "UNKNOWN"


class MediaError(Exception):
    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status, self.code, self.message, self.details = status, code, message, details


# ---- the pinned endpoint record ----------------------------------------------------------------------------------

def _finite_cost(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    amount = Decimal(str(value))
    return amount if amount.is_finite() and amount >= 0 else None


def _bounds(spec):
    """(min, max) of a range spec, only when the record states both as finite numbers; never invented."""
    lo, hi = spec.get("min"), spec.get("max")
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (lo, hi)) or lo > hi:
        return None
    return lo, hi


def _malformed(spec):
    """Why a supported_parameters entry is malformed, or None. Ranges need explicit finite numeric min <= max; enums a
    non-empty list of scalars; a boolean is exactly {"type": "boolean"} (a default, if any, a bool). Anything else fails."""
    if not isinstance(spec, dict):
        return "not a record"
    kind = spec.get("type")
    if kind == "range":
        return None if _bounds(spec) is not None else "a range needs explicit finite numeric min <= max"
    if kind == "enum":
        values = spec.get("values")
        ok = (isinstance(values, list) and values
              and all(v is None or isinstance(v, (str, int, float, bool)) for v in values)
              and all(math.isfinite(v) for v in values if isinstance(v, float)))
        return None if ok else "an enum needs a non-empty list of scalar values"
    if kind == "boolean":
        extra = set(spec) - {"type", "default"}
        ok = not extra and isinstance(spec.get("default", False), bool)
        return None if ok else "a boolean takes no values or bounds"
    return f"unknown parameter type {kind!r}"


def _allowed(supported, name, value):
    """Is ``name=value`` a control this endpoint documents? enum: value listed; range: within; boolean: a bool."""
    spec = supported.get(name)
    if not isinstance(spec, dict):
        return False
    kind = spec.get("type")
    if kind == "enum":
        return isinstance(spec.get("values"), list) and value in spec["values"]
    if kind == "range":
        bounds = _bounds(spec)
        return (bounds is not None and isinstance(value, (int, float)) and not isinstance(value, bool)
                and bounds[0] <= value <= bounds[1])
    if kind == "boolean":
        return isinstance(value, bool)
    return False


def pin(settings, op):
    """The validated pinned record for ``op``, or MediaError. Validation is structural; prices are checked per call."""
    provider = settings.providers.get(PROVIDER)
    raw = (getattr(provider, "media", None) or {}).get(op) if provider else None
    if not isinstance(raw, dict):
        raise MediaError(404, "op_unavailable", f"{op} has no host-pinned media endpoint on this hive")
    bad = lambda why: MediaError(503, "media_pin_invalid", f"the pinned {op} endpoint record is unusable: {why}")
    model, endpoint = raw.get("model"), raw.get("endpoint")
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+", model):
        raise bad("model")
    if not isinstance(endpoint, dict) or not isinstance(endpoint.get("provider_slug"), str) or not endpoint["provider_slug"]:
        raise bad("endpoint.provider_slug")
    supported = endpoint.get("supported_parameters")
    if not isinstance(supported, dict):
        raise bad("endpoint.supported_parameters")
    for name, spec in supported.items():          # every documented parameter, used or not, must be well formed
        why = _malformed(spec)
        if why:
            raise bad(f"supported_parameters.{name}: {why}")
    if not isinstance(endpoint.get("pricing"), list) or not endpoint["pricing"]:
        raise bad("endpoint.pricing")
    geometry = raw.get("geometry")
    if not isinstance(geometry, dict) or not geometry:
        raise bad("geometry")
    for name, g in geometry.items():
        if not (isinstance(g, dict) and all(type(g.get(k)) is int and 0 < g[k] <= 8192 for k in ("width", "height"))):
            raise bad(f"geometry {name}: exact width and height")
        controls = g.get("controls")
        if not isinstance(controls, dict) or not controls or set(controls) - GEOMETRY_CONTROLS:
            raise bad(f"geometry {name}: controls are size/resolution/aspect_ratio")
        for control, value in controls.items():
            if not _allowed(supported, control, value):
                raise bad(f"geometry {name}: {control}={value!r} is not a supported control of this endpoint")
        why = _geometry_unbound(supported, g, controls)
        if why:
            raise bad(f"geometry {name}: {why}")
    quality = raw.get("quality", [])
    if not isinstance(quality, list) or any(not _allowed(supported, "quality", q) for q in quality):
        raise bad("quality values must be supported by this endpoint")
    out = {**DEFAULTS, **{k: raw[k] for k in DEFAULTS if k in raw}}
    for k in DEFAULTS:
        if type(out[k]) is not int or out[k] < 0:
            raise bad(k)
    if out["max_references"] and "input_references" not in supported:
        raise bad("references need an endpoint that documents input_references")
    refs_spec = supported.get("input_references")
    if out["max_references"] and isinstance(refs_spec, dict) and refs_spec.get("type") == "range" and _bounds(refs_spec) is None:
        raise bad("input_references range needs explicit numeric min and max")
    if not _documents_one_output(supported):
        raise bad("the endpoint must document n and allow n=1 (one buffered output)")
    if not decoder_available():
        raise MediaError(503, "media_decoder_unavailable", "no image decoder: outputs and references cannot be verified, "
                         "so nothing is spent")
    out["timeout_seconds"] = min(out["timeout_seconds"], 600)
    out.update(op=op, skill=OPS[op], model=model, endpoint=endpoint, supported=supported, geometry=geometry, quality=quality,
               digest=hashlib.sha256(json.dumps(raw, sort_keys=True, separators=(",", ":")).encode()).hexdigest())
    return out


def _geometry_unbound(supported, g, controls):
    """r2 admission guard: why these pinned controls leave the output size to the vendor, or None.

    An exact ``size`` must name the pinned pixels ("WxH"). Without one, every other geometry control the endpoint
    documents (resolution, aspect_ratio) must be pinned and sent, so no vendor default picks a dimension. No control may
    be "auto", and an aspect ratio must be the pinned width:height. This makes a mismatch less likely; it cannot prove
    the vendor's pixels (the first canary does), and a mismatch is still refused at output."""
    if any(isinstance(v, str) and v.strip().lower() == "auto" for v in controls.values()):
        return "no control may be auto: the vendor would choose"
    if "size" in controls:
        if controls["size"] != f"{g['width']}x{g['height']}":
            return f"size {controls['size']!r} is not the pinned {g['width']}x{g['height']}"
        return None
    missing = sorted((GEOMETRY_CONTROLS - {"size"}) & set(supported) - set(controls))
    if missing:
        return f"{', '.join(missing)} documented by the endpoint but not pinned: the vendor would choose"
    ratio = controls.get("aspect_ratio")
    if ratio is not None:
        parts = str(ratio).split(":")
        try:
            a, b = (float(x) for x in parts) if len(parts) == 2 else (None, None)
        except ValueError:
            a = b = None
        if not a or not b or abs(a * g["height"] - b * g["width"]) > 0.01 * max(a * g["height"], b * g["width"]):
            return f"aspect_ratio {ratio!r} is not the pinned {g['width']}:{g['height']}"
    return None


def worst_case(p, geometry, prompt_bytes, references):
    """(usd, lines): the most this exact request can cost under the pinned schedule.

    EVERY pricing line is summed, whatever its variant: the endpoint record names a variant by a free label, with no
    machine-checkable condition tied to the control value actually dispatched, so no label (and no operator-supplied
    geometry variant) may exclude a line. Alternatives over-reserve, never under. An unknown billable or unit, a price
    that is missing, negative or non-finite, or a unit with no host-provable count (image tokens) is refused before
    dispatch. A documented zero price is a known price; the total must still be positive."""
    g = p["geometry"][geometry]
    total, used = Decimal(0), []
    for line in p["endpoint"]["pricing"]:
        if not isinstance(line, dict):
            raise MediaError(422, "media_unpriced", "a pricing line is not a record")
        billable, unit, variant = line.get("billable"), line.get("unit"), line.get("variant")
        if billable not in BILLABLE or unit not in UNITS:
            raise MediaError(422, "media_unpriced", f"unknown billable unit {billable!r}/{unit!r}: refused before dispatch")
        cost = _finite_cost(line.get("cost_usd"))
        if cost is None:
            raise MediaError(422, "media_unpriced", f"{billable}/{unit} has no finite non-negative price")
        if unit == "token" and billable != "input_text":
            # checked before any billable-specific count: only text tokens have a host-provable bound
            raise MediaError(422, "media_unpriced", f"{billable} priced per token has no documented finite ceiling")
        if unit == "request":
            count = 1
        elif billable == "input_font":
            count = 0                                   # this route never sends fonts
        elif billable == "input_text":
            if unit != "token":
                raise MediaError(422, "media_unpriced", f"input_text priced per {unit} has no host-provable count")
            count = prompt_bytes + 1                    # a token always covers at least one UTF-8 byte (chat's bound)
        elif unit == "token":
            raise MediaError(422, "media_unpriced", f"{billable} priced per token has no documented finite ceiling")
        elif billable == "output_image":
            count = 1 if unit == "image" else math.ceil(g["width"] * g["height"] / 1_000_000)
        else:                                           # input_image / input_reference: each reference sent
            count = (len(references) if unit == "image"
                     else sum(math.ceil(w * h / 1_000_000) for _m, w, h in references))
        total += cost * count
        used.append({"billable": billable, "unit": unit, "variant": variant, "cost_usd": float(cost), "count": count})
    if not total.is_finite() or total <= 0:
        raise MediaError(422, "media_unpriced", "the pinned schedule gives no positive finite worst case for this request")
    return float(total), used


def _documents_one_output(supported):
    """Does the record document ``n`` with 1 allowed? (enum listing 1, or a range covering 1)."""
    spec = supported.get("n")
    if not isinstance(spec, dict):
        return False
    if spec.get("type") == "enum":
        return isinstance(spec.get("values"), list) and any(v == 1 or v == "1" for v in spec["values"] if not isinstance(v, bool))
    if spec.get("type") == "range":
        bounds = _bounds(spec)
        return bounds is not None and bounds[0] <= 1 <= bounds[1]
    return False


# ---- image bytes -----------------------------------------------------------------------------------------------

FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}


class Undecodable(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


def _pillow():
    from PIL import Image, ImageFile   # Pillow; declared in hive/requirements.txt
    return Image, ImageFile


def decoder_available():
    try:
        _pillow()
    except Exception:
        return False
    return True


def container_complete(mime, data):
    """Is the file whole? PNG: every chunk present with a valid CRC, IEND last with nothing after it. JPEG: ends with EOI.
    WebP: the RIFF size equals the file length and every chunk is fully present."""
    import zlib
    if mime == "image/png":
        pos, first = 8, True
        while True:
            if pos + 12 > len(data):
                return False
            length = struct.unpack(">I", data[pos:pos + 4])[0]
            kind = data[pos + 4:pos + 8]
            end = pos + 12 + length
            if length > 0x7FFFFFFF or end > len(data) or (first and kind != b"IHDR"):
                return False
            if zlib.crc32(data[pos + 4:pos + 8 + length]) != struct.unpack(">I", data[end - 4:end])[0]:
                return False
            first, pos = False, end
            if kind == b"IEND":
                return length == 0 and pos == len(data)
    if mime == "image/jpeg":
        return len(data) >= 4 and data[:2] == b"\xff\xd8" and data[-2:] == b"\xff\xd9"
    if mime == "image/webp":
        if len(data) < 20 or struct.unpack("<I", data[4:8])[0] + 8 != len(data):
            return False
        pos = 12
        while pos < len(data):
            if pos + 8 > len(data):
                return False
            size = struct.unpack("<I", data[pos + 4:pos + 8])[0]
            pos += 8 + size + (size & 1)
        return pos == len(data)
    return False


def decode_image(data, max_width, max_height, max_pixels):
    """(mime, width, height) after a bounded FULL decode, or Undecodable(reason). Never headers alone.

    The header's dimensions are capped before any pixel is decoded (the decompression-bomb bound is the pinned pixel
    cap, enforced here rather than via Pillow's process-wide MAX_IMAGE_PIXELS); then Pillow must agree on the format and
    size, decode every pixel of a single frame, and report the same dimensions."""
    header = image_info(data)
    if not header or header[0] not in MIME_OK:
        raise Undecodable("not_image")
    mime, w, h = header
    if w <= 0 or h <= 0 or w > max_width or h > max_height or w * h > max_pixels:
        raise Undecodable("dimensions")
    try:
        Image, ImageFile = _pillow()
    except Exception:
        raise Undecodable("decoder_unavailable") from None
    if ImageFile.LOAD_TRUNCATED_IMAGES:
        raise Undecodable("decoder_unsafe")          # a process-wide setting would accept truncated data
    if not container_complete(mime, data):
        raise Undecodable("incomplete")              # Pillow can load() a PNG with its tail cut; the container must be whole
    if mime == "image/jpeg":
        # r2 P1-4: Pillow (libjpeg) fills a scan cut short before EOI and reports success; every block of every scan
        # must be present in the bytes (Design reproduction 2026-10-17, Kimi media-p1-r7)
        try:
            jpeg_complete.check(data, max_width, max_height)   # r2.1: state and work bounded by the admitted geometry
        except jpeg_complete.Incomplete:
            raise Undecodable("incomplete") from None
        except Exception:
            raise Undecodable("corrupt") from None
    import io
    import warnings
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as im:
                if FORMATS.get(im.format) != mime or im.size != (w, h) or im.width * im.height > max_pixels:
                    raise Undecodable("dimensions_mismatch")
                if getattr(im, "n_frames", 1) != 1:
                    raise Undecodable("animated")
                im.load()
                if im.size != (w, h):
                    raise Undecodable("dimensions_mismatch")
    except Undecodable:
        raise
    except Exception:
        raise Undecodable("corrupt") from None
    return mime, w, h


def image_info(data):
    """(mime, width, height) from the file's own signature and header, or None. Pixels are not decoded."""
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24 and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return "image/png", w, h
    if data[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                i += 2
                continue
            length = struct.unpack(">H", data[i + 2:i + 4])[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return "image/jpeg", w, h
            i += 2 + length
        return None
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP" and len(data) >= 30:
        chunk = data[12:16]
        if chunk == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
            w, h = struct.unpack("<HH", data[26:30])
            return "image/webp", w & 0x3FFF, h & 0x3FFF
        if chunk == b"VP8L" and data[20] == 0x2F:
            b = data[21:25]
            return "image/webp", 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
        if chunk == b"VP8X":
            return ("image/webp", 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little"))
    return None


# ---- result custody --------------------------------------------------------------------------------------------

def _schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS media_results (reservation TEXT PRIMARY KEY, agent_id TEXT NOT NULL, op TEXT NOT NULL, "
               "operation_id TEXT NOT NULL, model TEXT NOT NULL, endpoint TEXT NOT NULL, created_at TEXT NOT NULL, "
               "vendor_status INTEGER, billing TEXT NOT NULL, billing_origin TEXT, asset_sha256 TEXT, mime TEXT, width INTEGER, "
               "height INTEGER, bytes INTEGER, owner_swarm TEXT, refusal TEXT, finished_at TEXT)")
    db.execute("CREATE TABLE IF NOT EXISTS media_breakers (agent_id TEXT PRIMARY KEY, consecutive INTEGER NOT NULL DEFAULT 0, "
               "tripped_at TEXT, reason TEXT, reservation TEXT, reset_at TEXT, reset_by TEXT, reset_reason TEXT)")


# ---- r2: who may use an op, and the per-mind circuit breaker ----------------------------------------------------

def allowed(settings, op, agent):
    """Is this mind named for ``op`` in the host allowlist (HIVE_MEDIA_ALLOW)? By mind (agent:a_…) or by its swarm
    (swarm:s_…, an app's team). No entry, an empty list or a malformed entry admits nobody; there is no wildcard."""
    names = set((getattr(settings, "media_allow", None) or {}).get(op) or [])
    return f"agent:{agent['id']}" in names or bool(agent.get("swarm_id") and f"swarm:{agent['swarm_id']}" in names)


def breaker(db, agent_id):
    """This mind's breaker row ({consecutive, tripped_at, reason, ...}) or None."""
    _schema(db)
    row = db.one("SELECT * FROM media_breakers WHERE agent_id = ?", (agent_id,))
    return dict(row) if row else None


def trip(db, agent_id, reason, reservation=None):
    """Open this mind's breaker (idempotent: the first reason is kept until an admin resets it). True if newly open."""
    _schema(db)
    with db.transaction():
        row = db.one("SELECT tripped_at FROM media_breakers WHERE agent_id = ?", (agent_id,))
        if row and row["tripped_at"]:
            return False
        db.execute("INSERT INTO media_breakers(agent_id, consecutive, tripped_at, reason, reservation) VALUES (?,0,?,?,?) "
                   "ON CONFLICT(agent_id) DO UPDATE SET tripped_at = excluded.tripped_at, reason = excluded.reason, "
                   "reservation = excluded.reservation", (agent_id, now(), str(reason)[:300], reservation))
    return True


def count_refusal(db, agent_id, reservation, limit):
    """One more billed_refused in a row; trips at ``limit``. Returns True if this refusal opened the breaker."""
    _schema(db)
    with db.transaction():
        db.execute("INSERT INTO media_breakers(agent_id, consecutive) VALUES (?, 1) "
                   "ON CONFLICT(agent_id) DO UPDATE SET consecutive = consecutive + 1", (agent_id,))
        row = db.one("SELECT consecutive FROM media_breakers WHERE agent_id = ?", (agent_id,))
        if row["consecutive"] >= max(1, int(limit)):
            return trip(db, agent_id, f"{row['consecutive']} billed_refused results in a row", reservation)
    return False


def count_accepted(db, agent_id):
    """An accepted image ends a run of refusals (an open breaker stays open until an admin resets it)."""
    _schema(db)
    db.execute("UPDATE media_breakers SET consecutive = 0 WHERE agent_id = ? AND tripped_at IS NULL", (agent_id,))


def reset(db, agent_id, by, reason):
    """An admin closes a mind's breaker, with a reason; recorded on the row."""
    reason = str(reason or "").strip()
    if not reason:
        raise ValueError("a reason is required")
    _schema(db)
    with db.transaction():
        row = db.one("SELECT tripped_at FROM media_breakers WHERE agent_id = ?", (agent_id,))
        if not row or not row["tripped_at"]:
            raise ValueError("this mind's media breaker is not open")
        db.execute("UPDATE media_breakers SET consecutive = 0, tripped_at = NULL, reset_at = ?, reset_by = ?, reset_reason = ? "
                   "WHERE agent_id = ?", (now(), str(by), reason[:500], agent_id))
    return breaker(db, agent_id)


def overrun_trips(db, info):
    """budget.overrun hook (app.overrun_flag): an actual media charge above its hold opens the mind's breaker."""
    rid, agent = str(info.get("reservation") or ""), info.get("agent")
    if rid.startswith("media:") and agent and (info.get("actual_usd") or 0) > (info.get("held_usd") or 0):
        return trip(db, agent, f"vendor charged ${info['actual_usd']:.4f} against ${info['held_usd']:.4f} held", rid)
    return False


class MediaRoute:
    def __init__(self, hive, gateway, reservations, snapshot, hold_unknown, overrun_flag):
        self.hive, self.gateway, self.reservations = hive, gateway, reservations
        self.snapshot, self.hold_unknown, self.overrun_flag = snapshot, hold_unknown, overrun_flag
        _schema(hive.db)

    @staticmethod
    def key(agent_id, op, operation_id):
        """The billing identity: the mind's own operation, never a ProgramActions record key."""
        return "media:" + hashlib.sha256(f"{agent_id}\x1f{op}\x1f{operation_id}".encode()).hexdigest()

    @staticmethod
    def derive(agent_id, task, op, prompt, size, quality, references):
        """The operation id when the mind gives none: a pure function of (agent, task, op, normalized request), so a
        retry of the same request for the same task, before or after a restart, finds the same reservation and never
        pays twice. A deliberate new attempt passes a new explicit operation_id."""
        refs = [{k: r.get(k) for k in ("sha256", "artifact_id", "revision")} if isinstance(r, dict) else r for r in (references or [])]
        request = json.dumps({"agent": agent_id, "task": task or "none", "op": op, "prompt": prompt, "size": size,
                              "quality": quality, "references": refs}, sort_keys=True, separators=(",", ":"), default=str)
        return "auto-" + hashlib.sha256(request.encode()).hexdigest()[:48]

    # -- request validation, all before any reservation --

    def _task(self, agent, goal_id):
        """(task id or None, owner swarm, seconds left or None) from the task the mind holds."""
        if goal_id is not None:
            goal = self.hive.db.one("SELECT * FROM goals WHERE id = ? AND claimed_by = ? AND status IN ('claimed','waiting')",
                                    (str(goal_id), agent["id"]))
            if not goal:
                raise MediaError(409, "goal_not_held", "goal_id must name a task this mind holds")
        else:
            held = self.hive.db.all("SELECT * FROM goals WHERE claimed_by = ? AND status IN ('claimed','waiting')", (agent["id"],))
            goal = held[0] if len(held) == 1 else None
        if goal is None:
            if not agent.get("swarm_id"):
                raise MediaError(400, "no_swarm", "a mind in a swarm generates images")
            return None, agent["swarm_id"], None
        left = None
        if goal.get("deadline_at"):
            import datetime
            end = datetime.datetime.fromisoformat(goal["deadline_at"].replace("Z", "+00:00"))
            left = (end - datetime.datetime.now(datetime.timezone.utc)).total_seconds()
            if left <= 1:
                raise MediaError(409, "deadline_passed", "the task's deadline leaves no time for a provider call")
        return goal["id"], goal["swarm_id"], left

    def _references(self, agent, p, refs):
        if refs in (None, []):
            return []
        if not isinstance(refs, list) or len(refs) > p["max_references"]:
            raise MediaError(400, "bad_references", f"at most {p['max_references']} references for {p['op']}")
        spec = p["supported"].get("input_references") or {}
        if spec.get("type") == "range" and len(refs) > _bounds(spec)[1]:
            raise MediaError(400, "bad_references", "more references than this endpoint documents")
        out = []
        for ref in refs:
            if not isinstance(ref, dict) or set(ref) - {"sha256", "artifact_id", "revision"} or not SHA.fullmatch(str(ref.get("sha256", ""))):
                raise MediaError(400, "bad_references", "each reference is {sha256, artifact_id?, revision?}")
            try:
                readable = self.hive.assets.agent_may_read(agent, ref["sha256"], ref.get("artifact_id"), ref.get("revision"))
            except Exception:
                readable = False
            if not readable:
                raise MediaError(404, "not_found", "no such asset for you")
            row, data = self.hive.assets.read(ref["sha256"])
            if len(data) > p["max_reference_bytes"]:
                raise MediaError(413, "reference_too_large", f"references are limited to {p['max_reference_bytes']} bytes")
            try:
                info = decode_image(data, p["max_reference_width"], p["max_reference_height"], p["max_reference_pixels"])
            except Undecodable as exc:
                if exc.reason == "not_image":
                    raise MediaError(415, "bad_reference_type", "a reference must be a PNG, JPEG or WebP image") from None
                if exc.reason == "dimensions":
                    raise MediaError(413, "reference_dimensions", f"a reference must be at most {p['max_reference_width']}x"
                                     f"{p['max_reference_height']} and {p['max_reference_pixels']} pixels, and not empty") from None
                raise MediaError(415, "reference_undecodable", f"the reference does not decode as a whole image ({exc.reason})") from None
            out.append((ref["sha256"], info, data))
        return out

    def _request(self, p, data):
        if set(data) - {"op", "operation_id", "prompt", "size", "quality", "references", "goal_id"}:
            raise MediaError(400, "unsupported_field", "fields are op, operation_id, prompt, size, quality, references, goal_id")
        operation_id = data.get("operation_id")
        if operation_id is not None and (not isinstance(operation_id, str) or not OPERATION_ID.fullmatch(operation_id)):
            raise MediaError(400, "bad_operation_id", "operation_id is 8-120 of A-Z a-z 0-9 . _ : -, stable across retries")
        prompt = data.get("prompt")
        prompt = prompt.strip() if isinstance(prompt, str) else prompt      # the normalized prompt is what is sent and bound
        if not isinstance(prompt, str) or not prompt or len(prompt.encode("utf-8")) > MAX_PROMPT_BYTES:
            raise MediaError(400, "bad_prompt", f"prompt is non-empty text of at most {MAX_PROMPT_BYTES} UTF-8 bytes")
        size = data.get("size")
        if size is None and len(p["geometry"]) == 1:
            size = next(iter(p["geometry"]))
        if size not in p["geometry"]:
            raise MediaError(400, "bad_size", f"size is one of {sorted(p['geometry'])}")
        quality = data.get("quality")
        if quality is None and len(p["quality"]) == 1:
            quality = p["quality"][0]
        if (quality is None) != (not p["quality"]) or (quality is not None and quality not in p["quality"]):
            raise MediaError(400, "bad_quality", f"quality is one of {p['quality']}" if p["quality"] else "this op takes no quality")
        return operation_id, prompt, size, quality

    def _upstream(self, p, prompt, size, quality, refs):
        body = {"model": p["model"], "prompt": prompt, "n": 1, **p["geometry"][size]["controls"]}
        if quality is not None:
            body["quality"] = quality
        if _allowed(p["supported"], "output_format", "png"):
            body["output_format"] = "png"
        if refs:
            body["input_references"] = [{"type": "image_url", "image_url": {"url": f"data:{info[0]};base64,{base64.b64encode(raw).decode()}"}} for _s, info, raw in refs]
        # one pinned upstream, no silent substitution
        body["provider"] = {"only": [p["endpoint"]["provider_slug"]], "allow_fallbacks": False}
        return body

    # -- the call --

    async def handle(self, agent, data):
        op = data.get("op")
        if op in CLOSED_OPS:
            raise MediaError(501, "op_closed", f"{op} is closed: no selected model has a documented bound for every billed unit")
        if op not in OPS:
            raise MediaError(400, "bad_op", f"op is one of {sorted(OPS)}")
        skill = OPS[op]
        # J3 host R8: a person's own Studio maker, while it makes that person's live admitted session, is admitted through
        # its host binding (it is minted per member, so it can never be listed). Not a wildcard: every other mind is
        # admitted only by its exact allowlist entry, as before. The skill policy below still applies to both.
        makers = getattr(self.hive, "studio_makers", None)
        studio_person = makers.live_media_person(agent) if makers is not None else None
        if not allowed(self.hive.settings, op, agent) and studio_person is None:
            # r2 P1-3: the host allowlist comes first; the skill policy below still applies to the minds it names
            raise MediaError(403, "media_not_allowed", f"{op} is not enabled for this mind on this hive (HIVE_MEDIA_ALLOW)")
        self.hive.policy.enforce(agent, skill, f"({skill} {json.dumps(str(data.get('prompt', ''))[:200])})")
        p = pin(self.hive.settings, op)
        operation_id, prompt, size, quality = self._request(p, data)
        task, owner_swarm, left = self._task(agent, data.get("goal_id"))
        if operation_id is None:
            operation_id = self.derive(agent["id"], task, op, prompt, size, quality, data.get("references"))
        refs = self._references(agent, p, data.get("references"))
        usd, lines = worst_case(p, size, len(prompt.encode("utf-8")), [info for _s, info, _r in refs])
        self.gateway.enforce_egress(agent, PROVIDER)
        keyring = self.gateway.keyring
        locked = bool(self.gateway._options(agent).get("key_locked"))   # app platform P3a: no other key selection
        if studio_person is not None and keyring is not None and not locked:
            # R8: only the person's own key for the media provider pays; none is 402 own_key_needed before anything is
            # reserved or sent. It does not pause the session (the maker can keep drawing on the canvas without images);
            # any other 402 below (her own key's limits, caps) pauses the session exactly as before (gateway_refused).
            key_id = makers.media_key(agent, studio_person, PROVIDER)
            secret = keyring.secret_for(PROVIDER, key_id) if key_id else ""
            if not key_id or not secret:
                raise makers.key_refusal(agent["id"], None, "call")
        else:
            key_id, secret = self.gateway.paying_key(agent, PROVIDER)
        key_owner = ((keyring.ring.get("keys") or {}).get(key_id) or {}).get("owner") if (key_id and keyring) else None
        with self.hive.db.transaction():
            # One read: the payer is derived from the same sessions (and Ask turns) that are captured as the baseline.
            sessions = self._sessions(agent["id"])
            payer, own_key = self.hive.payer_for(agent, key_owner)
        model_label = f"{PROVIDER}/{p['model']}"
        reservation = self.key(agent["id"], op, operation_id)
        payload = {"agent": agent["id"], "op": op, "operation_id": operation_id, "pin": p["digest"], "prompt": prompt,
                   "size": size, "quality": quality, "references": [s for s, _i, _r in refs], "owner_swarm": owner_swarm}
        if self.reservations.get(reservation) is not None:
            # the same operation again: its recorded result or held state, whoever pays now; never a second POST
            stored = ((self.reservations.details(reservation) or {}).get("metadata") or {}).get("payload_hash")
            if stored != _payload_hash(payload):
                raise MediaError(409, "operation_conflict", "this operation_id was already used for a different request")
            return self.replay(reservation)
        open_ = breaker(self.hive.db, agent["id"])
        if open_ and open_["tripped_at"]:
            # r2 P1-1/2: refused before any reservation until an admin resets it (a replay above never spends)
            raise MediaError(423, "media_breaker_open", "image generation is paused for this mind until an admin resets it: "
                             f"{open_['reason']}", {"breaker": open_})
        studio = getattr(self.hive, "studio", None)
        studio_call = studio.gateway_call(agent) if studio is not None else None   # J3 R4: None unless a live maker
        try:
            self.hive.check_budget(agent, True, usd, key_id, payer, own_key)
        except Exception as exc:
            if studio_call is not None and getattr(exc, "status", None) == 402:
                studio.gateway_refused(studio_call, ("paused", "budget_exhausted", "refused_budget"))
            raise

        def budgets():
            # Inside the reservation's write transaction, which sessions.end also takes: a session that started or ended
            # since this request was admitted (its cap and payer) refuses the call rather than reserving on stale terms.
            if self._sessions(agent["id"]) != sessions:
                raise ValueError("session changed during admission")
            if self.hive.payer_for(self.hive.agent(agent["id"]), key_owner) != (payer, own_key):
                raise ValueError("payer changed during admission")
            host_use_check(self.hive, agent["id"], key_id, payer)   # money port r1.2: access removed since admission
            return self.snapshot(self.hive, agent["id"], key_id, payer, own_key)
        metadata = {"agent": agent["id"], "model": model_label, "payer": payer, "key": key_id, "kind": "media:" + op}
        try:
            if studio_call is None:
                row = self.reservations.reserve(reservation, payload, usd, budgets, metadata=metadata, dispatched=True)
            else:
                # J3 R4: bound to the maker's step and captured epoch, reserved undispatched (the send gate dispatches)
                row = studio.reserve_call(studio_call, self.reservations, reservation, payload, usd, budgets, metadata)
        except ValueError as exc:
            if "reused" in str(exc):
                raise MediaError(409, "operation_conflict", "this operation_id was already used for a different request") from None
            if "payer changed" in str(exc):
                raise MediaError(409, "payer_changed", "who pays for this mind changed meanwhile; ask again") from None
            if "session changed" in str(exc):
                raise MediaError(409, "session_changed", "a session on this mind started or ended meanwhile; ask again") from None
            raise MediaError(402, "reservation_refused", str(exc)) from None
        if not row["new"]:
            return self.replay(reservation)
        # J3 R4.1: a Studio maker's call is reserved, not dispatched; its record says so until the send gate (at the
        # transport's send-header boundary, inside _post's request) passes and marks both dispatched in one transaction
        self.hive.db.execute("INSERT INTO media_results(reservation, agent_id, op, operation_id, model, endpoint, created_at, billing) "
                             "VALUES (?,?,?,?,?,?,?,?)", (reservation, agent["id"], op, operation_id, p["model"],
                                                          p["endpoint"]["provider_slug"], now(),
                                                          "dispatched" if studio_call is None else "reserved"))
        timeout = p["timeout_seconds"] if left is None else max(1.0, min(p["timeout_seconds"], left))
        upstream = self._upstream(p, prompt, size, quality, refs)
        gate_token = None
        if studio_call is not None:
            from .gateway import SEND_GATE
            studio_call.on_dispatch = lambda: self.hive.db.execute(
                "UPDATE media_results SET billing = 'dispatched' WHERE reservation = ? AND billing = 'reserved'", (reservation,))
            gate_token = SEND_GATE.set(studio_call.gate)    # copied into wait_for's task with the rest of this context
        try:
            status, raw = await asyncio.wait_for(self._post(upstream, secret, p["max_response_bytes"], timeout), timeout)
        except asyncio.CancelledError:
            if self._not_sent(studio_call, reservation, "cancelled"):
                raise
            self._unknown(reservation, None, "cancelled")
            raise
        except BaseException as exc:
            from .studio_gateway import StudioRefused
            if isinstance(exc, StudioRefused):
                self._not_sent(studio_call, reservation, "studio_retired")
                raise exc.error from None
            if self._not_sent(studio_call, reservation, "not_sent"):
                raise MediaError(502, "upstream_unreachable", "the image request was never sent; nothing is held",
                                 {"reservation": reservation}) from None
            # timeout, transport loss, oversize stream: the vendor may have charged; hold the worst case, never retry
            self._unknown(reservation, None, "timeout" if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) else
                          "response_too_large" if isinstance(exc, _TooLarge) else "transport")
            raise MediaError(504 if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) else 502, "outcome_unknown",
                             "the provider's outcome is unknown; the worst case stays held until a person resolves it",
                             {"reservation": reservation, "held_usd": usd}) from None
        finally:
            if gate_token is not None:
                from .gateway import SEND_GATE
                SEND_GATE.reset(gate_token)
        if studio_call is not None and not studio_call.started:
            # answered without passing a transport's send boundary (no httpcore under it): made all the same
            studio_call.made()
            self.hive.db.execute("UPDATE media_results SET billing = 'dispatched' WHERE reservation = ? AND billing = 'reserved'",
                                 (reservation,))
        # The provider answered: from here nothing raises before custody is recorded.
        try:
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            # r2 P1-1: the whole output is checked first, off the event loop (a full JPEG scan walk can take seconds);
            # nothing is recorded as an accepted asset until it passes
            checked = await asyncio.to_thread(self._validate, p, body, size) if status < 400 else None
        except asyncio.CancelledError:
            self._unknown(reservation, status, "cancelled")
            raise
        except Exception:
            self._unknown(reservation, status, "host_error")
            raise MediaError(502, "outcome_unknown", "the outcome could not be recorded; the worst case stays held",
                             {"reservation": reservation, "held_usd": usd}) from None
        try:
            return self._finish(agent, p, reservation, status, body, checked, owner_swarm, usd, model_label, key_id, payer)
        except MediaError:
            raise
        except Exception:
            self._unknown(reservation, status, "host_error")
            raise MediaError(502, "outcome_unknown", "the outcome could not be recorded; the worst case stays held",
                             {"reservation": reservation, "held_usd": usd}) from None

    def _not_sent(self, studio_call, reservation, refusal):
        """J3 R4.1: a Studio maker's request that never passed the send gate: its hold is released and its record says
        so; never held unknown, never marked dispatched. False for every other call (unchanged)."""
        if studio_call is None or studio_call.started:
            return False
        studio_call.unsent()
        self.hive.db.execute("UPDATE media_results SET billing = 'released', refusal = ?, finished_at = ? WHERE reservation = ?",
                             (refusal, now(), reservation))
        return True

    def _sessions(self, agent_id):
        return [tuple(r) for r in self.hive.db._conn.execute(
            "SELECT id, spent_at_start, budget_usd FROM work_sessions WHERE agent_id = ? AND status = 'active' ORDER BY id",
            (agent_id,)).fetchall()]

    async def _post(self, body, secret, cap, timeout):
        """One buffered POST /images, read under a byte cap. Returns (status, bytes)."""
        provider = self.gateway.provider(PROVIDER)
        headers = {"Authorization": f"Bearer {secret}", "X-Title": "OmegaHive"} if secret else {"X-Title": "OmegaHive"}
        url = f"{provider.base_url.rstrip('/')}/images"
        from .gateway import SEND_GATE, _send_trace
        extensions = {"trace": _send_trace} if SEND_GATE.get() is not None else None   # J3 R4.1: the send gate, as chat
        async with self.gateway.client.stream("POST", url, json=body, headers=headers, timeout=timeout,
                                              extensions=extensions) as response:
            chunks, total = [], 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > cap:
                    raise _TooLarge()
                chunks.append(chunk)
            return response.status_code, b"".join(chunks)

    def _unknown(self, reservation, status, refusal):
        held = self.reservations.get(reservation)
        if held and held["state"] not in ("dispatched", "unknown"):
            return                       # already settled or released: nothing is held back over a recorded outcome
        self.hold_unknown(reservation)
        self.hive.db.execute("UPDATE media_results SET billing = 'unknown', vendor_status = ?, refusal = ?, finished_at = ? "
                             "WHERE reservation = ?", (status, refusal, now(), reservation))

    def _finish(self, agent, p, reservation, status, body, checked, owner_swarm, held, model_label, key_id, payer):
        """Custody after the vendor answered. ``checked`` is _validate's (refusal, image) for a 2xx answer.

        Order (r2 P1-1): the output was validated before this runs; then the vendor's actual cost is reconciled and
        recorded (a real charge is never hidden, accepted or not); only then is a validated image stored as the asset.
        A charge for a refused output is ``billed_refused``: the reason, no asset, told to the mind's people and admins,
        and counted toward this mind's breaker."""
        usage = body.get("usage") if isinstance(body, dict) else None
        cost = _finite_cost(usage.get("cost")) if isinstance(usage, dict) else None
        # The Image API documents created, data and optional usage: no generation id or resolved model. They stay UNKNOWN.
        self.reservations.observe(reservation, {"usage_origin": "provider-usage-cost" if cost is not None else "usage-absent"})
        refusal, image = (f"upstream_status_{status}", None) if status >= 400 else checked
        if status >= 400 or cost is None:
            # an error or a missing/negative/non-finite cost is never zero: hold the worst case for a person
            self._unknown(reservation, status, "upstream_error" if status >= 400 else "billing_unknown")
            billing, actual = "unknown", None
        else:
            counters = {k: usage.get(k) if type(usage.get(k)) is int and usage.get(k) >= 0 else 0
                        for k in ("prompt_tokens", "completion_tokens")}
            spent = {**counters, "cost_usd": float(cost), "key_id": key_id}
            # r2 P1-2: the reservation is the pinned worst case, not a ceiling the vendor obeys. Any actual cost is
            # recorded in full; above the hold, settle flags it (budget.overrun) and the hook opens this mind's breaker.
            self.reservations.settle(reservation, float(cost),
                                     lambda: self.hive.record_usage(agent, model_label, spent, None, payer), self.overrun_flag)
            billing, actual = ("billed_refused" if refusal else "settled"), float(cost)
            self.hive.db.execute("UPDATE media_results SET billing = ?, billing_origin = 'provider-usage-cost', "
                                 "vendor_status = ? WHERE reservation = ?", (billing, status, reservation))
        asset = None
        if image is not None:
            refusal, asset = self._store(image, owner_swarm, agent)
            if refusal and billing == "settled":
                billing = "billed_refused"
                self.hive.db.execute("UPDATE media_results SET billing = 'billed_refused' WHERE reservation = ?", (reservation,))
        self.hive.db.execute(
            "UPDATE media_results SET refusal = COALESCE(?, refusal), asset_sha256 = ?, mime = ?, width = ?, height = ?, bytes = ?, "
            "owner_swarm = ?, finished_at = ? WHERE reservation = ?",
            (refusal, asset and asset["sha256"], asset and asset["mime"], asset and asset["width"], asset and asset["height"],
             asset and asset["bytes"], asset and owner_swarm, now(), reservation))
        tripped = False
        if status < 400 and refusal:
            # the vendor answered and the host refused the output: billed (or, with no usable cost, held as possibly
            # billed). Either way it counts toward the breaker, so a wrong pin cannot keep spending.
            tripped = count_refusal(self.hive.db, agent["id"], reservation, getattr(self.hive.settings, "media_breaker_refusals", 2))
            self._tell_refused(agent, reservation, refusal, billing, actual, held, tripped)
        elif asset:
            count_accepted(self.hive.db, agent["id"])
        result = self._view(reservation)
        open_ = breaker(self.hive.db, agent["id"])
        if open_ and open_["tripped_at"]:
            result["breaker"] = open_          # opened by this refusal, or by an overrun on this call (app.overrun_flag)
        if billing == "unknown" and status >= 400:
            raise MediaError(502, "outcome_unknown", f"the provider answered {status}; the worst case stays held", result)
        if refusal:
            if billing == "billed_refused":
                message = (f"the provider billed ${actual:.4f} but the image was refused ({refusal}); no asset was stored. "
                           "The charge is recorded as billed_refused")
            else:
                message = f"the image was not accepted ({refusal}); billing is {billing}"
            if result.get("breaker"):
                message += "; image generation is now paused for this mind until an admin resets it"
            raise MediaError(502, "output_refused", message, result)
        return result

    def _event(self, kind, **payload):
        try:
            self.hive.events.publish(kind, **payload)
        except Exception:
            pass

    def _tell_refused(self, agent, reservation, refusal, billing, actual, held, tripped):
        """Plainly, to the mind's people (its last error, shown on the mind) and to admins (an event, and
        GET /api/media/results). Never raises."""
        cost = f"${actual:.4f}" if actual is not None else f"up to ${held:.4f} (held until resolved)"
        note = f"image refused after the provider charged {cost}: {refusal}; no asset ({reservation})"
        if tripped:
            note += "; image generation paused until an admin resets it"
        self._event("media.billed_refused", agent=agent["id"], reservation=reservation, refusal=refusal, billing=billing,
                    actual_usd=actual, held_usd=held, breaker_tripped=tripped)
        if tripped:
            self._event("media.breaker_tripped", agent=agent["id"], reservation=reservation, reason=refusal)
        try:
            self.hive.db.execute("UPDATE agents SET last_error = ? WHERE id = ?", (note[:500], agent["id"]))
            self.hive.emit_agent(agent["id"])
        except Exception:
            pass

    @staticmethod
    def _validate(p, body, size):
        """(refusal, None) or (None, (bytes, mime, w, h)): exactly one buffered image of the pinned geometry, within the
        byte cap, fully decoded. Pure: no store, no database (it runs in a worker thread)."""
        items = body.get("data") if isinstance(body, dict) else None
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            return "output_count", None
        encoded = items[0].get("b64_json")
        if not isinstance(encoded, str) or not encoded:
            return "output_missing", None
        if len(encoded) > (p["max_output_bytes"] * 4) // 3 + 4:
            return "output_too_large", None
        try:
            data = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            return "output_not_base64", None
        if len(data) > p["max_output_bytes"]:
            return "output_too_large", None
        g = p["geometry"][size]
        try:   # bounded by the exact pinned geometry: nothing larger is ever decoded
            mime, w, h = decode_image(data, g["width"], g["height"], g["width"] * g["height"])
        except Undecodable as exc:
            return {"not_image": "output_not_image", "dimensions": "output_dimensions"}.get(exc.reason, "output_undecodable"), None
        wanted = {"image/png"} if "output_format" in p["supported"] and _allowed(p["supported"], "output_format", "png") else MIME_OK
        if mime not in wanted:
            return "output_type", None
        if (w, h) != (g["width"], g["height"]):
            return "output_dimensions", None
        return None, (data, mime, w, h)

    def _store(self, image, owner_swarm, agent):
        data, mime, w, h = image
        try:
            stored = self.hive.assets.put(data, mime, f"agent:{agent['id']}", owner_swarm, "")
        except Exception:
            return "store_failed", None
        return None, {"sha256": stored["sha256"], "mime": mime, "width": w, "height": h, "bytes": len(data)}

    def _view(self, reservation):
        row = self.hive.db.one("SELECT * FROM media_results WHERE reservation = ?", (reservation,))
        held = self.reservations.get(reservation)
        details = self.reservations.details(reservation) or {}
        state = held["state"] if held else UNKNOWN
        view = {"reservation": reservation, "state": state, "op": row and row["op"], "operation_id": row and row["operation_id"],
                "model": row and row["model"], "endpoint_provider": row and row["endpoint"],
                "resolved_model": UNKNOWN, "response_id": UNKNOWN,
                "billing": {"state": state, "held_usd": held["maximum"] / 1_000_000 if held else None,
                            "actual_usd": held["actual"] / 1_000_000 if held and held["actual"] is not None else None,
                            "origin": ((details.get("observation") or {}).get("usage_origin"))},
                "asset": None, "refusal": row and row["refusal"]}
        # r2: a charge with no accepted image says so in the billing state itself
        if row and row["billing"] == "billed_refused":
            view["billing"]["state"] = "billed_refused"
        view["outcome"] = ("accepted" if row and row["asset_sha256"] else "billed_refused" if row and row["billing"] == "billed_refused"
                           else "released" if state == "released" else "refused" if state == "settled" else "held_unknown")
        if row and row["asset_sha256"]:
            view["asset"] = {"sha256": row["asset_sha256"], "mime": row["mime"], "width": row["width"], "height": row["height"],
                             "bytes": row["bytes"], "owner_swarm": row["owner_swarm"]}
        return view

    def replay(self, reservation):
        """The same operation again: the recorded result, or an explicit held state. Never a second vendor POST."""
        view = {**self._view(reservation), "replay": True}
        if view["state"] == "settled" and view["asset"]:
            return view
        if view["state"] == "settled":
            raise MediaError(409, "output_refused", "this operation was billed but produced no accepted image "
                             f"({view['refusal'] or 'no image'}); billing is {view['billing']['state']}", view)
        if view["state"] == "released":
            raise MediaError(409, "operation_released", "a person released this operation; use a new operation_id", view)
        raise MediaError(409, "outcome_unknown", "this operation's outcome is not settled; a person resolves it", view)


def _payload_hash(payload):
    """The request identity exactly as Reservations.reserve hashes it."""
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), allow_nan=False, default=str).encode()).hexdigest()


class _TooLarge(Exception):
    pass


def open_liabilities(db, agent_id):
    """Reservation ids still held on this mind's own cap (reserved, dispatched or unknown)."""
    try:
        rows = db.all("SELECT r.id FROM cost_reservations r JOIN cost_reservation_scopes s ON s.reservation = r.id "
                      "WHERE s.scope = ? AND r.state IN ('reserved','dispatched','unknown')", (f"agent:{agent_id}:total",))
    except Exception:
        return []
    return [r["id"] for r in rows]
