# Scratch-Space Organ - Design Notes for Review
## Purpose
Volatile short-term reasoning workspace for draft atoms before promotion to durable memory. Inspired by working-memory/buffer concepts from cognitive architecture.
## Architecture
- **&scratch** AtomSpace: bounded, volatile, TTL-governed
- **&scratch-ttl** AtomSpace: tracks remaining loops per atom
- **scratch-add** / **scratch-remove**: add with TTL (default 3 loops), remove with hash cleanup
- **scratch-gc**: loop-cycle garbage collection - decrements TTLs, expires stale drafts
- **promote-scratch**: copy verified atom to &beliefs (confidence 0.5/0.5 for draft origin), remove from scratch, record event
- **scratch-find / scratch-examples / scratch-pressure**: query and introspection
## Design Questions for Reviewers
1. Is TTL-based expiry in loops the right decay model, or should we use time-based or attention-weighted expiry?
2. Should promotion always reduce confidence (0.5/0.5) for scratch origin, or preserve source confidence?
3. How should scratch interact with ECAN attention allocation - should scratch atoms compete for STI/LTI?
4. Is promote-scratch to &beliefs the right target, or should there be intermediate confidence stages?
5. How does this relate to hyperon/MeTTa grounding - should scratch atoms be grounded before promotion?
## Key Files
- organs/scratch-space/scratch.metta - core add/remove/gc
- organs/scratch-space/init-scratch.metta - space initialization
- organs/scratch-space/gc-scratch.metta - garbage collection
- organs/scratch-space/promote-scratch.metta - promotion pipeline
- src/scratch-space/skills.metta - skill catalog entries
## Current Status
- MeTTa definitions exist but are NOT loaded into &self (unresolved when eval'd raw)
- Skills registered in catalog but no Python dispatch path found
- Organ boot/loading mechanism needs investigation