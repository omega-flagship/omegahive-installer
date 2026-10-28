# P14: apps work as soon as they're installed

An installed app must just work. Installing is the admin review, and a person opening a person app gets their own private context straight away, with no setup screen unless something real fails.

Code: `core/person_apps.py`. Tests: `tests/test_p14_ready_on_install.py`, `ui/src/lib/personAppOpen.test.ts` and `ui/src/features/programs/personAppPage.test.ts`.

## Manifest

These keys live in `plugin.json`, so the release digest pins them. They are parsed with `swarm_templates` and `related_apps`. A bad value stops the app from loading.

- **`placement`:** `"swarm"` (the default) or `"person"`. Existing apps are unchanged.
- **`person_allow`:** `"all"` (the default), or a list of 1 to 500 unique `user:u_…` principals. It is only valid on a person app.

## Install is the review

| Route | Purpose |
|---|---|
| `POST /api/programs/{id}/install` with `{release_digest, placement, person_allow?, use_in?}` | Install the app. This is the review. |
| `GET /api/programs/{id}/install` | Status. Members see the placement and whether the app is installed. Admins also see the release and the review. |
| `PUT /api/programs/{id}/install/person-allow` | Narrow who may use the app. |
| `DELETE /api/programs/{id}/install` | Revoke the review. |

The rules for the review:

- **Who can do it.** It must be a named, signed-in admin (`ProgramAttachments.admin`). The local operator is refused.
- **What it binds to.** The current pinned release only (`Programs.verified_release`, read from the pinned manifest bytes). The digest and placement shown to the admin must still match.
- **Templates.** A person app that declares more than one template is refused with `placement_templates`.
- **Audience.** An admin may narrow the manifest's `person_allow` but never widen it (`audience_wider`).
- **What it records.** One `app_install_reviews` row per app: the admin, the digest, the placement, the dependencies (capabilities, template digests, related apps) and the audience. If the app is disabled, installing also enables it.
- **"Use in".** For a swarm app, installing writes today's `app_activations` rows for the chosen swarms in the same act. A person app refuses `use_in`.
- **When it applies.** A record is consumed only while its digest, placement, dependencies and audience still match the loaded release (`_current`). An update therefore needs a new review. Reload, startup and member opens never write a review.

## Opening a person app

`POST /api/programs/{id}/person-context` takes the principal from the session only. Body fields are ignored. It always answers `ready`, with `{swarm_id, needs, helpers, private}`; anything else is a fixed failure (see "Failures" below). `helpers` is one of:

- `none`: the app has no template;
- `ready`: its helpers are deployed;
- `key_required`: no own key or no monthly total yet;
- `consent_required`: also carries `{card, space_line}`. The `card` is P2's `card()` payload, unchanged. `space_line` is display-only and is not a consent field.

**Opening is free.** Nothing spends or wakes.

**The app always opens.** Every open first binds the person's context (`_context`), before any helper exists:

- a valid binding is reused;
- for a template app, P2's existing open home is adopted (nothing is made, and no creation slot is used);
- otherwise one empty private swarm is created and bound in one transaction. For a template app, that same transaction also records the swarm as P2's home, so P2's `ensure` later fills this same swarm.

A missing key, or a declined card, therefore leaves the app open in the frame, with helper features unavailable and a host banner.

**Helpers, for an app with its one template:**

1. With no key or monthly total, the answer is `helpers: key_required`. No helper is made.
2. With no current consent, the answer is `helpers: consent_required`.
3. The person consents through P2's own `POST /api/me/app-swarms/…/consent`, with its 409 `card_changed` guard.
4. The UI opens again. The host runs P2's own `ensure` (its locks, tombstones and key lock) into the bound home. There is no new provisioning path.
5. After `ensure`, the review, audience and binding are checked again under P2's locks. If that check fails (disable, revoke, restriction), the fresh helpers are put to sleep and the open fails.

An unusable P2 home (archived, shared, or another owner's) is never replaced by a second one: the open fails with `space_failed` and nothing is made.

**Concurrency and locks.** Opens for the same person and app are serialised by P14's own per-(principal, app) lock. Nothing else takes that lock, so concurrent first opens make one context and call P2 `ensure` once. The open path holds no host lock when it enters `ensure`. The binding check and write run under P2's program and person locks, which `set_enabled`, uninstall and withdraw also take, so a disable that lands mid-open wins.

**Bindings.** `app_person_contexts` is keyed `(principal, program_id)`, with a `swarm_id UNIQUE` constraint. Every reuse validates the binding:

- owner, private and unshared;
- not archived;
- the same template;
- still P2's home.

An invalid binding fails closed into `space_needs_setup` and is never silently replaced. The only way out is `POST …/person-context/reset` ("Set up again"). For an app without a template, it retires the old binding (the swarm is kept, never deleted) and then opens again. It is limited to 3 per person and app per day, and a usable binding is never reset. For a template app, "Set up again" is refused up front with `space_failed` and nothing changes. P2 keeps finished helpers in their home and has no repair that moves them, so any replacement home would only be left behind.

**Scoped activation.** `app_person_activations` records `(program, swarm, principal)`. `ProgramAttachments.active()` reads it through `host_person_active`, which is true only in that one context while its binding and review still stand. `required()` never reads it, so no other swarm becomes attachment-required. An explicit `app_activations` row still decides.

**Own key only.**

- *P1 frames.* `AppAsk._frame` forces a person app's generation swarm to the validated context, so `ask_prefs.swarm_id` and an initial turn's swarm cannot redirect it.
- *Admission.* `AppAsk.before_admit` requires the validated context plus the person's own key and monthly total.
- *Every paid dispatch.* `Gateway.authorize_agent` is now `PersonApps.authorize_agent`. It runs P2's `require_current` first. Then a provenance fence applies: any mind in a person context, and any P2 helper or home of a person app (or of an app that is no longer loaded), dispatches only while that person's P14 binding for that app names this swarm and still stands. A helper left without a binding, after a revocation or a crash, fails closed. Finally, a key-locked own key is required.
- *One pinned key.* A template context pays only with its current P2 consent key. A template-less context records the first own key a mind dispatched with on the binding (`key_id`) and refuses a later switch. Admission checks that the pinned key is still the person's own.
- There is no fallback payer. Dispatch refusals are deliberately generic (`app_unavailable`, `own_key_needed`, `monthly_total_required`), because routes outside the app show them.

**Limits.** Hive-wide, at most 20 context creations a minute and 50 in flight. Over either limit, the open answers `busy` with nothing created. Only a real swarm create counts. Adopting an existing P2 home, filling a bound home with helpers, and repairs do not count. Because no slot is held across `ensure`, a stalled `ensure` cannot pin the pending count. The UI retries `busy` 3 times, waiting 1, 2 and 4 seconds.

**Failures.** `error.code` is `app_unavailable`, `reason` is one of `REASONS`, and the text and action are fixed. The audience is checked first, so someone outside it learns nothing more.

| Reason | Action |
|---|---|
| `not_available_to_you` | back |
| `app_turned_off` | ask admin |
| `not_reviewed` | ask admin |
| `release_changed` | ask admin |
| `space_needs_setup` | Set up again |
| `space_failed` | try again |
| `busy` | try again |

The UI shows its own copy of these fixed words, never the host message.

**Privacy.** The page states: "Private to you; hive admins can audit." Admin audit surfaces are unchanged: the admin `Viewer` bypass on swarm and mind reads, `include=personal`, and `/api/ask/audit`.

## UI

**Person apps** (`ProgramPage`, `lib/personAppOpen.ts`):

- A person app opens straight into the context the host names. There is no homes lookup, no swarm pick and no "Works in" menu, and a route naming another swarm is ignored.
- The P2 card (`PersonSwarmConsentHost`) shows the space line and reports `saved` (open again) or `declined`.
- The app frame always opens in the context. The host key card and the "helpers are off" note ("Set up helpers" asks again) are banners over it. "Not now" is remembered for the tab and identity (in memory and `sessionStorage`, cleared on identity change), so a reload does not ask again. Before the context opens, the page shows only "Opening…", or one fixed failure card with one action.

**Swarm apps.** The old "Not set up on any swarm you can see" page now shows only when nothing is turned on, with one action.

**Install.** The admin "Install" tab (`AppInstall` in "Where it runs") offers "Who can use it" for person apps and "Use in: [swarms]" for swarm apps.

## Known limits (honest)

- **"Set up again" for a template app.** It is refused with `space_failed` (see above). Recovering a template app's archived or invalid home needs an admin (restore the swarm), or P2 itself to grow a repair.
- **Sleeping fresh helpers.** When the post-`ensure` check fails, helpers are put to sleep without a P2 tombstone (P2's `_quiesce` only acts on a P2-revoked binding). Dispatch is refused independently by the provenance fence.
- **Template-less key pin.** One context pays with one key, so a template-less person app whose minds use two different providers is refused on the second. That is conservative.
- **Own-key checks on the Ask.** At P1 admission the check confirms the validated context and the person's own pinned key and limit. The Ask coordinator's own payer resolution (`Hive.payer_for`) is unchanged. The per-dispatch check enforces the key.
- **Limiter scope.** The creation limiter is in-process, matching the hive's single-process lock model.
- **Narrowing from the UI.** The app page narrows the audience by installing again with "Only these people". The `PUT …/person-allow` route exists, but the UI does not call it.
- **Install status.** It applies the audience first: a member outside a person app's audience sees it as not installed. The placement itself is public, as it is in the app list.
