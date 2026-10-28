# Key-locked minds: a fixed payer with existing owner grants

This generic Hive change adds `options.key_locked: true`. A locked mind spends on its owner's assigned personal key and refuses rather than falling back to another payer. It introduces no app-specific caller rule or authority.

Only the mind's owner may set or clear the lock, or change `options.key` while the stored options are locked, including when the lock stays on. Every options write and import must retain an owner-held key while locked; an admin cannot move the key or unlock the mind. Options updates replace the whole object. When the stored options are locked, an options write that omits `key_locked` is refused with `409 lock_confirm`: "send key_locked: true to keep the lock, or key_locked: false to unlock". The owner must explicitly send `key_locked: false` to unlock; an explicit boolean survives options cleaning and is stored. A locked mind without its owner's key gets `own_key_needed`; a missing or incompatible assigned key gets `key_unavailable`. A key used by locked minds cannot be removed unless its owner explicitly forces removal; the minds retain that key ID and stop until repaired by their owner.

Host-initiated re-resolves (for example, `studio_makers._resolve` acting as `hive:studio-maker`) on a locked mind are refused with `409 lock_confirm` by design when the options write omits the lock confirmation. The host is a non-owner; the owner explicitly confirms `key_locked: true` to retain the lock. This fail-closed behavior is not a regression.

Both `DELETE /api/keys/{key_id}` and `DELETE /api/providers/{name}/key` use the same guarded stored-key removal. The provider route resolves its current default stored key and retains its admin-only authorization and provider-status response; an admin cannot force removal of another person's locked key. The key route still lets a member remove their own key. On either path, unlocked minds assigned to the removed key are unassigned with the acting principal, while locked minds retain the removed key ID. Options are parsed once per active mind and matched structurally, including escaped JSON spellings. `options.key_locked` accepts only JSON booleans, not numeric `0` or `1`.

A member's newly added key can become the provider default implicitly when there is no existing stored or environment default. This existing default-selection behavior is unchanged; removal of that default now passes the same lock and owner guard. Environment keys are not removed by the provider's stored-key route.

The lock fixes the paying key. The existing `OwnHive.person_key_check` still permits its owner, a person explicitly granted a live limit on that key, and a caller with no person behind the work. A non-owner without a grant receives `own_key_needed`. Guests and public visitors remain subject to the existing H1 `use_check` rules. An owner grant preserves the same paying key while attributing the call to the grantee and their existing limit scope. It does not unlock or move the mind. No `key_locked` branch belongs in `person_key_check`.

`Gateway.paying_key` checks the assigned key and its owner before returning it. `Budgets.check` applies `OwnHive.use_check`, including caller admission and existing grant limits. The Ask conductor checks `person_key_check` explicitly for its asking principal before budget admission or dispatch. `Hive.payer_for` and `record_usage` retain existing grantee attribution. Locked paid embeddings and Studio media use the assigned key; embeddings use the free local embedder when that key belongs to a different provider. Unlocked paying-key selection is unchanged. This is a host contract; no UI, credential export or deployment is included.

## Tests

`hive/tests/test_key_lock_p3a.py` covers the lock contract with synthetic data and no provider calls:

- only the owner can set, clear or move the lock or the locked key, including an admin moving a locked mind between two keys the owner holds, an admin repointing it after a forced key removal, and a non-owner import that changes the key;
- an options write that omits `key_locked` on a locked mind gets `409 lock_confirm` and leaves the stored state unchanged; an explicit `false` from the owner unlocks, and an explicit `false` from anyone else gets `403 key_lock_owner_only`;
- both key-removal routes use the same guarded removal, `key_locked` accepts JSON booleans only, and key matching is structural;
- a grant from the owner keeps the same paying key, attributes usage to the grantee and is refused again after revocation.
