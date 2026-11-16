"""The hive's ONE key-id grammar (keyview R9, Dot on a0975c2f): every module that accepts, matches or redacts a key id
builds from these, so a key the hive can hold is exactly a key every check recognises.

- STORED: a stored key's id, k_ + 8 or 32 lowercase hex digits;
- ENV: an environment key, env:<provider>;
- KEY_ID: either. Patterns are bare (no anchors, no groups that capture); callers anchor or wrap them.
"""

STORED = r"k_(?:[0-9a-f]{32}|[0-9a-f]{8})"
ENV = r"env:[a-z0-9_-]+"
KEY_ID = r"(?:" + STORED + "|" + ENV + r")"
