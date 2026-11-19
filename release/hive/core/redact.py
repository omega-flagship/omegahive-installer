# Purpose: the hive's one redactor: provider keys scrubbed from a local-owner hive's logs and errors, and what may leave
# any hive in a file a person shares cleaned of keys, ids, emails, home folders, OAuth codes, cookies and addresses.
"""One redactor for provider keys (J1 design r2 F, r3 N): what it scrubs never reaches a log line or an error.

- register(value): a key is registered the moment the hive holds it: loaded from the keyring or the environment, or
  submitted (before it is verified with its provider). Replaced keys stay registered until the process ends.
- scrub(text): every registered value, every ``sk-or-...`` / ``sk-ant-...`` / ``sk-...`` shaped token and every
  ``Bearer <token>`` becomes ``[redacted]``.
- Scrubbing is active only once enable() runs, which only the local-owner hive does (HIVE_LOCAL_OWNER=1): every other
  hive's logs and error texts are exactly as before. Registering is always harmless (an in-memory set).
- install_logging(): scrub factory records, every standard filter callback boundary, and final formatted text
  from Handler.format and QueueHandler.prepare (including later handlers and custom formatters). Post-factory
  extras and filter-replaced records are scrubbed; raw exception/traceback references are discarded after
  caching safe text. ScrubbingStream does the same for each print() write.
- The output boundary covers handlers using standard dispatch and self.format, not arbitrary custom emission
  or other code that bypasses these hooks. Logging instrumentation must not replace these hooks after enable();
  a repeated install refuses if their identity has changed. Non-logging access to caller objects is out of scope.

A key held in memory is out of scope (J1 design r2 F).

- clean(text): what may leave the hive in a file a person shares, on every hive, enable() or not: the keys registered
  here and the key shapes above, then the page's report rules (shared(): emails, home folders, keys and tokens, the
  ids of people and conversations, phone numbers, OAuth codes, cookie values and network addresses), so the hive's own
  log lines and error messages are clean before the logs a person exports carry them (GET /api/feedback/logs).
"""

from __future__ import annotations

import io
from collections.abc import Mapping
import logging
import logging.handlers
import re
import threading
from types import MemberDescriptorType

MARK = "[redacted]"
MIN_SECRET = 16  # local-owner registry accepts long provider keys/tokens, not ordinary words
PATTERNS = (
    re.compile(r"sk-(?:or|ant|proj)-[A-Za-z0-9_\-]{8,}"),
    re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"),
    re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._~+/=\-]{8,}"),
    re.compile(r"(?i)(x-api-key['\"]?\s*[:=]\s*['\"]?)[A-Za-z0-9._\-]{8,}"),
)


class Redactor:
    def __init__(self):
        self._values: set[str] = set()
        self._ordered_values = ()
        self._lock = threading.Lock()
        self.enabled = False

    def register(self, value):
        value = str(value or "").strip()
        if value in MARK or MARK in value:
            return  # the replacement marker must never contain an accepted registered secret
        if len(value) >= MIN_SECRET:
            with self._lock:
                if value not in self._values:
                    self._values.add(value)
                    self._ordered_values = tuple(sorted(self._values, key=len, reverse=True))

    def unregister(self, value):
        """gateway r1c (plan §2.6): a value that no longer needs scrubbing (a revoked or expired mind token) is dropped,
        so the set does not grow with every token the hive ever minted. Unknown values are ignored."""
        value = str(value or "").strip()
        with self._lock:
            self._values.discard(value)

    def holds(self, value):
        with self._lock:
            return str(value or "").strip() in self._values

    def registered(self):
        with self._lock:
            return len(self._values)

    def scrub(self, text):
        if not self.enabled or text is None:
            return text
        if not isinstance(text, str):
            return text
        with self._lock:
            values = self._ordered_values   # cached longest-first snapshot, refreshed only on registration
        for value in values:
            if value in text:
                text = text.replace(value, MARK)
        for pattern in PATTERNS:
            text = pattern.sub(lambda m: (m.group(1) if m.groups() and m.group(1) else "") + MARK, text)
        return text


REDACTOR = Redactor()


def register(value):
    REDACTOR.register(value)


def unregister(value):
    REDACTOR.unregister(value)


def scrub(text):
    return REDACTOR.scrub(text)


# ---- what may leave the hive in a file a person shares ---------------------------------------------------------------
# The page's report rules (hive/ui/src/features/feedback/report.ts REDACTIONS), in its order and with its words, so the
# hive and the page clean a line alike: hive/ui/src/features/feedback/redact.cases.json holds the cases both test suites
# run. ASCII classes and word edges, as JavaScript's are without its u flag.
_IPV4 = r"(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}"
_H = "[0-9a-f]{1,4}"
# every written form of an IPv6 address (the forms Sentry Relay's IPV6_REGEX lists, relay-pii/src/regexes.rs), never a
# bare "::" nor a time like 12:34:56, and whole: no word character or colon on either side, nor a zone or IPv4 tail
# left after
_IPV6 = (r"(?<![\w:.])(?:" + "|".join([
    rf"(?:{_H}:){{7}}{_H}", rf"(?:{_H}:){{1,7}}:", rf"(?:{_H}:){{1,6}}:{_H}", rf"(?:{_H}:){{1,5}}(?::{_H}){{1,2}}",
    rf"(?:{_H}:){{1,4}}(?::{_H}){{1,3}}", rf"(?:{_H}:){{1,3}}(?::{_H}){{1,4}}", rf"(?:{_H}:){{1,2}}(?::{_H}){{1,5}}",
    rf"{_H}:(?::{_H}){{1,6}}", rf":(?::{_H}){{1,7}}", r"fe80:(?::[0-9a-f]{0,4}){0,4}%[0-9a-z]+",
    rf"::(?:ffff(?::0{{1,4}})?:)?{_IPV4}", rf"(?:{_H}:){{1,4}}:{_IPV4}"]) + r")(?![\w:%]|\.\d)")
# the session and sign-in cookies the hive sets (people.SIGNIN_COOKIE and OAUTH_COOKIE, sso.SESSION_COOKIE,
# app.GOOGLE_CONNECTOR_COOKIE) and the common ones Relay's SENSITIVE_COOKIE_NAMES lists
COOKIES = ("hive_signin", "hive_oauth", "hive_google_connector", "omega_session", "session", "sessionid",
           "__session", "user_session", "connect.sid", "jsessionid", "phpsessid", "laravel_session", "csrf", "xsrf",
           "_csrf", "_xsrf", "csrf-token", "csrf_token", "xsrf-token", "xsrf_token")
_I = re.IGNORECASE | re.ASCII
SHARED = (
    (re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", _I), "[email]"),
    (re.compile(r"(?:/Users|/home)/[^/\s]+", re.ASCII), "~"),
    (re.compile(r"\b[A-Z]:\\Users\\[^\\\s]+", _I), "~"),
    (re.compile(r"\bBearer\s+\S+", re.ASCII), "Bearer [token]"),
    (re.compile(r"\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}", re.ASCII), "[key]"),
    (re.compile(r"\bc_[A-Za-z0-9_.-]*~[A-Za-z0-9_:~.-]+", re.ASCII), "[conversation]"),
    (re.compile(r"user:[A-Za-z0-9_.-]+", re.ASCII), "[person]"),
    (re.compile(r"\+\d[\d\s().-]{6,}\d", re.ASCII), "[phone]"),
    # an OAuth flow's codes and tokens where an address carries them, and a code named as one, short ones included
    (re.compile(r"([?&#](?:code|state|code_verifier|code_challenge|oauth_token|oauth_verifier|access_token"
                r"|refresh_token|id_token|client_secret|token)=)[^&#\s\"'<>]+", _I), r"\1[code]"),
    (re.compile(r"\b((?:authori[sz]ation|auth|oauth|device|user|verification|one[-_ ]?time|otp)[-_ ]?code[\"']?"
                r"\s*[:=]\s*[\"']?)[^\s\"',;&]+", _I), r"\1[code]"),
    # any other code given as code=, code: or "code" and then a value of 6 or more with a digit in it ("code=3b9c8a5f",
    # "oauth code 4/0AbC1"), never a word such as an error's code (rate_limited) nor a status (code 429)
    (re.compile(r"\b((?:(?:authori[sz]ation|auth|oauth|device|verification|one[-_ ]?time|otp)[-_ ]?)?code[\"']?"
                r"(?:\s*[:=]\s*[\"']?|\s+))(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{6,}", _I), r"\1[code]"),
    # cookie values: a Cookie or Set-Cookie header's whole value, and a session or sign-in cookie's wherever it is named
    (re.compile(r"\b((?:set-)?cookie[\"']?\s*[:=]\s*[\"']?)[^\n\"']+", _I), r"\1[cookie]"),
    (re.compile(r"\b((?:" + "|".join(re.escape(c) for c in COOKIES) + r")=)[^;\s&\"']+", _I), r"\1[cookie]"),
    # network addresses
    (re.compile(_IPV6, _I), "[address]"),
    (re.compile(rf"\b{_IPV4}\b", re.ASCII), "[address]"),
    # a long run of letters and digits with both in it: a key, a token or a secret's digest, never a word
    (re.compile(r"\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b", re.ASCII), "[token]"),
    # what the report importer reads as its own: its hidden marker
    (re.compile(r"<!--|-->"), ""),
)


def shared(text: str) -> str:
    """`text` through SHARED, the page's report rules, exactly as the page's redact() cleans it (but for its label rule,
    which only a report's fields need). Time: one pass over the text per rule."""
    for pattern, put in SHARED:
        text = pattern.sub(put, text)
    return text


def clean(text: str) -> str:
    """`text` as it may leave the hive in a file a person shares (a report, the logs they export): the keys this hive
    holds (register) and the shapes of provider keys (PATTERNS) as [key], then the page's report rules (shared). Always
    applied, whatever enable() did, since a shared file leaves every kind of hive.
    Example: "sign-in for ana@example.org from 203.0.113.9 with code=4f2a91" -> "sign-in for [email] from [address] with
    code=[code]". Time: r + p + s passes over the text, r the keys held, p and s the two pattern tables' lengths."""
    with REDACTOR._lock:
        values = REDACTOR._ordered_values   # the cached longest-first snapshot scrub() reads
    for value in values:
        if value in text:
            text = text.replace(value, "[key]")
    for pattern in PATTERNS:
        text = pattern.sub(lambda m: (m.group(1) if m.groups() and m.group(1) else "") + "[key]", text)
    return shared(text)


_installed = False
_FORMAT_VERB = re.compile(r"%(?:\([^)]*\))?[#0+ -]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?[diouxXeEfFgGcrsa%]")

# Explicit union of supported logging fields; independent of the importing interpreter's record layout.
_STANDARD_RECORD_KEYS = frozenset({
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName", "levelname", "levelno",
    "lineno", "message", "module", "msecs", "msg", "name", "pathname", "process", "processName",
    "relativeCreated", "stack_info", "taskName", "thread", "threadName"})
_OUTPUT_OWNER = object()
_EMIT_OWNER = object()
_installed_hooks = None


def _scrub_log_arg(value):
    """Keep safe built-in argument shape; replace object/subclass payloads with scrubbed text.

    Foreign numeric-only format requirements may force a flat, scrubbed fallback. Arbitrary
    caller objects are never reconstructed merely to preserve their custom repr/format hooks.
    """
    if isinstance(value, str):
        return REDACTOR.scrub(str.__str__(value))
    if isinstance(value, Mapping):
        return {_scrub_log_arg(key): _scrub_log_arg(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return (tuple if isinstance(value, tuple) else list)(_scrub_log_arg(item) for item in value)
    text = str.__str__(str(value))
    clean = REDACTOR.scrub(text)
    if value is None or type(value) in (bool, int, float):
        return value if clean == text else clean
    return clean


def _scrub_record(record):
    if not REDACTOR.enabled:
        return record
    try:
        message = record.getMessage()
    except Exception:   # malformed input: preserve scrubbed context, without live %-verbs
        message = _FORMAT_VERB.sub(lambda match: "%" if match.group() == "%%" else "[unavailable]",
                                   str.__str__(str(record.msg)))
    try:
        record.msg = REDACTOR.scrub(str.__str__(str(record.msg)))
        record.args = _scrub_log_arg(record.args)
        rendered = record.getMessage()
        if REDACTOR.scrub(rendered) != rendered:
            raise ValueError("redaction crosses formatting boundaries")
    except Exception:   # bad formats, recursive args or changed numeric/key formatting
        record.msg, record.args = REDACTOR.scrub(message), ()
    if record.exc_info and not record.exc_text:
        try:
            record.exc_text = logging.Formatter().formatException(record.exc_info)
        except Exception:
            record.exc_text = "[unavailable exception text]"
    record.exc_info = None  # no raw exception object, traceback frames or locals reach a handler
    if record.exc_text:
        record.exc_text = REDACTOR.scrub(str.__str__(str(record.exc_text)))
    if record.stack_info:
        record.stack_info = REDACTOR.scrub(str.__str__(str(record.stack_info)))
    # Extras may have been attached after the factory or introduced by a later filter.
    for key, value in list(record.__dict__.items()):
        if key in ("msg", "args", "exc_info", "exc_text", "stack_info"):
            continue
        try:
            clean = _scrub_log_arg(value)
        except Exception:
            clean = "[unavailable]"
        if key in _STANDARD_RECORD_KEYS:
            record.__dict__[key] = clean
        else:
            clean_key = _scrub_log_arg(key)
            del record.__dict__[key]  # replacing an equal key alone can retain a subclass object
            record.__dict__[clean_key] = clean
    # A replacement LogRecord may retain fields outside __dict__, including shadowed base slots.
    # Use each declaring class's descriptor, so inherited/private and duplicate slot storage is scrubbed.
    for cls in type(record).__mro__:
        names = cls.__dict__.get("__slots__", ())
        if isinstance(names, str):
            names = (names,)
        for name in names:
            if name in ("__dict__", "__weakref__"):
                continue
            class_name = cls.__name__.lstrip("_")
            if name.startswith("__") and not name.endswith("__") and class_name:
                name = "_" + class_name + name
            slot = cls.__dict__.get(name)
            if not isinstance(slot, MemberDescriptorType):
                continue
            try:
                value = slot.__get__(record, type(record))
            except AttributeError:  # optional slot not initialized
                continue
            try:
                clean = _scrub_log_arg(value)
            except Exception:
                clean = "[unavailable]"
            slot.__set__(record, clean)
    return record


def _output_text(value):
    """Final rendered text is checked after composition, then detached from lazy str subclasses."""
    return REDACTOR.scrub(str.__str__(str(value))) if REDACTOR.enabled else value


def _protect_handler_format(handler):
    current = handler.format
    if getattr(current, "_omega_output_owner", None) is _OUTPUT_OWNER:
        return
    def output(record):
        if REDACTOR.enabled:
            _scrub_record(record)
        return _output_text(current(record))
    output._omega_output_owner = _OUTPUT_OWNER
    handler.format = output


def _protect_handler(handler):
    _protect_handler_format(handler)
    current = handler.emit
    if getattr(current, "_omega_emit_owner", None) is _EMIT_OWNER:
        return
    def emit(record):
        # Handler.handle truth-tests its filter result after Filterer.filter has returned.
        # A LogRecord subclass can mutate during that test: guard the actual consumer entry.
        if REDACTOR.enabled:
            _scrub_record(record)
        return current(record)
    emit._omega_emit_owner = _EMIT_OWNER
    handler.emit = emit


def install_logging():
    """Protect standard logging dispatch and its final output, including later handlers.

    Records are scrubbed before/after each filter callback and its truth test, and at the actual
    emitter/formatter consumer entry. Raw exc_info is discarded,
    and final handler-format / QueueHandler.prepare output scrubbed after composition.
    A handler may override format when using standard handle/filter dispatch: its callable
    is wrapped on entry. Custom emit/handle/prepare code bypassing those entry points is
    outside this boundary, as is non-logging code's access to caller objects.
    Logging instrumentation must not replace these hooks after enable(); a repeated install
    detects changes and refuses rather than silently claiming that interception survives.
    """
    global _installed, _installed_hooks
    if _installed:
        current = (logging.getLogRecordFactory(), logging.Filterer.filter, logging.Handler.format,
                   logging.Handler.handle, logging.handlers.QueueHandler.prepare)
        if current != _installed_hooks:
            raise RuntimeError("logging redaction hooks changed")
        return
    prior_factory = logging.getLogRecordFactory()
    prior_filter = logging.Filterer.filter
    prior_format = logging.Handler.format
    prior_handle = logging.Handler.handle
    prior_prepare = logging.handlers.QueueHandler.prepare

    def factory(*args, **kwargs):
        return _scrub_record(prior_factory(*args, **kwargs))

    def filter_record(self, record):
        if not REDACTOR.enabled:
            return prior_filter(self, record)
        if isinstance(self, logging.Handler):
            _protect_handler(self)
        _scrub_record(record)
        for callback in self.filters:
            _scrub_record(record)
            result = callback.filter(record) if hasattr(callback, "filter") else callback(record)
            accepted = bool(result)  # match standard order; truth testing can itself mutate fields
            if accepted and isinstance(result, logging.LogRecord):
                record = result
            _scrub_record(record)
            if not accepted:
                return False
        return record

    def format_record(self, record):
        if REDACTOR.enabled:
            _scrub_record(record)
        return _output_text(prior_format(self, record))
    format_record._omega_output_owner = _OUTPUT_OWNER

    def handle_record(self, record):
        if REDACTOR.enabled:
            _protect_handler(self)
            _scrub_record(record)
        return prior_handle(self, record)

    def prepare_record(self, record):
        if REDACTOR.enabled:
            _protect_handler(self)
            _scrub_record(record)
        prepared = prior_prepare(self, record)
        if REDACTOR.enabled:
            _scrub_record(prepared)
            prepared.msg = _output_text(prepared.msg)
            prepared.message = _output_text(prepared.message)
        return prepared

    logging.setLogRecordFactory(factory)
    logging.Filterer.filter = filter_record
    logging.Handler.format = format_record
    logging.Handler.handle = handle_record
    logging.handlers.QueueHandler.prepare = prepare_record
    _installed_hooks = (factory, filter_record, format_record, handle_record, prepare_record)
    _installed = True


class ScrubbingStream(io.TextIOBase):
    """A text stream that scrubs each write before passing it on (stdout/stderr of the local-owner hive)."""

    def __init__(self, inner):
        self._inner = inner

    def write(self, text):
        return self._inner.write(REDACTOR.scrub(text))

    def flush(self):
        return self._inner.flush()

    def fileno(self):
        return self._inner.fileno()

    def isatty(self):
        return self._inner.isatty()

    @property
    def encoding(self):
        return getattr(self._inner, "encoding", "utf-8")


def enable():
    REDACTOR.enabled = True
    install_logging()


PROVIDER_CATEGORY = {401: "auth", 403: "auth", 402: "billing", 404: "not_found", 408: "timeout", 413: "too_large",
                     422: "bad_request", 400: "bad_request", 429: "rate_limited"}


def provider_category(status):
    """A provider's answer status as this hive names it (never anything the provider wrote)."""
    status = int(status)
    return PROVIDER_CATEGORY.get(status) or ("unavailable" if status >= 500 else "provider_error")


def provider_error_text(name, response):
    """What a provider's failed answer may say, on every hive (keyview R8, sol and Kimi on 1edef3b4): its HTTP status and
    this hive's own category for it, never the provider's text or its own error code (both can echo ids, account
    names or a fragment of the key itself)."""
    return f"{name} answered {response.status_code} ({provider_category(response.status_code)})"
