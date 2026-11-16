"""The browser mind's frame: served at one exact path with its sandbox header, or not at all (gateway plan r1 §2.5, r1.1 §B, §L).

Surface builds `hive/ui/public/mind-iter/mind-frame.html` to `hive/ui/dist/mind-iter/mind-frame.html`. That file's own
`<meta>` policy cannot carry `sandbox` or `frame-ancestors`, so the host sends the header, and only here. Everything is
decided on the resolved file, never on how the request spelled the path:
- a request whose resolved target is the frame file, or any `.html` under `mind-iter/`, gets the frame header **only** at
  the canonical raw path, byte for byte. Every other spelling (`//`, `./`, `..`, `%2F`, `%2e`, case, a trailing `/`, a
  symlink or hard link) is 404. Nothing legitimate uses an alias, so there is no redirect.
- any other build file the catch-all would serve is checked at request time for the frame (r1d.2): it carries a bootstrap
  hash read since boot, or it is a document whose CSP meta names a `'sha256-…'` source (the frame's shape, whichever hash).
  Such a copy is 404 and turns the frame off, whenever it was added and whatever state the canonical file is in.
  "Document" is decided on every request from the names the response is served under (the resolved file, as
  FileResponse labels it, and the requested name), or from the content itself where it reads as HTML (as a browser would
  sniff it). Only content facts are cached (r1de.3): which known hashes the file holds, whether a CSP meta names a hash,
  whether it reads as HTML. The key is the build's generation and the file's (dev, inode, size, mtime, ctime), so each
  version is read once, whatever names link to it. A file that changes while it is read is not cached and is refused.
  The cache assumes a deploy swaps the build directory (a new root dev and inode, a new generation), not that it
  restores timestamps on files rewritten inside a live one.
- the frame's `sha256-` source is read from the built file's meta, and cached by the file's (dev, inode, size, mtime,
  ctime) and the build directory's identity, so a UI-only deploy needs no host restart. Whenever that is (re)read, and on
  every `available()`, the whole build is walked for copies (each file read only when its version is new).
- fail closed: no file, an unreadable file, not exactly one hash, a canonical path that is itself a link, or a copy
  means the frame path is 404 and `available()` is False (the `browser_mind` capability, §2.4, reads it).
Constructed only when HIVE_MIND_GATEWAY=1; with the switch off the UI catch-all is unchanged.
"""

from __future__ import annotations

import mimetypes
import os
import pathlib
import re
import stat

FRAME_DIR = "mind-iter"
CANONICAL = FRAME_DIR + "/mind-frame.html"

# The host note §2.4 policy (BROWSER_ITER_HOST_WORK_FOR_PLATFORM_20261017.md:240); {source} is the built file's hash.
POLICY = ("sandbox allow-scripts; default-src 'none'; script-src {source} 'wasm-unsafe-eval' blob:; worker-src blob:; "
          "connect-src 'none'; img-src 'none'; style-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; "
          "frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'")

# What a browser runs as a document, as FileResponse labels it (by the file name): only these can be a working frame
# under an unknown hash. Any file at all that carries a known hash is a copy.
DOCUMENT_TYPES = {"text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml"}

_META = re.compile(rb"""<meta\s[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>""", re.I)
_CONTENT = re.compile(rb"""content\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
_SOURCE = re.compile(rb"'sha256-[A-Za-z0-9+/]{43}='")
_OVERLAP = 4096          # a meta tag or a hash split across two read chunks is still seen whole
_FACTS = 4096            # cached per-file content facts kept before the cache is dropped and rebuilt
_SNIFF = 512             # how much of a file's start is read for "it reads as HTML"
# The WHATWG MIME sniffing table's HTML patterns: a file starting with one (after whitespace) reads as HTML to a browser.
_HTML_STARTS = (b"<!doctype html", b"<html", b"<head", b"<script", b"<iframe", b"<h1", b"<div", b"<font", b"<table",
                b"<a", b"<style", b"<title", b"<b", b"<body", b"<br", b"<p", b"<!--")


def bootstrap_source(html: bytes) -> str | None:
    """The single `'sha256-…'` source in the file's one CSP meta, or None (no meta, two metas, zero or several hashes)."""
    metas = _META.findall(html)
    if len(metas) != 1:
        return None
    content = _CONTENT.search(metas[0])
    if not content:
        return None
    sources = set(_SOURCE.findall(content.group(1) or content.group(2) or b""))
    return sources.pop().decode("ascii") if len(sources) == 1 else None


def _names_a_hash(html: bytes) -> bool:
    """Any CSP meta in `html` naming a `'sha256-…'` source: the frame's shape, whichever hash it carries."""
    for meta in _META.findall(html):
        content = _CONTENT.search(meta)
        if content and _SOURCE.search(content.group(1) or content.group(2) or b""):
            return True
    return False


def _identity(st: os.stat_result) -> tuple[int, int]:
    return (st.st_dev, st.st_ino)


def _version(st: os.stat_result) -> tuple[int, ...]:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def _reads_as_html(head: bytes) -> bool:
    text = head.removeprefix(b"\xef\xbb\xbf").lstrip(b" \t\n\r\x0c").lower()
    return any(text.startswith(p) and (p == b"<!--" or text[len(p):len(p) + 1] in (b" ", b">", b"\t", b"\n", b"\r", b"\x0c")) for p in _HTML_STARTS)


def _is_document(*names: str) -> bool:
    return any(mimetypes.guess_type(name)[0] in DOCUMENT_TYPES for name in names if name)


class _Changed(OSError):
    """The file changed while it was read: no verdict on doubt."""


def _content_facts(path: pathlib.Path, st: os.stat_result, needles: set[bytes]) -> tuple[frozenset, bool, bool]:
    """(the known hashes the file holds, whether a CSP meta in it names a sha256 source, whether it reads as HTML). These
    depend on the bytes alone, never on a name, so every link to one file shares them."""
    found, shape, head, tail = set(), False, None, b""
    with open(path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            head = chunk[:_SNIFF] if head is None else head
            window = tail + chunk
            found |= {needle for needle in needles if needle in window}
            shape = shape or _names_a_hash(window)
            tail = window[-_OVERLAP:]
        if _version(os.fstat(f.fileno())) != _version(st):
            raise _Changed(path)
    return frozenset(found), shape, _reads_as_html(head or b"")


class MindFrame:
    def __init__(self, dist: pathlib.Path):
        self.dist = pathlib.Path(dist)
        self._key: tuple | None | bool = False   # the canonical file's version; False until first read
        self._source: str | None = None          # the canonical file's `'sha256-…'`, when it is servable by itself
        self._reason = "not_read"                # why the canonical file is not servable by itself; "ok" when it is
        self.frame_id: tuple[int, int] | None = None
        self.needles: set[bytes] = set()         # every bootstrap hash text read since boot: never forgotten
        # resolved path -> (identity, the names it was found under), for build files carrying the frame; the names are kept
        # because a copy may carry the frame only under a document name (a symlinked .html for a .js file, r1de.4)
        self.copies: dict[str, tuple[tuple[int, int], frozenset[str]]] = {}
        self._facts: dict[tuple, tuple] = {}     # (generation, file version) -> content facts (for the current needles)
        self._root_id: tuple[int, int] | None = None
        self._generation = 0                     # bumped whenever the build directory itself is another one
        self.refresh(scan=True)

    # ---- state -----------------------------------------------------------------------------------------------------

    @property
    def source(self) -> str | None:
        """The `'sha256-…'` the header carries, when the frame is servable: the canonical file is good and no copy is known."""
        return self._source if not self.copies else None

    @property
    def reason(self) -> str:
        """Why the frame is not servable (for logs and tests); "ok" when it is."""
        if self._reason != "ok":
            return self._reason
        return "second_copy" if self.copies else "ok"

    def _stat_key(self) -> tuple | None:
        try:
            frame = os.lstat(self.dist / CANONICAL)
            root = os.stat(self.dist)
        except OSError:
            return None
        return _version(frame) + (frame.st_mode, root.st_dev, root.st_ino)

    def refresh(self, scan: bool = False) -> None:
        """Re-read the hash when the frame's (dev, inode, size, mtime, ctime) or the build root changed, and then walk the
        build. Otherwise walk it only when asked (`scan`), and else re-check just the copies already known."""
        try:
            root_id = _identity(os.stat(self.dist))
        except OSError:
            root_id = None
        if root_id != self._root_id:
            self._root_id, self._generation = root_id, self._generation + 1
            self._facts.clear()
        key = self._stat_key()
        if key != self._key:
            self._key, self._source, self.frame_id = key, None, None
            self._reason = self._load() if key is not None else "missing"
            scan = True
        if scan:
            self._scan()
        else:
            self._prune()

    def _load(self) -> str:
        frame = self.dist / CANONICAL
        try:
            root = self.dist.resolve(strict=True)
            st = os.lstat(frame)
            if not frame.is_file() or frame.is_symlink() or frame.resolve(strict=True) != root / CANONICAL:
                return "not_canonical"          # the canonical path must be the file itself, not a link to one
            html = frame.read_bytes()
        except OSError:
            return "unreadable"
        source = bootstrap_source(html)
        if source is None:
            return "no_single_hash"
        self.frame_id = _identity(st)
        needle = source[1:-1].encode("ascii")   # the hash text without its quotes: a copy may quote it any way
        if needle not in self.needles:
            self.needles.add(needle)
            self._facts.clear()                 # each fact was for the needles known then
        self._source = source
        return "ok"

    @staticmethod
    def _found(copies: dict, target: pathlib.Path, ident: tuple[int, int], name: str) -> None:
        names = copies[str(target)][1] if str(target) in copies else frozenset()
        copies[str(target)] = (ident, names | {name} if name else names)

    def _scan(self) -> None:
        """Walk the build for copies. Its result replaces what was known, except a known copy that still carries the frame
        under a name it was requested by (a name the walk need not see)."""
        copies = {}
        try:
            root = self.dist.resolve(strict=True)
        except OSError:
            self.copies = copies
            return
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                try:
                    target = (pathlib.Path(dirpath) / name).resolve(strict=True)
                    if target == root / CANONICAL or root not in target.parents:
                        continue
                    st = os.stat(target)
                    if _identity(st) != self.frame_id and self._carries(target, st, name):   # a link to the frame is an alias
                        self._found(copies, target, _identity(st), name)
                except OSError:
                    continue                    # unreadable here is unservable too; it never turns the frame off
        for path, (ident, names) in self.copies.items():
            if path not in copies and self._still_a_copy(path, ident, names):
                copies[path] = (ident, names)
        self.copies = copies

    def _still_a_copy(self, path: str, ident: tuple[int, int], names: frozenset[str]) -> bool:
        """The same file, still carrying the frame under any name it was found by. In doubt (unreadable now), it stays."""
        target = pathlib.Path(path)
        try:
            st = os.stat(target)
        except OSError:
            return False                        # gone
        try:
            return _identity(st) == ident and self._carries(target, st, *names)
        except OSError:
            return True

    def _prune(self) -> None:
        """Forget a known copy only once it is gone, or is a different file, or no longer carries the frame under any name
        it was found by (stand-in r1de.3 P2: a check by its own name alone forgot a copy found through an .html link)."""
        for path, (ident, names) in list(self.copies.items()):
            if not self._still_a_copy(path, ident, names):
                del self.copies[path]

    def _carries(self, target: pathlib.Path, st: os.stat_result, *names: str) -> bool:
        """Whether this version of a build file, served as `target` (and requested as `names`), carries the frame: it holds
        a known hash, or it is a document by either name or reads as HTML and a CSP meta in it names a hash. Raises
        OSError when it cannot be read, or changed while it was read."""
        if not stat.S_ISREG(st.st_mode):
            return False
        key = (self._generation,) + _version(st)
        facts = self._facts.get(key)
        if facts is None:
            facts = _content_facts(target, st, self.needles)
            if len(self._facts) >= _FACTS:
                self._facts.clear()
            self._facts[key] = facts
        found, shape, html = facts
        return bool(found) or (shape and (html or _is_document(target.name, *names)))

    def available(self) -> bool:
        """The `browser_mind` capability (§2.4): True only while the frame is served with its header and the build holds
        no copy of it."""
        self.refresh(scan=True)
        return self.source is not None

    def headers(self) -> dict[str, str]:
        return {"Content-Security-Policy": POLICY.format(source=self.source), "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-cache"}

    # ---- the per-request decision ----------------------------------------------------------------------------------

    def decide(self, scope: dict, target: pathlib.Path) -> str:
        """For a UI request whose resolved `target` is a file in the build: "frame" (serve with the frame header),
        "deny" (404), or "pass" (not the frame's business; the ordinary branch serves it)."""
        self.refresh()
        try:
            st = os.stat(target)
        except OSError:
            return "pass"
        ident = _identity(st)
        if ident == self.frame_id or self._is_frame_file(target, st):
            if self.source is not None and ident == self.frame_id and self._canonical_request(scope):
                return "frame"
            return "deny"
        name = pathlib.PurePosixPath(scope.get("path", "")).name
        try:
            if not self._carries(target, st, name):
                return "pass"
        except OSError:
            return "deny"                       # cannot be read (or changed meanwhile), so not shown not to be a copy
        self._found(self.copies, target, ident, name)   # a copy, however late it came: 404, and off while it stays
        return "deny"

    def _is_frame_file(self, target: pathlib.Path, st: os.stat_result) -> bool:
        """The frame file (by identity, even when it is not servable now) or any `.html` under `mind-iter/` (by the
        directory's identity, so a case variant of the directory counts too)."""
        frame = self.dist / CANONICAL
        try:
            if os.path.samefile(target, frame):
                return True
        except OSError:
            pass
        if not target.name.lower().endswith((".html", ".htm")):
            return False
        try:
            frame_dir = os.stat(self.dist / FRAME_DIR)
        except OSError:
            return False
        root = self.dist.resolve()
        for parent in target.parents:
            if parent == root or root not in parent.parents:
                break
            try:
                if _identity(os.stat(parent)) == _identity(frame_dir):
                    return True
            except OSError:
                continue
        return False

    @staticmethod
    def _canonical_request(scope: dict) -> bool:
        """The raw request path is the canonical one byte for byte, after the mount prefix: no percent-escapes at all (so
        what the server decoded is what was sent), and exactly `/mind-iter/mind-frame.html` below `root_path`."""
        raw = scope.get("raw_path")
        path = scope.get("path", "")
        if not isinstance(raw, (bytes, bytearray)) or b"%" in raw or raw.decode("latin-1") != path:
            return False
        root = scope.get("root_path", "") or ""
        if root and not path.startswith(root):
            return False
        return path[len(root):] == "/" + CANONICAL
