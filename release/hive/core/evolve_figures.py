"""Figures (PNG images) attached to recorded OmegaEvolve reports (lab-figures r1).

A figure is producer content shown beside a recorded claim. Attaching one never changes the report: the record row in
`evolve_records` is immutable and is not touched here, so its verification, state and adoption fields stay exactly as
they were (`verified=False`, `state=recorded-claim`, `adoption_authorized=False`, evidence custody unresolved).

- Content-addressed: the bytes live under the hive's data directory (`evolve_figures/`, the asset store's layout) by
  their sha256; the caller declares the hash and the bytes must match it. The same bytes are stored once.
- PNG only, at most 4 MiB: the signature, a well-formed chunk structure with valid CRCs (IHDR first, an empty IEND
  last, at least one IDAT) and a sane IHDR (width and height read from it). Pixels are not decoded and nothing is fetched.
- Separate from the generic asset store on purpose: a figure is readable only through its report, so the generic
  `/api/assets/{sha}` route (swarm-owner access) never serves it.
- Who may attach: the report's contributor (the principal that recorded it) or a hive admin.
- Who may read: whoever may read the report (its swarm, as the OmegaEvolve view), and nobody else (404 otherwise).
"""

from __future__ import annotations

import hashlib
import re
import struct
import zlib

from .assets import LocalStore
from .db import now
from .evolve import SCHEMA as RECORDS_SCHEMA

MAX_BYTES = 4 * 1024 * 1024
MAX_SIDE = 16384
MAX_CAPTION = 4000
MAX_LOCATOR = 500
MAX_PER_REPORT = 16
SIGNATURE = b"\x89PNG\r\n\x1a\n"
SHA = re.compile(r"[0-9a-f]{64}")
# PNG's valid (colour type -> allowed bit depths)
DEPTHS = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS evolve_figure_blobs (
 sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS evolve_figures (
 record_id TEXT NOT NULL, swarm_id TEXT NOT NULL, sha256 TEXT NOT NULL, caption TEXT NOT NULL,
 source_locator TEXT, position INTEGER NOT NULL, attached_by TEXT NOT NULL, attached_at TEXT NOT NULL,
 PRIMARY KEY (record_id, sha256))""",
    "CREATE INDEX IF NOT EXISTS evolve_figures_swarm ON evolve_figures (swarm_id, record_id, position)",
]


class FigureError(ValueError):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def png_size(data):
    """(width, height) of a structurally valid PNG, or raise FigureError(400). Walks every chunk: lengths in bounds,
    CRCs valid, IHDR first with a legal depth/colour pair, at least one IDAT, an empty IEND last and exactly at the end."""
    if not isinstance(data, (bytes, bytearray)) or data[:8] != SIGNATURE:
        raise FigureError(400, "not_png", "a figure must be a PNG image (its signature is missing)")
    i, seen, size, end = 8, [], None, False
    while i < len(data):
        if end or i + 12 > len(data):
            raise FigureError(400, "bad_png", "the PNG has bytes after its end or a truncated chunk")
        length = struct.unpack(">I", data[i:i + 4])[0]
        kind = bytes(data[i + 4:i + 8])
        if length > len(data) - i - 12:
            raise FigureError(400, "bad_png", "the PNG has a truncated chunk")
        body = data[i + 8:i + 8 + length]
        crc = struct.unpack(">I", data[i + 8 + length:i + 12 + length])[0]
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise FigureError(400, "bad_png", "a PNG chunk fails its checksum")
        if not seen:
            if kind != b"IHDR" or length != 13:
                raise FigureError(400, "bad_png", "the PNG does not start with its header chunk")
            w, h, depth, colour, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if not (0 < w <= MAX_SIDE and 0 < h <= MAX_SIDE):
                raise FigureError(400, "bad_png", f"figure sides must be 1 to {MAX_SIDE} pixels")
            if depth not in DEPTHS.get(colour, ()) or compression or filtering or interlace > 1:
                raise FigureError(400, "bad_png", "the PNG header is not valid")
            size = (w, h)
        elif kind == b"IHDR":
            raise FigureError(400, "bad_png", "the PNG has a second header chunk")
        if kind == b"IEND":
            if length:
                raise FigureError(400, "bad_png", "the PNG end chunk must be empty")
            end = True
        seen.append(kind)
        i += 12 + length
    if not end or b"IDAT" not in seen:
        raise FigureError(400, "bad_png", "the PNG has no image data or no end chunk")
    return size


class EvolveFigures:
    def __init__(self, hive):
        self.hive, self.db = hive, hive.db
        self.db.execute(RECORDS_SCHEMA)         # additive: the records table may not exist yet on a fresh hive
        for statement in SCHEMA:
            self.db.execute(statement)
        self.store = LocalStore(hive.settings.data_dir / "evolve_figures")

    # ---- reports ---------------------------------------------------------------------------------

    def report(self, swarm_id, record_id):
        """The recorded report (a contribution) in this swarm, or None."""
        row = self.db.one("SELECT id, swarm_id, kind, author FROM evolve_records WHERE swarm_id = ? AND id = ?",
                          (str(swarm_id), str(record_id)))
        return row if row and row["kind"] == "contribution" else None

    # ---- writing ---------------------------------------------------------------------------------

    @staticmethod
    def _text(value, field, limit, required):
        if value is None and not required:
            return None
        if not isinstance(value, str) or (required and not value.strip()):
            raise FigureError(400, "bad_request", f"{field} must be plain text")
        if len(value) > limit:
            raise FigureError(400, "bad_request", f"{field} is limited to {limit} characters")
        if any(ord(c) < 32 and c not in "\n\t" or ord(c) == 127 for c in value):
            raise FigureError(400, "bad_request", f"{field} must be plain text without control characters")
        return value

    def attach(self, swarm_id, record_id, by, may_attach, sha256, caption, source_locator=None, data=None):
        """Store (when `data` is given) and attach one figure to a recorded report. `may_attach(report)` is the caller's
        authorization (contributor or admin). Repeating the same attachment returns it; the same figure with different
        words on the same report is refused. Never writes `evolve_records`."""
        report = self.report(swarm_id, record_id)
        if report is None:
            raise FigureError(404, "not_found", "no such report")
        if not may_attach(report):
            raise FigureError(403, "not_contributor", "only the report's contributor or a hive admin attaches figures")
        sha = str(sha256 or "")
        if not SHA.fullmatch(sha):
            raise FigureError(400, "bad_hash", "sha256 must be 64 lowercase hex characters")
        caption = self._text(caption, "caption", MAX_CAPTION, True)
        locator = self._text(source_locator, "source_locator", MAX_LOCATOR, False)
        size = None
        if data is not None:
            if len(data) > MAX_BYTES:
                raise FigureError(413, "too_large", f"a figure is limited to {MAX_BYTES // (1024 * 1024)} MiB")
            if hashlib.sha256(bytes(data)).hexdigest() != sha:
                raise FigureError(400, "hash_mismatch", "the bytes do not match the declared sha256")
            size = png_size(data)
        with self.db.transaction():
            blob = self.db.one("SELECT * FROM evolve_figure_blobs WHERE sha256 = ?", (sha,))
            if blob is None:
                if data is None:
                    raise FigureError(404, "figure_not_stored", "send the figure's bytes (content_base64) the first time")
                self.store.put(sha, bytes(data))     # content-addressed: a leftover after a rollback is harmless
                self.db.execute("INSERT INTO evolve_figure_blobs VALUES (?,?,?,?,?,?)",
                                (sha, len(data), size[0], size[1], by, now()))
            prior = self.db.one("SELECT * FROM evolve_figures WHERE record_id = ? AND sha256 = ?", (report["id"], sha))
            if prior:
                if prior["caption"] != caption or prior["source_locator"] != locator:
                    raise FigureError(409, "already_attached", "this figure is already attached with other words")
                return self.view(prior, self.blob(sha))
            count = self.db.one("SELECT count(*) AS n FROM evolve_figures WHERE record_id = ?", (report["id"],))["n"]
            if count >= MAX_PER_REPORT:
                raise FigureError(409, "too_many_figures", f"a report holds at most {MAX_PER_REPORT} figures")
            self.db.execute("INSERT INTO evolve_figures VALUES (?,?,?,?,?,?,?,?)",
                            (report["id"], report["swarm_id"], sha, caption, locator, count, by, now()))
            row = self.db.one("SELECT * FROM evolve_figures WHERE record_id = ? AND sha256 = ?", (report["id"], sha))
        return self.view(row, self.blob(sha))

    # ---- reading ---------------------------------------------------------------------------------

    def blob(self, sha):
        return self.db.one("SELECT * FROM evolve_figure_blobs WHERE sha256 = ?", (str(sha),))

    @staticmethod
    def read_url(swarm_id, record_id, sha):
        return f"/api/evolve/swarms/{swarm_id}/records/{record_id}/figures/{sha}"

    def view(self, row, blob):
        out = {"sha256": row["sha256"], "mime": "image/png", "bytes": blob["bytes"], "width": blob["width"],
               "height": blob["height"], "caption": row["caption"],
               "read_url": self.read_url(row["swarm_id"], row["record_id"], row["sha256"])}
        if row["source_locator"] is not None:
            out["source_locator"] = row["source_locator"]
        return out

    def for_swarm(self, swarm_id):
        """{record_id: [figure, ...]} for every report in this swarm that has figures (in attach order)."""
        rows = self.db.all("SELECT f.*, b.bytes, b.width, b.height FROM evolve_figures f JOIN evolve_figure_blobs b "
                           "ON b.sha256 = f.sha256 WHERE f.swarm_id = ? ORDER BY f.record_id, f.position", (str(swarm_id),))
        out = {}
        for row in rows:
            out.setdefault(row["record_id"], []).append(self.view(row, row))
        return out

    def for_report(self, swarm_id, record_id):
        return self.for_swarm(swarm_id).get(str(record_id), []) if self.report(swarm_id, record_id) else None

    def read(self, swarm_id, record_id, sha):
        """The bytes of a figure attached to this report, checked against its hash; FigureError(404) otherwise."""
        if self.report(swarm_id, record_id) is None:
            raise FigureError(404, "not_found", "no such figure")
        row = self.db.one("SELECT sha256 FROM evolve_figures WHERE record_id = ? AND swarm_id = ? AND sha256 = ?",
                          (str(record_id), str(swarm_id), str(sha)))
        if row is None:
            raise FigureError(404, "not_found", "no such figure")
        data = self.store.get(row["sha256"])
        if data is None:
            raise FigureError(404, "not_found", "no such figure")
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise FigureError(500, "corrupt_figure", "the stored figure does not match its hash")
        return data

    @staticmethod
    def headers(sha):
        return {"Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": f'inline; filename="figure-{sha[:12]}.png"',
                "Cache-Control": "private, no-store", "ETag": f'"{sha}"',
                "Cross-Origin-Resource-Policy": "same-origin", "Referrer-Policy": "no-referrer"}
