# Mind program contract v0.1 (provisional, frozen; formerly titled 'Dot program contract')

A **mind program** supplies the meaning of a piece of work as a **work graph**.
The **host** (the OmegaDots UI and server) turns it into an experience that
adapts to what the person is doing. This document is the boundary between the
two.

- v0.1 is frozen.
- Changes come as v0.2 and later, and a program declares which version it
  speaks.
- The contract is plain JSON. It does not depend on MeTTa, a particular truth
  calculus, or any earlier Omega architecture.

```
   person
     │  asks · follows · compares · inspects · acts
     ▼
 ┌──────────────────────────── HOST (platform owns) ─────────────────────────────┐
 │ layout · stage transitions (unfold / map / compare / detail) · accessibility   │
 │ navigation trail · back with state restored · always-visible sources and       │
 │ uncertainty · permission checks · task status · rendering text only, no code   │
 └───────────────▲──────────────────────────────────────────────┬────────────────┘
       WorkGraph │ (data)                       describe/view/act│ (intent)
 ┌───────────────┴──────────────────────────────────────────────▼────────────────┐
 │ PROGRAM (application owns): meaning, kinds, evidence model, assessments,      │
 │ corrections, its private records and store, workflows (e.g. a Scientist)       │
 └────────────────────────────────────────────────────────────────────────────────┘
        loaded from the owner's local workspace (HIVE_PLUGIN_DIRS); data stays there
```

## Status

| Part | State |
|---|---|
| Server host: discovery, manifest, capability-limited context, graph and result validation, routes below | **implemented** (`hive/core/programs.py`) and tested (`hive/tests/test_programs_api.py`) |
| Standalone checker: `python -m hive.programs_check <dir>` | **implemented**. Needs no hive, no UI, no network |
| Public fixture program | **implemented** (`hive/plugins/contract_fixture/`) |
| Adaptive UI host: stages, morphing, trail, back, sources and uncertainty chrome | **built** (`hive/ui/src/features/programs/`), tested in the UI suite and against a local hive with the public programs |
| Scientist route, deadlines, idempotent retry, `proposal` field, manifest `app` block | **backend built and tested** (`hive/tests/test_scientist_route.py`) |
| App morph into the manifest identity, the hive spine, the app switcher, the transport/review proposal badges | **pending UI implementation**; not tested, not claimed |
| Live readiness with private apps (OmegaTruth, Atlas) | **not yet qualified.** Backend contract readiness is not live app readiness: that needs the owners' local synthetic acceptance run, reported separately from mock/echo or replay demos |
| Deltas, program-owned tasks, out-of-process programs, rendering hints | **later** (v0.2 and after) |

**What a program team can do now, independent of host layout:** write
`describe()`, `view()` and `act()` over its own store, and run the checker
against its directory until it prints `COMPATIBLE`. Everything the host
renders comes from these returns.

## 1. Signatures and lifecycle

```python
def describe() -> Description                                   # once at load, and on reload
def view(ctx, focus: str | None, stage: str) -> WorkGraph       # every time the person looks
def act(ctx, action: str, items: list[str], params: dict) -> Result   # sync or async
```

1. **Load.** The host reads `plugin.json`, imports the module and calls
   `describe()`. A failure marks the program as errored, with the reason; it
   never crashes the hive.
2. **View.** On each navigation the host calls `view(focus, stage)`. `stage`
   is one of `unfold`, `map`, `compare`, `detail`. `focus` is an item id, or
   None for the program's starting view. The return is **always a full
   snapshot** in v0.1.
3. **Act.** The person picks an action on some items. The host checks
   permission, then calls `act` with `params.base_revision` set to the
   revision the person was looking at.
4. **Reload.** `POST /api/programs/reload` re-reads the code. Enable and
   disable are operator switches.

## 2. Shapes

```jsonc
// Description
{ "contract": "0.1",
  "kinds":     [{ "id": "evidence", "label": "Evidence", "role": "evidence" }],
  "relations": [{ "id": "contradicts", "label": "contradicts", "polarity": "oppose" }],
  "actions":   [{ "id": "inspect-source", "label": "Open source", "applies_to": ["evidence"],
                  "stage": "detail", "params": { "name": "what it means" } }] }   // stage: optional hint
```

- `role` is one of `question`, `claim`, `evidence`, `hypothesis`,
  `assessment`, `explanation`, `gap`, `source` or `other`. Roles drive shared
  styling. Kinds are the program's own; several kinds may share a role.
- `polarity` is one of `support`, `oppose`, `qualify` or `neutral`. Polarity
  drives the compare stage. Relation ids are the program's own: for example
  `supports`, `contradicts`, `qualifies` and `depends_on`.

```jsonc
// WorkGraph: a full snapshot
{ "revision": "r7",                    // REQUIRED, opaque; changes whenever content changes
  "focus": "q1", "title": "...", "suggested_stage": "unfold",
  "items": [{
     "id": "e3",                       // REQUIRED, stable across revisions; never reused for something else
     "kind": "evidence", "label": "short", "text": "optional longer text",
     "status": "current",              // current | corrected | superseded | retracted
     "flags": ["affected-by-correction"],
     "uncertainty": { "method": "nal", "f": 0.9, "c": 0.8 },   // OPTIONAL; see below
     "sources": [{
        "id": "s-blog", "label": "Structural engineering blog post", "kind": "document",
        "url": "https://…", "local_ref": "optional path or record id in the owner's store",
        "date": "2025-11-20", "locator": "section 'Load rating'",
        "status": "retrieved",         // retrieved | inspected | cited | unavailable
        "origin": "independent-engineer"   // shared by sources with a common origin
     }],
     "revisions": [{ "revision": "r6", "label": "previous wording", "note": "why", "at": "ISO" }],
     "at": "ISO time", "weight": 0.6,
     "meta": {},                       // anything program-specific; the host shows nothing from it by default
     "atom": "(optional MeTTa expression for programs that keep one)"
  }],
  "links":  [{ "id": "l5", "from": "e3", "to": "c1", "rel": "contradicts", "weight": 0.6 }],
  "groups": [{ "id": "conflict", "label": "Points to a lower rating", "items": ["e3", "h1"] }],
  "notes":  ["caveats the host always shows"] }
```

Validation rules, applied by both the server and the checker:
- Ids are unique.
- Every link and group points at items in the same graph.
- A link id defaults to `from|rel|to`.
- Kinds and relations must come from `describe()`.
- At most 400 items and 1200 links per view. A bigger view is refused, never
  cut short: narrow it instead.

**Uncertainty is optional and labelled with its method.** The host never
converts one method into another or into a single probability.
- `{"method": "nal", "f", "c"}`
- `{"method": "pln", "strength", "confidence"}`
- `{"method": "qualitative", "status": "contested"}`
- any other `method` with a `label`

Values are checked to lie in [0, 1] only for `nal` and `pln`. A missing
uncertainty means unassessed, which is different from zero.

**Groups may overlap and are never merged.** In the compare stage they keep
contradictory evidence and alternatives side by side. Disagreement is shown,
not collapsed.

**References are not access.** A `url` or `local_ref` is shown as a
reference. Opening it is up to the person, or happens through the program's
`inspect-source` action, and the host fetches nothing by itself.

## 3. Actions, results and updates

```jsonc
// Result
{ "status": "done | started | needs_input | stale | refused | error",
  "graph": { /* full WorkGraph snapshot, optional */ },
  "task":  { "id": "g_ab12", "kind": "goal", "status": "open" },   // required when status = started
  "needs": { "param": "what is missing" },                          // with needs_input
  "detail": { /* action-specific, e.g. { "sources": [...] } for inspect-source */ },
  "message": "shown to the person" }
```

| Status | Meaning |
|---|---|
| `done` | The action finished. If `graph` is present it replaces the view. |
| `started` | Long-running. `task.id` is a **swarm goal**, so its lifecycle is the goals lifecycle: open → claimed → waiting (needs a person) → done / failed / stalled / cancelled. Cancelling is `PATCH /api/goals/{id} {status:"cancelled"}`. |
| `needs_input` | Call again with the named `params`. |
| `stale` | `params.base_revision` is no longer current. Nothing changed. Return the current graph so the host can reconcile. |
| `refused` | The program declined, for example because the action doesn't apply. |
| `error` | The program failed cleanly, with a message. |

- **Incremental updates in v0.1 are full snapshots.** The host keeps focus
  and trail by item id across revisions.
- **Corrections:** a correction keeps the item id and sets `status`. It
  appends the prior state to `revisions`, flags dependent conclusions with
  `affected-by-correction`, and bumps `revision`.
- Deltas come in v0.2.

Recommended action ids, so hosts can place them consistently:
`inspect-source`, `challenge`, `compare`, `investigate-gap` and `correct`.
Programs may add their own.

## 4. Mounting and discovery

- **Built-in programs:** `hive/plugins/<dir>/plugin.json` and the module.
- **Private programs:** set `HIVE_PLUGIN_DIRS=/path/to/workspace/programs` on
  the owner's local hive. It accepts a directory of program directories, or
  one program directory.
- Nothing is copied into this repository. The program's store, records and
  references stay wherever the program keeps them.
- **Release pins (`HIVE_APP_PINS`, Platform 2026-10-06).** JSON
  `{app_id: {release, digest, files?, env?}}`: `release` is the absolute path of
  the app's own folder (the one holding `plugin.json`), `digest` its
  `sha256:` source digest (`Programs.source_digest`), `files` optional
  `{relpath: "sha256:<hex>" or "<hex>"}` for any file in the release (also ones
  the source digest skips, such as `deployment.json`), `env` optional
  `{VAR: exact value}`. A pinned app loads only when it is discovered (through
  `HIVE_PLUGIN_DIRS`) at exactly that folder and every listed digest, file and
  value matches; its code is never imported otherwise. `release` (and a
  renewal `release` it is compared with) must already be in normal form: no
  `..` or `.` component, no doubled or trailing slash. The refusal is the
  app's `error`, with the reason first, and it serves no view, act, read or UI
  (403 with the reason as code). Only admins see why (the app list and detail
  for an admin, and the admin-only `app.release_refused` event); everyone
  else, including every 403 body and the public program events, sees only
  `<code>: not its pinned release`. The codes:
  - `release_mismatch`: the folder, digest, a file or an env value differs, the
    pin is malformed, or the app is not found at its release. Only an app id
    absent from `HIVE_APP_PINS` is unpinned: a declared `null` or any other
    non-object refuses, and so does a present `files`/`env` that is not a
    mapping of non-empty names to non-empty values (64-hex hashes), a digest
    that is not `sha256:` plus 64 hex, or an unknown key. Omitting `files` or
    `env` means no such check. The admin-only reason names only files inside
    the release and env var names, never values.
  - `duplicate_discovery`: a pinned id is found in more than one plugin folder
    (an editable copy beside the release); both are refused, never one picked.
  - `pin_conflict`: the app also has `HIVE_APP_GRANT_RENEWAL` and its
    `release`/`digest` there disagree with the pin (the pin's folder must lie
    inside the renewal release and the digests must be equal).
  - `unpinned`: `HIVE_APP_PINS_REQUIRED=1` and a non-builtin app has no pin.
  - `pins_invalid`: `HIVE_APP_PINS` is not a JSON object; every non-builtin
    app is refused (fail closed).

  The whole pin (folder, digest, files, env) is checked again at every view,
  act, read, result validation and UI serve, as integrity is; a mismatch then
  closes the app (403 `release_mismatch`, event `app.release_refused`) until
  the next reload, even if the file is put back (on purpose: a swap and
  restore must not reopen it by itself). Pins are read at each full reload
  (`POST /api/programs/reload` or a start), before any app in it runs;
  reloading one app keeps the pins it already had. Apps without a pin load as
  before. Threat model: pins decide which code the host itself imports, so an
  unreviewed or drifted folder never loads; an app already loaded shares the
  process and can do anything the host can, so that boundary is code review
  of every mounted app, as for grant renewal.
- **Migration.** Atlas's release and digest stay in `HIVE_APP_GRANT_RENEWAL`
  for now (one source per setting) and keep being enforced there; Atlas moves
  to `HIVE_APP_PINS` later, after which its renewal entry may keep or drop
  `release`/`digest` (if kept, they must agree). `HIVE_APP_PINS_REQUIRED=1`
  is off by default and is the end state once all five mounted apps
  (Design, Truth, Purple, Fusion, Planner) and Atlas are pinned.

```json
{ "id": "my-program", "name": "My program", "version": "0.1.0", "contract": "0.1",
  "module": "program.py", "capabilities": ["goals:write"], "icon": "spark" }
```

## 5. Permissions, errors and cancellation

- **The view is data.** The host renders text as text. A program cannot
  inject markup or code into the UI.
- **Program code is trusted server code,** loaded by the hive's owner. v0.1
  runs it inside the hive process. Capabilities only limit which hive APIs the
  context offers. They are **not** a sandbox: in-process Python can still
  reach the filesystem and network as the hive's user. Out-of-process
  isolation is planned.
- **Capabilities** limit the context. The program gets errors for anything it
  did not declare:
  - `commons:read` gives `beliefs()`, `belief(s)`, `agents()` and `mind(ref)`;
  - `goals:read` gives `goals()`;
  - `goals:write` gives `create_goal(title, detail)`.

  Naming a mind (r16): a person's view, read, act or confirm names a mind only
  as `mind:<id>` or `agent:<id>`. Before the app runs, the host finds every mind
  named there, in that spelling or any an app could decode (percent-encoding,
  escapes, letter case, space at the colon, Unicode forms), and answers
  `404 not_found` ("no such mind") unless the person may see each one, the same
  for unknown and deleted ids. A visible mind written another way is refused
  with `400 mind_reference_spelling`. The scan has one bounded budget per
  request, linear in its size; a request it cannot finish (encoded too deeply,
  or still encoded beside a mind-like name) is refused with
  `400 mind_reference_unresolved`, never passed on. For a person's call, `agents()` lists
  only the minds they may see, and `mind(ref)` resolves a `mind:<id>`,
  `agent:<id>` or bare id the same way, or refuses 404. An app resolves minds
  through these; one that reaches hive internals itself is outside the
  guarantee (program code is trusted server code, above).

  A program's own store is its own business.
- **Scope:** each call is limited to one swarm, the one the person is in.
- **The routes are operator-only today:** a person drives a program. Agent
  calls are not supported yet. When they come, they will be an explicit,
  separate route, and each action will go through the policy gate as skill
  `program:<id>:<action>`.
- **Errors:**

  | Code | Meaning |
  |---|---|
  | 400 `bad_graph` / `bad_result` | The return broke the contract; the message says how |
  | 403 `capability_missing` | The program called a method it did not declare |
  | 409 `program_disabled` | An operator turned the program off |
  | 500 `program_error` | An exception in the program, with its last lines |

  A failing program never takes the hive down.
- **Cancellation:** v0.1 tasks are goals, so cancel the goal. Program-owned
  tasks with their own cancel are v0.2.

## 6. Compatibility test

```bash
python -m hive.programs_check path/to/your_program                 # structural checks; read-only
python -m hive.programs_check path/to/fixture --scenario --allow-mutation
```

**Always run:**
- `describe()`, and `view()` in every stage, are valid;
- ids and the revision are stable across repeated views;
- `inspect-source` (if offered) returns `detail.sources`.

**Only on request:**
- `--scenario` requires a question with one supporting and one opposing link.
  That is a check on a **test scenario**. A real investigation never has to
  contain, or invent, counterevidence to be compatible.
- `--allow-mutation` runs `correct`. It checks that `correct` keeps every id,
  records the prior revision, bumps the revision and returns `stale` on an old
  base. **`correct` changes data.** Run it only against a disposable fixture
  or a throwaway copy of the store, never against real records.

The public example is `hive/plugins/contract_fixture/`, a synthetic question:
"Is the Riverside footbridge rated for 5-tonne loads?" It has:
- two supporting reports with a common origin;
- independent counterevidence;
- a rival hypothesis, an assessment and a gap;
- all five recommended actions.

The fixture runs through the real API in `hive/tests/test_programs_api.py`.

## 6b. Clarifications to v0.1 (additive; nothing existing breaks)

Raised while building the host, settled here:

1. **Focus.** `view(focus)` should keep the requested item in focus whenever
   it still exists, even if it belongs to a larger view. If it no longer
   exists, return the starting view and add a note saying so. The host then
   tells the person that their item is gone.
2. **Stale.** A `stale` result's graph is the current state. The host passes
   `params.focus` and `params.stage` with every action, so a program can
   return the person's own view. A host may always refetch its own step
   after a stale result.
3. **Selection.** A WorkGraph may carry `selected: [ids]`, the items the
   person picked (e.g. for compare). The host highlights them. Ids that are
   not in the graph are dropped.
4. **`needs.items`** is reserved. It means "choose (more) items", not "fill in
   a parameter". Every other key in `needs` is a parameter.
5. **Direction.** A link reads `from <rel> to`: `e1 supports c1`, `c1
   depends_on e1`. Polarity describes the effect of `from` on `to`.
6. **Action `stage`** is an optional hint for where the result is best shown.

## 7. Scientist route: a revision-bound request to a named mind

**Implemented and tested** (`hive/tests/test_scientist_route.py`). It is built
from existing goals and exhibits, with no second coordinator. The extensions
are additive and do not change the v0.1 contract.

1. **The program shows the snapshot.** `await ctx.exhibit(title, ["Scientist"], minutes, body, atoms)`
   needs capability `exhibits:write`. It returns the hive-computed `digest`
   (`sha256` over title, body and atoms) and the share ids.
2. **The program posts a bound goal.**
   `await ctx.create_goal(title, detail, assignee="Scientist", binding={request_id, base_revision, snapshot_digest, share_ids})`.
   Only the assignee is told, and only the assignee can claim (others get 403
   `not_assigned`). The goal has `binding` and a `binding_digest`.
3. **The Scientist** (an Omega, or an external member over HTTP):
   - `GET /api/agent/goals/{id}` returns the goal with its binding and digest;
   - `POST …/claim` takes the claim, which is a lease (renew it with `…/heartbeat`);
   - `GET /api/agent/shares/{share_id}/atoms` reads the snapshot. The returned
     `digest` must equal `binding.snapshot_digest`.
4. **The proposal.**
   `POST /api/agent/goals/{id}/result {status: "done", result, data: {binding | binding_digest, proposal}}`.
   A result that doesn't echo the binding exactly gives 409 `binding_mismatch`.
   The program reads it back with `ctx.goal(id)["result_data"]`, which needs
   `goals:read`.
5. **Cancellation.** `await ctx.cancel_goal(id)` cancels only goals the
   program created; the operator can also `PATCH /api/goals/{id} {status: "cancelled"}`.
   - The claimer or assignee gets `[GOAL-CANCELLED g_…]` (event `goal_cancelled`).
   - The shares in `binding.share_ids` are revoked, so reading gives 410.
   - A late result gives 409 `goal_cancelled`.
   - The Scientist calls `POST /api/agent/goals/{id}/cancel-ack`, which sets
     `cancel_ack_at` and `cancel_ack_by`.

Omega skills for the same steps: `hive-goal-get`, `hive-goal-claim`,
`hive-shared`, `hive-goal-propose g_id {json}` (echoes the binding digest)
and `hive-goal-cancel-ack`.

Not in this route:
- Admission rules, evidence semantics and what a proposal means. Those belong
  to the application.
- An end-to-end run with a live Omega Scientist on a real model.

### 7b. Additions after 9a16f50 (additive; v0.1 programs are unaffected)

- **Deadlines.** `ctx.create_goal(..., deadline_minutes=N)` (operator: `deadline_minutes`) is a hard time
  budget. Past it, the goal becomes `failed` ("deadline passed before a result arrived"), its
  `binding.share_ids` are revoked, the holder or assignee gets `[GOAL-EXPIRED g_…]` (event `goal_expired`),
  claims and results get 409 `goal_expired`, and `cancel-ack` acknowledges it. A lapsed *claim* lease is
  still separate: it re-opens the goal until 3 lapses.
- **Idempotent retry.** Re-posting the *identical* full payload (same status, the complete result text
  of at most 4000 characters, and the same data) to a finished goal returns 200 with the goal, so a lost
  response can be retried safely. Anything else is refused: a differing payload (409), a cancelled or
  expired request (409 `goal_cancelled` / `goal_expired` / `not_claimed`), or a late result.
  Applications keep their own `base_revision` checks and pending review regardless.
- **Async error boundary.** Exceptions from `view`/`act` become a clean 500 `program_error`, whether
  they are raised before or after an `await`.
- **Atomic bound request.**
  - `await ctx.bound_request(title, assignee, snapshot={title, body?, atoms?}, binding={…your fields},
    detail="", minutes=30, deadline_minutes=None)` shows the snapshot to the named mind, then posts the
    assigned goal.
  - The hive adds `snapshot_digest` and `share_ids` to the binding.
  - If the goal cannot be posted, the exhibit is revoked before the error is raised.
  - `await ctx.revoke_exhibit(exhibit_id)` withdraws any exhibit the program created.
  - Programs that keep their own snapshot store (`share_ids: []`) are unaffected: they revoke in their
    own store.
- **Proposal state on items** (optional): `item.proposal = {goal_id, binding_digest, transport, review}`.
  - `transport` is `validated | stale | refused | expired | cancelled`. This is what the **hive** checked:
    binding and digest matched, or the request ended. The program copies it from the goal.
  - `review` is `pending | accepted | rejected | superseded`. This is what the **application** decided,
    after its own scientific review.
  - The host always shows the two separately. A validated transport is never shown as an accepted
    finding.
- **App identity** (optional manifest block, data only; the host validates it and renders it):

```json
"app": {
  "theme": { "accent": "#rrggbb", "accent_2": "#rrggbb", "surface": "#rrggbb", "ink": "#rrggbb",
             "type": "editorial | technical | humanist | mono",
             "motif": "none | constellation | strata | lattice | grain | rings",
             "density": "airy | regular | dense" },
  "home": "item id to open on (optional)",
  "open_stage": "unfold | map | compare | detail",
  "tagline": "one line, shown during the morph"
}
```

  Rules for the theme:
  - Ink on surface must reach 7:1 and accents on surface 3:1, or the host substitutes its defaults and
    lists `app_warnings` in `GET /api/programs`.
  - Unknown keys are ignored, with a warning.
  - No CSS, fonts, images or scripts are taken from an app.

## Local live test (no deployment, no upload)

On the machine that holds the private apps:

```bash
cd OmegaClaw-Core && git fetch origin claude/holarchy-nested-spaces && git checkout <commit>
pip install -r requirements.txt -r hive/requirements.txt
(cd hive/ui && npm ci && npm run build)                  # the UI the hive serves
HIVE_DATA_DIR=~/.omegadots/apps-test HIVE_ADMIN_PASSWORD=<pw> \
HIVE_PLUGIN_DIRS=/path/to/atlas/programs:/path/to/omegatruth/programs \
python3 -m hive                                          # binds 127.0.0.1:8700 only
```

1. Open `http://127.0.0.1:8700/?sim=0` and log in.
2. Create a swarm for the test, e.g. `apps-local`. Enrol it in each app's own local configuration; the
   hive passes `swarm_id` and the app refuses swarms it has not enrolled.
3. Create the Scientist as an external member: `POST /api/agents {name: "Scientist", kind: "module",
   swarm_id}`. Give its token to the local Scientist worker process.
4. The worker loop:
   - poll `GET /api/agent/inbox?after=…`;
   - on `event: goal`, `GET /api/agent/goals/{id}`, then claim;
   - read the snapshot with `GET /api/agent/shares/{share_id}/atoms` (paged) and check its `digest`;
   - post `…/result {data: {binding_digest, proposal}}`;
   - on `goal_cancelled` or `goal_expired`, stop and `…/cancel-ack`.
5. In the UI, open **Programs** and pick the app; or pick a mind, then "Open in…".

Only the swarm you name sees anything. Nothing leaves 127.0.0.1 unless a mind uses a remote model, and
none is needed for this test.

## Responsibilities

| Platform (OmegaDot session) | Application (Codex: OmegaTruth, Atlas adapter) |
|---|---|
| host, stages, morph into app identity, hive spine, trail and back, sources and uncertainty chrome, accessibility | meaning, kinds, evidence model, scientific review (`review`), corrections, private stores and their revisions |
| program loading, capability checks, graph and result validation | swarm enrolment, admission rules, what a proposal means |
| goals, assignment, binding checks, digests, deadlines, revocation, cancel-ack (`transport`) | Scientist worker logic, staging and reconciling results, labelling analysis depth honestly |
| public demo with synthetic programs only | private code, data and test receipts stay local |

## 8. HTTP routes (operator)

| Method & path | Body → Response |
|---|---|
| `GET /api/programs` | → `[{id, name, version, description, icon, capabilities, source, enabled, error}]` |
| `GET /api/programs/{id}` | → that plus `describe` |
| `POST /api/programs/{id}/view` | `{swarm_id, focus?, stage?}` → `WorkGraph` (validated, with `contract`, `program`, `stage` added) |
| `POST /api/programs/{id}/act` | `{swarm_id, action, items, params?, base_revision?, confirm_token?}` → `Result` (`confirm_token`: §9d) |
| `POST /api/programs/{id}/confirm` | *§9d.* `{swarm_id, action, payload, payload_digest}` → `{confirm_token, expires_at, expires_in}`; person sessions only |
| `POST /api/programs/{id}/enable` · `/disable` · `POST /api/programs/reload` | operator switches |
| *(any app route above)* | a host-refused app (§4 release pins) answers 403 `release_mismatch`, `duplicate_discovery`, `pin_conflict`, `unpinned` or `pins_invalid`; `GET /api/programs` lists it with `enabled: false` and that `error` |
| `GET /api/swarms/{swarm_id}/artifacts?kind=&limit=` | *Candidate (§9).* → `[{artifact_id, kind, title, revision, digest, created_at, revised_at}]`: the swarm's own artifacts at their latest revision, metadata only (no body, no author), for a viewer who sees the swarm (404 otherwise) |

## 9. App frame bridge (an app's own `ui/`)

An app that ships `ui/` (index.html, app.js, style.css) runs in an opaque-origin `srcdoc` iframe with a nonce CSP,
no network, no forms and no storage (`hive/ui/src/lib/appFrame.ts`, `features/programs/AppFrame.tsx`). It talks to
the host only by `postMessage`, always carrying the `channel` from `<html data-app-channel>`, and sends to the
origin in `<html data-app-host-origin>`. The host accepts only that exact frame window, from origin `null`, on that
channel.

**The CSP comes first (r17, both modes).** The client builds the frame document as
`<!doctype html><html data-app-host-origin="…" data-app-channel="…"><head><meta http-equiv="Content-Security-Policy"
content="…">` followed by the app's index.html (its stylesheet and scripts inlined with the nonce). The policy is
the first element the parser inserts, before any app-authored byte, so no markup in index.html can move or drop
it; the browser ignores the app's own later doctype and `<head>`, and merges its `<html>` attributes (the host's
`data-app-*` win). index.html no longer needs a `<head>`. A real-browser test loads adversarial heads (a
`<select><head>`, `<template>`, `<frameset>`, `<svg>` breakout, a `<head>` in an attribute, comment, `noscript` or
`textarea`, a second `<html>`, a duplicate `<head>`, spoofed `data-app-*`) and shows that an inline script or
handler without the nonce never runs and no request leaves the frame, while the 6614939 builder (CSP after the
first literal `<head>`) loses the policy on several of them. It also shows Atlas and Design's apps still run.
The frame is now always in standards mode (the host's doctype comes first).

**Files (`GET /api/programs/{id}/ui`, `programs.py` `ui_bundle`).** Every file in `ui/` is pinned by sha256 in
`ui/bundle.lock.json` (`{"files": {name: hex}}`); a changed, extra or unpinned file on disk answers 404 `no_app_ui`.
By default the frame gets exactly index.html, app.js and style.css, each at most 600,000 bytes, as `{program, files}`.

*Script parts (host slice r17, "app frame parts"; rules in `hive/core/ui_parts.py`, the client's copy in
`hive/ui/src/lib/appFrameParts.ts`).* The lock may also list `"scripts": ["a.js", "b.js", "app.js"]`:

- 1 to 3 plain `.js` names, `[a-z0-9][a-z0-9_-]{0,60}\.js`, anchored: no dots in the stem (`a.b.js`, `app.min.js`
  refuse), no trailing newline; no repeats; `app.js` always last;
- the lock pins exactly index.html, style.css and the parts, and the folder holds exactly those files;
- each of them at most 600,000 bytes, all together at most 1,800,000 bytes (UTF-8 bytes on both sides);
- no part contains `<!--` (inside an inlined script it changes where the browser ends that script);
- index.html ends with the part block: one `<script type="module" src="./X.js"></script>` per part, in the listed
  order, separated only by whitespace, then `</body>` (and optionally `</html>`); no other `<script` tag anywhere;
- before the block, the markup must leave the browser in its normal data state: no comment, no unclosed tag or
  attribute quote, no unclosed raw-text element (`title`, `textarea`, `style`, `noscript`, `iframe`, `xmp`,
  `noembed`, `noframes`), no `template`, `plaintext`, `svg`, `math`, `frameset` or `frame`; and the first
  `<link rel="stylesheet" href="./style.css">` is a real tag. These rules make the parts run; the CSP does not
  depend on them.

The answer is then `{program, files, scripts}` with `scripts` in order. Any broken rule, pins and the folder's
files included, answers 422 `bad_app_ui` with its reason; only bytes that differ from their pin keep 404
`no_app_ui` (or 403 `app_integrity` once the app's digest changed). The client (`appDocument`) checks the same
rules on the answer, sizes included, before inlining anything; `tests/fixtures/ui_parts_cases.json` is checked
by both suites. Each part is inlined as a module script with the same nonce, in order; the CSP text, the
opaque origin and the no-network boundary are unchanged.

*Order and sharing.* Inline module scripts run in document order: a real-browser test runs three parts that
read each other's globals at top level, and every accepted shared case, in Chromium
(`hive/ui/src/lib/appFrame.browser.test.ts`; set `PW_CHROMIUM`, else `/opt/pw-browsers/chromium`, else skipped).
Inline modules cannot import each other, so parts share through globals (for example a first part sets
`globalThis.THREE`). One caveat, also tested: a part that awaits at top level does not hold back the next part,
so publish shared globals before any top-level `await`.

*No list.* With no `scripts` key, the server's answer is unchanged from 6614939, including its handling of extra
files: an extra file that is pinned and on disk is not served and not refused (200). The frame document differs
only in the CSP-first prefix above (no longer the first literal `<head>`), and no `<head>` is required.

Existing messages:

| Frame → host | Host → frame |
|---|---|
| `{type:'app-ready'}` | `{type:'app-context', program, swarm_id, source?}` (`source` = the exact `{artifact_id, revision, digest}` it was opened on) |
| `{type:'app-dirty', dirty}` | none (the host guards unsaved edits) |
| `{type:'app-request', id, op:'view'\|'act', body}` | `{type:'app-reply', id, ok, result\|error}`; the host fixes `swarm_id` and the person, the frame cannot choose them |
| `{type:'app-request', id, op:'subscribe'\|'unsubscribe', body:{artifact_id}}` | `app-reply`, then `{type:'artifact.revision', artifact_id, revision, digest, created_at}` (never a body) |
| Candidates §9c: `read`, `act` with `file`, `show-file`, `open-url`, `back-request`/`escape`, `layout`, goal `subscribe`/`unsubscribe` | `read-result`/`read-refused`, `app-reply` with `reason`, `file-shown`/`file-closed`/`file-refused`, `url-opened`/`url-refused`, none, `layout-set`, `goal.subscribed`/`goal.status`/`goal.refused` |

### 9a. Candidate additions (Studio slice 1; Surface builds, Platform reviews)

Additive: an app that ignores them is unaffected. Unknown `type`s are ignored. Each message is at most 2048
bytes serialised and has exactly the keys shown (plus `channel`).

**`context`.** Sent after `app-ready` (right after `app-context`), whenever it changes (experience, its chrome,
the look's app identity, reduced motion), and on request `{type:'context?'}` (at most 10 per 10 s; more are ignored).

```json
{ "type": "context", "schema": "omegahive.app-context/0.1",
  "experience": "classic | cosmos | construct | still | flux | canvas | <future id>",
  "grammar": "classic | cosmos | construct | still | flux | canvas",
  "chrome": { "surface", "raised", "ink", "ink2", "ink3", "line", "edge", "accent", "onAccent", "danger",
              "onDanger", "font", "display", "radius", "controlRadius", "scrim", "shadow": "<CSS value string>",
              "material": "glass | paper | terminal | none", "scheme": "light | dark" },
  "appIdentity": { "accent", "accent_2", "surface", "ink": "#rrggbb",
                   "type": "editorial | technical | humanist | mono",
                   "motif": "none | constellation | strata | lattice | grain | rings | ruled | blueprint" } | null,
  "reducedMotion": true,
  "capabilities": { "picker": true, "draftSave": false, "read": false, "openUrl": true, "showFile": true,
                    "actFile": false, "fullBleed": true, "presence": false, "handoff": false },
  "person": { "kind": "person | operator", "localOperator": false } | null,
  "insets": { "top": 0, "right": 0, "bottom": 0, "left": 0 },
  "reserved": { "bottomLeft": { "width": 0, "height": 0 } } }
```

- Data only: strings, booleans and enums. There are no functions, URLs or host objects. Every chrome value is
  checked (≤160 characters; no `url(`, `image-set`, `data:`, escapes, at-rules, blocks, comments or markup) and is
  replaced by the classic value if it fails. `grammar` is the experience when the host has a grammar for it, else
  `classic`.
- `appIdentity` is the identity as actually shown in this look: the app's surface blended into the look's, accents
  that fall below 3:1 replaced by the look's, and ink that is the app's own only at 7:1 or better. It is null when
  the app has no theme.
- A frame uses these as CSS custom properties it sets itself. Nothing is applied to the frame by the host.
- `insets` and `reserved` (whole CSS px, 0–4096, measured in the frame's own box) are the frame's fit on the screen:
  §9c **Fit**. Context is re-sent when they change (resize, orientation, layout).

**`pick`.** The frame asks, the host shows its own picker, the person chooses.

```json
frame → host  { "type": "pick", "id": "<[\\w.:-]{1,80}>", "accept": ["artifact", "asset"], "kinds": ["studio-source", "image/*"] }
host → frame  { "type": "picked", "id", "source": { "artifact_id", "revision", "digest" } }
           or { "type": "picked", "id", "asset": { "handle": "<sha256 hex>", "name", "mime", "size" } }
           or { "type": "picked", "id", "cancelled": true, "reason"?: "busy | unavailable | rate-limited | invalid | too-large" }
```

- `accept` is one or both of `artifact` and `asset`, with no repeats.
- `kinds` is optional (1–16 entries). An entry matches an artifact `kind` exactly, or an asset mime type exactly
  or as `type/*`.
- The host lists only what this person may read for this app in this swarm, through the host's routes:
  - artifacts owned by the frame's swarm, at their latest exact revision (`GET /api/swarms/{id}/artifacts`, §8);
  - files the swarm owns (`GET /api/assets?swarm_id=`, visibility-filtered).
- The frame never sees the list or any search.
- One picker is open at a time; a second `pick` gets `cancelled` with `busy`. At most 5 picks per 10 s
  (`rate-limited`). A hive without the listing routes answers `unavailable`, and `capabilities.picker` is false.
- A cancellation without `reason` means the person cancelled.
- The reply carries only the chosen item, re-validated: an exact `CreationReference`, or the asset's content hash,
  name, mime and size. Treat `name` as untrusted text.

**Authority.** A picked reference is a selection, not a grant. It adds no permission.

*Reading a picked artifact.* The frame passes the reference to its own program through the existing `view`/`act`
bridge, for example Design's `view` with `focus:"studio-source:<reference JSON>"`. The host then:

1. re-checks that the person sees the swarm (`program_view` → `visibility.check_path`);
2. hands the program a host-derived `ctx.viewer`;
3. lets the program call `ctx.read_revision`, which allows only the owning swarm (or a live review request on
   exactly that revision).

The program must still compare the digest it reads with the one picked.

*Reading a picked asset.* No bridge route reads asset bytes today. A program can read the file in `view`/`act`
through `ctx.read_asset(handle)`: the swarm must own the file, or a readable revision in the same swarm must list
it. It must turn that into frame-safe data itself, since the frame's CSP allows only `data:`/`blob:` images. A
host op returning a picked asset's bytes (bounded, mime-checked, allowed only for handles picked in this frame
session) is `asset-bytes`, §9b.

Not yet: keyboard forwarding (beyond `escape`, §9c), presence and hand-off (capabilities reported `false`).
`read`, `openUrl`, `showFile`, `actFile` and `fullBleed` are §9c.

### 9b. Candidate additions (Studio slice 2: drafts, picked-image bytes; Surface builds, Platform reviews)

Additive, like §9a: exact keys (plus `channel`), unknown `type`s ignored, every refusal answered in the request's
own reply type when its `id` is usable (`[\w.:-]{1,80}`). Host code: `hive/ui/src/lib/studioBridge.ts`.

**Context additions.** `capabilities.draftSave` is true only when the host has the draft routes AND `/api/auth/me`
reports `person_kind: "person"` (an operator session saves no drafts). `person` is `{kind, localOperator}` from
`/api/auth/me` (`person_kind`, `local_operator`), data only (no id, name or email), or null when the host does not
report them.

**Drafts.** A private draft per (signed-in person, app, swarm, `draft_key`). The frame names only the key and body:
the host adds its own app id and the frame's swarm, and the hive takes the person from the session. A message that
carries `program_id`, `swarm_id`, a principal or any other extra key is refused `invalid`. A draft is not a
publication: saving one adopts and shares nothing.

```json
frame → host  { "type": "draft-save", "id", "draft_key": "<[a-z0-9][a-z0-9_-]{0,79}>",
                "expected_revision": null | <int ≥ 1>, "body": { <JSON object ≤ 256 KB UTF-8> },
                "source_ref"?: { "artifact_id", "revision", "digest" } }
host → frame  { "type": "draft-saved", "id", "draft_key", "revision", "saved_at" }
frame → host  { "type": "draft-list", "id" }               host → frame  { "type": "drafts", "id", "drafts": [{ "draft_key", "revision", "saved_at" }] }
frame → host  { "type": "draft-load", "id", "draft_key" }  host → frame  { "type": "draft", "id", "draft_key", "revision", "saved_at", "body", "source_ref": {…} | null }
frame → host  { "type": "draft-delete", "id", "draft_key" } host → frame { "type": "draft-deleted", "id", "draft_key" }
refusal       { "type": "draft-refused", "id", "op": "save | list | load | delete",
                "reason": "conflict | too-large | unavailable | invalid | rate-limited | not-found | not-set-up | not-opened | busy",
                "current_revision"?: <int> | null }
```

- Host routes (Platform, platform/next8): `PUT /api/apps/{program_id}/drafts/{draft_key}` with
  `{swarm_id, expected_revision, body, source_ref?}`; `GET /api/apps/{program_id}/drafts?swarm_id=`;
  `GET|DELETE /api/apps/{program_id}/drafts/{draft_key}?swarm_id=`. Signed-in person only; app enabled; swarm
  visible; last 20 revisions kept; 30 days idle expiry.
- One write per key at a time, per frame: while a `draft-save` or `draft-delete` for a key is unanswered, another
  save or delete of that key is refused `busy` (never queued, never re-based onto a newer revision); other keys and
  list/load stay usable. The frame keeps the edits marked dirty and saves again once the first answer arrives.
- `source_ref` is optional on the wire but not nullable: when a loaded draft has `source_ref: null`, omit the field
  when saving it again (sending `null` is `invalid`).
- `expected_revision` is required: `null` creates (an existing draft is a conflict), a number replaces exactly that
  revision. A stale save is never applied: `conflict` with the hive's `current_revision` (null: the draft was
  discarded elsewhere). The frame keeps the person's edits and offers "load the newer one" or "keep mine" (save
  again with `expected_revision: current_revision`).
- `body` must be JSON data (plain objects, arrays, strings, finite numbers, booleans, null; depth ≤ 64). Over 256 KB
  (UTF-8) is refused `too-large` by the host before any request, and by the hive (413 `draft_too_large`).
- `body` comes back as JSON data; `source_ref` is re-validated as an exact reference or returned as null.
- Mapping from the hive: 409 `draft_conflict` → `conflict`; 413 → `too-large`; 400/422 → `invalid`; 404 on
  load/delete → `not-found`; anything else (no person, app disabled, swarm unknown, no route, network) →
  `unavailable`. Hive error text is never forwarded.
- Limits per frame per 10 s: save 20, list 10, load 20, delete 10 (`rate-limited`). Messages other than
  `draft-save` are at most 2048 bytes; a `draft-save` at most 256 KB + 4 KB.
- Deleting is the person's own action inside the app on their own private draft; the host does not ask again.

**Picked-image bytes.**

```json
frame → host  { "type": "asset-bytes", "id", "handle": "<sha256 hex>" }
host → frame  { "type": "asset", "id", "handle", "mime": "image/png | image/jpeg | image/webp | image/gif",
                "size", "bytes": <ArrayBuffer, transferred> }
           or { "type": "asset-refused", "id", "handle"?,
                "reason": "not-picked | unsupported-type | too-large | mismatch | busy | unavailable | invalid | rate-limited" }
```

- Only for a handle the host itself returned in a `picked` reply to THIS frame session. The host records each picked
  asset as it answers; a new frame, a reload of this one, or another app's frame starts with none (`not-picked`).
  At most 256 remembered per session.
- Bytes come through the host's existing authenticated download route (`GET /api/assets/{sha256}`), as the person.
- Raster images only. The listed mime must be one of the four above, else `unsupported-type`, before any fetch.
  **SVG is excluded**: it is active content (script, event handlers, external references). In an `<img>` it runs
  nothing, but the frame could also navigate to or embed a `blob:` of it, and slice 2 does not lean on CSP
  inheritance for `blob:` documents to keep that safe. A later slice may rasterise SVG on the host (decode in an
  `<img>`, draw to a canvas, send PNG) once Platform reviews it.
- At most 8 MB, checked against the listed size before fetching and against the bytes received (`too-large`).
- The bytes must start with the signature of the listed type (PNG, JPEG, GIF, WebP), else `mismatch`.
- At most 3 fetches in flight per frame (`busy`), 30 requests per 10 s (`rate-limited`).
- The frame shows them with `URL.createObjectURL(new Blob([bytes], {type: mime}))`; its CSP allows `blob:` images.


**Platform next8 change (2026-10-05):** drafts exist only where the app is set up (one of its homes). Otherwise the hive returns 404 `app_not_here`, which reaches the frame as `draft-refused` with reason **`not-set-up`**. Show it neutrally, e.g. "Drafts aren't kept here: this app isn't set up in this swarm". It is not a missing draft.

### 9c. Candidate additions (frame ops for apps' real interfaces: Atlas survey G1–G9; Surface builds the host side, Platform the routes)

Additive, like §9a/§9b: exact keys (plus `channel`), unknown `type`s ignored. A message that names a program, swarm,
person or any extra key is refused `invalid`: the host supplies the app and swarm, the hive the person. Host code:
`hive/ui/src/lib/frameOps.ts` (shapes, checks, reply mapping), `lib/frameWire.ts` (every wire name and the read route,
in one place), `features/programs/AppFrame.tsx` and `FrameOpsDialogs.tsx` (prompt and viewer).

**Context additions.** `capabilities` gains `read` (the host has the read route AND the app's `describe().reads` lists
at least one read), `openUrl`, `showFile` and `fullBleed` (true in this host), and `actFile` (true only for a
signed-in person: `/api/auth/me` `person_kind: "person"`).

**Limits.** Every message from a frame spends one token of a per-frame bucket (60, refilled 20 a second). An empty
bucket answers `rate-limited` in the message's own reply type where it has one (`read-refused`, `url-refused`,
`file-refused`, `picked`, `draft-refused`, `asset-refused`, `goal.refused`, `app-reply`), else the message is dropped.
Per-op limits per 10 s on top: read 30, open-url 5, show-file 10, layout 10, goal (un)subscribe 30; back/escape 4 per 2 s.

**G1 `read`.** A declared read of this app in this swarm, as the person: not a WorkGraph and not an action.

```json
frame → host  { "type": "read", "id", "query": "<[\\w.-]{1,64}>", "params"?: { <JSON object, ≤ 1 MB serialised> } }
host → frame  { "type": "read-result", "id", "query", "result": { <JSON object> } }
           or { "type": "read-refused", "id", "query"?, "reason":
                "not-declared | refused | too-large | bad-request | unavailable | not-set-up | not-opened | rate-limited | busy | invalid" }
```

- Route (Platform): `POST /api/programs/{id}/read {swarm_id, query, params?}` (any other key 400) → `{program, query,
  result}`. Only `result` goes to the frame. A read is declared in `describe().reads = [{id, label?}]`; `read(ctx,
  query, params)` must return a JSON object (else 500 `bad_result`), at most 4 MB serialised (413 `read_too_large`);
  never persisted. A successful read admits the person exactly as a view does; an oversized or bad answer does not.
- The host checks the query id, refuses `params` that are not a plain JSON object (`bad-request`) or over 1 MB
  serialised (`too-large`; Platform's server cap) and a query the app
  does not declare (`not-declared`) before any request; refuses a 200 `result` that is not a plain object
  (`unavailable`) or over 4 MB (`too-large`); at most 4 reads in flight (`busy`).
- Mapping: 404 `unknown_read` → `not-declared`; 403 `program_refused` → `refused`; 413 → `too-large`; 400 `bad_request`
  → `bad-request`; `app_not_here` → `not-set-up`; `app_not_opened` → `not-opened`; 403 `app_integrity`, 409
  `program_disabled`, 500 `bad_result`, network, anything else → `unavailable`. Hive error text is never forwarded.

**G2 `act` with a file.** The existing `app-request op:'act'` body may carry one file from the person.

```json
frame → host  { "type": "app-request", "id", "op": "act", "body": { "action", "items", "params"?, "base_revision"?,
                "file": { "name", "mime", "bytes": <ArrayBuffer, transferred> } } }
host → frame  { "type": "app-reply", "id", "ok": true, "result" }
           or { "type": "app-reply", "id", "ok": false, "error": "<reason>", "reason":
                "file-not-accepted | file-type-refused | too-large | bad-file | not-opened | person-required | declined | busy | unavailable | rate-limited | invalid | confirm-required" }
```

- The host computes `size` from the bytes and refuses over 20 MB before anything else; cleans the name (control and
  bidi characters removed, at most 255 characters; untrusted text) and checks the mime shape (`bad-file`). An action
  declares `describe().actions[].accepts_file = {mimes, max_bytes ≤ 20 MB}`; when the host's describe shows it, the
  host pre-checks (`file-not-accepted`, `file-type-refused`, `too-large`). The hive stays the authority.
- Only a signed-in person (`capabilities.actFile`); an operator session is refused `person-required` before any call.
- The host shows its own decision (DecisionDialog: app, action, items, params, file name, type, size, what happens).
  Cancelling answers `declined`. One at a time (`busy`). A file action is `person_activity`, so the confirm also mints
  the host confirm token of §9d, whose payload digest includes the file's `{name, mime, size, sha256}`.
- On send the host base64-encodes in chunks and detaches the frame's buffer; it keeps no bytes and never puts them in
  drafts or assets. Route (Platform): `POST /api/programs/{id}/act` with `file: {name, mime, size, content_base64}`
  and an `idempotency_key` the HOST makes, one per confirmed intent (a frame-sent key is replaced). A lost or
  failed answer of a `person_activity` act is first checked by presenting the same token once (§9d: a done intent
  returns its recorded result; nothing is delivered again). Otherwise the host asks the person again, saying the
  earlier attempt may already have had its effect and that confirming again may repeat it unless the app recovers it;
  that confirm mints a new token and sends the same key and bytes. A `confirm: true` action without `person_activity`
  has no recovery and is asked again directly. Cancelling that ask answers `unavailable`.
  Request capped at 28 MB. The program gets `ctx.file = {name, mime, size, sha256, bytes}`; only name, mime, size and
  sha256 enter the intent digest.
- Mapping: 400 `file_not_accepted` → `file-not-accepted`; 415 `file_type_refused` → `file-type-refused`; 413
  `file_too_large` or `request_too_large` → `too-large`; 400 `bad_file` → `bad-file`; 403 `app_not_opened` →
  `not-opened`; 403 `person_required` → `person-required`; anything else → `unavailable`.
- **Host confirm (§9d), every confirm act, with or without a file** (an action whose describe says `confirm: true`,
  always so for `person_activity`, or one the host's describe does not show). The host asks in its DecisionDialog
  before anything is sent; the frame never sees the token. Reasons: `declined` (cancelled), `busy` (another confirm is
  open), `person-required` (a `person_activity` action and no signed-in person), `invalid` (the payload holds a value
  outside the §9d number domain, refused before any call, or 400 `confirm_unsupported_value`), `too-large` (the
  canonical payload, file bytes excluded, is over 2 MiB: refused before any call, or 413 `confirm_payload_too_large`
  at mint or act), `confirm-required`
  (403 `confirm_required` / `confirm_invalid`, or 400 `confirm_digest_mismatch`: the hive did not accept the host's
  confirm; the person is told plainly "This needs your confirmation again." and nothing was done; the frame may ask
  again). Other refusals map as above.

**G3 `show-file`.** The host shows a program-held document in its own viewer.

```json
frame → host  { "type": "show-file", "id", "name", "mime": "application/pdf | text/plain", "bytes": <ArrayBuffer, transferred> }
host → frame  { "type": "file-shown", "id" }   then, when the person closes it, { "type": "file-closed", "id" }
           or { "type": "file-refused", "id", "reason": "unsupported-type | too-large | mismatch | busy | rate-limited | invalid" }
```

- The frame sends the bytes it already has (the simpler path: no second route, and the program decides what it hands
  the frame through `read`/`act`). At most 20 MB. Other types (HTML, SVG, images, …) are `unsupported-type`.
- Text is decoded as UTF-8 and rendered as text (escaped; first 1,000,000 characters). A PDF must start with `%PDF-`
  (`mismatch`) and is **download-only** (Review I1, 2026-10-05): the host shows the file's name, type and size and an
  explicit Download; it never renders a PDF. Chromium renders PDFs only in an unsandboxed iframe, and a link inside
  one navigated the whole host tab in real Brave, so no show-file path creates an iframe, and every iframe in the UI
  is sandboxed without `allow-same-origin`, `allow-popups` or top navigation (a source test enforces both). The
  download blob is typed `application/octet-stream` whatever the app declared, so it is saved, never rendered. A
  contained PDF viewer (pdf.js to canvas in a sandboxed frame) is a later request with a real-browser link and
  top-navigation test.
- Nothing is persisted, no URL goes back to the frame, the blob URL is revoked on close. One viewer at a time.

**G4 `open-url`.**

```json
frame → host  { "type": "open-url", "id", "url": "<https only, ≤ 2048>" }
host → frame  { "type": "url-opened", "id" }
           or { "type": "url-refused", "id", "reason": "not-https | invalid | busy | rate-limited | declined" }
```

- https only (anything else `not-https`); no user/password in the URL (`invalid`). The host prompt shows the full
  destination origin (punycode as parsed) and the path, shortened in the middle. Only the person's own click on the
  prompt's link opens it (`target=_blank`, `rel="noopener noreferrer"`, no referrer). One prompt at a time (`busy`).
- The frame cannot open popups itself: its sandbox is `allow-scripts allow-downloads` (no `allow-popups`, no
  `allow-top-navigation`, no `allow-same-origin`). References are not access (§2).

**G7 `back-request` / `escape`.** `{type:'back-request'}` and `{type:'escape'}` (exact keys; no reply). The host treats
either as its own Back (`programBackOrExit`: a step back, else leave the app), unless one of its own dialogs is open
(that dialog owns Escape). Escape pressed inside the frame reaches the host only if the frame forwards it as `escape`.
The frame never navigates the host; keep the frame's own sheet stack internal (no history API).

**G8 `layout`.** `{type:'layout', mode:'full'|'framed'}` → `{type:'layout-set', mode}`. In `full` the frame fills the
stage below the host's minimal chrome (no rounding or minimum height); Ω stays bottom-left, so Back and Leave stay
reachable. A new frame starts `framed`. A full-bleed frame must honour `context.insets` and `context.reserved` (Fit,
below).

**Fit (request J): height, safe areas, the Ω corner, host notices.** Host code: `hive/ui/src/lib/frameFit.ts`
(geometry, pure), `features/programs/useStageFit.ts` (measuring), `shell/appStage.ts` and `shell/Hud.tsx` (notices).

- *Height.* The app page is `100dvh` and the frame takes the stage's height by flex. There is no fixed minimum height,
  so a short screen (a phone in landscape, 844×390) never pushes the app's own navigation below the fold. A frame
  that needs a minimum should use `min(640px, 100%)` or its own scroll, never one taller than the screen.
- *Why the host says it.* Inside a sandboxed frame `env(safe-area-inset-*)` is always 0, and the frame cannot see Ω.
  The host measures both on its own page and sends them in `context`, **in the frame's own box**:
  - `insets {top, right, bottom, left}`: how far the device's safe areas (notch, home indicator, rounded corners)
    reach into the frame;
  - `reserved.bottomLeft {width, height}`: the rectangle at the frame's bottom-left corner that Ω covers, plus a
    12 px margin. Ω's glyph is a 36 px disc 12 px from the edges, lifted by the bottom inset and moved right by the
    left inset. Its hit area (`omegaHit`) is the glyph on a fine pointer and a 44 px square around the same glyph on a
    coarse (touch) pointer, 8 px from the edges, so the glyph does not move; the reserved rectangle is measured from
    the hit area, so on touch it is 4 px larger each way (request Q). It is `{0, 0}` when Ω does not meet the frame.
  Context is re-sent on resize, orientation change, visual-viewport change, layout change and when the frame or Ω
  changes size; only a change of a whole pixel sends it.
- *Framed (the default).* The host pads the frame by the device insets and keeps a bottom lane as tall as Ω's area
  (Ω on its left, host notices on its right). Ω and notices never cover the frame, so both values read 0 and an app
  that ignores them is fully usable. The lane is not wasted: it is where the host's own controls and notices live.
- *Full-bleed (`layout: full`).* The frame fills the stage, under the safe areas and under Ω. **The frame must honour
  both:** pad its content by `insets` on each side, and keep every control out of `reserved.bottomLeft`, for example
  by padding a bottom navigation bar on the left by `max(insets.left, reserved.bottomLeft.width)` when the bar lies
  within `reserved.bottomLeft.height` of the bottom. A typical pattern is custom properties set from `context`:
  ```css
  .bottom-nav { padding: 8px max(8px, var(--hive-inset-right)) calc(8px + var(--hive-inset-bottom))
                max(8px, var(--hive-inset-left), var(--hive-reserved-bl-w)); }
  ```
  An app that cannot honour them should stay framed.
- *Host notices (toasts) while an app frame is mounted.* Framed: one line in the bottom lane, right of Ω, outside the
  frame (the newest notice, with a count of the others; the full text stays in the live region). Full-bleed: one line
  at the top centre, below the top inset, so the app's bottom navigation stays clear; it is transient and
  dismissible. While a whole experience is in front (no classic page or sheet over it; request Q,
  `shell/experienceStage.ts`), notices are the same one-line pill at the top centre by preference, placed clear of the
  chrome the experience marks `data-xc-keep-clear` (its bars, docks, pagers, command lines) and of Ω, between the top
  and bottom insets (`experienceNoticeTop`). On a coarse pointer the pill and its controls are 44 px tall. Elsewhere
  in the hive notices are where they always were. In every case they sit under host dialogs (z 50) and are inert while
  a dialog is open, as before.

**G9 goal notices.** `{type:'subscribe'|'unsubscribe', goal_id}` → `{type:'goal.subscribed'|'goal.unsubscribed',
goal_id}` or `{type:'goal.refused', goal_id, reason: 'not-started-here | invalid | rate-limited'}`; then
`{type:'goal.status', goal_id, status}`.

- Only goals THIS frame's own `act` started (the host records `result.task.id` when `task.kind` is `goal`). A new
  frame, or a reload, starts with none; every subscription is dropped when the frame unmounts.
- Status only, from `goal.updated` events the page itself already receives (visibility-filtered by the hive). The
  host fetches nothing for the frame and adds no server subscription. Not delivered: a `program.revision` notice (the
  page receives no such event today; gap noted for Platform).

**G5 CSP (client-side, `lib/appFrame.ts` `frameCsp`).** The frame CSP adds `style-src-attr 'unsafe-inline'` (style
ATTRIBUTES only; style elements still need the nonce; scripts stay nonce-only):
`default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; style-src-attr 'unsafe-inline'; connect-src 'none';
img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'`. With no fetch directive open, an attribute
style cannot load anything; the risk is visual only. **Review note: this is a deliberate CSP widening (Platform
ruling 2026-10-05).**

### 9d. Host confirm for app acts (Platform/Surface agreement 2026-10-05; Platform built the routes, Surface the host side)

A consequential act is confirmed by the person in the host, not in the frame, and the hive checks that it was.

**Field.** `describe().actions[].confirm` is an optional boolean (any other value, `null` included, fails the app's
load). An action needs a host confirm when `confirm: true` OR `person_activity: true`; a `person_activity` action
cannot opt out (`confirm: false` with `person_activity: true` fails the load). The hive's describe
(`GET /api/programs/{id}`) carries the effective value on every action as `confirm: true|false`; the host shows its
DecisionDialog (app, action, what it acts on, any file) for every action where it is `true`.

**Payload digest.** `payload = {"items": items, "params": params, "base_revision": base_revision}` exactly as the act
will send them, normalized as the hive does (missing `items` is `[]`, missing `params` is `{}`, missing
`base_revision` is `null`), plus `"file": {"name", "mime", "size", "sha256": "sha256:<hex of the bytes>"}` when the act
sends a file (the cleaned name the host sends). `payload_digest = "sha256:" + hex(sha256(utf8(canonical(payload))))`,
where `canonical` is JSON with:
- object keys sorted by Unicode code point at every level (in JS compare `codePointAt`, not the default UTF-16 sort,
  which orders astral characters differently);
- separators `,` and `:` with no whitespace;
- strings and keys as `JSON.stringify` writes them: U+007F and all non-ASCII (U+2028/U+2029 included) as is,
  UTF-8 encoded; escaped are exactly `\"`, `\\`, the shorthands `\b \f \n \r \t` (U+0008, U+000C, U+000A, U+000D, U+0009), and
  every other U+0000–U+001F as `\u00xx` with lowercase hex (U+0007 is `\u0007`); `/` is not escaped;
- in Python, `json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`.

*Number domain.* So that both sides always write the same text, a confirmable payload holds only objects, arrays,
strings (valid Unicode, no lone surrogates), `true`, `false`, `null` and integers with |n| ≤ 2^53−1. No decimals at
all: no `1.5`, no `1.0`, no exponent forms, no `-0.0`, no NaN or Infinity. The confirm route and the act route both
refuse anything else with 400 `confirm_unsupported_value` before a token is minted or spent (the host should tell the
person this act cannot be confirmed as sent; an app that needs fractions sends them as strings or scaled integers).
Actions without a confirm are unaffected.

*Size.* A confirmable payload is at most 2 MB (2,097,152 bytes) as canonical UTF-8 JSON; file bytes are not in it
(only the file's name, type, size and sha256). Larger payloads are refused 413 `confirm_payload_too_large`, at the
confirm route and at the act route alike, so no token is minted for an act that would be refused. The confirm
request itself is capped at 5 MB to leave room for a host that escapes more than the canonical form.

*Normalization.* The confirm route normalizes `payload` exactly as the act route normalizes its body before checking
the digest: `items` missing or `null` is `[]`, `params` missing or `null` is `{}`, `base_revision` missing is `null`, a
`file` that is missing or `null` is left out. The host digests that normalized form.

The shared vectors `hive/tests/fixtures/confirm_digest_vectors.json`
(payload, canonical text, digest; and refused payloads as raw JSON text) are asserted by the hive's tests and are
for Surface's JS tests to assert too.

The `action`, `swarm_id`, `idempotency_key` and the token itself are not in the payload; action and swarm are bound
separately.

**Token flow.**

1. The frame sends `app-request op:'act'` as before. For a confirm action the host shows its DecisionDialog.
2. Only after the person confirms, the host calls `POST /api/programs/{id}/confirm` with exactly
   exactly `{swarm_id, action, payload, payload_digest}` (any other key, a payload with keys other than `items`,
   `params`, `base_revision` and `file`, or a digest not `sha256:` + 64 lowercase hex: 400 `bad_request`). The hive refuses a payload
   outside the number domain (400 `confirm_unsupported_value`) and a digest that is not its own digest of `payload`
   (400 `confirm_digest_mismatch`), so a host canonicalization bug shows at once, never as an unredeemable token. It
   then applies the act route's own gates: a signed-in session (a mind's token is no session: 401),
   the swarm visible to this person (404 otherwise), the app loaded, enabled and unchanged on disk, the action declared
   (400) and needing a confirm (400 `confirm_not_needed`), `approver: "person"` → a named person (403
   `person_required`), `person_activity` → a named person with role admin or member, never the local operator password
   (403 `person_required`), and the app active in this swarm when it needs activation (403 `app_inactive`).
3. The answer is `{"confirm_token": "hct_<43 url-safe characters>", "expires_at": "<UTC ISO, ms, Z>",
   "expires_in": 120}`. The hive stores only the token's sha256 with the person's principal, the session's token hash,
   the program, swarm, action and payload digest.
4. The host sends the act with `confirm_token` at the top level of the act body (never inside `params`, where any
   `*token*` key is still refused as a credential). The frame never sees the token; the app never receives it.
5. The act route refuses a confirm action without a token (403 `confirm_required`) and a token that does not match
   the acting principal, the same session, program, swarm, action and the digest of the payload actually sent, or that
   is expired or already used (403 `confirm_invalid`). One conditional update spends it, so two acts racing on one
   token cannot both pass. Actions without a confirm ignore the field (back-compat).

**Retries, failures and what the hive does not promise.** Every delivery that can have an effect spends an unused,
unexpired token, and spending binds the token to that delivery's intent record (`program_actions`, keyed by person,
program and `idempotency_key`). A spent token is accepted again in one case only: the same intent is already **done**,
so the hive answers the retry as a recovery (`ctx.actor.recovery: true`, the recorded result in `ctx.command`), and
the program delivers nothing again. Every binding still applies (person, session, program, swarm, action, payload), as
do the current gates (named person, activation, the program's own access check in its recovery). This holds after the
token's 120 s, for a day, so a lost answer to a completed act does not ask the person twice.

A **failed** intent (the program raised, timed out, or the hive lost the call) has an **unknown** effect: the hive does
not know whether the program acted before it failed. Such an intent is never re-run under its spent token, before or
after expiry (403 `confirm_invalid`). Trying again needs a fresh token, which the host mints only from a new explicit
confirm by the person, who should be told the first attempt's outcome is unknown. A re-run delivers the same
`ctx.command.idempotency_key` and `record_id`; only the program can make its effect idempotent on them. The key and the
hive's records give at-most-one delivery per confirm, not exactly-once effects. When a failed intent is delivered again
under a fresh confirm, `ctx.command` carries `prior_failed: true`, so the program knows an earlier attempt may have
acted; a first delivery and a recovery never carry it. An intent still `running` is refused
409 `in_progress`. A new key with a spent token is `confirm_invalid`. A confirm action that is not `person_activity` has
no intent record: its token is strictly single use.

Suggested mapping for the host's `app-reply` reason (Surface's to settle): 403 `confirm_required` / `confirm_invalid` → `unavailable` (the host
minted and attached the token itself, so either means the host's confirm went stale; it asks again).
Settled by Surface (2026-10-05): a frame is answered `confirm-required` for 403 `confirm_required` / `confirm_invalid`
and 400 `confirm_digest_mismatch`, `invalid` for 400 `confirm_unsupported_value`, and `too-large` for 413
`confirm_payload_too_large` (§9c); the person sees a plain sentence ("This needs your confirmation again."), never the
hive's text.

## Read actions (`"effect": "read"`, r15)

An action that discloses content and changes nothing (for example a library search or a page read) declares
`"effect": "read"` next to `"agents": true`. For such an action, when a mind calls it:
- **No disclosed content is stored.** The hive stores the action record with `{"redacted": "read", "digest", "status"}`
  in place of the result. The content reaches only the caller, and the activity feed never shows it.
- **A repeat runs the action again.** The same `idempotency_key` re-runs the read under the grants in force at that
  moment. A withdrawn grant or attachment therefore discloses nothing, even for a key that succeeded before.
  Ordinary actions still return their stored receipt.
- **The app's `ctx` is read-only, enforced by the hive.** Publishing and every write capability fail with `read_only`.

Declare `effect: "read"` only for actions that are safe to repeat. Anything with an effect keeps the ordinary contract.


## App-scoped Ask (P1 host contract)

P1 requires a named signed-in person, trusted consent to the app's exact pinned
release, and an active visible frame generation. `GET /api/programs/{id}/ui`
adds a positive `release: {digest, version}` atomically bound to the same returned
verified UI bytes for a pinned app. Legacy omission or `null` means the app may
render but Ask is unavailable. The frame receives
no bearer, cookie, confirmation token or session reference.

The host uses `/api/programs/{id}/ask/consent` (GET card, POST its host-only
`card_id`, DELETE revoke), `/ask/frames` (POST a fresh generation) and
`/ask/frames/{generation}/presence` (POST renewal), DELETE that generation, and
POST `/ask/frames/{generation}/ops`. Mutations use the existing exact host-Origin
named-person gate. P1 operations are closed and capped at 8,192 UTF-8 bytes;
existing generic bridge operations retain their 2 KiB limit.

Operations are send, resume, subscribe, unsubscribe, poll, yield, act-claim and
act-result. IDs select existing consent-bound turns, never other conversations.
Events use bounded canonical chunks/cursors, not a frame websocket token or a new
transcript. Presence renews every five seconds with a fifteen-second server TTL.
New documents fence old generations; lapse offers the same nonterminal turn back
to the host. Only consent-started turns resume; an initial trusted host handoff is
limited to its original generation. Raw frame handoff cannot choose that snapshot.

Host reclaim/handback uses GET/POST `/api/ask/{operation}/presentation` with an
expected owner epoch. It never calls terminal takeover. Every P1 act has its
original recipient and must claim once before any browser effect; host claim is
POST `/api/ask/{operation}/acts/{act}/claim` with `owner_epoch`. Duplicate or
unknown claims never execute/retry; late old-frame results cannot use host routes.
A persisted `app_ask: true` view/event marker prevents historical automatic legacy
side effects from being replayed as host actions after reload.

See `P1_APP_ASK.md` for limits, races and recovery.
