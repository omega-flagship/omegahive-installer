# Create plan engine: seams and deltas for Dot

The host engine (`hive/core/create_plan_engine.py`, R4.1) works end to end. It passes faked tests and a live run against
a scratch OmegaCode with the sandboxed check. Each item below is a change that belongs to someone else's file, or a
decision that is not the engine's to make. None is patched around in the engine.

## 1. Relay: the forks route is held by Code (`hive/core/code.py`)

**Current state.** `POST /v1/workspaces/{ws}/forks` is held "per Code: actions not named". The relay does not guess
authority (`test_code_proxy_actions.py`), so this branch does not add the route. `OmegaCodeSpace` picks its mode from
the relay table:
- **patch** (what runs today). Each piece gets its own workspace on the plan's task, brought to the integration head's
  content. Integration is one guarded patch of the piece's changed files. Each edit's `expected_digest` is the file's
  digest where the piece started, so OmegaCode refuses a moved file with `stale_file`; that becomes `merge-conflict`.
- **fork-merge** (switches on by itself once Code names the route's actions). It uses OmegaCode's own cross-fork
  merge. The base is the integration checkpoint the fork came from, because OmegaCode requires a common ancestor. A
  merged piece's next fix forks afresh.

**What Code needs to do.** Name the actions for the forks route. The service itself checks read on the parent, plus
workspace authority and full task scope. Then add that row to `PROXY_ROUTES`.

**Evidence.** Both modes pass live, against the scratch service. The fork-merge run adds the route to the relay table
for that test only.

## 2. Deployment configuration

- **Scaffold repository.** OmegaCode's service config must register a scaffold repository under
  `repositories` (by default `create-web-scaffold`; override with `HIVE_CREATE_SCAFFOLD_REPO`). It holds
  `index.html`, `style.css`, `app.js` and a README, and uses `execution_policy: proposal-only`.
- **Sandbox runner.** `HIVE_SANDBOX_RUN_APPS` must include `create-acceptance-check`. This is the pinned bundle at
  `hive/plugins/create_acceptance_check`. `HIVE_SANDBOX_RUNTIMES` must name `python`.
- **App installs.** `HIVE_PLUGIN_DIRS` must include `<data>/create/apps`. If it does not, the deploy is a definite
  `deploy-refused` with that reason.
  - Under `HIVE_APP_PINS_REQUIRED=1`, an app the person made has no pin and will not load. We need a pin policy for
    apps the person made, for example the host writing the pin at deploy. This is Jon's or Kabir's call.
- **Switch.** `HIVE_CREATE_PLAN_ENGINE=on`. It is off by default.

## 3. OmegaCode has no read-at-checkpoint route

The service reads only a workspace's current generation. So when the host makes a checkpoint, it reads that
generation's files once into `create_plan_snapshots`. Every later read is re-verified against the service's digest.
If OmegaCode adds `GET /v1/workspaces/{ws}/checkpoints/{cp}/files`, the snapshot table can go.

## 4. Pieces are built by per-change members (R3.14 `plan-member`), live

**Current state.** Every piece is built by one real R3.14 per-change member. The typed-goal build adapter is gone:
`Ports.build` has no other path, and `GoalMinds` no longer has a `build` kind. The adapter is `PerChangeBuilds`
(`hive/core/create_plan_members.py`), set as `Ports.members`.

**Mapping (plan effect or observation → member API):**
- **build (piece-started or route-fix).** The piece's fork is made first (`space.ensure_fork`). Then
  `code_controller.adopt_member(plan_id, piece, origin, paths, assignee, budget_ref=plan_id, "plan-reviewed", person,
  task=<op>, brief=...)`. The task is the piece-started op, or `fix-for-<failing op>` on a route-fix. The effect waits
  on `member:<task_id>`. adopt is idempotent, so a member that is already ready is taken at once.
- **Candidate scope (checked, not trusted).** A candidate is checked before it is snapshotted, tested or merged. Every
  file that differs from the fork's origin must be one of the piece's own files, and never `checks/` or a reserved
  path (`candidate_scope`). Otherwise it is refused: the plan journals `piece-blocked`, and the member journals
  `refused`, because `run_test` answers `{refused}` instead of testing.
- **piece-ready.** Wakes on `code.controller.member_ready {plan_id, piece, cand, task_id}`, or on resume, from the
  member's run row (never a poll). The candidate is verified as the fork's current checkpoint and snapshotted
  (`adopt_checkpoint`).
- **integrated.** After the plan journals `integrated`, the plan calls `member_integrated(task, op, cand, ckpt)`. That
  is the member's only delivery. A delivery lost between the journal entry and the call (a crash) is made again from
  the journal, idempotently: before any build, and after every plan step (`settle`).
- **route-fix before integration.** The plan calls `member_refix(task, op, cand, failing_ref, failing)` on the same
  member.
- **route-fix after integration.** The member is already delivered, so a new member starts on a fresh fork. Its brief
  carries the plan's failing output.
- **Budget end.** The plan calls `member_budget_ended(task)`:
  - whenever the plan blocks or stops, for any reason, for every open member. A build still waiting is read back after
    the resume and gets a fresh member, under the attempt key `op~n`;
  - on a reconciled lost build;
  - when a member is replaced.
- **The member's test.** It is `member_ports.run_test`, which is the plan's sandboxed acceptance check on the
  candidate. A piece passes when the check passes, or when the check fails only on files the piece does not own.

**Delta in the per-change engine (`code_controller_member.py`, `code_controller_engine.py`):** `adopt_member` takes
`brief=`, a JSON object of at most 40000 characters. The plan bounds each part, and marks a part it shortened
`{truncated, chars, text}`. It holds the sentence, the piece's title and brief, the acceptance
criteria, the person's answers, and a fix's failing output. The member stores it, and the helper's packet carries it as
UNTRUSTED_DATA. Without it, the member's mind got only its paths and their current text, not what to build. No
reducer change. Member suites stay green.

**Third per-change engine delta.** `_test_effect` journals `refused` when `run_test` answers `{refused}`, for the scope
check.

**Second per-change engine delta.** The scratch folder of `Reducer` (`code_controller_engine.py`) is now rebuilt from
the pinned bytes it already verified when a temp sweep removes it. `PlanReducer` already did this.
- **Seen live.** A second plan in the same hive failed every member step with `FileNotFoundError`.
- **Root cause.** What sweeps `$TMPDIR` in the live world was not identified. `Reducer.close` was not the cause: a probe
  showed only the shutdown calls.

**Plan-engine deltas (`create_plan_engine.py`), each a wake or a callback the port cannot make on its own:**
- **`on_event`.** It routes `code.controller.member_ready` to `goal_changed("member:<task>")`. The engine's watch is
  the only event subscriber, and it knew only `goal.updated`.
- **After `integrated` is journalled,** it calls `ports.integrated(...)`. It must come after the journal entry, and the
  merge port runs before it (journal first, F4).
- **`_step` ends in `ports.settle(run)`.** It runs after every step, so also on resume. It re-delivers lost deliveries
  and ends the members when the plan blocks or stops. This replaces the earlier stop-only callback.
- **The plan view** shows `pieces[].member`, the member's task id.

There is no R4.3 reducer change.

## 5. R4.1 notes (reducer)

- **Unbounded retries.** A lost `integrate`, `review`, `preview`, `author-tests` or `design` is not counted against the
  retry budget. Only start, route-fix and run-checks are counted. If an integrate keeps failing with outcome unknown,
  then `unknown` → `reconcile` → `integrate` repeats without bound. I saw this live before the merge-base fix. The
  engine stops each wake at `MAX_STEPS` and the next event retries. Suggestion: count every lost dispatch.
- **Questions.** `question-withdrawn (q person)` is supported, but no route exposes it, because Surface did not ask for
  one. It would be `POST /api/create/plans/{id}/questions/{q}/withdraw`.

## 6. Who is called for model work (data, not code)

The defaults rows in `create_assignee_defaults` map:
- `capability:plan` and `capability:test-author` → the foundation Create · Code binding;
- `capability:design` → the person's Make mind;
- `capability:code` → Create · Code;
- `capability:review` and `capability:design-review` → the foundation Review binding.

Under the per-change engine, the Code coordinator's request goals are held by the host. The planner or test-author goal
will reach that agent, but it is only answered if a mind runs it. A dedicated planner binding, such as purpose
`create_planner`, is a one-row change.

The design review's render evidence is the appFrame document digest (`render-…`), not a pixel screenshot. A Surface
render service could later supply `(render <screenshot ref>)` through the same ReviewFor evidence kind.

## 7. Preview: every file the pieces built

- **The bundle.** It is every file of the verified checkpoint except `checks/`. Paths are path-checked, at most 64
  files, 600 KB each, 4 MB in all. It goes into the preview release's `ui/` with each file's sha256 in
  `bundle.lock.json`.
- **`GET /api/create/plans/{id}/preview`.** It returns every file, with its content type (from the extension) and its
  digest.
- **`GET .../preview/file?path=`.** It serves one file raw, after its lock digest checks. The headers are CSP
  `sandbox`, `nosniff` and `no-store`.
- **`frame_document`.** It inlines `./<asset>` references in index.html (`src`/`href`) and in style.css (`url()`) as
  `data:` URIs. That is the only way the frame's CSP lets them load.
- **Surface.** `appDocument` got the same inlining in e8fadb31.
- **Deployed apps.** The release lock lists `"assets"`, and `programs.ui_bundle` serves them beside the frame's three
  files.
  - The opt-in is a lock key, so a lock without it keeps the old answer (r17 ruling 3).
  - Each asset must be pinned, path-safe and UTF-8 text: at most 64 assets, 600 KB each, 4 MB in all.
  - appDocument inlines them (Surface e8fadb31, on `surface/create-plan-r1`).

## 8. Multi-hive

There is no federation yet (`shares.py`: "federation comes later"). An `(Assignee hive <other> cap)` therefore resolves
to `assignee-unavailable` (federation-not-available). This hive's own id, or `this`, resolves locally.

## 9. Since the review (R4.3 and the four fixes)

- **Reducer.** The engine runs on R4.3 (`24c3987d…`). R4.2 and R4.1 stay vendored beside it: a plan started under
  either keeps replaying with that version's shapes (Caps, Needs, tests-authored).
- **Data rows (`create_plan_settings`):**
  - `retries` (default 3) is the lost-operation budget, fixed per plan.
  - `reserved_paths` holds the check path plus the stdlib module files the check imports.
- **F1 (reviews).** The reviewer and the evidence are stored in the review effect before the call.
- **F2 (the check):**
  - No piece may own `checks/`, a reserved path, or a `.py` file named like a stdlib module. Both the host and R4.3
    refuse it.
  - The check always comes from the base checkpoint.
  - The runner keeps the build off the check's import path.
- **F3 (who may be asked).** Every resolver candidate is filtered by what the person sees as a member, and never
  another person's personal mind.
- **F4 (journal first, restarts):**
  - Results are journalled before the effect is marked done.
  - Waiting goals are collected on every step, which covers a restart.
  - A refused or untranslatable result becomes `unknown (op)`.
- **App id.** Programs ids are at most 41 characters, so the app id is `create-<32 hex plan id>`; the title goes in the
  app's name.
