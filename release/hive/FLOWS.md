# OmegaFlow host candidate

OmegaFlow adds native Flow navigation and an object/link canvas to Hive, with immutable semantic revisions and explicit goal-run adoption. The agent extension is based on platform 99c2d74; integration and deployment belong to the platform owner.

## Representation and authoring

The bounded `omegaflow/1` IR retains typed objects, n-ary ordered roles, relations about relations, transitions, events, constraints and pinned subflow references. Layout is a separately versioned sidecar and never changes the semantic fingerprint. Fixed MeTTa predicates contain inert hex-encoded JSON, with derived indexes checked against retained fields. This is lossless interchange and structural querying; reflective rewriting, inference and native Hyperon flow execution are unqualified.

The studio saves semantic snapshots as existing C39 artifact revisions, requires an optimistic parent when adding a revision, and uses a compare-and-swap layout version. Drafts stay in browser memory until explicitly saved or exported. Host APIs derive named-user authority from a live SSO session and database person, scope ownership and visibility; agent credentials cannot adopt. Native agent publication and invocation use the distinct member-token routes described below. The iframe never receives a bearer token. The parent loads three fixed studio assets and embeds them in an opaque-origin srcdoc iframe with allow-scripts/allow-downloads, without allow-same-origin. Nonced inline assets and CSP connect-src none keep resource/API fetches out of the child. The parent bridge requires origin null, the exact frame WindowProxy and the current random document channel; replies target that window with *, while the child pins the parent origin and channel. The child cannot access the parent DOM, host storage, cookies or its own sandbox attribute. The bridge exposes only the fixed operation allowlist through Hive's existing authenticated client.

## First executable subset

Execution requires explicit adoption of the exact revision fingerprint, then an explicit start with an idempotency key. Supported transitions form an acyclic, single-predecessor graph; triggers are run.start and run-local goal.done/goal.failed. Actions create goals in the flow's own swarm with literal title/detail/priority/assignee/result_schema/review/deadline parameters. Review is none or person. Completion is validated again against bound worker results, schemas and the matching named-person review receipt.

Guards, loops, joins, subflows, request/message/app actions and program validators are refused. A worker's native child goals are tracked for cancellation and must finish before the flow advances. Cross-swarm requests from any flow-rooted goal are refused until that path is qualified. Element metadata describing adoption or an approver is never host authority.

## Coordinator and recovery

Hive's existing level-triggered reconcile calls `Flows.reconcile`; there is no second scheduler. A SQLite BEGIN IMMEDIATE transaction atomically admits the deterministic goal and step record. Person run identity pins actor and session; agent runs pin actor_kind, actor_ref and token identity separately. Both pin artifact revision and digest; actor/client-key is unique. Dispatch rechecks current session/person/scope authority, adoption, immutable body, target and assignee. Revocation blocks the run and cancels unfinished work. Cancellation covers the native child-goal family and atomic parent admission prevents late children after cancellation.

Notifications follow commit and are advisory; workers discover durable goals. Crash/replay cannot duplicate a dispatched native goal. This does not promise exactly-once external worker effects. No provider run or deployment was performed in qualification.

## Verification

`hive/tests/test_flows.py` is self-contained with synthetic people, swarms and a fake process supervisor. It covers storage, actor authority, adoption, result/review gates, unsupported forms, idempotency, cancellation, delegated children, three crash stages, restart and concurrent controllers. Browser checks exercise the actual native shell and bridge against an offline disposable Hive. Receipts and screenshots are in the OmegaDot workspace's `coordination/omegaflow/`; integration handoff records final counts and commit.

## Frame isolation qualification

Candidate changes use nonce-bound inline assets with no dynamic evaluation. The frame retains local export/import but receives no bearer token. Browser adversarial probes cover parent DOM/storage/cookie access, sandbox element access, direct API fetch denial, stale-channel messages, host-origin forgeries and sibling-frame messages. The normal save/adopt/start/layout/cancel/load browser path remains qualified against an offline fixture. This does not establish browser-independent protection against every possible navigation or external effect; the studio is reviewed platform code and imported data is always inert.

## Authoring templates

Use **Templates** in the canvas toolbar for task review workflows, lead funnels, interaction handoffs, connection maps and the invented garden example. Selection replaces the local draft and is undoable; export it to keep it. Connections support ordered n-ary roles and links about links. The catalogue supplies no live identities or permissions, and selecting a starter never saves, adopts or starts a run. Configure actual host bindings and approvals separately.

## Native mind authoring and reusable workflow skills

Member-token routes support own-swarm drafts, exact-parent revisions and exact-revision reads. Fixed skills are hive-flow-draft, hive-flow-revise, hive-flow-read and hive-flow-drafts. Agent-authored elements remain draft; C39 retains agent authorship. These operations never grant adoption or execution authority.

hive-flows discovers published own-swarm definitions in flow_skills. hive-flow-publish registers a name, purpose and exact artifact/revision/digest; it requires an exact agent-specific admin allow rule through EXPLICIT_ONLY. Missing, hive-wide, swarm-wide and wildcard rules fail. This permission is the first-slice publication review gate; there is no invented review receipt. Registration may precede person adoption. Names preserve history and cannot be rebound, even after retirement; a changed definition uses a new name. Discovery supplies an empty-object input schema.

hive-flow-run accepts a name and JSON containing exactly params={} and a bounded client_key. Invocation requires current exact person adoption. The coordinator rechecks the invoker's token, own swarm, policy, lifecycle, publication and digest before advancement. Stopped minds are eligible; deleted, moved or error minds are refused. An agent run survives the adopting person's session expiry. Migration defaults legacy runs to person and backfills actor_ref; person session_hash remains unchanged. Token hashes never appear in API run views.

hive-flow-run-get and hive-flow-cancel are limited to the invoking mind. hive-flow-retire requires the same exact publication permission, hides discovery, blocks new starts and cancels in-flight goal families. Workers retain native cancel-ack. A deleted recipient cannot acknowledge; durable cancellation remains recorded and notifications still reach any remaining live recipient. A stalled step now blocks the run with step_stalled and cancels unfinished work.

Validation labels non-goal actions unsupported by this host, while preserving their inert representation. Person result review remains required where declared; publication cannot bypass it.

## Follow-on seams

Person session expiry still follows the existing fail-closed cancellation behavior. Proposed next change: an explicit awaiting_reauthentication state with no new admissions, retaining the original person and pinned definition; only that current named person (or a separately reviewed recovery authority) can rebind a session after all scope/adoption checks. Whether already admitted workers pause or cancel needs platform review before implementation.

Transition outcomes should use D2's shared evidence envelope once platform S1 exists. No parallel evidence publisher, fabricated truth values, or claim of autonomous Hyperon reasoning is introduced here. Qualification is disposable offline host testing; live worker, provider and deployment acceptance remain platform work.


## S4 dynamic inventory follow-up

agent_dynamic_inventory(agent) is a read-only internal projection for platform S4 integration. It checks hive-flows policy and current token/lifecycle, and returns the draft's dynamic entries: kind=flow-skill, id=the own-swarm registered name, registry_revision=sha256 of the complete sorted published discovery catalogue. It does not create boot receipts or label workflows callable. The hash is a content revision, not a monotonic counter; retiring a newly added skill can restore an earlier catalogue hash. The consumer must retain the mind/swarm context of these local names. Platform owns the S4 route and schema integration; there is no new route, tool or registry here.
