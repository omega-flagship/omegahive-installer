# Extracted from helper.py to keep OmegaClaw membranes reviewable.
import os
import pathlib
import sqlite3
import uuid

CORE_ROOT = pathlib.Path(__file__).resolve().parents[1]
MEMORY_DIR = pathlib.Path(os.environ.get("OMEGACLAW_MEMORY_DIR", CORE_ROOT / "memory"))

def promotion_open_map(path=None):
    global _PROMOTION_CONN
    path = pathlib.Path(path) if path else MEMORY_DIR / "promotions.db"
    path.parent.mkdir(parents=True, exist_ok=True)
    _PROMOTION_CONN = sqlite3.connect(path)
    _PROMOTION_CONN.execute("PRAGMA journal_mode=WAL")
    _PROMOTION_CONN.execute("PRAGMA synchronous=NORMAL")
    _PROMOTION_CONN.execute("""
        CREATE TABLE IF NOT EXISTS kv (
            key BLOB PRIMARY KEY,
            value REAL NOT NULL,
            lasttime REAL
        )
    """)
    _PROMOTION_CONN.commit()

def promotion_key(k):
    if isinstance(k, uuid.UUID):
        return k.bytes
    if isinstance(k, str):
        return uuid.UUID(k).bytes
    if isinstance(k, bytes) and len(k) == 16:
        return k
    raise TypeError("key must be uuid.UUID, UUID string, or 16-byte UUID")

def promotion_set_value(k, v):
    _PROMOTION_CONN.execute(
        """
        INSERT INTO kv(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (promotion_key(k), float(v))
    )

def promotion_get_value(k, default=None):
    row = _PROMOTION_CONN.execute(
        "SELECT value FROM kv WHERE key = ?",
        (promotion_key(k),)
    ).fetchone()
    return row[0] if row else default

def promotion_get_all_keys():
    rows = _PROMOTION_CONN.execute(
        "SELECT key FROM kv"
    ).fetchall()
    return [str(uuid.UUID(bytes=row[0])) for row in rows]

def promotion_set_lasttime(k, t):
    _PROMOTION_CONN.execute(
        """
        INSERT INTO kv(key, value, lasttime)
        VALUES (?, 0.0, ?)
        ON CONFLICT(key) DO UPDATE SET lasttime = excluded.lasttime
        """,
        (promotion_key(k), float(t))
    )

def promotion_get_lasttime(k, default=None):
    row = _PROMOTION_CONN.execute(
        "SELECT lasttime FROM kv WHERE key = ?",
        (promotion_key(k),)
    ).fetchone()
    return row[0] if row and row[0] is not None else default

def promotion_has_key(k):
    row = _PROMOTION_CONN.execute(
        "SELECT 1 FROM kv WHERE key = ?",
        (promotion_key(k),)
    ).fetchone()
    return row is not None

def promotion_delete_key(k):
    _PROMOTION_CONN.execute(
        "DELETE FROM kv WHERE key = ?",
        (promotion_key(k),)
    )

def promotion_commit():
    _PROMOTION_CONN.commit()

def promotion_close_map():
    global _PROMOTION_CONN
    if _PROMOTION_CONN is not None:
        _PROMOTION_CONN.commit()
        _PROMOTION_CONN.close()
        _PROMOTION_CONN = None
