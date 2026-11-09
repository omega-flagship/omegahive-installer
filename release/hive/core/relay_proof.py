"""Same-connection relay proof (Code wire proposal R1, adopted 2026-10-28).

The hive sends a person's capability bearer to the Code service only after the listener that will receive it has
proved, on that very TCP connection, that it holds this service's enrolled capability_secret:

  1. POST /v1/relay-challenge {version, service_id, nonce, method, path, body_sha256}   (no bearer)
  2. <- {version, challenge_id, proof}, proof = HMAC-SHA256(secret, "omegacode-relay-v1\\n" + canonical JSON of
     {service_id, nonce, method, path, body_sha256, challenge_id})
  3. the one bound request, with the bearer and X-OmegaCode-Relay-Challenge: <challenge_id>, on the same socket.

Canonical JSON is json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) as UTF-8. Plain HTTP/1.1
over one asyncio stream: no pooling, redirects, retries or fallback connection. Anything unexpected refuses, and
the bearer is never written. Same-host transparent proxies and same-account adversaries are outside this check.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import secrets
from urllib.parse import urlsplit

PROOF_DOMAIN = b"omegacode-relay-v1\n"
MAX_HEAD = 16384
MAX_CHALLENGE_BODY = 4096
MAX_BODY = 64 * 1024 * 1024
PROOF_WINDOW = 4.0                     # seconds; Code expires a challenge after 5


class RelayProofError(Exception):
    pass


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def expected_proof(secret: str, fields: dict) -> str:
    return hmac.new(secret.encode(), PROOF_DOMAIN + canonical(fields), hashlib.sha256).hexdigest()


async def _read_response(reader, limit):
    head = await reader.readuntil(b"\r\n\r\n")
    if len(head) > MAX_HEAD:
        raise RelayProofError("response head too large")
    lines = head.decode("latin-1").split("\r\n")
    m = re.fullmatch(r"HTTP/1\.1 (\d{3}) .*", lines[0]) or re.fullmatch(r"HTTP/1\.1 (\d{3})", lines[0])
    if not m:
        raise RelayProofError("not an HTTP/1.1 response")
    headers = {}
    for line in lines[1:]:
        if line:
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
    if "transfer-encoding" in headers:
        raise RelayProofError("chunked responses are not accepted")
    length = headers.get("content-length", "")
    if not length.isdecimal() or int(length) > limit:
        raise RelayProofError("response length missing or too large")
    body = await reader.readexactly(int(length))
    return int(m.group(1)), headers, body


def _request(method, path, host, headers, body) -> bytes:
    lines = [f"{method} {path} HTTP/1.1", f"Host: {host}", "Connection: keep-alive",
             f"Content-Length: {len(body)}"] + [f"{k}: {v}" for k, v in headers.items()]
    return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + body


# Headers a relay may add to the one bound request besides its own. X-Hive-Token is a mind's member token: Code binds an
# agent capability to it, so a mind's relayed call must carry it (2026-10-29: minds relay through the hive).
EXTRA_HEADERS = {"X-Hive-Token"}
HEADER_VALUE = re.compile(r"[!-~]{1,4096}")


async def proved_request(address: str, service_id: str, secret: str, method: str, path: str, body: bytes,
                         bearer: str, content_type: str = "application/json", timeout: float = 60.0,
                         extra_headers: dict | None = None):
    """Challenge, verify, then send the one bound request on the same connection. Returns (status, headers, body)."""
    url = urlsplit(address)
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path not in ("", "/"):
        raise RelayProofError("the Code address is not a loopback HTTP listener")
    if not re.fullmatch(r"/[!-~]*", path) or method.upper() != method:
        raise RelayProofError("the relayed path or method is not canonical")
    extra = dict(extra_headers or {})
    if set(extra) - EXTRA_HEADERS or not all(isinstance(v, str) and HEADER_VALUE.fullmatch(v) for v in extra.values()):
        raise RelayProofError("only a well-formed X-Hive-Token may be added to a relayed request")
    host = f"127.0.0.1:{url.port}"
    fields = {"version": 1, "service_id": service_id, "nonce": secrets.token_hex(32), "method": method,
              "path": path, "body_sha256": hashlib.sha256(body).hexdigest()}
    loop = asyncio.get_running_loop()
    proved_by = loop.time() + PROOF_WINDOW                         # challenge -> bound request inside Code's expiry
    reader, writer = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", url.port), timeout=PROOF_WINDOW)
    try:
        sock = writer.get_extra_info("socket")
        local = sock.getsockname() if sock is not None else None
        challenge = canonical(fields)
        writer.write(_request("POST", "/v1/relay-challenge", host, {"Content-Type": "application/json"}, challenge))
        await writer.drain()
        status, _headers, raw = await asyncio.wait_for(_read_response(reader, MAX_CHALLENGE_BODY),
                                                       timeout=max(0.01, proved_by - loop.time()))
        if status != 200:
            raise RelayProofError(f"relay challenge refused ({status})")
        answer = json.loads(raw)
        if type(answer) is not dict or answer.get("version") != 1 or set(answer) != {"version", "challenge_id", "proof"}:
            raise RelayProofError("relay challenge answer malformed")
        challenge_id, proof = answer["challenge_id"], answer["proof"]
        if type(challenge_id) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", challenge_id) \
                or type(proof) is not str or not re.fullmatch(r"[0-9a-f]{64}", proof):
            raise RelayProofError("relay challenge answer malformed")
        if loop.time() > proved_by:
            raise RelayProofError("the relay challenge took too long")
        bound = {k: fields[k] for k in ("service_id", "nonce", "method", "path", "body_sha256")}
        bound["challenge_id"] = challenge_id
        if not hmac.compare_digest(proof, expected_proof(secret, bound)):
            raise RelayProofError("relay proof does not verify")
        # same socket: the stream is the one we challenged on, still open, still bound to the same local endpoint
        if writer.is_closing() or reader.at_eof() or (sock is not None and sock.getsockname() != local):
            raise RelayProofError("the challenged connection did not stay open")
        if loop.time() > proved_by:
            raise RelayProofError("the relay challenge took too long")
        writer.write(_request(method, path, host, {"Authorization": f"Bearer {bearer}", "Content-Type": content_type,
                                                    "X-OmegaCode-Relay-Challenge": challenge_id, **extra}, body))
        await writer.drain()
        return await asyncio.wait_for(_read_response(reader, MAX_BODY), timeout=timeout)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ValueError, OSError) as exc:
        raise RelayProofError(f"relay exchange failed ({type(exc).__name__})") from exc
    finally:
        writer.close()
