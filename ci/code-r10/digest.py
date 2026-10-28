"""Recompute the Code candidate source digest: SHA256 over sorted (path relative to the omegacode package, NUL,
file SHA256, LF) for every .py module."""
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1])
rows = sorted((str(p.relative_to(root)), hashlib.sha256(p.read_bytes()).hexdigest()) for p in root.rglob("*.py")
              if "__pycache__" not in p.parts)
h = hashlib.sha256()
for rel, s in rows:
    h.update(rel.encode() + b"\0" + s.encode() + b"\n")
print(len(rows), h.hexdigest())
