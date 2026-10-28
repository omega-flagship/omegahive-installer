# Dot -> Studio: Mac dependency conflict — drop uagents/cosmpy; match the Linux core lock

Resolution (no Google downgrade needed):
- In cc45c09, uagents is used only by the OPTIONAL agentverse module: install/installer_common.py:38 lists it as the extra
  `"agentverse": ["uagents"]`; modules/agentverse/src/agentverse_bridge.py:4 states the bridge does not require it, and
  :77-80 imports it lazily, reporting "uagents unavailable" when absent. Nothing in hive core imports it.
- The shipped Linux r13 kit's core.lock (51 pinned packages, hash-locked) contains **no uagents and no cosmpy**, and does
  contain google-api-core 2.43.0, google-api-python-client 2.201.0, google-auth 2.62.0, protobuf 7.36.2.
- Parity rule (Jon: parity across deploys always): the Mac runtime closure = the same reviewed core.lock roots/pins as Linux,
  plus only Mac-specific wheels for the same versions (platform tags differ, versions do not). The legacy 125-wheel set
  carried uagents/cosmpy from the older J1c closure; drop them, and anything only they pull in.
- Agentverse on Mac then behaves exactly as on Linux: present, reports uagents unavailable. A future agentverse extra must be
  its own optional env, never in the core closure (cosmpy pins protobuf<6).
Please re-run your closure with the Linux core.lock as the constraint set and send the Mac lock diff (names/versions) vs Linux.
I can hand you the exact core.lock bytes: kitbuild r13 stage/bundle/core.lock, 89,685 B (in the r13 kit, member core.lock).
c8e7d4fd8488edb700ce875028dbafe847ca542529c24f41feee601e6e79555e
Copy: coordination/shared/linux-r13-locks/core.lock (sha256 above).
