# P2.1 total-only limits

A numeric-only monthly-total change preserves an active helper and its existing authority. It does not silently sleep helpers or revoke otherwise valid work. The next ensure, repair or setup must use the current total and consent card; a stale shown total returns the current card without minting new authority or sleeping the existing helper.

Key and template changes, consent withdrawal, missing required limits and uninstall remain distinct authority boundaries. Numeric edits do not replace the assigned own-key lock with shared-key authority. Every paid call still passes current budget enforcement and the P3a key lock. Existing template/key invalidation, withdrawal and uninstall/revocation paths remain load-bearing; this patch does not relax them or claim broad uninstall qualification.

## Expired totals, setup notice and spend note

An expired total refuses like a missing or revoked total, using the existing active-limit filter. Setup may return a content-free `total_changed_during_setup` notice alongside `ready` only when the final live-consent boundary remains valid; existing stale-card and partial-setup paths remain `consent_required` and do not create later helpers. Budget admission remains estimate-based; the full actual cost is recorded even when an estimate is low. The host-authored card JSON adds the fixed `spend_note` outside consent binding. Its visible renderer is a separate follow-up change.

## Tests

`hive/tests/test_person_swarm_total_consent_p2_1.py` covers same, raised and lowered totals; ongoing driver state and ordinary reads; current paid-call cap admission; next ensure and repair cards and stale-card refusal; changes within setup; continued program actions; and retained template, key, withdrawal, uninstall and missing-total revocation. It also covers a lowered total with open holds, a total change across budget preflight and reservation, a first setup where the total changes after the first helper so the second waits for fresh consent, the content-free ready hint after final live consent, a missing-total and restoration race, and the fixed spend-note card and binding. One existing boundary case that expected a total-only change to revoke a wake now expects the wake to stay authorised, and an expired-total case was added to the existing revocation test. All data is synthetic.
