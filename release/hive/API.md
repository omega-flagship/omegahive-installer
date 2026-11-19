<!-- Purpose: describe the hive's authenticated HTTP, event and mind interfaces. -->
# OmegaDots Hive — API contract (Phase 1)

The contract between `hive/core` (server), `hive/ui` (web app) and agents.
JSON over HTTP and WebSocket. Times are ISO-8601 UTC strings. IDs are short
URL-safe strings.

## Auth

- **Humans**
  - `POST /api/auth/login {"password"}` → `{"token"}`.
  - From outside this machine the operator password login answers `403 password_login_local_only` before the
    password is read, `HIVE_PUBLIC_PASSWORD=1` included (that flag is for members' passwords, below), so no guess
    at the hive password is checked or counted from outside. An operator password session made on the hive's own
    machine never counts from outside either. On the machine a wrong password is `401 unauthorized` and nothing
    waits.
  - Send the token as `Authorization: Bearer <token>`. Only the events WebSocket takes it as `?token=`, since a
    browser can't set a header there; no HTTP route reads a token from the URL, so `?token=` alone is 401
    `unauthorized`.
  - Without an email, this signs in the local operator using `HIVE_ADMIN_PASSWORD`.
- **Member passwords** (`hive/core/people.py`)
  - An admin adds a member with `POST /api/people/members {"email", "name"?}`. The 201 response contains
    `{person, password, note}`. The password is shown once; people views and events expose only `password_set`.
    The hive stores a salted scrypt hash, never the password. New passwords are three random words from the pinned
    `xkcdpass==1.30.0` packaged EFF long list, joined by dashes; startup refuses a missing or unusable list.
  - The member calls `POST /api/auth/login {"email", "password"}` and receives `{token}` for that person's
    `member_password` session. It has member authority even if that person is later promoted to admin.
  - Admins reset with `POST /api/people/{id}/password` → `{person, password, ended_sessions, note}`, or remove with
    `DELETE /api/people/{id}/password` → `{person, ended_sessions}`. These end only that person's password sessions;
    Google sessions remain. Disabling a person also drops their password. Reset/removal/disable committed during
    in-flight verification prevents a new session from the old credential.
  - Public member-password sign-in and sessions work only with `HIVE_PUBLIC_PASSWORD=1` while Google sign-in is
    unconfigured, and once it is configured only for the test account (below). Google sign-in continues as the same
    person row when configured. Public operator-password sessions retain this fork's existing refusal; this member
    path does not grant operator access from outside.
  - **The test account.** `HIVE_TEST_ACCOUNT_EMAIL` and `HIVE_TEST_ACCOUNT_PASSWORD` name the hive's one test
    account; at start the hive makes that member or marks the member who has that email, with that password. Once
    Google sign-in is configured it keeps its password from outside, still only with `HIVE_PUBLIC_PASSWORD=1`;
    everyone else continues with Google. People views carry `test_account`, read-only: `test_account` on
    `POST /api/people/members` or `PATCH /api/people/{id}`, any value, is `400 bad_request`, and so are
    `PATCH /api/people/{id} {"role": "admin"}` and `POST /api/people/{id}/password` on the test account (its password
    comes from the variable). An admin is never the test account. Unsetting or changing the variables moves or ends
    the mark at the next start, and that person's password sessions stop counting from outside. From outside with
    Google configured, every refused member sign-in (an unknown email, a wrong password, or someone who is not the
    test account) is the same `401 unauthorized`, whose message names Google, so the answers never say which email
    is the test account.
  - `GET /api/auth/methods` says which ways in count where the page was opened: `password`, the operator's hive
    password, only on the hive's own machine (from outside it is `false`, `HIVE_PUBLIC_PASSWORD=1` included, since
    that session never counts there); `member_password`, member passwords, from outside while Google sign-in is
    unconfigured and, once it is, while the test account is enabled and has a password; `sso.login_url`, Google.
  - Wrong public guesses use identical counters, responses, expensive checks, retention and eviction for member
    and unknown identifiers. State has at most 10,000 fixed-size identifier keys. Each wrong guess raises the
    identifier's count, whose waits grow up to an hour; the count decays, one failure forgiven per hour without a
    new one, instead of resetting after a quiet hour. 100 failures since the last right password close the
    identifier's outside sign-in. Counters are in memory and subject to uniform bounded-table eviction; local
    correct sign-in or admin reset clears the identifier's counter. Local guesses do not count or wait.
  - J1 local-owner hives refuse login/add/reset/remove before parsing a password body or changing stored access.
    `GET /api/auth/methods` exposes `member_password: false`; the admin People response exposes
    `member_passwords: false`, so clients hide the controls. Other hives expose their supported capability explicitly.
- **Local or public** (`hive/core/sso.py`, `PublicGate`): a request is local only when it comes straight from this
  machine, and public otherwise. Local means all of: the connection's peer is a loopback address (or there is no
  network peer: a unix socket, an in-process caller); for a network peer, a Host naming this machine (a loopback
  address, `localhost` or a `.localhost` name) and, when it sends one, an `Origin` of that same origin; no base-path
  prefix; and no header a relaying proxy adds (`Forwarded`, `Via`, any `X-Forwarded-*`, `X-Real-IP`, `True-Client-IP`,
  `Fastly-Client-IP`, `X-Client-IP`, `X-Cluster-Client-IP`, any `CF-*` or `Tailscale-*`). A header can only make a
  request public. So a direct connection from another machine (`HIVE_HOST` beyond loopback), a page that rebinds its own
  name to 127.0.0.1, another site's page in this machine's browser and a sandboxed app frame (`Origin: null`) are all
  public: they get no operator password login, no password session, no mind routes and nothing else local-only.
- **Who acts on a mind** (`hive/core/visibility.py`, `Viewer.controls`): its owner or a hive admin. Acting is editing it,
  starting, stopping, sleeping, waking or deleting it, retiring or resetting its memory, changing who sees it, moving it
  to another hive, scheduling its wakeups and answering its approvals. Seeing a mind (public, or shared with you) lets
  you see it and talk to it, nothing more: anyone else who sees it gets `403 owner_only`, and someone who does not see
  it gets `404 not_found`. A personal mind is also its person's. Narrower rules stay on top: some settings are an
  admin's alone, a Remind on a personal mind is its person's, and a mind set to `owner_only` approvals is answered by its
  owner alone (`403 approval_owner_only`). Agent views carry `may_control`, the same answer, beside `may_sleep`.
- **People (Google sign-in)** (`hive/core/people.py`)
  - Invite only by default: an admin invites an address (`POST /api/invites`), and that Google account accepts it
    through `GET /api/auth/google/start?invite=…` → Google → `GET /api/auth/google/callback`. Admins come only from
    `HIVE_ADMIN_EMAILS` or an explicit role change (`PATCH /api/people/{id}`) or an admin-role invite.
  - **Configured admins** `HIVE_ADMIN_EMAILS` (comma list; each entry matched exactly after strip and lowercase): a
    listed email is always an admin. At startup a listed email with no row gets an admin row
    (`invited_by: "config"`), and an existing enabled non-admin row (for example one first enrolled as `member` through
    `HIVE_SIGNIN_DOMAINS`) is upgraded to `admin`. Every sign-in (the hive's Google callback and the family path)
    checks the same thing inside its transaction, so a listed row that became a member later is upgraded again at the
    next sign-in or restart. An upgrade stamps `promoted_by: "config:HIVE_ADMIN_EMAILS"` and `promoted_at` (both on
    people views), writes a warning line to the `hive` log and publishes `people.updated`
    `{person, change: "promoted", via: "config", previous_role, trigger: "startup"|"signin"}` (admin-only on
    `/api/events`; startup notices precede any listener, so the log line is the record there). It never downgrades
    anyone, never changes `invited_by` (so a domain-enrolled row keeps its Workspace check), and never enables a
    disabled row: a disabled listed email stays disabled, with its role unchanged, until an admin or an invitation
    restores it.
  - **Domain allowlist** `HIVE_SIGNIN_DOMAINS` (comma list, lowercase, empty by default; empty = invite only,
    unchanged). A Google account with no person row and no invitation is enrolled as `member` (never `admin`) only
    when all hold: Google's userinfo says `email_verified` is true; the email's domain *exactly* equals a listed
    domain (no subdomain or suffix match: `x@eng.singularitynet.io`, `x@singularitynet.io.evil.com` and
    `x@evilsingularitynet.io` are refused); and Google's hosted-domain claim `hd` is present and equals that same
    domain wherever it appears (the userinfo response and, when Google returns one, the ID token from the token
    endpoint). A missing `hd` (a consumer Google account that merely uses that address) is refused. An ID token that
    is present but unreadable, or names another email, is refused.
  - A disabled person stays refused; the domain path never re-enables or changes an existing row.
  - The new row has `invited_by: "domain:<domain>"`; the hive publishes `people.updated`
    `{person, change: "enrolled", via: "domain:<domain>"}` (admin-only on `/api/events`).
  - With exactly one domain listed, the Google URL carries `hd=<domain>` as an account-picker hint only; the callback
    check is what enforces.
  - **Configured members** `HIVE_MEMBER_EMAILS` (comma list, parsed like `HIVE_ADMIN_EMAILS`; empty by default). A
    listed email with no person row signs in through the hive's Google flow without an invitation and is enrolled as
    `member` on that first sign-in, after the same checks an invited person gets (one-time state, verified email, ID
    token, and the Workspace `hd` when the address is in a listed domain). The row has
    `invited_by: "config:HIVE_MEMBER_EMAILS"` and is bound to that Google account; the hive publishes `people.updated`
    `{person, change: "enrolled", via: "config:HIVE_MEMBER_EMAILS"}`. Nothing is created at startup. A callback that
    carries an invitation is decided by the invitation alone; domain enrolment is tried first; an address also in
    `HIVE_ADMIN_EMAILS` is upgraded to `admin` as above. The list never re-enables a disabled row, never changes a
    role, and is not read on the webhost path, which treats a listed address with no row as before (the webhost's own
    allow list decides). Removing an address keeps its row: the person keeps signing in until an admin disables them.
  - **Identity binding.** Each person is bound to Google's stable subject (`sub`, column `people.google_sub`). Every
    later Google sign-in must present the same `sub`; another Google account reporting the same email is refused
    `403 identity_mismatch` (no silent rebind). People who have no binding yet (rows from before this change,
    `HIVE_ADMIN_EMAILS` rows, family-path rows) bind on their next Google sign-in: **trust on first use**. For an
    address in a listed domain that first use also needs the matching `hd`, so a consumer account cannot win it;
    for other domains it does not. An admin clears a binding explicitly with
    `PATCH /api/people/{id} {"clear_google_identity": true}` (also ends the person's sessions); people views carry
    `google_bound`.
  - **Workspace on every sign-in.** A person enrolled by domain, or whose address is in a listed domain, must present
    the matching `hd` on every Google sign-in (`403 domain_unverified`). The family sign-in (`POST /api/auth/sso` with
    the webhost cookie) carries no `sub` or `hd` and cannot verify a Google subject, so it refuses every person bound
    to a Google account and everyone who needs the Workspace check (`403 google_signin_required`, with the hive's
    Google `login_url`), whatever the family `allowed` flag says, and never accepts their invitations. It decides
    against the person row (disabled or not) before any write, and the decision, any invitation acceptance and the
    session are one transaction, so a refusal re-enables no one and consumes no invitation. Unbound people
    with no Workspace requirement still map as before. Whenever the hive's own Google flow is set up,
    `GET /api/auth/methods` offers it as `sso.login_url` (family login only when it is not); a family session already
    in the browser is still exchanged by `POST /api/auth/sso`.
  - **ID token.** Required, and checked: `iss` is `accounts.google.com` or `https://accounts.google.com`, `aud` is the
    hive's client id (a list must contain it; with more than one entry `azp` is required), any `azp` present equals
    the client id, `exp` is a finite number that has not passed, `sub` equals userinfo's
    `sub`, `email` equals userinfo's email; userinfo and token `hd` must agree. Any failure: `401 bad_id_token`. The
    signature is not verified: the token comes straight from Google's token endpoint over TLS (OIDC Core 3.1.3.7 (6)).
  - **Login CSRF.** `GET /api/auth/google/start` sets an HttpOnly, SameSite=Lax (Secure on https) `hive_oauth`
    cookie with a random value, stored hashed with the state. The callback refuses `400 state_mismatch` unless the
    same browser presents it, before the code is exchanged, and clears the cookie on every outcome.
  - **Atomic decision.** The binding check, invitation acceptance, re-enabling, domain enrolment, the binding itself
    and the sign-in are one database transaction; a refused callback (for example one that lost a concurrent binding)
    changes nothing.
  - **Endpoint failures.** Transport errors and malformed JSON from Google's endpoints end the sign-in with
    `signin_error=google_unavailable`; anything unexpected with `signin_error=signin_failed`. Both clear `hive_oauth`.
- **Agents**
  - Each agent gets its own token when it is created. The token is shown once
    and stored hashed.
  - Agents use it on `/agent-hub`, `/llm/*` and `/api/agent/*`.

## Resources

```ts
type AgentKind = "omega" | "iter" | "module";
type AgentStatus = "created" | "starting" | "awake" | "asleep" | "stopped" | "error";

interface Agent {
  id: string;            // "a_7f3k2q"
  name: string;          // "Vega"
  kind: AgentKind;
  swarm_id: string | null;
  model: string;         // "<provider>/<model>", e.g. "anthropic/claude-sonnet-5-5", "mock/echo"
  persona: string;       // system prompt text
  hue: number;           // 0-359, the agent's colour everywhere in the UI
  status: AgentStatus;
  driver: string;        // "local" | "docker" | ...
  budget_usd: number;    // hard cap; 0 = none, so free (mock/local) models only
  spent_usd: number;
  connected: boolean;    // live hub connection
  last_error: string | null;  // why status is "error"
  refused: MindRefusal | null; // why its own model calls are refused, until one is answered (hive/core/refusals.py)
  last_active_at: string | null;
  created_at: string;
  belief_link: null | "all" | string[];  // its owner's link setting: null for its default, [] for none
}

interface Swarm {
  id: string;            // "s_alpha"
  name: string;
  description: string;
  hue: number;
  member_ids: string[];
  created_at: string;
}

interface Message {
  id: string;
  agent_id: string;
  conversation_id: string;
  direction: "in" | "out";   // in = to the agent, out = from the agent
  sender: string;            // "user:operator" | "agent:<id>"
  text: string;
  created_at: string;
}

interface TruthValue { f: number; c: number }   // frequency, confidence in [0,1]

interface Belief {                // a statement of a swarm's view: its commons and its minds' linked beliefs
  swarm_id: string;
  statement: string;              // MeTTa text, e.g. "(--> sky blue)"; a mind's belief reads (--> (x domain value) relation)
  tv: TruthValue;                 // its sources integrated by the commons' own rule when it is read
  stamp: string[];                // evidence ids, e.g. ["ev:a_7f3k2q:1"]
  sources: string[];              // agent ids whose evidence supports it
  holders: string[];              // the minds holding it in their own space, through their link
  updated_at: string;
}

interface Assertion {             // one published contribution
  agent_id: string;
  statement: string;
  tv: TruthValue;
  stamp: string[];
  outcome: "adopted" | "revised" | "chosen" | "kept" | "duplicate" | "quarantined" | "denied";
  unmapped?: string[];            // when quarantined: the words outside the swarm's vocabulary
  created_at: string;
}

interface BeliefDetail extends Belief {
  assertions: Assertion[];        // full provenance, oldest first
  choices: { kept: string[]; rejected: string[] }[];
  held: { mind: string; tv: TruthValue; stamp: string[]; since: string | null }[];   // each holder's own belief
}

interface BeliefLink {            // a mind's link of its own beliefs into its swarm's view
  agent_id: string;
  domains: null | "all" | string[];   // as its owner set it: null for its default, [] for none
  default: "all" | "none";        // "none" for a person's own mind, a researcher, or a private or shared mind
  default_reason: null | "personal" | "researcher" | "private" | "shared";   // why the default is "none"
  linked: "all" | "none" | string[];  // what links now
  patterns: string[];             // the statement patterns its read grants hold
  as: "owner" | "admin-audit" | "admin";   // how this person stands to the mind (Hive.LINK_RIGHTS)
  rights: { read_beliefs: boolean; read_setting: boolean; read_topics: boolean; narrow: boolean; widen: boolean };
  known_domains: string[] | null; // the domains its saved beliefs are about now, where rights.read_topics
}

// Who may do what with a mind's link, by how they stand to it; the kind of mind (a person's own, a researcher,
// private, shared, public) decides only the class. The owner is the mind's owner or the person it is the own mind of,
// or an admin for a mind with neither. Refused: 404 to unseen and admin-hidden, else 403 owner_only.
//   class          read_beliefs  read_setting  read_topics  narrow  widen
//   owner               yes          yes           yes        yes     yes
//   admin-audit         yes          yes           yes        yes     no      (?include=personal)
//   admin               yes          yes           no         yes     no
//   admin-hidden        no           no            no         no      no      (another person's own mind or researcher)
//   sees                yes          no            no         no      no
//   unseen              no           no            no         no      no
// Minds read linked beliefs through the read grants alone: a mind of the same swarm, as the link admits.

interface Usage {
  agent_id: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  created_at: string;
}

interface ModelOption { id: string; provider: string; label: string; local: boolean }
```

## REST

| Method & path | Body → Response |
|---|---|
| `POST /api/auth/login` | `{password, email?}` → `{token}`; an email selects member-password sign-in |
| `POST /api/people/members` | Admin only. `{email, name?}` →201 `{person, password, note}`; password shown once |
| `POST /api/people/{id}/password` | Admin only. → `{person, password, ended_sessions, note}`; new password shown once |
| `DELETE /api/people/{id}/password` | Admin only. → `{person, ended_sessions}`; remove password and its sessions |
| `GET /api/auth/me` | → `{principal, auth_session_ref, kind, expires_at, role, person, person_kind, local_operator}`. `auth_session_ref` is `"as1_"` + lowercase hex HMAC-SHA256, keyed with this deployment's secret (`HIVE_DATA_DIR/auth-session-ref.key`, 32 random bytes as 64 hex, mode 0600, created atomically on first use; a missing or malformed key is replaced, never skipped), over the ASCII string `hive-auth-session-reference/2`, a NUL byte, then the verified session's `token_hash`. It is stable within one session and across restarts with the same key, different across sessions and principals, changes if the key is replaced, and cannot be computed from the bearer or the sessions table without the key. **No consumer yet: attribution only, not a bound identity.** No route accepts it as authentication or capability authority, and nothing binds actions to it today. |
| `GET /api/hive` | → `{name, version, agents, swarms, awake, beliefs, spent_usd}`. `beliefs` counts the statements of the swarms this person may see, as `GET /api/swarms/{id}/beliefs` lists them |
| `GET /api/models` | → `ModelOption[]` |
| `GET /api/swarms` | → `Swarm[]`, each with this person's `may_control`: whether they may act on it (its owner, its person or an admin), as the vocabulary route below decides. A hint for the UI; the routes still enforce. |
| `POST /api/swarms` | `{name, description?, hue?}` → `Swarm` |
| `GET /api/swarms/{id}` | → `Swarm`, with `may_control` as above |
| `POST /api/swarms/{id}/archive` · `/restore` | Admin only. → `Swarm`. Archive hides a swarm with history, deletes nothing and is restorable; refused (409 `swarm_busy`) while a mind there is awake, starting or wants to wake, or a flow is still running. |
| `DELETE /api/swarms/{id}` | Admin only (a member gets 403 `admin_only`, or 404 for a private swarm they cannot see). No body (or a body without `with_minds: true`): only an empty swarm is deleted → `{deleted: id}`; otherwise 409 `swarm_not_empty` with `counts: {minds, members, goals, artifacts, child_swarms}`, `with_minds: bool` (true when it has minds) and a `hint`. The message lists the counts ("…this one has 2 minds, 1 task"). |
| `PATCH /api/swarms/{id}` | Admin only. partial `{name, description, coordinator_id, parent_mind_id}` → `Swarm`. Held under the membership fence of the swarm and of the parent mind's swarm: during a delete or restore of either, 409 `swarm_busy`. Validated inside the fence; the parent must still be a live mind in the swarm validated, in the write itself (409 `parent_moved` otherwise). |
| Lifecycle rule (existence and membership) | Every change to a mind's existence or membership (creation and child spawn included) runs end to end under that mind's lock and the fence of every swarm it touches: single and swarm delete, cleanup finish/retry, import and return, settle (move out), converting an outside member to a native mind (re-checked in the write, refused in a retired swarm), moving a mind between swarms (the whole update, space changes and notifications included), and creating a mind or spawning a child (fenced from the insert through spaces, workspace, role and, for a child, its start, holding the new mind's lock from before its row is visible). **By design, outside that rule:** `restore` takes only its swarm's guard (it changes no mind rows); Stop all and power off take each mind's lock but no fence (they change running state, not membership). |
| `GET /api/swarms/{id}/delete-preview` | Admin only (member 403, or 404 for a private swarm they cannot see). Writes nothing and takes no lock. → `{name: "<exact name>", counts: {minds, members, goals, artifacts, child_swarms}, awake_minds: [{id, name}], would: "delete" \| "archive", reason, released_tasks_estimate: n, busy: false \| "<why>"}`. `would` and `reason` use the same rule as the last step of delete-with-minds (tasks, artifacts or external members keep it, archived); `released_tasks_estimate` counts the tasks that step would release; `busy` names a running flow or a delete, restore or membership change in progress. **Advisory snapshot only:** `would`, `busy`, the counts and the estimate can change before a confirmed delete; the confirmed `DELETE` re-checks everything itself, inside the fence, and its answer is what happened. Use this, not a plain DELETE, to show the warning. |
| `DELETE /api/swarms/{id}` with `{with_minds: true, confirm: "<exact swarm name>"}` | Admin only. Deletes the swarm together with its minds in one step. `confirm` must equal the swarm's current name exactly (400 `confirm_mismatch` otherwise, with `expected: "<name>"`, nothing changed). **One fence per swarm:** a delete, delete-with-minds or restore holds its swarm for the whole operation, and while it does every membership change there is refused with 409 `swarm_busy`: creating a mind or task, a mind joining or arriving, moving a mind in or out, starting a mind, and another delete or restore; an operation is itself refused (409 `swarm_busy`) while such a write is in flight. Once a delete has finished, a repeat gets 404. Every insert or move into a swarm also requires, in the same statement, that the swarm exists and is not archived (404 `not_found` if it was deleted). A returning mind (import over its tombstone) is fenced on its source and target swarms, re-read under the fences, and written only if its source swarm, `moved_to` and `deleted` are unchanged (409 `placement_stale` otherwise). The whole arrival runs under the mind's lock and both fences: every database effect (row, messages, wakeups, policy rules, move record) is one transaction together with the workspace preparation and the space grant/revoke, and any failure rolls all of it back (spaces by compensation, the workspace by the swap); after the commit only notifications and the placement evidence follow, and their failures are logged, not undone. Its files are staged beside the workspace first; the old workspace is swapped aside by rename only under the mind's lock and the fences, after that re-check, and restored on any refusal or failed write. A deleted mind coming back first finishes its pending deletion cleanup (or drops it if that fails): cleanup records carry the mind's deletion generation and never act on a mind that is live again or deleted anew. Supervisor stop verification is positive: Docker accepts only docker's own missing-container answer or `State.Running` exactly `false`; a daemon error or unclear answer is `minds_unstoppable`. In order: a running flow refuses (409 `swarm_busy`); every awake or starting mind (or one that wants to wake) is stopped through the stop path; then every mind, whatever its row says, must be confirmed gone by the supervisor (driver reports absent or exited); if any cannot be stopped or confirmed, 409 `minds_unstoppable`, `failed: [{id, name, error}]`, `stopped_minds: [{id, name}]` (stopped by this call, still not deleted: they stay stopped), nothing deleted or archived; the swarm is archived; then, mind by mind (not external members): its stop is confirmed (a Docker mind's container must be gone), and in ONE transaction it is soft-deleted (only while still in this swarm) and its unfinished tasks are released: open, claimed, waiting or stalled tasks it is assigned or holds go back to open, unassigned and unclaimed, and nothing else changes (attempts, returns, results and reviews stay); a submitted task keeps its submission pending review and loses only the dead assignee, and if the review returns it, it goes back to open, never to the deleted mind. Each release adds a `released` entry to the task's review trail. Cleanup after the commit (spaces revoke, `goal.updated` for each released task, `agent.deleted`, swarm update, Coffee Room sync) is recorded with the released task ids, each step is marked done as it succeeds, and the record is removed only after all have; a retry runs only the steps still outstanding, so `agent.deleted` is published once. Then with no tasks, artifacts or external members left → `{deleted_minds: [id], swarm: "deleted", released_tasks: n}`; otherwise the swarm stays archived, history kept and restorable → `{deleted_minds: [id], swarm: "archived", reason: "it has history (3 tasks, 1 artifact)", released_tasks: n}`. A failure after the archive is 200 `{swarm: "archived", deleted_minds (every committed delete), remaining_minds: [id], error: {code: "minds_unstoppable" | "cleanup_failed" | …, message, mind}, hint, released_tasks, cleanup_pending?: [id]}`; nothing is running, and the same request again finishes the job, including pending cleanup (or restore the swarm to keep the minds that remain). Child swarms of the minds it deleted are kept and stand on their own; the answer adds `detached_swarms: [id]`, read from the final state, on success and on failure. Events: `swarm.updated` (archived), `goal.updated` per released task, `agent.deleted` once per mind, then one `swarm.deleted`, or one `swarm.updated` when it stays archived. |
| `GET /api/swarms/{id}/beliefs` | → `Belief[]`: the commons and the beliefs of the swarm's minds this person may see, as each mind's link admits; an admin's leaves out another person's own minds and researchers unless `?include=personal` |
| `GET /api/swarms/{id}/beliefs/detail?statement=` | → `BeliefDetail`, of the same minds |
| `GET /api/swarms/{id}/vocab` | → `string[]` |
| `POST /api/swarms/{id}/vocab` | The swarm's owner, its person or an admin: the vocabulary decides which statements the commons admits, so a person who only sees the swarm gets 403 `owner_only`, and a mind's publishing adds words only for one of them (`POST /api/agent/publish`). `{terms: string[]}` → `string[]` |
| `GET /api/artifacts?limit=` | → `{artifact_id, kind, title, swarm_id, mind_id, revision, digest, created_at, revised_at}[]`: every artifact of the swarms this person sees (as `GET /api/swarms` lists them), newest first, at most `limit` (200). Metadata only, never a body. `revision`, `digest` and `revised_at` are `null` while nothing is saved in it yet (`GET /api/swarms/{id}/artifacts`, the Studio picker's list, leaves those out). `mind_id` names the mind that made it while that mind is one `GET /api/agents` shows this person, else `null`; a person who made one is never named. The Artifacts page lists these as creations. |
| `GET /api/artifacts/{id}` | → one row as `GET /api/artifacts` lists it, for a person shown that artifact (the same swarms; anyone else, and an id that names nothing, get 404): a mind names what it made by id, and the page shows that id as the artifact's title and opens it from there, whatever the list's length. Metadata only, never a body. |
| `GET /api/artifacts/{id}/revisions/{n}` | → `{artifact_id, kind, title, swarm_id, revision, digest, body, created_at}`: one saved revision with its text, for a person shown that artifact (the same swarms; anyone else, and a revision that does not exist, get 404). The Artifacts page's reader shows `body` as text and never draws it, a view's included, since a view's grant gates running it, not reading it. |
| `GET /api/artifacts/{id}/view?revision=` | One saved revision as an interactive view, for a person shown that artifact (the same swarms as `GET /api/artifacts`; anyone else gets 404). Without `revision`, the latest saved one. A view a mind writes in MeTTa (kind `view`, a body starting with `(` or `;`: one `(Screen name "Title")` and its parts in the screens vocabulary, its `Start` values, `value` rules and `on` rules; hive/ui/src/features/views/lib_view.metta) comes as `{artifact_id, kind, title, swarm_id, mind_id, revision, digest, created_at, carrier: "metta", source}`, which the person's browser composes and draws with the hive's own blocks; it has no document. A create or revision of kind `view` that could not be drawn is refused with 400 `bad_view` and the reason (it does not parse, a line starts with `!`, or it names no screen or two). Only the owning swarm adds a revision, and `POST /api/agent/artifacts` and `POST /api/agent/artifacts/{id}/revisions` are checked as the skills `hive-artifact-create` and `hive-revision`, as the Omega gate checks them: `deny` gives 403 `policy_denied`, `ask` gives 403 `approval_required` with an `approval_id`, and once a person approves it the identical request succeeds once; an open view takes up each new revision as its `artifact.revision` event arrives. Otherwise a view is an artifact of kind `view` whose body is an HTML document or the MCP resource as JSON (`{mimeType: "text/html;profile=mcp-app", text \| blob, _meta: {ui: {csp, permissions, prefersBorder}}}`), or any other artifact whose body is an HTML document. → `{artifact_id, kind, title, swarm_id, mind_id, revision, digest, created_at, carrier: "view" \| "resource" \| "document", resource: {uri: "ui://hive/artifacts/{id}/r{n}", mimeType, _meta: {ui: {csp, permissions, prefersBorder?}}}, allow, refused: [string], document: "/api/views/{ticket}"}`: `csp` and `permissions` are what the hive grants (declared domains that are explicit origins and none of the hive's own addresses; clipboard-write only), `refused` what it dropped, `allow` the iframe allow value. 415 `not_a_view` when the revision holds no view, with the reason when its kind says it should. |
| `POST /api/artifacts/{id}/view/grants` | The person's own consent to one revision of a view shown to them, given by their click: `{revision, reach?: bool}` records that they ran it, and with `reach: true` (an HTML view only; a MeTTa view reaches no domain, 400) that it may reach the domains it declares. It covers only the person who gave it. No view runs before it: `GET …/view` answers `grant: {ran, reach}` with `source` or `document` null until `ran`, and an HTML view's `asks` lists the declared domains still waiting. It gates running a view, not reading its text, which `GET /api/artifacts/{id}/revisions/{n}` returns as text. Its document is served with `connect-src 'none'` and none of them until `reach`, which is for that one revision; a MeTTa view's run covers its later revisions, which arrive live. Anyone not shown the artifact gets 404. → `{ran, reach}` |
| `GET /api/views/{ticket}` | The view's document, no session: the ticket from `GET /api/artifacts/{id}/view` names one revision for 10 minutes, signed with a key the hive makes at start. HTML with `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; …; frame-ancestors 'self'` built from the granted domains, so the document has an opaque origin wherever it is opened, plus nosniff, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. A script ahead of the view's own gives it in-memory `localStorage` and `sessionStorage` and sends its size (`ui/notifications/size-changed`). An expired or forged ticket gets a 404 page under `sandbox`. |
| `GET /api/agents` | → `Agent[]` |
| `POST /api/agents` | `{name, kind, swarm_id?, model, persona?, hue?, budget_usd?}` → `Agent & {token}` |
| `GET /api/agents/{id}` | → `Agent` |
| `PATCH /api/agents/{id}` | partial `{name, swarm_id, model, persona, hue, budget_usd}` → `Agent`. Its owner or an admin (403 `owner_only`, checked before the body is read). |
| `DELETE /api/agents/{id}` | → `{ok: true}` (stops it, keeps memory on disk). Its owner or an admin (403 `owner_only`). Runs under the mind's lock and its swarm's fence (409 `swarm_busy` during a delete or restore of that swarm); its stop is verified; the soft delete and the release of its unfinished tasks are one transaction; its cleanup is recorded with its deletion generation and finished (or retried later) step by step. |
| `POST /api/agents/{id}/start` · `/stop` · `/sleep` · `/wake` | → `Agent`. Its owner or an admin (403 `owner_only`), as `DELETE` is. |
| Task claims and review returns (mind and person routes) | A claim lands only for a live mind, in the same statement: a mind deleted after it authenticated gets 409 `mind_deleted`. A review "return" goes back to its holder only while the holder is a live mind, in the same statement; otherwise the task reopens, unclaimed and unassigned. A heartbeat renews only while the task, its status and its holder are unchanged since it was read and the holder is a live mind, in the same statement; otherwise 409 `not_claimed`, the same answer as a lapsed lease. |
| `GET /api/agents/{id}/messages?conversation_id=&limit=` | → `Message[]` (oldest first). A note the hive sends a mind to instruct it (a goal and how to claim it, an approval, a share or file notice, a code packet, First Light's request for a greeting, a Health alert) carries `mind_only: true`, here, in its live `message` frame and on its copy in the mind's DM room (`GET /api/rooms/{id}/messages`): it stays in the mind's log and on its socket, and a chat page leaves it out. A person's scheduled wakeup and Health's verified question (`health_check`) are people's words and are never marked. A room's `unread` counts no `mind_only` copy. |
| `POST /api/agents/{id}/messages` | `{text, conversation_id?, from_ask?}` → `Message`. `from_ask`: the Ask exchanges this mind's own chat has not heard, as the person's browser keeps them, in the Ask's `conversation` shape (at most 8 `{said, answer, by, at}`, 8 KB). Taken only from a named person in their own chat with the mind, else 400 `bad_request`. The mind's envelope carries them as `ask_earlier`, one line per exchange naming who answered ("they said “…”; you answered “…”"), shown before the person's words in the same channel event, so no model call is added; an exchange naming a private app is dropped, and the person's own view of the chat shows only their words. |
| `GET /api/agents/{id}/logs?tail=200` | → `{lines: string[]}` |
| `GET /api/usage?agent_id=&since=` | → `Usage[]` |

Errors are `{"error": {"code", "message"}}` with a 4xx/5xx status. Every error answer also carries an id in its
`X-Hive-Error-Id` header (`e-` and 8 hex digits), and the hive keeps the most recent ones with the person who met them
(`GET /api/feedback`), so a bug report can name what failed. An error the hive did not expect is a 500
`internal_error` whose id is also on the hive's log line with the whole traceback; the page never gets the insides.
The hive also keeps each person's last 100 requests, by method, route pattern, status and how long the answer took to
start, a run answered alike folded into one line with its count, and its own newest 100 warnings and errors, for the
logs a person saves from the feedback area (`GET /api/feedback/logs`). A page file that loaded is not kept.

| Method & path | Body → Response |
|---|---|
| `GET /api/feedback` | Any signed-in person → `{version, which, system, to, errors}`: the hive's version as a report quotes it (`"Mac v0.31 (build f9648d4386)"`, or the build for a hive run from git), which hive it is (`"own hive, Mac install"`, `"the hive at <host>"`), where reports go (`to`: `{kind: "board", owner, repo, url, public}` with `public` true once GitHub answers the board as public, false while private, null while not known; `{kind: "service", url, host}`; `{kind: "none"}`; `{kind: "invalid", reason}`), and this person's newest error answers (`[{id, at, method, route, status, code, message, raised?}]`, newest first, at most 10; `route` is the matched pattern, so no id is named; `message` is kept with this hive's key ids, key scopes and people taken out, whoever met it, then cleaned as the logs' messages are; `raised` locates an unexpected error in the hive's code). Where reports go is the one setting `HIVE_FEEDBACK_TO` (unset: the `FEEDBACK_TO` the release was built with, else the team's feedback board). |
| `GET /api/feedback/logs` | Any signed-in person → `{version, which, system, scope, requests, errors, log}`, what the logs file they save from the feedback area holds from the hive, every list newest first. `scope` `"person"`: their own requests and error answers; `"hive"`, for an admin: the whole hive's, with `log`, the hive's own newest warnings and errors (`[{at, level, logger, message}]`, the message cleaned and cut to 300 characters and an exception named by its type), which is `[]` for a person. `requests` is `[{at, method, route, status, ms, count, who}]`, at most 100: `route` the matched pattern (the path's first two parts when no API route matched), `ms` how long the answer took to start, `count` how many alike requests in a row the line stands for (`at` the newest, `ms` the slowest), `who` `"you"`, `"another person"`, `"a mind"` or `"no session"`. `errors` are the error answers as `GET /api/feedback` gives them, all those kept (up to 100); in an admin's each also says `who` as `requests` do, and one another person or no session met is only `{id, at, method, route, status, code, who}`, never its message, which can carry words that person typed for a private space or mind. Nothing names an id, a query or a body; the hive cleans every message as it keeps it (keys, emails, home folders, the ids of people and conversations, phone numbers, OAuth codes, cookie values and network addresses), the page cleans the whole file again before showing it, and nothing leaves until the person saves or copies it. |
| `POST /api/feedback/send` | `{schema: "omega-hive-report-1", id: "HR-xxxxxxxx", kind: "bug"\|"ux"\|"idea", title, form, fields, text, picture: "data:image/png;base64,…"\|null}`, at most 12 MB → `{sent: true, to, reference}`. Passes the report, as the person saw it, to the report service that setting names; the page sends it only on the person's press. 409 `no_report_service` when the destination is not a service, 400 `bad_report` for another shape, 502 `report_not_delivered` when the service refused it or could not be reached. |
| `POST /api/feedback/drafts` | A mind, with its own token (the `hive-report-problem` skill): `{kind: "bug"\|"ux"\|"idea", title, words, steps?, expected?, conversation?}` → 201 `{id: "fd-xxxxxxxx", for: "<principal>"}`. The draft waits for one person: the one whose conversation with the mind it came up in (a person's chat with the mind, the operator's own chat, the asker of an Ask turn the mind answered), so what someone told a mind never reaches another person's area. A draft naming no conversation gets the one the mind is answering, worked out from its messages as a plain reply's is: the one person's conversation waiting for an answer when its message is the last the mind received, or with none waiting the last message's when a person sent it; with no person behind it (another mind's message, the hive's own, or none) it waits for the mind's owner when that is a person, else the hive's owner, but only while no one else has written to the mind, since it could then be about their chat. `conversation: "own"` names a problem from the mind's own work and waits for that same owner. A named conversation must hold a message that person sent the mind. It is sent nowhere from here; only that person's send, copy or save in the feedback area makes it a report. The same person, mind and title again replaces the open draft's words and time and keeps its id. 400 `bad_draft` with the reason (an unknown kind or field; an empty title or words; a title over 80 characters or with a line break; words, steps or expected over 4000; a conversation id over 200; a conversation that is not one of the mind's conversations with one person who wrote to it there: a room's, another mind's, or one only the mind wrote in; no conversation named while several people are waiting, or while another message came after the one waiting, unless each is the mind's owner; no conversation named with no person behind it once someone besides the mind's owner has written to it), and 400 `bad_request` for a body that is not a JSON object, as everywhere; 403 `mind_only` for a person's session; 409 `no_person` when a draft names no conversation and neither the mind nor the hive has a person as owner. |
| `GET /api/feedback/drafts` | The session's person → `{drafts: [Draft]}`, newest first, only theirs. A Draft is `{id, kind, title, words, steps, expected, created, source: {kind: "mind", agent, name, conversation}}`. |
| `DELETE /api/feedback/drafts/{id}` | The session's person dismisses a draft or has used it → 204. Another person's draft and an unknown id are both 404 `not_found`. |

Live events, each to the draft's person only (admins included): `{"type": "feedback.draft", "at", "principal", "draft": Draft}`
when a mind drafts or replaces one, and `{"type": "feedback.draft.removed", "at", "principal", "id"}` when it is deleted.

## Live events: `WS /api/events?token=`

The server pushes `{"type", "at", ...}` frames. The client may send
`{"type":"ping"}`.

- An invalid or missing token closes the socket with code `4401`.
- A message sent without a `conversation_id` uses the agent's default
  conversation, `c_<agent_id>`.
- The stream has no replay. Each hive process has one stream, named by a 16-hex `id`, and `at` counts the frames it
  has delivered. The `hello`'s `stream` says where this socket's subscription begins, and every HTTP answer says
  where its request was read, in `Hive-Stream: <id> <at>`. A client that held reads before the subscription began
  (an older `at`, or another `id` after a restart), or whose socket came back after a gap, reads them again.
- A client that falls so far behind that frames were dropped for it is closed with `1013` ("try again later"). It
  reconnects, and reads again what it held.

| type | payload |
|---|---|
| `hello` | `{hive: {...GET /api/hive}, stream: {id, at}}` on connect |
| `agent.updated` | `{agent: Agent}` (status, connected, spent, …) |
| `agent.deleted` | `{agent_id}` |
| `swarm.updated` | `{swarm: Swarm}` |
| `swarm.deleted` | `{swarm_id}` |
| `message` | `{message: Message}` |
| `agent.thinking` | `{agent_id, phase: "llm" \| "skills" \| "idle"}` |
| `belief.published` | `{swarm_id, assertion: Assertion}` |
| `belief.updated` | `{belief: Belief, outcome: "adopted" \| "revised" \| "chosen"}` |
| `usage` | `{usage: Usage}` |
| `log` | `{agent_id, line}` |

## Agent-facing

- **`WS /agent-hub`** with header `Authorization: Bearer <agent token>`. The
  frames are those of upstream Omega `channels/wschat.py` (see
  `modules/channel_hive/src/hive_channel.py`):
  - `resume`, `user_message{seq,text}`, `agent_message{client_seq,text,conversation_id?}`, `ack`, `error`;
  - the hub sends `text` as a hive envelope
    `{"hive":1,"sender","conversation_id","text"}`;
  - a hive-run mind is accepted only while its desired state is `awake` (set by start, wake, restore or a
    reconcile restart before the process is spawned); otherwise the socket is closed with code `4409` and the
    mind stays stopped or asleep, so a late connection from a process a stop was ending never wakes it.
    The check is repeated when the connection is registered, after the accept: a stop, sleep, delete or restart
    since the first check also closes it with `4409`, and a stop after registration closes a registered
    connection with `4409`.
    External members (`kind: module`) connect whenever their token is valid and are not closed by a stop.
- **`POST /llm/v1/chat/completions`** is OpenAI-compatible and takes the agent
  token. The gateway picks the provider and model from the agent's `model`,
  injects the key, meters the usage, and enforces `budget_usd` (402 once the
  budget is spent).
  A call's output room (`max_tokens` or `max_completion_tokens`, 4096 when it
  names none) is held to its OpenRouter model's own output limit. A mind
  holding a claimed goal of a Create plan asks with that whole limit from its
  first call, as much of it as a new reservation can hold now, and never less
  than it asked for.

  A provider's refusal comes back with the provider's status and a row of the
  hive's one refusal table (`hive/core/refusals.py`), never the provider's own
  words: `provider_no_credit` (402), `provider_key_refused` (401, 403),
  `provider_busy` (429, or any answer naming a wait), `provider_unavailable`
  (5xx, 408) or `provider_request_refused` (other 4xx), each with a sentence for
  the person; a held $0 model is `free_model_unreconciled`. A refusal that knows
  its wait sends it as `Retry-After`, and a provider's own asked wait counts for
  at most 30 minutes. The hive keeps the refusal on the mind as its `refused`
  field, `{code, say, remedy, count, since, retry_at}` with `remedy` one of
  `wait`, `credit`, `key` or `model`, which the mind's chat shows and Health
  counts (`refused-calls`, high; `held-calls`, medium, for a wait). Everyone who
  can see the mind reads it, so a sentence that speaks to one person ("You've
  used today's free model calls") is kept in words for the mind ("This mind's
  person has used today's free model calls").
  While a provider's refusal is kept, the mind's next calls get the same code
  and sentence as a 429 with `Retry-After`, with nothing reserved or sent, until
  its wait passes (the provider's own, else 60 s doubling with each refusal in a
  row, at most 30 minutes either way), someone writes to the mind, or the mind's
  model or the key its calls go out with changes (a new default key, or a key
  replaced, removed or assigned to the mind); a key added for someone else leaves
  the wait alone. The hive's own checks (a day's cap, a spending limit) answer
  before a kept refusal. The mind's own task work (a claim, heartbeat or result)
  never ends the wait. An answered call clears it. The hive's own refusals (a
  held $0 model, a day's free calls used up) are kept and shown the same way but
  never hold a call, so their `retry_at` is null.
- **`POST /api/agent/publish`** `{statement, f, c, evidence?}` → `Assertion`. The
  stamp is minted by the hive when `evidence` is omitted. A mind acting for
  someone who controls its swarm (the swarm's owner, its person or an admin)
  adds the statement's new words to the swarm's vocabulary as it publishes. Any
  other mind publishes in the vocabulary as it stands: a statement with a word
  outside it is `quarantined`, its `unmapped` naming the words, until the
  swarm's control adds them.
- **`POST /api/agent/query`** `{pattern}` → `{results: string[]}`, the union view
  of the agent's swarm commons and the federation.
- **`GET /api/agent/belief?statement=`** → `BeliefDetail`.
- **`GET /api/agent/inbox?after=<seq>`** → `{messages: [{seq, text}]}`. This
  is an HTTP alternative to the hub for agents that cannot hold a WebSocket:
  Iter workers and external agents. `text` is the same hive envelope the hub
  sends. Acknowledgement is implicit: the next call passes the highest `seq`
  seen.
- **`POST /api/agent/messages`** `{text, conversation_id?, client_seq?}` →
  `Message`. Replies over HTTP; deduplicated by `client_seq`.

---

# Phase 2 additions

## Types

```ts
type PolicyMode = "allow" | "ask" | "deny";

interface PolicyRule {
  id: string;
  scope: "hive" | `swarm:${string}` | `agent:${string}`;  // most specific scope wins
  skill: string;           // glob over skill names: "shell*", "write-file", "*"
  mode: PolicyMode;
  note: string;
  created_at: string;
}

type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "used";

interface Approval {
  id: string;              // "p_..."
  agent_id: string;
  skill: string;           // e.g. "shell-confirm"
  command: string;         // full MeTTa command text, e.g. (shell-confirm "ls /")
  reason: string;          // why it needs a human: rule note or "human-only"
  risk: "low" | "medium" | "high";
  status: ApprovalStatus;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

type GoalStatus = "open" | "claimed" | "done" | "failed" | "cancelled";

interface Goal {
  id: string;              // "g_..."
  swarm_id: string;
  parent_id: string | null;
  title: string;
  detail: string;
  priority: number;        // 0..1
  status: GoalStatus;
  created_by: string;      // "user:operator" | "agent:<id>"
  claimed_by: string | null;   // agent id
  result: string | null;
  created_at: string;
  updated_at: string;
}

interface TraceCommand { command: string; result: string; gated?: "allow" | "ask" | "deny" }

interface Trace {          // one loop iteration that called the model
  id: number;
  agent_id: string;
  iteration: number;
  input: string | null;    // the new message that triggered it (null for autonomous turns)
  response: string;        // raw model output
  commands: TraceCommand[];
  llm_ms: number | null;   // gateway latency of the model call
  tokens: number | null;
  created_at: string;
}

interface Wakeup {
  id: string;              // "w_..."
  agent_id: string;
  cron: string | null;     // 5-field cron, e.g. "0 9 * * 1-5"
  at: string | null;       // one-shot ISO time (exactly one of cron/at)
  tz: string;              // IANA zone, default "UTC"
  text: string;            // what the agent is told when it wakes
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
}

interface MemorySpace { name: string; atoms: number; bytes: number }
interface MemoryAtom { index: number; text: string }

// Agent gains:
//   idle_sleep_minutes: number   (0 = never auto-sleep)
//   personal: boolean            (a person's own mind, alone in its swarm; never whose: personal_of stays on the host)
```

## REST

| Method & path | Body → Response |
|---|---|
| `GET /api/policy` | → `PolicyRule[]` |
| `POST /api/policy` | `{scope, skill, mode, note?}` → `PolicyRule` |
| `DELETE /api/policy/{id}` | → `{ok}` |
| `GET /api/approvals?status=` | → `(Approval & {may_answer: boolean})[]` (newest first): the approvals of minds this person sees; `may_answer` is the answer routes' own rule for this person. `kind` is `ask` (a skill whose policy asks a person) or `grant` (a mind's request for an explicit-only skill it lacks, `policy.grantable`), which only a hive admin answers (403 `admin_only`), with `for`, `always`, `no` or `never`: a permission is a rule, so `once` is refused (400 `grant_is_a_rule`). |
| `POST /api/approvals/{id}/approve` | `{remember?: boolean}` → `Approval`. `remember` also adds an `allow` rule for this agent and skill. Every answer, once or lasting, yes or no, is the mind's owner's or an admin's (403 `owner_only`; 404 for an approval whose mind this person does not see); `owner_only` minds, their owner's alone. |
| `POST /api/approvals/{id}/deny` | → `Approval`. Who may: as approve. |
| `GET /api/swarms/{id}/goals` | → `Goal[]` |
| `POST /api/swarms/{id}/goals` | `{title, detail?, priority?, parent_id?}` → `Goal` |
| `PATCH /api/goals/{id}` | `{status?, priority?, title?, detail?}` → `Goal` |
| `GET /api/agents/{id}/traces?limit=` | → `Trace[]` (newest first) |
| `GET /api/agents/{id}/wakeups` | → `Wakeup[]` |
| `POST /api/agents/{id}/wakeups` | `{cron? \| at?, tz?, text}` → `Wakeup` |
| `PATCH /api/wakeups/{id}` | `{enabled?, cron?, at?, tz?, text?}` → `Wakeup` |
| `DELETE /api/wakeups/{id}` | → `{ok}` |
| `GET /api/agents/{id}/memory` | → `MemorySpace[]` (the agent's private spaces, read from disk) |
| `GET /api/agents/{id}/memory/{space}?q=&limit=` | → `MemoryAtom[]` |
| `POST /api/agents/{id}/memory/{space}/retire` | `{atom}` → `{queued: true}`. The agent removes it on its next loop. Its owner or an admin (403 `owner_only`). |
| `POST /api/agents/{id}/memory/reset` | → `{queued: true}`. Clears all private spaces. Its owner or an admin (403 `owner_only`). |
| `GET /api/agents/{id}/belief-link` | → `BeliefLink`, for someone with `read_setting` in the table above (404 or 403 `owner_only` otherwise) |
| `PUT /api/agents/{id}/belief-link` | `{domains: null \| "all" \| string[]}` (up to 64 names of up to 200 characters, `[]` for none) → `BeliefLink`. A change that lets more be seen ("all", a domain not linked yet, or `null` where the default links more than now) needs `widen`, any other `narrow`, in the table above; 404 or 403 `owner_only` otherwise, before the body is checked; 400 `bad_domains`. The mind's read grants follow at once, and `agent.updated` carries the new `belief_link`. A mind made narrower by `PUT /api/agents/{id}/visibility` (public, shared, private) has a link that widened past `[]` set back to `null`, its default |
| `POST /api/hive/stop-all` | Admin only (member 403 `admin_only`), as power off: it acts on every mind. → `{stopped: n}`. Global kill switch: every agent is stopped and its desired state set to stopped. If some mind cannot be stopped, the rest are still stopped and the call fails with 500 `stop_incomplete`, `details: {stopped, failed: [{id, error}]}`. Each mind meant to be awake (desired awake, not an external member, swarm not archived) is first recorded in the pending power snapshot, so Wake all (`POST /api/hive/power {state: "on"}`) restores it; the snapshot is kept when some stop fails. |
| `GET /api/hive/power` | Any signed-in person → `{state: "on"\|"off", since, by}`; an admin also gets `minds_in_snapshot` (minds the pending snapshot would wake; 0 when none). Never names minds. |
| `POST /api/hive/power` | Admin only (member 403, mind token 401). `{state: "off"\|"on", operation_id}` (operation_id required, at most 128 characters; a replay of a finished run returns the original result; a run cut short by a failure or restart is redone by a replay; the same id with the other state is 409 `operation_conflict`). Each mind is added to the pending snapshot durably, under its lock, before its stop, so a cut-short Off never loses a stopped mind from the restore set. **off** → `{state: "off", since, stopped, failed: [{id, error}]}`: records the awake minds into the pending snapshot, then runs Stop all; a non-empty `failed` names minds still running. A second off adds to the pending snapshot and never replaces the set the first one recorded. **on** (also Wake all) → `{state: "on", since, woken: [id], skipped: [{id, reason}], failed: [{id, error}]}`: wakes, one at a time under each mind's lock, the pending snapshot's minds that still exist and are stopped or asleep; skipped reasons are `deleted`, `swarm archived`, `moved`, or the mind's current status. A mind stopped by a person before Off was never recorded and stays stopped. The snapshot is then marked restored. With no pending snapshot, on wakes nothing. |

## Events (added)

| type | payload |
|---|---|
| `approval.created` | `{approval: Approval}` |
| `hive.power` | `{state: "on"\|"off", since}`, to every signed-in viewer; no mind list. Sent after each power off or on (not on a replay). |
| `approval.updated` | `{approval: Approval}` |
| `policy.updated` | `{rules: PolicyRule[]}` |
| `goal.updated` | `{goal: Goal}` |
| `agent.trace` | `{trace: Trace}` |
| `wakeup.updated` | `{wakeup: Wakeup}` |
| `wakeup.fired` | `{wakeup_id, agent_id}` |

## Agent-facing (added)

- **`POST /api/agent/authorize`** `{command}` → `{decision: "allow" | "deny" | "pending", approval_id?, message?}`.
- **`POST /api/agent/replies/rest`** `{in_flight: [conversation_id]}` → `{sent: "reminder" | "note" | null, message_id?}`. The mind's loop calls it each time the mind stops calling its model, whether its turns ran out, it chose a wait or its format retries ran out (never for the runtime's own retries while their next turn comes by itself: a provider back-off, a format failure within its three retries). While a person's message in one of its direct chats has no answer from it, the first rest sends the mind `HIVE-REPLY-OWED` with the conversation to answer in (`hive:reply-reminder`, only the mind reads it), which gives it new turns; the second leaves a note in that chat that the mind stopped without answering (`hive:reply-owed`, shown to people). Once each per message. `in_flight` names conversations the mind has answers queued for that its channel has not sent yet; they owe nothing at that rest.
- **`GET /api/agent/replies/owed`** → `{owed: [{message_id, conversation_id, from, from_name, text, at}]}`: the people's messages this mind has not answered, newest first (hive-goals shows them).
  - The Omega loop calls it before running a skill.
  - An `ask` rule creates an `Approval` and returns `pending`.
  - Once the operator approves, the same command (same text) is allowed
    **once**, and the agent is told by a hub message
    `[APPROVED p_x] <command>`.
- **`POST /api/agent/trace`** `{iteration, input, response, commands}`. The
  hive fills in `llm_ms` and `tokens` from the gateway's last call.
  The runtime adds `rested` and `failure_cause`: when `rested` is true, its
  reply left the mind resting after its replies kept being refused, and every
  task the mind holds and is working on ends failed with the result "Its
  replies kept being refused; the last was <failure_cause>.", so a Create step
  or Code repair waiting on one goes on and can say why.
- **`GET /api/agent/control`** → `{ops: [{op: "retire", space, atom} | {op: "reset"}]}`.
  The queued memory operations, polled each loop.
- **`POST /api/agent/create`** `{sentence, conversation_id?}` → 201 (200 for the
  same open offer again) `{id, mind, sentence, state: "offered", plan_id: null,
  created_at}`. A mind's hive-create: what to build (an app, a page, a game, a
  tool, a script, a change to code) offered to its person, never a plan, since
  a Create plan starts only on a person's word in their own session. The offer
  is for the person of the conversation the mind is answering when
  `conversation_id` names one (an Ask turn's asker, else the last person who
  wrote there), else the person whose own mind it is, else the last person who
  wrote to it. 400 `bad_request` with no sentence or one over 2000 characters,
  403 `person_required` with no person to offer it to, 409 `not_available`
  while Create plans are off. The person reads it with
  `GET /api/me/create-offers?mind=` (their open offers, newest first) and
  presses `POST /api/create/offers/{id}/start`, which starts the plan with the
  offer's words as `POST /api/create/plans` would, behind the same person gate,
  and answers `{offer, plan}` (the same plan when pressed again; 409
  `offer_closed` once set aside), or `POST /api/create/offers/{id}/dismiss`.
  Someone else's offer is 404. Each change sends `create.offer`
  `{principal, offer_id, agent_id, state}` to that person only.
- **Goals:**
  - `GET /api/agent/goals?status=open` → `Goal[]` (the agent's swarm);
  - `GET /api/agent/goals/history?q=&offset=0` → `{goals: Goal[], next_offset: number | null}`.
    Returns three completed tasks per page, newest update first. The query is a literal,
    case-insensitive substring of the title, detail, result, structured result or binding.
    An artifact ID also matches its recorded Studio source or proposal relationship.
    Empty query lists recent work; pass `next_offset` with the same query to reach older work.
    The current mind's task visibility checks run before pagination. An author's other
    tasks are never treated as evidence that a task produced an artifact.
  - `GET /api/agent/goals/{id}/output?offset=0` → `{text, next_offset}`.
    Reads the complete visible goal record as JSON text in 3000-character pages, including
    instructions, result rules and structured output, with the same access checks as goal
    detail. Pass `next_offset` until it is null.
  - `POST /api/agent/goals/{id}/continue` `{instruction}` → `Goal`.
    Creates a fresh root task linked by `binding.continued_from` to a completed task the mind
    can read, claimed by the calling mind and announced to no one. Its detail holds the new
    instruction (nonempty text of at most 3500 characters), then the source's result and
    instructions, cut to fit with a marker naming the output read that has all of them.
    The source result and reviews stay recorded. Result schemas, validators and review
    requirements carry over; execution grants, request identity, deadlines and Studio
    sessions do not. Finish it like any task: it needs no binding echo (see `result` below),
    and an inherited result schema still needs a proposal that fits it. A hive not yet ready
    for claims refuses with 409 `coding_not_ready` and creates nothing.
    An unfinished source returns 409 `not_done`; existing swarm and researcher fences apply.
  - `POST /api/agent/goals` `{title, detail?, priority?, parent_id?}` → `Goal`;
  - `POST /api/agent/goals/{id}/claim` → `Goal` (409 if already claimed).
    A claim is a lease: `lease_until` is set `HIVE_GOAL_LEASE_MINUTES` (default
    60) ahead;
  - `POST /api/agent/goals/{id}/heartbeat` → `Goal`. The claimer renews its
    lease; also resumes a `waiting` goal (409 if you don't hold it);
  - `POST /api/agent/goals/{id}/files` `{path, text}` → `{goal_id, path, bytes}`
    (hive-goal-file). Stages one whole file on a goal the mind holds and is
    working on, for the goal's answer: a Create builder's and test author's
    staged files are read beside the answer's own `files` map, which has the
    last word. A path staged again keeps its last text. 409 `not_claimed`
    unless the mind holds the goal, 400 `bad_path` unless the path is a plain
    relative one, 413 `file_too_large` over 256 KiB, 409 `too_many_files` past
    40 files on one goal.
  - `POST /api/agent/goals/{id}/result` `{status: "done" | "failed" | "waiting", result}`
    → `Goal`.
    - `done` needs a non-empty `result` (400 `no_result`).
    - On a goal with a binding, `done` echoes it: `data.binding`, or `data.binding_digest` equal
      to the goal's `binding_digest` (409 `binding_mismatch` otherwise). A follow-up made by
      `/continue` may leave the echo out, since its binding names only the task it continues and
      the result checks it inherits, which the hive applies itself; an echo it does send must match.
    - `waiting` means "delivered, waiting on a person" and pauses the lease.
  - A lapsed lease puts the goal back to `open` and re-announces it. After 3
    lapses the goal is `stalled` until a person acts.
  - Splitting is limited to 3 levels and 12 subgoals per goal (400 `too_deep`,
    `too_many_subgoals`).
  - Goal statuses: `open`, `claimed`, `waiting`, `stalled`, `done`, `failed`,
    `cancelled`. `Goal` gains `lease_until` and `attempts`.
- **New goals** are announced to the swarm's awake members as hub envelopes
  with `event: "goal"` and `goal_id`.
- **Reads count.** When an agent reads a belief (`/api/agent/query`,
  `/api/agent/belief`) and then publishes the same statement without citing
  evidence, the publish inherits the stamp it read. It is an echo and does not
  revise the belief.
- **LLM spend is checked before the call.**
  - 402 `no_budget`: a paid model with `budget_usd` 0 while the hive has no cap
    on the Limits page. Once it has one, a `budget_usd` 0 mind is held by the
    hive cap, its payer's allowance and the caps set (see "Spending limits" below).
  - 402 `unpriced_model`: a remote model with no price; `HIVE_ALLOW_UNPRICED=1`
    allows it.
  - 402 `budget_exhausted`: spent plus the call's worst-case cost would pass
    the budget.
  - 402 `hive_budget_exhausted`: the call would pass `HIVE_BUDGET_USD` (only
    while the hive has no cap on the Limits page).
  - 429 `rate_limited`: more than `HIVE_MAX_LLM_CALLS_PER_MINUTE` calls (default
    60) in a minute.
- **Free inference** (`hive/core/free_inference.py`): with `HIVE_FREE_INFERENCE_KEY` set, provider `free` is the
  endpoint `HIVE_FREE_INFERENCE_URL` names (Singularity Compute's `https://llm.a.singularitycompute.com/v1` when
  unset; https, or http to a literal loopback address, else there is no provider) on that key, its models
  `HIVE_FREE_INFERENCE_MODELS` (`free/<model>`). A call on it is for the
  person `Hive.user_for` names, or the caller's principal (the Ask conductor's asker, the mind gateway's token
  principal); outside an Ask turn or a work session that is the mind's owner, its replies in rooms and goals included.
  It is never paid with a key in the ring or one assigned to the mind, reserves nothing, and is recorded with its
  tokens at `cost_usd` 0, `payer` the person, `payer_mode: "free"` and `key_id` null. Refused before anything is sent:
  - 403 `free_inference_off`: the hive offers no free inference (no key, or 0 calls a day for a person or the hive), or
    the mind is left on it after the key went;
  - 403 `free_model_not_offered`: the mind's model isn't in the deploy's list now;
  - 403 `free_inference_person_only`: the call is for no named, enabled person;
  - 403 `free_inference_invited_only`: the call is for a public visitor and `HIVE_FREE_INFERENCE_VISITORS` isn't `1`;
  - 429 `free_inference_daily_cap`: the person has made `HIVE_FREE_INFERENCE_DAILY_CALLS` calls today (UTC; default
    200);
  - 429 `free_inference_hive_daily_cap`: the hive has made `HIVE_FREE_INFERENCE_HIVE_DAILY_CALLS` calls today (UTC;
    default 2000);
  - 429 `free_inference_busy`: the endpoint still answered 429 after the retries below; the call counts toward no one's
    calls;
  - 400 `unsupported_route` for embeddings.
  A call counts once it is sent: it is counted for the person and the hive in one step before it goes out, and given
  back if it ends before its request is written (no connection, a refusal or a closed turn at the send boundary, a
  cancellation). At the send boundary the route's authority (offered, the deploy's model, a person it admits) and the
  egress rule are judged again, as for a subscription, so a person disabled while their call waited is refused there.
  A 429 from the endpoint (its key's limit on calls a second, shared by every hive the key is in) is retried up to four
  times: after the wait its `retry-after-ms` or `Retry-After` asks for, when that is at most 8 s, else after a random
  wait under 1, 2, 4 and then 8 s; an answer asking for a longer wait isn't retried. Each retry passes the send
  boundary's checks again and is the same call, counted once; a call refused to the end is given back and refused with
  `free_inference_busy`, whose `Retry-After` is the wait the answer asked for, however long, else the next wait the
  retries would have made; its sentence names the wait only when the endpoint asked for one ("Try again in about an
  hour"), else it says "Try again in a moment". Each of these refusals is a row of one table, `hive/core/refusals.py`: its code, one sentence
  written for the person, and its remedy, what the person can do (`wait`, `credit`, `key` or `model`). An Ask turn whose
  free call is refused for any of these reasons ends with outcome `error`, the refusal's code in `done.error`, its
  remedy in `done.remedy` and its sentence as the answer, which the page then words no second time; the mind gateway
  answers a browser turn with the same code and sentence. `POST /api/agents` and `PATCH /api/agents/{id}` refuse a
  model on the free route the deploy doesn't list (403 `free_model_not_offered`, or `free_inference_off` without the
  route); an edit that keeps a mind's model as it was is not refused for it.
  `GET /api/providers` lists `free` with `needs_key: false`, `key_hint: ""`, `keys: 0`, `account: null` and
`daily_calls`, configured only for a caller the route admits (a public visitor reads `configured: false` unless
visitors are opted in); `GET /api/models` lists its models for every person it admits. `POST /api/keys` refuses it
(400 `no_key_needed`), and a mind's `options.key` cannot name it. Provider `asicloud` is ASI Cloud with a person's own
  key or `ASI_API_KEY`, verified by `GET /models`; it lists `asi1-mini`, free on ASI Cloud.

## Spending limits: one allowance per payer, one hive cap, caps where set

Code: `hive/core/budgets.py` (the rows a call meets and where they are enforced), `hive/core/limits_view.py` (the page's
read model). Plan: omega-flagship/omegahive#107.

**The rows a paid call meets** (`Budgets.applicable`), each with the call's worst case and the worst cases of calls not
yet settled counted against it:

| Row | Where it comes from |
|---|---|
| the payer's monthly allowance | when the hive's money pays (`Hive.payer_for` decides who pays): their `person:<id>` month rule, else a key owner's grant or invite on the call's key, else the member default (`HIVE_MEMBER_MONTHLY_USD`, $50; an admin has none) |
| the hive cap | the hive `month` rule, which a fresh install's first key sets (the starting limit below), else a hive `day` rule |
| every other rule someone stored | on the hive, the mind, its team, the key or the payer, any period |
| the every-mind rule | `POST /api/budgets {scope: "every-mind", period: "month", limit_usd}`: a month cap on each mind with no cap of its own (`budget_usd` 0 and no rule on it but a work session's), never a shared pool; another period is 400 `bad_period` |
| a mind's own `budget_usd` | its lifetime cap, as before |
| `HIVE_BUDGET_USD` | an all-time cap, only while the hive has no cap |

Nothing is derived: a limit applies only where a person, a form or a work session stored it. The first row a call would
pass refuses it, 402 `spend_limit` naming its `scope`, `period`, `limit_usd`, `spent_usd` and `rule` (the stored rule's
id, `member-default`, `grant`, `invite` or `every-mind`).

**A mind with no cap of its own.** Without a hive cap, a paid mind with `budget_usd` 0 is refused 402 `no_budget`; an
every-mind rule alone doesn't change that. Once the hive has a cap, such a mind is admitted within the hive cap, its
payer's allowance and the caps set (its `$0` lifetime row is then not one of its reservation rows). A personal mind its
person pays for from their allowance is admitted without a hive cap. Neither the every-mind rule nor this admission
reaches the two Foundation bindings, which keep their explicit caps.

**Sized defaults.** A session given no `budget_usd` gets `clamp(10% of the mind's headroom, $0.25, $100)`, never above
the headroom, once the hive has a cap ($1 without one); 402 `spend_limit` with nothing left. A lifecycle lease suggestion
is `min(what the coordinator may hand on, its session default)`.

**A person's instruction** (`POST /api/requests`) is bounded by `Budgets.request_bound`: the asker's monthly allowance
(the instruction is theirs to pay), every hive rule, `HIVE_BUDGET_USD` while the hive has no cap, the caps set on the
receiving team, and the team controller's own caps. The row with the least room bounds it; a larger budget is refused
402 `spend_limit` carrying that row whole and its room:

```json
{"error": {"code": "spend_limit", "message": "the instruction asks for $0.80; the month limit on person:u_1a1b1c1d has $0.60 of room left ($1.00 spent and $0.40 held of $2.00)",
           "limit": {"label": "person:u_1a1b1c1d:month", "scope": "person:u_1a1b1c1d", "period": "month", "limit_usd": 2.0,
                     "spent_usd": 1.0, "held_usd": 0.4, "room_usd": 0.6, "kind": "member_allowance"},
           "ceiling_usd": 0.6}}
```

`kind` is `member_allowance`, `hive_cap`, `swarm_cap` or `mind_cap`.

**Server settings only seed a hive with no cap** (Jon 2026-10-07: "surely they should match the number I set in the
admin panel"). `HIVE_BUDGET_USD` applies only while the hive has no cap; once it has one it is reported and unused, and
`GET /api/hive` `limits.hive_budget_usd` is the cap in force (0 then). `HIVE_MEMBER_MONTHLY_USD` and
`HIVE_ASK_CONDUCTOR_TURN_USD` have no panel setting above them and always apply (a person's own month rule still replaces
the member allowance). `HIVE_SWARM_MONTHLY_USD` and `HIVE_PERSON_REQUEST_CEILING_USD` are retired: a hive that still sets
one logs once at startup that it does nothing. Every live setting is listed in `server_settings` below.
**Starting limit** (Jon 2026-11-09): `HIVE_START_LIMIT_MONTH_USD` (default 50, 0 = off, anything unreadable = 50 with a startup warning). When an admin or the owner adds a key (`POST /api/keys`) while nothing governs a paid call yet, the hive sets that month limit: gateway off, the hive cap (only while it has none and `HIVE_BUDGET_USD` is not set non-zero, checked and written in one transaction; always the setting, never a request's `month_usd`); gateway on with no `month_usd`, the owner's all-keys total through the `month_usd` path. The 200 then carries `starting_limit: {"usd", "scope": "hive"|"own"}`; never for a member, never over an existing limit.

**Notices at 50, 80 and 100%** (`hive/core/limit_notices.py`). Once a paid call's usage commits, the payer's monthly
allowance on the hive's money and the hive's monthly cap are each compared with this month's spend. Crossing 50, 80 or
100% of a figure posts one notice through the person's notices (`Notices.from_hive`: kind `hive`, never one of their
daily pop-ups, held in quiet hours for the digest), once a month for that figure; a raised or lowered figure notifies
again, and a call crossing several thresholds at once posts one notice for the highest. The person gets their own
allowance's notices, the admins get the hive cap's and any person's 100%. A person's 100% also asks the admins for more
(a `person_requests` allowance request, once a month), and admission refusing a call on an allowance or the hive's month
cap is that limit's 100% notice too. The marks are the table `limit_notices(label, month, threshold, limit_micros)`, so a
restart never repeats one. A hive cap that is a day rule has no monthly notice.

**The spend-rate guard** (`cost_reservations.guard_charges`). What a mind spends on its own is paced: the payer's monthly
allowance, the hive's monthly cap and a team's or a mind's monthly cap where one is set (`cost_reservations.guarded`; a
day or total rule and a key's cap are held by their limit alone) each refill at a thirtieth of the month a day with a
burst of a tenth (GCRA, ITU-T I.371 annex A, one theoretical arrival time per limit in `limit_rates`): with $50 a month
that is $1.67 a day and a $5 burst. A call a person's own live work holds (`Hive.present_for`: their Studio session, the
Ask turn open on the mind, an active Session with it, a child mind a team spawned for their request until its allocation
goes back, such as a Code request's helper, their live Create plan waiting on a goal it gave the mind, their live Code
request waiting on the mind's second opinion, or their message to the mind, in its chat or a room that delivered it to
the mind, that it hasn't answered yet, for an Ask turn's `TIMEOUT` (120 s) from when they sent it; and every call of the
Ask conductor and the personal-mind gateway) is held by its limits alone and charges the guard nothing, so Make can
spend a small month in one sitting: paced, a $1 month held Make's planner about 17 hours after one 2-cent call, since
each call's worst case was nearly the whole $0.10 burst, and a $2 month held a Code helper's second call about 13 hours.
A month limit someone raises or lowers keeps the money the guard counts ahead: each `limit_rates` row keeps the limit it
was counted at, and the next call scales its time ahead and its open charges by old over new, so a raised cap frees its
larger burst at once.
A call is admitted while its worst case fits the burst left, inside the reservation's own transaction; a call bigger
than the burst only when the guard is full. A call settled below its worst case gives the difference back and a released
call all of it (a trigger on `cost_reservations`, so every path that ends a hold does), so the guard counts what was
actually spent. A refused call holds nothing and is answered 429 `spend_rate` with `scope`, `period`, `limit_usd`,
`retry_after` (whole seconds, also the `Retry-After` header) and `until`, the same shape as a provider's rate limit;
`budget.slowed` announces it once until a call is admitted again. Every refusal of a mind's call for spending or pace
also carries `say`, the hive's sentence for anyone who reads the mind, which names no limit (a spending limit's 402 says
"A spending limit has no room for this call."): the mind's own wait shows it and lasts `retry_after` where the refusal
gives one, else 60 s, and the mind's page keeps it slowed or paused until a call is billed again.

### `GET /api/budgets/limits` (admins only; 403 `admin_only` otherwise)

The Limits page's read model, built from the same calls admission uses. Every row has `key` (the exact label a
reservation is checked under), `scope`, `period` (`day`, `month`, `total`, `lifetime` for a mind's own `budget_usd`,
`all-time` for `HIVE_BUDGET_USD`), `limit_usd`, `spent_usd`, `held_usd` (what calls not yet settled hold against it),
`room_usd` (what admission still lets through) and `source`: `set` (stored), `session` (a work session's total rule while
it runs, not removed from the page), `member-default` or `visitor` (a person's default allowance), `every-mind`,
`server-settings` or `default` (`HIVE_BUDGET_USD`). Every stored rule is in exactly one of `hive`, `people` and `caps`:

```json
{
  "hive": {"cap": {"key": "hive:month", "scope": "hive", "period": "month", "limit_usd": 50.0, "spent_usd": 12.4,
                   "held_usd": 0.6, "room_usd": 37.0, "source": "set", "rule_id": "b_fee5d015"},
           "all_time": null, "month_spent_usd": 12.4, "pace_usd_per_day": 1.24},
  "people": [{"person_id": "u_0a0b0c0d", "principal": "user:u_0a0b0c0d", "name": "Ana", "role": "member", "access": null,
              "allowance": {"key": "person:u_0a0b0c0d:month", "scope": "person:u_0a0b0c0d", "period": "month", "limit_usd": 50.0,
                            "spent_usd": 3.0, "held_usd": 0.0, "room_usd": 47.0, "source": "member-default"},
              "source": "member-default", "spent_usd": 3.0, "pace_usd_per_day": 0.3, "grants": []}],
  "caps": [{"key": "swarm:s_c9a64dee:month", "scope": "swarm:s_c9a64dee", "period": "month", "limit_usd": 500.0,
            "spent_usd": 3.0, "held_usd": 0.0, "room_usd": 497.0, "source": "set", "rule_id": "b_9f8e7d6c"}],
  "old_defaults": [{"kind": "swarm", "swarm_id": "s_c9a64dee", "name": "Alpha", "rule_id": "b_9f8e7d6c",
                    "current": {"key": "swarm:s_c9a64dee:month", "period": "month", "limit_usd": 500.0},
                    "reasons": ["equals the old $500.00 swarm default, with no note"],
                    "change": "Alpha: $500.00 a month -> the hive cap and each payer's allowance",
                    "reset": {"method": "DELETE", "path": "/api/budgets/b_9f8e7d6c"}}],
  "minds": [{"agent_id": "a_72b7ff60", "name": "Dot0", "swarm_id": "s_c9a64dee", "kind": "omega", "budget_usd": 0.0,
             "spent_usd": 3.0, "paid_calls": "allowed", "limits": [],
             "checked": ["hive:month", "swarm:s_c9a64dee:month"], "ask_threads": [],
             "headroom_usd": 37.6, "session_default_usd": 3.76, "lease_default_usd": 3.76}],
  "rulings": [{"name": "ask_thread", "limit_usd": 0.25, "max_usd": 5.0, "source": "jon-ruling"},
              {"name": "conductor_turn", "limit_usd": 0.25, "source": "jon-ruling", "setting": "HIVE_ASK_CONDUCTOR_TURN_USD"},
              {"name": "member_month", "limit_usd": 50.0, "source": "jon-ruling", "setting": "HIVE_MEMBER_MONTHLY_USD"}],
  "server_settings": [
    {"name": "HIVE_BUDGET_USD", "value": 0.0, "set": false, "applies": false, "effect": "not used: the hive cap on the Limits page replaces it", "until_total": true},
    {"name": "HIVE_MEMBER_MONTHLY_USD", "value": 50.0, "set": false, "applies": true, "effect": "the month allowance of each member with no limit of their own", "until_total": false},
    {"name": "HIVE_ASK_CONDUCTOR_TURN_USD", "value": 0.25, "set": false, "applies": true, "effect": "the most one Ask conductor turn may spend", "until_total": false},
    {"name": "HIVE_START_LIMIT_MONTH_USD", "value": 50.0, "set": false, "applies": false, "effect": "not used: the hive already has a cap on the Limits page", "until_total": false}]
}
```

- `hive.cap` is the hive month rule, else its day rule, else null (no paid calls for a mind with no cap of its own);
  `all_time` is `HIVE_BUDGET_USD` while it applies. The pace is this month's hive spend per day elapsed.
- `people` has one row per enabled person: their allowance on the hive's money (null for an admin with no rule of their
  own), where it comes from (`set`, `member-default`, `visitor` or `none`), their month's spend and pace, and the key
  owners' grants to them (`OwnHive.limit_view` rows), each of which holds their calls on that owner's key instead.
  Editing one is `POST /api/budgets {scope: "person:<id>", period: "month", limit_usd}`; removing a `set` allowance
  (`DELETE /api/budgets/{rule_id}`) puts them back on the member default.
- `caps` is every other stored rule: a swarm's, a mind's, a key's, the every-mind rule, a hive day or total rule beside
  the cap, a person's day or total rule.
- `old_defaults` lists stored values that look like an old form's pre-filled figure rather than one someone chose: a
  mind whose `budget_usd` equals a form pre-fill ($5 or $10) or its role's `default_budget`, and a swarm month rule of
  exactly $500 with no note. Never listed: work-session caps and other agent rules, $0 swarm rules (deliberately inert)
  and the Foundation bindings' caps. Each carries the `change` its removal makes and the `reset` that makes it; the page
  removes them in one action after one confirmation that lists every `change`.
- `minds[].checked` lists every key a paid call by that mind is checked against; taking the lowest `limit_usd` per key
  over `hive`, `caps` and the mind's own `limits` gives exactly the reservation snapshot (tested). `paid_calls` is
  `allowed` or `no_budget`. `ask_threads` are the mind's active Ask threads, each held by its own cap.

`GET /api/budgets` (the flat list) holds the stored rules only, each with `spent_usd`, `held_usd` and `origin: "rule"`.
For a non-admin it leaves out every row about a team or mind they cannot see, any key's row and other people's
allowance rows. The admin route also passes rows through the viewer's visibility, as defence in depth.

**Reservations count liabilities by subject.** Each reservation records what the call spends against (the hive, the
mind, its team, the paying person off their own key, the key), whether or not a rule on it existed then. A budget row
`<subject>:<period>` counts every open reservation of its subject (a hive row counts all of them), so a cap or team
rule added or lowered while calls are in flight still sees them; the check and the hold stay one transaction. Holds made before
subjects were recorded are backfilled once, in the startup recovery, from what was recorded with them (the mind, its
current team, the paying person, the key); one that cannot be attributed in full is marked `*`, and it is counted
against every team, mind, person and key row, as is any hold with no subjects at all.

## Default policy

These apply when no rule matches.

| Skills | Mode | Why |
|---|---|---|
| `send`, `wait`, `pin`, `hive-*`, `query`, `remember`, `episodes`, `search`, `web-search`, `web-fetch`, `read-file`, space reads | `allow` | No side effects outside the agent and the hive |
| `shell`, `shell-confirm`, `write-file*`, `append-file*`, `send-file*`, `codex-*`, any `*-commit` | `ask` | Side effects on the machine or on durable memory |
| `metta`, `space-transform`, `space-merge-atoms`, `persistent-merge-atoms`, `retire-persistent-expression`, `persistent-cleanup-commit`, `add-atom`, `remove-atom`, `match`, `get-atoms`, `run-metta-file` | by what the command reaches | Runs when it touches only the mind's own memory spaces, listed in the decision history as ran without asking; asks when it reaches past them (Python, files, Prolog, evaluating an atom the gate can't see, a variable in head position, a function definition, `&self`, a space named other than the memory spaces, such as `skills`, or a function the gate hasn't reviewed). `run-metta-file` always asks. `persistent-cleanup-commit` names only a proposal, and refuses one whose atom is or could be a function definition or type declaration. Quote data, as in `(quote (Found $x))`, to keep it from running |
| Private-data reads: `read-whatsapp-chat*`, `whatsapp-chats`, `whatsapp-inbox`, `observe-glucose`, `glucose-history`, `glucose-rings`, `glucose-watch-status`, `set-glucose-watch`, the Home Assistant reads (`observe-house*`, `observe-room`, `observe-device`, `house-action-log`), `webcam-observation-log`, `audio-observation-log`; also `persistent-expression` and `body-container-launcher` | `ask` | People's private data; an atom that can define a function; a host file outside the sandbox (omega-flagship/omegahive#299) |
| `reboot-self` | `deny` unless the launcher sets `HIVE_EMBODIED_VM=1` | It runs `sudo reboot`, which restarts the whole computer, so only a hive that is the mind's own VM offers it, and then it asks one at a time |
| (human-only) `change-password`, `transfer-funds`, `pay*`, `purchase*` | `deny` to agents | These always need a human to act; no rule can open them |

Code that runs (`shell`, `vm-shell`, `code-exec`, `code-test-run`, `code-proof-check` and the four `codex-code` runs) is approved one at a time, like `shell-confirm` and `restart-omega`: an answer can't be Always or For a time, and an Always answered before that no longer stands. Every skill that takes a path on the hive's computer (`read-file`, `write-file*`, `append-file*`, `delete-file`, the `send-*file*` and `reply-whatsapp-file*` heads) is refused unless the path is inside the mind's own folder. A file send (`send-*file*`, `reply-whatsapp-file*`) reads only from the mind's `files/` and `memory/outbox/` folders, where its shared files and generated pictures are, so its hive token, `.env`, `auth/` sessions and memory are never sent, whatever a person answered.

## The Lab: tests and benchmarks

Each run is a child process (`python -m hive.bench run <suite>`). Its hives
use scratch data, so a run never touches this hive's minds or commons.

| Method & path | Body → Response |
|---|---|
| `GET /api/lab/suites` | → `Suite[]` `{id, kind: "tests" \| "bench", title, description, estimate_s, needs, missing, runnable, last_run, may_run}`. `may_run` says whether this person may start and cancel runs (admins only). |
| `GET /api/lab/runs?suite=&limit=` | → `RunSummary[]` newest first `{id, suite, status, started_at, finished_at, duration_ms, passed, failed, skipped, errors, commit_sha}` |
| `POST /api/lab/runs` | Admin only (403 `admin_only`): a run uses the hive's machine and its environment. `{suite}` → `Run`. Errors: 409 `already_running`, 400 `missing_requirements` |
| `GET /api/lab/runs/{id}` | → `Run` = `RunSummary & {log, cases: Case[]}` |
| `POST /api/lab/runs/{id}/cancel` | Admin only (403 `admin_only`). → `{cancelling: true}` |
| `GET /api/lab/history/{suite}?limit=` | → `{suite, runs, metrics: [{case_id, case, metric, unit, better, target, legacy_names?, points: [{run_id, at, value, ok, renamed_from?}]}]}` |

`Case` = `{run_id, id, name, group, status, duration_ms, message, notes, metrics: Metric[], series: Series[], renamed_from?}`.
- `Metric` = `{name, value, unit, better: "lower" | "higher" | "equal", target, ok, legacy_names?, renamed_from?}`. A metric with no target is informational.

**Renamed metrics.** History and Compare pair metrics by `name` (cases by `id`). When a shown name changes,
`hive/bench/names.py` keeps the old one: a renamed metric carries `legacy_names: [old]` from the run that made
it, and a stored run that used the old name is served under the new one with `renamed_from: old` (also on
its history points, and in a `missed target:` message). Stored runs are never rewritten. A case title renamed
the same way carries `renamed_from` on the `Case`. A case's `group`, and a series' `name` and `x`, are labels (never
paired): a stored run is served with the current ones, a renamed series with `renamed_from`.

| Old name | Current name |
|---|---|
| `memory per dot` | `memory per mind` |
| `idle model calls per dot-day` | `idle model calls per mind-day` |
| `dot stayed up` | `mind stayed up` |
| `dots restored` | `minds restored` |
| `dots in error` | `minds in error` |
| `dots connected` | `minds connected` |
| `dots with errors` | `minds with errors` |
| `finished by second dot` | `finished by second mind` |
| `goals with two winners` | `tasks claimed twice` |
| `goals with a winner` | `tasks with one owner` |
| `subgoals accepted` | `subtasks accepted` |
| `Dot crash recovery` (case title) | `Mind crash recovery` |
| `Goal claim race` (case title) | `Task claim race` |
| `Abandoned goal recovery` (case title) | `Abandoned task recovery` |
| `Subgoal explosion` (case title) | `Subtask explosion` |
| `goals` (case group) | `tasks` |
| `winners per goal` (series), x `goal` | `owners per task`, x `task` |
| `goal state (0 open, 1 claimed, 2 waiting, 4 done)` (series) | `task state (0 open, 1 claimed, 2 waiting, 4 done)` |
- `Series` = `{name, unit, kind: "line" | "bar" | "step", x, points: [[x, y]], renamed_from?}`.

Events: `lab.run {run}`, `lab.case {case}`, `lab.log {run_id, text}`.

| Suite | What it runs |
|---|---|
| `tests-hive` | Server tests against real PeTTa spaces |
| `tests-runtime` | Omega runtime tests |
| `tests-memory` | Boots Omega: memory isolation, protected atoms, atomic saves |
| `tests-e2e` | Real Omegas end to end: Phase 1 and Phase 2 acceptance |
| `tests-ui` | Web UI tests (vitest) |
| `bench-core` | Commons, gate, hub and gateway latency; revision accuracy; claim races |
| `bench-drift` | Echo storm, corroboration, self-repetition, retry storm, spend runaway, abandoned goals, subgoal explosion, refusals |
| `bench-epistemic` | Epistemic Resolve (Crawford & Hammer, AGI-26) through the swarm commons, next to the paper's calibration mocks. Step polarity is hand-annotated; this tests the update discipline, not language understanding |
| `bench-swarm` | Three live Omegas on the offline model: boot, reply latency, belief propagation, loop health |

From a shell: `python -m hive.bench list`, `python -m hive.bench run bench-drift`,
`python -m hive.bench record --out results.json [suites…]`.

## Timed sharing between minds

A mind's spaces are private. Another mind **in the same swarm** can read them
only through a share. Every share is time-limited (default 30 min, at most
240), always the owner's choice, logged on every read, and revocable by the
owner or the operator. The reconcile loop closes shares when their time is up.

| Kind | Who starts it | What the reader gets |
|---|---|---|
| request | the reader asks for one space, with an optional filter and a reason; the owner grants or denies | live reads of that space, from its saved file, through the owner's filter |
| offer | the owner opens a space to a reader | the same |
| exhibit | the owner publishes a fixed piece of work (title, text, atoms, or a filtered snapshot of a space) to named minds or `swarm` | that snapshot. One read replaces a long message thread |

**Agent routes:**

| Method & path | Body → Response |
|---|---|
| `GET /api/agent/shares` | → `Share[]`: open shares you own or can read |
| `POST /api/agent/shares/request` | `{owner, space, minutes?, filter?, reason?}` → `Share` (`requested`). The owner gets `[SHARE-REQUEST sh_x] …` |
| `POST /api/agent/shares/{id}/grant` | `{minutes?}` → `Share` (`active`). Owner only. The reader gets `[SHARE-GRANTED sh_x] …` |
| `POST /api/agent/shares/{id}/deny` | `{reason?}` → `Share` (`denied`) |
| `POST /api/agent/shares/offer` | `{grantee, space, minutes?, filter?, note?}` → `Share` (`active`). The reader gets `[SHARE-OFFERED sh_x] …` |
| `POST /api/agent/shares/{id}/revoke` | → `Share` (`revoked`). Owner only |
| `GET /api/agent/shares/{id}/atoms?q=&limit=&offset=` | → one page: `{kind, space? \| title, body (whole, first page only), body_bytes, source, atoms, total, offset, limit, returned, complete, next_offset, limit_clamped, owner, expires_at}`. `limit` is at most 500. `complete` is true only when this one response holds everything; otherwise keep reading from `next_offset` until it is null. Reader only. 410 `share_closed` once it lapses |
| `POST /api/agent/exhibits` | `{title, to: "swarm" \| [minds], minutes?, body?, atoms?, space?, filter?}` → `{exhibit_id, atoms, bytes, shares}`. Limits: 256 KB and 2000 atoms (413 `too_large`). To `"swarm"` from a mind with no other mind in its swarm, as a person's own mind always is: 409 `no_reader`, before any approval is asked, its words saying no other mind could read it. Each reader gets `[EXHIBIT sh_x] …` |

**Operator routes:**

| Method & path | Response |
|---|---|
| `GET /api/shares?status=&agent_id=` | → `Share[]` |
| `GET /api/shares/{id}/reads` | → the read log |
| `POST /api/shares/{id}/revoke` | → `Share` (`revoked`) |

Event: `share.updated {share}`.

`Share` = `{id, kind: "space" | "exhibit", swarm_id, owner_id, owner_name, grantee_id, grantee_name, space, pattern, exhibit_id, exhibit?, minutes, reason, status: "requested" | "active" | "denied" | "revoked" | "expired", initiated_by, created_at, decided_at, expires_at, reads, last_read_at}`.

**Omega skills:**
- `hive-share-request mind space minutes reason`
- `hive-share-grant sh_id`
- `hive-share-deny sh_id reason`
- `hive-share-offer dot space minutes`
- `hive-shared sh_id filter`
- `hive-shares`
- `hive-exhibit minds minutes title | text`
- `hive-exhibit-space minds space minutes filter`

**Policy is enforced at the endpoints**, for Omegas and direct HTTP callers
alike. Each route is checked as a skill: `hive-share-request`,
`hive-share-grant`, `hive-share-deny`, `hive-share-offer`, `hive-exhibit`,
`hive-exhibit-space` (an exhibit built from a space) and `hive-shared`
(reading).
- `deny` gives 403 `policy_denied`.
- `ask` gives 403 `approval_required` with an `approval_id`. Once a person
  approves it, the identical request succeeds **once**.
- An Omega whose own gate already obtained and used an approval for that skill
  is let through once on the matching call.
- Revoking is never blocked, because it only narrows access.

Limits: a space read reflects the owner's last save, and requests that get no
answer lapse after an hour.


## Web tools: `POST /api/agent/web/search` and `/api/agent/web/fetch`

Host-side web access for minds (code: `hive/core/webtools.py`). A sandboxed mind reaches only its hive, so its `web-search`
and `web-fetch` skills (`modules/web_search`) call these routes with the mind's own token; the hive searches and fetches.
**On by default**; `HIVE_WEB_TOOLS=off` leaves every route below absent (404).

| Method & path | Who | Body → Response |
|---|---|---|
| `POST /api/agent/web/search` | mind | `{query, max_results?: 1..20 (8)}` → `{query, provider, searched_at, results: [{title, url, snippet}]}` |
| `POST /api/agent/web/fetch` | mind | `{url, max_chars?: 100..200000 (20000)}` → `{url, final_url, title, content_type, fetched_at, status, bytes, truncated, redirects, text}` |
| `GET /api/web/settings` | admin | → `{deny, allow, origin, updated_at, updated_by}` (seeded from `HIVE_WEB_DENY` / `HIVE_WEB_ALLOW` until an admin saves) |
| `PUT /api/web/settings` | admin | `{deny?, allow?}` host lists (`example.com` covers its subdomains); an empty allow list allows every host not denied |
| `GET /api/web/audit?agent_id=&limit=` | admin | → newest first `{at, agent_id, turn, tool, query, urls, final_url, status, outcome, reason, bytes, content_type, results, provider, elapsed_ms}`; never a page body |
| `GET /api/web/breakers` | admin | → each mind's breaker row |
| `POST /api/web/breakers/{agent_id}/reset` | admin | `{reason}` → the closed row |

Fetch rules: https on port 443 only, no user info; the host resolves the name and refuses private, loopback, link-local,
CGNAT, multicast, reserved, unspecified and cloud-metadata addresses (IPv4 and IPv6, IPv4-mapped/6to4/Teredo/NAT64
unwrapped), every resolved address checked; it connects to the vetted address itself (Host header and TLS SNI carry
the name; the certificate is checked against it), so the name is never resolved twice. Every redirect hop is vetted the
same way, at most 5; 10 seconds for the whole call, reading the page included; only uncompressed answers are read
(`Accept-Encoding: identity`); the body stops at 2 MB; only HTML, XHTML, plain text, JSON and PDF are read (PDF text in
a limited child process); robots.txt is honoured (cached 10 minutes, an unreachable one disallows for a minute). A name
that does not resolve and one that leads to a refused address get the same answer.
Limits: `HIVE_WEB_TURN_MAX_FETCHES` (20) and `HIVE_WEB_TURN_MAX_SEARCHES` (10) per turn (a turn ends at the mind's next
model call that returned); the mind's budget and its monthly and daily limits refuse a web call once used up; after
`HIVE_WEB_BREAKER_REFUSALS` (5) safety refusals within `HIVE_WEB_BREAKER_WINDOW_SECONDS` (600) the mind's web access
pauses until an admin resets it (robots.txt verdicts and names that do not resolve never count). Two searches run at once at most; a third is refused.
The audit keeps URLs without query or fragment, and folds the same refusal within a minute into one row (`count`).
Search provider: `HIVE_WEB_SEARCH_PROVIDER` (`ddgs`, the default and only one so far); a provider's key stays on the host.

## Metered media: `POST /llm/v1/media` (P1)

One host-metered image route. **Off by default**: it exists only when the operator sets `HIVE_MEDIA_ROUTE=on` (launcher env file); otherwise it is absent (404). Code: `hive/core/media.py`. No new meter, registry or scheduler: it reuses the chat route's payer (`Hive.payer_for`), key (`Gateway.paying_key`, the existing OpenRouter key), caps (`Hive.check_budget`, `Reservations.reserve` over `host_budget_snapshot`), the person resolve route, and the native asset store.

**Request** (agent token, JSON, at most 64 KB): `{op, operation_id?, prompt, size?, quality?, references?, goal_id?}`; any other field is 400 `unsupported_field`.
- `op`: `image.generate` (gated by skill `generate-image`) or `image.generate-quality` (skill `generate-image-quality`). The existing per-mind policy rules on those names are the on/off switch (403 `policy_denied`). `image.inspect`, `image.observe` and `video.generate` are 501 `op_closed`: no selected model has a documented bound for every billed unit.
- `operation_id`: optional, 8-120 of `A-Za-z0-9._:-`. Without one, the host derives `auto-` + sha256(agent, task, op, normalized request), where task is the goal held or `none` and the request is the stripped prompt, size, quality and references. A retry of the same request for the same task, before or after a restart, therefore finds the same operation and never pays twice. A deliberate new attempt passes a new explicit id. The reservation id is `media:` + sha256(agent, op, operation_id); a ProgramActions record key is never the billing identity.
- `prompt`: 1 to 4096 UTF-8 bytes after leading and trailing whitespace is stripped (the stripped prompt is what is sent and bound). `size`: a key of the pinned geometry (default when only one). `quality`: one of the pinned qualities (default when only one; refused when none is pinned).
- `references`: at most the pin's `max_references` of `{sha256, artifact_id?, revision?}`; each must pass `assets.agent_may_read`, be at most `max_reference_bytes` (10 MiB), carry a PNG/JPEG/WebP signature, and have positive header dimensions within `max_reference_width` × `max_reference_height` (4096 × 4096) and `max_reference_pixels` (16,777,216), else 413 `reference_dimensions`; then it must fully decode (below), else 415 `reference_undecodable`. All before any reservation. Sent as `input_references` data URLs; nothing is fetched by URL.
- `goal_id`: the task the mind holds (claimed or waiting). Its swarm owns the image and its `deadline_at` bounds the call; without it, the single task the mind holds, else the mind's own swarm and no deadline.

**The pinned endpoint record** (operator, providers file, `Provider.media` on `openrouter`; never from a request):

```json
{"image.generate": {
  "model": "<author>/<slug>",
  "endpoint": {"provider_name": "...", "provider_slug": "...", "provider_tag": "...",
               "supported_parameters": {"size": {"type": "enum", "values": ["..."]}, "...": {}},
               "pricing": [{"billable": "output_image", "unit": "image", "cost_usd": 0.04, "variant": "2K"}]},
  "geometry": {"<name>": {"width": 2048, "height": 2048, "controls": {"size": "2048x2048"}}},
  "quality": [], "max_references": 1, "max_reference_bytes": 10485760,
  "max_response_bytes": 20971520, "max_output_bytes": 15728640, "timeout_seconds": 180,
  "max_reference_width": 4096, "max_reference_height": 4096, "max_reference_pixels": 16777216}}
```

`endpoint` is the definitive record from `GET /api/v1/images/models/{author}/{slug}/endpoints`, copied verbatim. Each geometry control (`size`, `resolution`, `aspect_ratio`) and each quality must be a supported parameter of that endpoint, and the geometry is an exact pixel pair. Otherwise the pin is 503 `media_pin_invalid`. References need `input_references` in `supported_parameters`. The record must document `n` and allow 1 (an enum listing 1, or a range covering it; and every entry of `supported_parameters`, used or not, must be well formed: a range has explicit finite numeric `min` ≤ `max`, an enum a non-empty list of scalars, and a boolean is exactly `{type: boolean}`; any other entry is 503 `media_pin_invalid`), else 503 `media_pin_invalid`. Without an image decoder (Pillow, `hive/requirements.txt`) every op is 503 `media_decoder_unavailable` before any spend. An op with no pin is 404 `op_unavailable`.

**Decode.** References and outputs are fully decoded; a header alone is never enough. The header's dimensions are capped first, at the reference caps or the exact geometry for an output, so nothing larger is decoded: that cap is the decompression-bomb bound. Then the container must be whole: for PNG every chunk is present with a valid CRC, and IEND comes last with nothing after it; JPEG ends with EOI; for WebP the RIFF size equals the file length and every chunk is fully present. Then Pillow must agree on the format and dimensions, decode every pixel of a single frame (`load()`, truncated data refused), and report the header's dimensions.

**Worst case**, checked before any reservation (422 `media_unpriced`): **every** pricing line is summed, whatever its `variant`. The record names a variant by a free label, with no machine-checkable condition tied to the dispatched control value, so neither that label nor any operator-supplied label excludes a line.

| unit | output_image | input_image / input_reference | input_text | input_font |
|---|---|---|---|---|
| request | 1 | 1 | 1 | 1 |
| image | 1 | the number of references | refused | 0 |
| megapixel | ceil(W·H/10⁶) of the geometry | the sum of ceil(w·h/10⁶) over the references | refused | 0 |
| token | refused | refused | prompt bytes + 1 | refused |

An unknown billable or unit is refused, and so is a price that is missing, non-numeric, negative or non-finite. A documented zero is a known price, but the total must be positive and finite. `HIVE_ALLOW_UNPRICED` never applies here.

**Wire**: one `POST {openrouter base}/images` with `{model, prompt, n: 1, <geometry controls>, quality?, output_format: "png" (only when the endpoint supports it), input_references?, provider: {only: [provider_slug], allow_fallbacks: false}}`. No `response_format` and no streaming. The response is read under `max_response_bytes`, with a total timeout of min(`timeout_seconds`, the task's time left).

**Outcomes**. Billing and the asset are separate:
- **Billing.** A finite, non-negative `usage.cost` settles the reservation (`usage` row on `openrouter/<model>`; a cost above the hold is settled and flagged in `/api/budgets/overruns`). Anything else holds the worst case as an unknown liability: a vendor error, a missing, negative or non-finite cost, a timeout, a cancel, a transport loss, an oversize response or a host error. Nobody settles it by hand: `GET /api/budgets/reservations` (admins) says how each held call settles itself, `settles` being `record` when OpenRouter keeps a record of the call (the reconcile pass reads it), `estimate` for any other unknown call and `answer` for a call still in flight, and `auto_settles_at` when the expiry settles an unknown call at its worst case if nothing settles it first. Nothing retries.
- **Estimates.** A hold still unknown an hour after its outcome went unknown is settled at its worst case as an estimate: a resolution by `hive:expiry` and a `usage` row with `estimated: 1` that names its call (`reservation`). A $0 model's one-micro-dollar floor is no worst case, so its call is estimated at $0, the model's price, which lets the model be called again; until then a further call to it is refused with 402 `free_model_unreconciled`, saying in about how many minutes the earlier call settles. Each pass that settles calls publishes one `budget.estimated` event (admins only): `{count, total_usd, payers: [{payer, count, total_usd}], free: [{model, count}], reservations}`, `free` naming the free models whose calls it settled at $0. Each person gets at most one notice a day about the estimates made before their local day began (an admin about all of them, anyone else about the calls they paid), kind `hive`, which quiet hours hold for the digest: "Yesterday, 3 calls were estimated at $0.15. That's their worst case, an upper bound that's usually lower; you can correct them in Usage from the provider's billing within 30 days." It asks nobody to correct anything. An admin's line also names the free models whose calls were settled at $0, their price ("1 call to a free model (…) had an unknown outcome and was settled at $0, its price."); anyone else's line leaves those out, since they moved none of that person's spend. `GET /api/budgets/reservations/estimated` (admins) lists the estimates a person may still correct, newest first: `[{id, estimate_usd, settled_at, correctable_until, metadata, observation, scopes}]`. `POST /api/budgets/reservations/{id}/correct` (admins) `{action: "settle", actual_usd, reason}` or `{action: "release", reason}` corrects one within 30 days of its settlement, once: `usage` keeps the estimate's row and gets an adjusting row of the billed cost minus the estimate, dated with the estimate so each day and month takes it where the estimate was charged; a billed cost above the hold is flagged as an overrun (`source: "correct"`). It answers `{id, state, maximum, actual, estimate, action}`, 409 `not_correctable` for a call that is no estimate, was corrected already or was estimated more than 30 days ago, and 400 for a bad action, amount or missing reason. OpenRouter's own record corrects an estimate the same way, by `hive:provider-record`, when it comes after the hour: each reconcile pass gives the record lookups the unknown calls leave to the estimates of OpenRouter calls the hive holds a generation id for, inside their 30 days, asking about each again once its age has doubled since it was last asked. A cost above the hold that a record reports, for a held call or an estimate, is flagged with `source: "provider-record"`. `POST /api/budgets/reservations/correct` (admins) `{action: "settle" | "release", ids, reason}` corrects several estimates as one decision, all or none: settle keeps each as billed, release corrects each to nothing billed. It answers `{action, count, estimate_usd, corrected}`, and 409 `not_correctable`, changing nothing, when one of them can no longer be corrected; a held call never can, being no estimate.
- **Asset.** Exactly one `data[0].b64_json`, at most `max_output_bytes` decoded, that fully decodes as a PNG (or PNG/JPEG/WebP when `output_format` is not supported) with dimensions equal to the geometry. It is stored with `assets.put` into the task's swarm, with no upload name. Otherwise the asset is refused (`output_count`, `output_missing`, `output_not_base64`, `output_too_large`, `output_not_image`, `output_undecodable`, `output_type`, `output_dimensions`, `store_failed`) and the billing still stands: a complete response whose bytes do not decode stays settled, and no corrupt asset is stored.
- `resolved_model` and `response_id` are always `"UNKNOWN"`: the Image API response documents only `created`, `data` and `usage`.

**Responses**: 200 `{reservation, state, op, operation_id, model, endpoint_provider, resolved_model, response_id, billing{state, held_usd, actual_usd, origin}, asset{sha256, mime, width, height, bytes, owner_swarm}|null, refusal}`. Errors carry the same fields in `error`:
- 502 `output_refused`: the image was refused (billing as stated);
- 504 or 502 `outcome_unknown`, with `reservation` and `held_usd`;
- 402 `reservation_refused`, `budget_exhausted` or `no_budget`;
- 409 `goal_not_held`, `deadline_passed`, `session_changed` (a session on the mind started or ended between admission and the reservation transaction) or `payer_changed` (the payer, captured in one read with the sessions, is re-derived inside the reservation transaction and differs); in both cases nothing was reserved or sent.

**The same operation again** never makes a second vendor call:
- settled with an image: 200, the recorded result, `replay: true`;
- settled without an image: 409 `output_refused`;
- dispatched or unknown: 409 `outcome_unknown`;
- released: 409 `operation_released`;
- the same id with a different request: 409 `operation_conflict`.

**Session close.** `POST /api/sessions/{id}/end` is 409 `liabilities_open` (`reservations[]`) while the mind has a reserved, dispatched or unknown liability on its own cap, whatever the switch, for a session whose cap is part of the mind's rule: an ordinary session, or an Ask thread the mind answers itself. Ending one restores the outer cap, so it waits until they settle by themselves, an unknown one at the latest an hour after its outcome went unknown. An Ask thread with its own cap (the conductor's or a browser's) is never part of the mind's rule, so ending it restores nothing and is not refused for the mind's open calls; its own holds stay counted against it however late they settle. The check runs inside the same write transaction a reservation takes, and the media admission re-checks the mind's active sessions inside its reservation transaction, so either order is safe. With the route on, ending an ordinary (non-Ask) session is also 409 `mind_running` while the mind is awake or starting.

**Mind side.** Inside a hive (`HIVE_LLM_URL` set), `generate-image` and `generate-image-quality` (`modules/media_imagegen`) call this route and return `IMAGE-GENERATED sha256=… WxH operation=… artifact-ready`. Without an id, a retry reuses the derived operation. A deliberate new attempt starts the prompt with `op=<new-id> ` (or passes `operation_id` from Python). They never fall back to the direct vendor. The inventory reports these skills as `host_metered: true`, with `budget_route: "reservations"`, while the route is on and the op is pinned.

---

## Per-mind tool inventory (S4)

What a mind can *prove* it registered, not what its source says. Read-only; no secrets. Contract: platform seam contracts r2, r2.4 item 6.

- `POST /api/agent/inventory` (mind token): the **boot receipt**, posted once per boot by `modules/hive` (`hive-inventory-boot`, a trusted RuntimeOrgan). Exact shape `{boot_id, pid?, loader?, core?, modules[{dir, id?, version?, source_digest?, configured, loaded, signature_heads}], provides[[module id, skill]], parser{skill: [[type, name]]}}`; unknown keys are refused (400 `invalid_receipt`). Outside members (`kind: module`) have none.
- `GET /api/agents/{id}/inventory` (owner or admin; other viewers 403 `owner_or_admin`, unseen minds 404) and `GET /api/agent/inventory` (the mind itself; over MCP: `hive_capabilities`, policy name `hive-capabilities`).
  - `availability`: `boot-receipt`, `receipt-stale` (the mind restarted, stopped or is not awake since the receipt: every skill `unknown`), or `no-boot-receipt` (`inventory_revision: null`, `loaded_at: null`, every skill `unknown`).
  - skill `status`: `callable` (parser registered the head and the module is loaded; says nothing of provider, budget or future authority), `imported` (module loaded, no parser head), `configured` (loader selects the module, the mind did not load it), `unknown`.
  - skill `policy`: `{decision, reason, snapshot_at}` from `Policy.decide` for this mind; `route` per skill (`none-declared`, or image/video/vision with `budget_route: "unknown"`, since the host does not meter media; with `HIVE_MEDIA_ROUTE=on`, a pinned image op shows `host_metered: true`, see "Metered media"); top-level `provider` `{model, resolved_model, payer_kind, budget_route[], snapshot_at}`.
  - `help`, `topic`, `effects`, `risk`, `signature.declared` come from Match's extractor (vendored, pin `c8b4a4c5…`) and only from sources whose digest equals the receipt's (`metadata: "verified-source"`), else `null` / `"unverified"`.
  - `dynamic`: workflow registry entries from Flow's `agent_dynamic_inventory` when the Flow branch is merged (`dynamic_status: not-installed|ok|refused:<code>`), kept apart from `skills`, `status: "unknown"`.
- `GET /api/agents/{id}/inventory/activity?cycles=30` (owner or admin): reasoning activity for the dormancy meter, counted from the mind's recorded commands over its last N cycles (max 200): `nal-step`, `pln-step`, `nars-*`, `metta` and belief writes (`belief-claim`, `belief-derived`, `assimilate-belief`; commons `hive-publish`), each `{attempted, ran}` (`ran` excludes commands the gate denied or held), plus `dormant`.


## Motivations and the Tasks query (phase 1)

Design: `MOTIVATIONS_TASKS_HOST_DESIGN_20261005.md` r3 with Jon's Q1–Q7. Code: `hive/core/motivations.py`. A **motivation** is the *why*; a **task** is today's goal, unchanged. Every goal route, MCP tool, envelope, board, program `ctx` and the `goal.updated` event are unchanged and carry no motivation field (design §1.6, pinned by freeze tests).

`Motivation` (reader view): `{id, title, why, owner, swarm_id, status, visibility, rev, parent_id, created_by, created_at, updated_at, status_changed_at, editable}`; an editor also gets `shared_with` and `links_version`.
- `owner`: `user:u_…` (a person; `swarm_id` null = spans teams, or one team), `swarm:s_…` (a team; `swarm_id` is that swarm) or `agent:a_…` (a mind's own, scoped to its swarm). Anything else is 400 `bad_scope`; the hive password (`user:operator`) owns no personal motivation.
- `status`: `active | paused | achieved | retired`; presentational, never cascades to tasks; there is no delete. Team and mind rows of an archived swarm are read-only (409 `swarm_archived`).
- **Read**: admins; a person's row by its `visibility`/`shared_with` as for minds and swarms; a team or mind row only if the viewer sees the swarm, then `public`, or `shared` and named, or the swarm's current owner. **Edit**: admins, the person who owns a personal row, the swarm's current owner for team and mind rows (a mind never edits). Hidden and missing ids give the same 404 `not_found`.
- `rev`/`updated_at` move only on content edits (title, why, status, visibility); link changes move only `links_version`.
- `parent_id` (Q1) is null and refused by every route (400 `parent_disabled`) unless `HIVE_MOTIVATION_HIERARCHY=1`; switched on, creation accepts a parent with the same owner and scope, two levels at most; it is never changed after creation (400 `parent_fixed`).

| Route | Body / query → result |
|---|---|
| `GET /api/motivations?owner=&swarm=&status=&cursor=&limit=` | readable rows, newest first → `{items: Motivation[], cursor}` |
| `POST /api/motivations` | `{title, why?, owner?, swarm_id?, visibility?, shared_with?}` → `Motivation`; `owner` defaults to the caller; personal: the person (an admin may create one for a person); team: the swarm's owner or an admin; personal rows default `private`, team rows `public`. The person, the swarm, its visibility and its owner are judged inside the insert transaction, so authority withdrawn before the insert creates nothing. A hidden or missing swarm is 404 `not_found`; a seen swarm the caller does not own is 403 `owner_only` |
| `GET /api/motivations/{id}` | `Motivation` |
| `PATCH /api/motivations/{id}` | `{title?, why?, status?, expected_rev}` → `Motivation`; 409 `motivation_changed` on a stale `expected_rev` |
| `PUT /api/motivations/{id}/visibility` | `{visibility?, shared_with?, expected_rev}` → `Motivation`; a stale write is 409 and never overrides a newer choice |
| `POST /api/motivations/{id}/links` | see below |
| `GET /api/tasks` | see below |
| `POST /api/agent/motivations` (mind token) | `{title, why?, scope?: "self" \| "team", operation_id}` → `{motivation, replayed?}`; `operation_id` (`[A-Za-z0-9_.:-]{8,120}`) is required, so every mind create is replay-safe: the same id and body returns the first motivation (`replayed: true`), another body or a swarm move since is 409 `operation_conflict`; owner, creator and swarm come from the mind's row (re-read in the transaction); `owner`, `swarm_id`, `visibility`, `shared_with`, `created_by` are refused (400 `bad_scope`); no swarm 400 `no_swarm`; archived 409 `swarm_archived`; policy `hive-motivation-create`; MCP `hive_motivation_create` |
| `GET /api/agent/motivations` (mind token) | `{motivations: Motivation[]}`: exactly those this mind created (by id); MCP `hive_motivations` |

**Links** (`POST /api/motivations/{id}/links`), one transaction: `{operation_id: [A-Za-z0-9_.:-]{8,120}, op: "link"|"unlink"|"move", goal_ids: [1..200], cascade: bool (required), expected_to_rev, expected_to_links_version?, from_motivation_id?, expected_from_rev?, expected_from_links_version?}` (the `from_*` fields for a move only, and then required). → `{operation_id, applied, unchanged, motivation, from_motivation?, replayed?}`.
- Order of checks: both motivations editable (else 404), not archived, the destination `active|paused` for link and move (409 `motivation_closed`), each against its own `rev` and optional `links_version` (409 `motivation_changed`); each named task visible (404), in the destination's scope (400 `scope_mismatch`), in an open swarm (409 `swarm_archived`); with `cascade` every descendant by the same rules (409 `cascade_refused`, naming none); then prior state: an existing link is unchanged, an unlink or move whose named pair is gone is 409 `link_changed` for the whole operation (descendants are changed only where the change applies). Any refusal changes nothing and records nothing.
- Links of other motivations are never read or touched. A task may serve many motivations (Q7). A link discloses nothing to minds or apps.
- **Idempotency**: key `(principal, operation_id)`, bound to a SHA-256 of `{method, domain, destination, op, sorted goal_ids, cascade, from_motivation_id, every expected_* field}` (absent = null); any difference is 409 `operation_conflict`. The record commits with the links. A replay re-checks current authority (both motivations editable, every stored task visible) and otherwise answers exactly as a first call would (404); it does not re-check the consumed revision preconditions, and it returns all the stored goal ids (never a subset) plus the current view. Each `links_version` bump is a compare-and-set on the `rev` and `links_version` read in the first check, so a change between the check and the write is 409 `motivation_changed` with nothing applied.

**Tasks** (`GET /api/tasks`): `motivation=mo_…|none`, `swarm`, `mind`, `status` (one or a comma list), `q` (≤ 100), `top=true`, `sort=priority|updated`, `group=status`, `cursor`, `limit` (1–200, default 50).
- One `WHERE` for items, `counts` (`{total, by_status}`) and every group page: the swarms the viewer sees (admins: all), plus the named filters. `motivation=mo_x` needs the motivation readable, `swarm` the swarm seen, `mind` the mind seen (assignee, claimer or creator), each else 404. `motivation=none` (Unsorted) means no link to any motivation the viewer can read, so a hidden link and no link look the same.
- Each item is the `GET /api/swarms/{id}/goals` item plus `motivations: [{id, title, status}]` (readable links only) and `requests: [{id, kind, state, direction}]` (visible requests only).
- → `{items, counts, cursor}`; with `group=status` → `{counts, groups: {status: {items, cursor}}}` and a group cursor answers `{group, items, cursor}`.
- Cursors are opaque and host-MAC'd (key `HIVE_DATA_DIR/motivations-cursor.key`), bound to sort, filter, group and principal; anything edited or foreign is 400 `cursor_invalid`. They carry no authority: visibility is judged again on every page. No snapshot: a task whose priority, status or `updated_at` changes while paging may repeat or be skipped; a task created meanwhile may or may not appear; any other task appears exactly once.

**Events**: `motivation.updated` `{motivation: reader view}` on content changes only, delivered to people who can read the stored row now; `motivation.links` `{motivation_id, swarm_id, linked, unlinked}` once per (motivation, swarm) after a committed link change, delivered only to people who can read the motivation and see the swarm, and only when every goal named is in that swarm (checked against the goal rows). Missing or malformed rows fail closed.

Not in phase 1: the motivation summary (progress, minds, money), subtask link inheritance, `motivation_id` on goal/session/Ask/request creation, the boards alias, task-scoped `/api/match`, disclosure grants.

## Universal Ask, phase 1 (text)

A person types a request anywhere in the UI; the coordinator of the relevant swarm answers it in an Ask thread.
Code: `hive/core/ask.py`. Contract: `UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005.md` as amended by
OmegaReview's design review (items 1–5) and Jon's routing ruling. Phase 1 has no proposals, app tools, ui changes,
confirm tokens, delegation or voice.

**Who may call:** a named signed-in person whose role is admin or member. The local operator password gets 403
`person_required`, and a mind's token gets 401.

**Refusals:** `{"error": {"code": <reason>, "message": <a sentence the host wrote>, ...details}}`. The reason is one of
`not_available | not_allowed | person_required | no_mind | no_orchestrator | coordinator_busy | mind_asleep | spend_limit | ask_busy |
rate_limited | too_large | timed_out | operation_conflict | invalid | stopped`, plus `wrong_route` for a body carrying
`kind`. Host error text is never forwarded. A refused request creates nothing: no turn, message, session or goal.

### Routes

- `POST /api/ask` creates one turn and returns **202** with the turn view (below).
  - Body (exact keys, 32 KB at most):
    `{operation_id: [A-Za-z0-9_.:-]{8,120}, text: 1–4000 chars, context?, thread?: <Ask thread id>, via?: "typed"|"voice", continues?: <ended turn id>,
    carry?: true}`.
  - Continue names its stopped turn with `continues` (the accepted frame's `turn_id`). Typed requests omit it.
    It must name an undeleted, ended turn of the same person and answering mind, created within the last 24 hours
    (`ask_intents.TURN_MAX_AGE`); otherwise admission returns 400 `invalid`. The field is stored on the turn and
    included in the idempotency body digest. A conductor turn's model is told what it continues from the host's own
    record of the turns it continues: where they kept their words (a swarm thread's turns, and only into a turn of the
    same swarm) the first request's words and the latest answer, otherwise that the person's browser sends them (an
    own mind's turns); how often it was continued; and the hand-overs already made. Nothing of it is stored again.
  - `carry: true` says the page opens the turn only to carry the words to another swarm on the turn's intent (Create's
    Code bench sends the person's change to Code as a `code.request`). The host admits it for that intent and closes it
    at once as `refused/stopped`: no conductor, model or mind answers it, nothing reaches the mind's outbox, and the
    intent is recorded and submitted on the closed turn as on an open one. It takes no `memory_notes`, `answer_in`,
    conductor pick, `conversation` or `continues` (400 `invalid`).
  - `context` (exact keys): `{route?: ≤120, experience?: slug, program?: app id, swarm_id?, mind?: <mind id>,
    with?: <mind id>, chosen?: true, selection?: [≤20 {kind, ref}], view?: ≤2 KB {refs?: [≤50 {kind, ref}], acts?: [≤50 act ids],
    summary?: ≤500}}`. The `kind` of a ref is one of `mind|swarm|goal|room|artifact|item|feature`.
  - `with` names the mind whose chat or card the person is using. When the hive's conductor answers the turn and
    nothing in `mind` or `selection` addresses a mind, the turn goes to that mind's swarm (its coordinator holds the
    thread, money and limits) and that mind speaks, named in `speaks_as`. A mind the person can't see, an external
    member, or a mind whose swarm the Ask may not use is passed over, and without the conductor `with` routes nothing.
  - `chosen: true` beside `mind` says the person chose that mind to answer: their pick in the Ask (a swarm's pick names
    its coordinator) or an `@Name` address. On a conductor turn the chosen mind speaks, named in `speaks_as`; a mind
    only named in the words is asked about, in the turn's usual voice. A chosen mind the person can't see, or one the
    Ask may not route to (another person's own mind among them), refuses the turn as `mind` does, so someone else never
    answers a choice. `chosen` other than `true`, or without `mind`, is refused `invalid`.
  - Refused field names: authority, model, money and credentials (for example `principal`, `agent_id`, `model`,
    `provider`, `budget_usd`, `to`, `coordinator_id`, `*_key`, `*token*`) get 400 `not_allowed`. Any other unknown
    key gets 400 `invalid`.
  - Idempotency is per `(person, operation_id)`. The same body returns the original turn, with no new quota, message or
    spend. A different body gets 409 `operation_conflict`.
- `GET /api/ask/{operation_id}?after=0&limit=100` is the recovery read: the turn view plus `events` (its frames in seq
  order, after `after`, at most 100), `next_after` and `more`. Only the asker can read it; anyone else gets 404
  `not_available`. Limited to 60 per minute.
- `POST /api/ask/{operation_id}/stop` closes an open turn as `refused/stopped`. A later reply from the mind still
  lands in the room. A conductor turn's loop is cancelled, so no further model call or act follows, and a result posted
  for one of its acts gets 409 `turn_closed`. Money (this holds for stop, thread end, the turn's time limit and shutdown
  alike): a model call is reserved first, then committed at httpcore's send_request_headers trace (after any wait for a
  pooled connection and after connecting), where the turn is read again: a call the close caught before then never
  reaches the provider and its hold is released. Dispatch = commitment to the in-flight call; at most this one
  already-authorised request may still be handed off after a stop commits, and it is settled at its real cost. No
  further model call or act follows it, and nothing retries or redirects it (the provider client has retries and
  redirects off). A committed paid call finishes apart from the loop, in its own window of up to 300 s (not the turn's
  remaining time), and is settled at its real cost. At shutdown no new conductor turn starts (an admitted one closes at
  once, spending nothing), running turns' loops are cancelled and joined, and every call they had committed gets up to
  10 s in all to settle before the provider client closes; the turns' rows then close by expiry, as on any restart.
  Best effort: a call that fails, outlasts its window or is still out at the end of that grace keeps its worst case
  held unknown, as any unknown outcome, logged once by turn and exception type; a failed shutdown drain is logged too.
- The person's own use of the page (a click, a scroll, a key that moves the page, Back) never ends a turn. The page
  holds the mind's moves of the page itself for the rest of that turn, until the person steers it: an `act` it is sent
  then is answered `stale_origin` and not applied, and a move the mind proposes becomes a Go card. The turn runs on to
  its answer. `POST /api/ask/{operation_id}/takeover` is posted only by a page loaded before this rule; it always
  answers 404 `not_available` and changes nothing, which such a page reads as nothing for the host to do.
- `GET /api/ask?limit=50` lists the caller's own turns, admins included.
- `DELETE /api/ask/threads/{thread_id}` is for the thread's owner only. It returns `{deleted, turns}`, and it:
  - ends the thread, which restores the cap and stops any open turn;
  - archives and empties its room;
  - removes the request and answer text from its turns, frames and hub messages;
  - resets the thread, room and bookkeeping task titles to `Ask with <mind>`.

  The turn rows stay, without text, for the audit. What the mind itself remembered is not erased.
  Deletion is a durable tombstone. A later reply in that turn's conversation (hub, `/api/agent/messages` or
  `hive_send`) is dropped before it is stored or published, including after a restart. Emptied outbox rows are not
  replayed to the mind.
- `GET /api/ask/audit?limit=100&principal=&before=` and `GET /api/ask/audit/{turn_id}?after=&limit=` are **admins
  only**. They return every person's turns (text, resolved context, state and frames). A personal mind's turn shows
  metadata only (ids, times, state, money, `acting_as`, content-free frames): the host keeps no words for it.
- `GET /api/me/ask` returns
  `{swarm_id, swarm: {id, name, orchestrator {id, name, status}} | null, thread_budget_usd, max_thread_budget_usd: 5, eligible: [swarm…], capabilities: {conductor: bool, memory: bool}}`.
  `capabilities` is the hive's on/off signal for the page and nothing else: `conductor` is `HIVE_ASK_CONDUCTOR=1`,
  `memory` is the conductor on and `HIVE_ASK_MEMORY=on` (memory_notes reach the model, and the `remember` tool exists).
- `PUT /api/me/ask` takes `{swarm_id? | mind_id?, thread_budget_usd?: >0 and ≤5}`. A `mind_id` is stored as its swarm.
  The swarm must pass the same gate as a turn.

**Turn view:** `{operation_id, turn_id, state: accepted|thinking|done|refused, reason, thread: {id, mind {id, name}, budget_usd, spent_usd, addressed}, text, via, context, addressed, answer_message_id, created_at, closed_at, turn_spent_usd, acting_as: {mind_id, name} | null, speaks_as: {mind_id, name} | null}`. `acting_as` marks a turn routed to the asker's personal mind, whose words stay in the browser. `speaks_as` names the mind whose voice answers. On a conductor turn routed through a swarm, the person's own mind may speak while `thread.mind` remains the coordinator used for routing and accounting. Clients without `speaks_as` use `thread.mind` for the name.
`addressed` is `{id, name}` of the mind the turn was addressed to, or `null`. On `thread` it is the addressed mind of
the thread's latest turn.
`turn_id` is global. `context` is exactly what the mind was given.

### Who answers

Routing follows Jon's ruling of 2026-10-05: "ask should be the orchestrator or owner of whatever mind you're talking
to". The answering mind is the coordinator (`swarms.coordinator_id`) of the first swarm in this order:

1. the swarm of the addressed mind: `context.mind`, or else the first visible mind in `selection`;
2. `context.swarm_id`;
3. the swarm of the `thread`'s coordinator;
4. the `/api/me/ask` default (an explicit choice: it wins over 5);
5. the asker's own **personal mind** (personal minds P2): the coordinator of their personal swarm (`GET /api/me/mind`).

The gate:
- A swarm that is unknown, hidden or archived is refused with `not_available`.
- The person must **participate** in the swarm: an admin, its owner, or named in its `shared_with`. Seeing a public
  swarm is not enough; otherwise `not_allowed`.
- The person must be able to see the coordinator; otherwise `not_allowed`.
- If there is no coordinator, or it was deleted, the result is `no_orchestrator`. The host never falls back to another
  mind.
- A personal mind answers its own person only: anyone else (an admin too) addressing it, asking from its page or
  choosing its swarm as their default is refused with `not_allowed`, and it is never in another person's `eligible`.
- With nothing to route by (no default and no personal mind), the result is `no_mind`.
- A turn routed to the asker's personal mind: with the conductor on, the conductor runs **as** it (its `model`, unless an
  admin's A/B pick; its usage rows and swarm; paid by the asker from their month allowance although its own cap is $0;
  allowance spent: 402 `spend_limit` at the call, the turn's `done` says `spend_cap`). It is never woken. With the
  conductor off it is never asked: asleep is `mind_asleep`, awake is `not_available` (the hub path would keep the
  words). Its own turns are never held copies.
- **A personal mind's turn keeps no content on the host** (Jon 2026-10-08: its memory and history live in the person's
  browser). Its turn row has no `text` and no `context` (`personal = 1`; ids, times, state, money and the body digest
  only); nothing is written to its thread's room or the hub; its frames are stored content-free, by allowlist: ids,
  phase, seq, time, host enums (`outcome`, `reason`, `state`, `op`), money, flags and digests; an act keeps `act_id`
  and `kind` only; `thread` its ids and money; `acting_as` its `mind_id`; `personal: true`. Everything else (words,
  routes, targets, refs, prefs, captions, labels, the refusal sentence) is dropped. The live frames to the person carry
  everything as usual. The question and page context reach the conductor in memory for that turn only. A steer on such a turn keeps
  its digest only. It still controls the hive: the conductor's `dispatch` and `POST .../intents` record (and the person sends) its intents as any turn's; the work handed over is a normal work item in the receiving swarm.
  Every read returns no content for it, to anyone: the turn views, the audit, event pages, and its thread's room (which
  reads empty to anyone but its person, admins included). A turn is read as personal by its mark or by its mind being
  a personal mind. At startup, a personal mind's turn written before r3 is marked and its content erased (text,
  context, frames to the allowlist, its thread's room messages, hub messages, steers, intent bodies), with
  `secure_delete` on and the WAL truncated after.

The addressed mind is passed only as context (`context.addressed`). It gives the coordinator no authority.

### Threads and spend

An Ask thread is a Session with `purpose: "ask"`:
- one active thread per (person, coordinator);
- a private room and a bookkeeping task, named from the first request (up to 200 characters, 80 for the room).
  A personal conversation keeps no request words: its title is "Ask with <mind>".
- The bookkeeping task has binding kind `ask.thread`, no assignee and no claim lease. It is omitted from task
  lists and task events. A mind cannot claim or finish it; ending the thread closes it as done.

The thread's cap is the coordinator's spend at creation plus `thread_budget_usd`. The default is **$0.25**, as Jon
decided on 2026-10-05. The person may raise it up to $5 without an admin. Session caps on one mind compose: the mind's total rule is min(the rule before any session, every
active session's cap). It is recomputed on every start and end, so the rule that was there before comes back exactly
whatever order the sessions end in. A rule set by anyone else in the meantime is kept. A session never raises a cap.
The model calls are paid through the existing payer chain (`Hive.payer_for`), bound to the turn:
- **One payer person per coordinator at a time.** A turn is refused with 409 `coordinator_busy` while another person
  has an open turn, or an active ordinary Session, on that coordinator.
- **Ordinary Sessions follow the same rule.** `POST /api/sessions` is refused with 409 `payer_conflict` while another
  person has an open Ask turn, or an active ordinary Session, on that mind.
- **Who pays.** While a turn is open, the coordinator's model calls are billed to its asker, through the actual gateway
  reserve and settle path. An Ask thread with no open turn pays for nothing: the coordinator's other work then falls to
  an ordinary Session's owner, the mind's owner, or the hive.
- **Approximate figures.** `spent_usd`, `turn_spent_usd` and the usage ledger's per-person attribution are
  approximate. They measure the mind's spend over a window, which includes anything else the coordinator did in it,
  such as its own goals, or late work on an earlier person's timed-out turn.

- A thread at or over its cap refuses the next turn with 402 `spend_limit`.
- `POST /api/sessions/{id}/end` ends the thread. Any open turn closes as `stopped`, and the next request starts a new
  thread. A thread with its own cap ends even while its mind has calls whose cost is not settled (Session close).

**One turn in flight per thread.** Another request gets 409 `ask_busy`, carrying the open turn's `operation_id`.
- A coordinator that is not `awake` or `starting` is refused with 409 `mind_asleep`. Ask never wakes it.
- A turn with no answer within 120 s (`HIVE_ASK_TIMEOUT_SECONDS`) closes as `timed_out`, or as `spend_limit` if the
  thread's cap is spent.
- Rate limit per person: 10 turns per minute and 300 per day, enforced inside the admission transaction.
- The per-person admission lock is never held across an await. The thread is created between two short locked steps.
  An Ask thread that exists without a turn, left by a race or a crash, is adopted by the person's next turn, or ended
  after 10 minutes.

### Delivery and the answer

Admission is a single transaction: the turn row, the person's message in the thread room, the coordinator's hub-outbox
message and the `accepted` frame. A mind that is offline gets the message on reconnect, and it is never posted twice.
The coordinator receives the text in conversation `ask:<turn_id>`, with `ask: {turn_id, reply_in, label, context}` in
its envelope. The context holds names, ids and statuses the person may see:
- unknown or hidden refs are dropped silently;
- app items are dropped;
- a view's `summary` is dropped.

The coordinator's ordinary reply in that conversation (a hub `agent_message`, `POST /api/agent/messages` or MCP
`hive_send`) answers the turn: it lands in the room, and the turn closes `done`. A reply to a turn that has already
closed stays in the room and never answers a newer turn. Messages in any other conversation answer nothing.

### Event `ask` on `/api/events`

`{type: "ask", operation_id, turn_id, principal, seq, phase, ...}` is delivered **only to the asker**; this check runs
before the admin bypass. Admins read other people's turns in the audit routes. Frames are stored before they are
published, and the recovery read returns the same sequence.

| phase | fields |
|---|---|
| `accepted` | `thread {id, mind{id,name}, budget_usd, spent_usd}`, `acting_as: {mind_id, name} \| null`, `speaks_as: {mind_id, name} \| null` (as the turn view) |
| `thinking` | `step` (the mind's `agent.thinking` phase), only for a model call billed to this turn's asker while it is the coordinator's only open turn. At most 64 frames per turn: when the cap is reached, one last `thinking` frame with `truncated: true` and `step: ""` marks that later ones were not kept |
| `answer` | `text` (cut once to 8000 characters, as is the room copy), `message_id` |
| `done` | `spent_usd` (the thread), `turn_spent_usd` (approximate: the mind's spend delta over the turn), `outcome: "answered"` |
| `refused` | `reason` (`timed_out`, `stopped`, `spend_limit` or `not_available`), `say`, `spent_usd`, `turn_spent_usd` |

Asker-only frames, with admins using the audit list, is Jon's decision of 2026-10-05. The same asker-only rule,
checked before the admin bypass, covers every live event that carries Ask content:
- `message` frames in an `ask:<turn_id>` conversation: the request, and the mind's replies;
- `agent.trace` frames, by an audience the host fixes when the trace is created and stores (`ask_trace_scopes`). It is
  never re-judged at delivery.
  - **Candidate source turns.** Every Ask turn the mind has served that no context boundary has cleared: turns that
    are open, or that closed at or after the mind's last fresh start.
  - **The only boundary** is owner evidence of a genuinely new execution. `Supervisor.start` (from Hive lifecycle
    `start`/`wake`, hive boot or a reconcile restart after a crash) records it only when the driver's start returned
    and the driver then reports a running execution whose identity differs from the one before. The identity is the
    local process id and start time, or the Docker container id and `StartedAt`. It is recorded in `ask_boundaries`
    with that identity.
    - A start that found the mind already running (the drivers return early) is not a boundary, and neither is a
      start that failed.
    - An open turn is never cleared by a restart, because its work resumes from the outbox.
    - **A trace keeps the execution that sent it.** `POST /api/agent/trace` pins the mind's boundary sequence when the
      request is authenticated, before any await or worker-thread hop. The pin is never read from the body. A trace
      stored after a newer boundary is still judged with the turns that were uncleared when it entered, so a request
      from an old execution never gets the new, wider audience.
  - **Not boundaries:** elapsed time, model calls, a stop or a sleep on their own, a no-op or failed start, and a
    queued memory reset.
  - **One asker.** If the candidates all belong to one asker and none was deleted, the trace goes live only to that
    asker.
  - **Uncertain.** Several askers, a deleted turn, or an error deciding: the trace goes live to nobody. Admins keep
    HTTP audit.
  - **No candidates:** the ordinary rules (admins, and people who can see the mind).
  - **So:** a coordinator that has served an Ask keeps its live traces private until it is restarted.
  - **Limit:** content the mind wrote to its long-term memory survives a restart. That memory remains its own.

Contentless notices (`room`, `goal.updated` with the neutral title, `agent.thinking`) still follow their own rules.
Over HTTP, admins can read the thread's room and the mind's traces as audit.

**Remaining limit.** A coordinator's traces, and its memory of the request, can be read over HTTP by anyone who may
read that mind's traces.

### Steering an open turn

`POST /api/ask/{operation_id}/steer {steer_id: [A-Za-z0-9_.:-]{4,112}, text: 1–4000 chars, at_seq: integer ≥ 0, via?: "typed"|"voice"}`
(the Ask person gate; requester only, else 404 `not_available`). `via` defaults to `typed`, is recorded, and any other value
is 400 `invalid` with nothing written. Idempotent on `(person, steer_id)`: the same body answers the same result, another
body is 409 `operation_conflict`.
- **Open turn:** the words join it as the person's message in the thread room, are delivered to the coordinator in the
  turn's own conversation (`extra.ask.steer = {steer_id, at_seq, via}`), and an asker-only frame
  `{phase: "steer", steer_id, text, at_seq, via}` is stored when the turn's shared frame quota has a place (else `seq`
  is null; the words still reach the room and the mind). No new turn and no new budget. At most 20 per turn (429
  `rate_limited`); `at_seq` beyond the turn's last frame is 400 `invalid`. **202**
  `{steer_id, operation_id, turn_id, new_turn: false, seq, via}`.
- **Closed turn:** the words start a fresh turn, `operation_id` `"steer:" + steer_id`, in the same swarm, with the same
  `via` (never dropped). The steer_id is first bound to its source turn and its whole body (`text`, `via`, `at_seq`);
  reuse on another turn or with any changed field is 409 `operation_conflict`. That binding answers first, so the same
  body replays the same fresh turn even after the source turn's thread is deleted. **202** `{steer_id, operation_id, turn_id, new_turn: true, thread, state, via}`. Refusals are
  `POST /api/ask`'s.

### Conductor memory: kept by the person's browser

Jon, 2026-10-07: "keep the memory local on the browser side and put cloud hosted memory coming soon". The host keeps
**nothing** about the person: no store, no memory routes (`/api/me/ask/memory` does not exist), no memory data dir.
Applies only to conductor turns (`HIVE_ASK_CONDUCTOR=1`).

- **Recall (input).** `POST /api/ask` may always carry `memory_notes`: at most 20 entries, each a
  non-empty string or `{id: [A-Za-z0-9_-]{1,64}, text}` (ids distinct, chosen by the browser), at most 8 KB in all
  (UTF-8, ids and texts). Anything else is 400 `invalid`, whatever the switches. With the conductor or
  `HIVE_ASK_MEMORY` off they are accepted and ignored: they go nowhere (not to the coordinator) and nothing is logged.
  With both on they are used in that turn's model context only (the model sees `[id] text`), never stored or logged. A note whose text or id names a private app (Atlas, OmegaTruth, Truth;
  the conductor's canonical fence) never reaches the model. A text holding half a character (a lone surrogate, which a
  page cutting an emoji in two would send) is not text: 400 `invalid`.
- **The conversation so far (input).** Jon, 16 Nov: "context and continuity are consistently persistent regardless of
  which model you interact", "without needing additional LLM calls to pass through convo". `POST /api/ask` may always
  carry `conversation`: the person's latest Ask exchanges as their browser keeps them, oldest first, at most 8, each
  exactly `{said, answer, by, at}` (non-empty `said` and `answer`, `by` the id of the mind that answered, `at` the
  browser's epoch ms, a number >= 0), at most 8 KB in all (UTF-8: words, answers and ids). Anything else is 400
  `invalid`, whatever the switches. It is continuity, not learned memory: on every conductor turn, with
  `HIVE_ASK_MEMORY` on or off and whichever mind answers, the model reads it as one transcript, each exchange with how
  long ago it was and who answered (`you` for the mind answering now, a mind the asker may see by its name, their own
  mind as theirs, anything else "a mind"). A turn reads only the exchanges its answer may show (Jon on #346: "carry
  own-mind exchanges only into turns that keep no words on the host, and limit swarm turns to exchanges answered by
  minds in that swarm"): a turn as the asker's own mind keeps no words on the host and reads them all; any other turn
  keeps its answer in its swarm's thread and reads only those a mind of that swarm answered (not anyone's own mind),
  so what the person said with their own mind, with another swarm's mind or with an id the page made up is left out.
  An exchange naming a private app never reaches the model; it is never stored, and the log has a count and a digest
  (and how many were left out). With the conductor off it is accepted and ignored.
- **Their own chat with the mind (input).** A conductor turn also reads the person's own chat with the mind that
  answers (its conversation `c_<mind>~<person>`, the hive's own copy): the latest 8 messages they and the mind said
  there, oldest first, each cut at 400 characters and the whole at 4 KB, with how long ago. A hive note, a message kept
  for the mind alone, Health's question and every room are left out. It follows the conversation's rule (Jon on #347):
  a turn kept in a swarm's thread reads it only when the mind that answers is one of that swarm's own minds, so a swarm
  turn that speaks as the person's own mind reads nothing of their chat with it, and that mind is told that what they
  said with it alone stays private unless they say it in the swarm. The other way, the person's next message in that
  chat carries what the mind has not heard of the Ask (`POST /api/agents/{id}/messages` `from_ask`).
- **Learning (output).** `HIVE_ASK_MEMORY=on` (off by default; any other value is off) gives the model a `remember`
  tool: `{statement: 1–500 chars, kind: preference|name|place|person|project|correction, confidence?: 0–1 (default 0.8),
  revises?: note id}`. Each accepted call is one asker-only frame
  `{phase: "memory", op: "remember"|"revise", item: {statement, kind, truth: {frequency: 1.0, confidence}}, target_id, digest}`
  (plus the usual `operation_id, turn_id, principal, seq`). `target_id` is `revises` when that id was among this
  turn's (fenced) notes, else null (any other id is dropped); `op` is `revise` exactly when `target_id` is set. The
  confidence is kept within 0.01–0.99.
  - **Live only.** The frame with `item` and `target_id` is published on `/api/events` to the asker only (admins
    included in the exclusion). The stored copy in the turn's sequence (the recovery read `GET /api/ask/{op}`, the
    admins' audit) is `{phase: "memory", op, digest}` with no item: a page that missed the live frame cannot recover
    the item from the host.
  - **Caps.** At most 8 memory frames per turn (then `{ok: false, reason: "memory_cap"}`); each call counts against the
    32-act cap and each frame against the turn's shared frame quota (no place: `{ok: false, reason: "not_sent"}`, and
    nothing is sent). A statement naming a private app is `{ok: false, reason: "private"}`, with no frame; a malformed
    call is `invalid`. The model's tool result on success is `{ok: true, op, target_id, truth}`.
  - **Logs** carry a count and a digest per turn, never the content.
  - **Thread deletion** blanks a stored memory frame's `op` and `digest`.

### Intents and links (linkage r3.6 §(a), slice 2)

Code: `hive/core/ask_intents.py`. An intent is the host's custody of one exact r2.13 body for one Ask turn; it adds no
authority. Its key `request_operation_id` is `"ask." + intent_id`, host-derived, so `POST /api/requests` refuses any
`operation_id` starting `ask.` (400 `operation_reserved`). States: `pending | dispatching | linked | refused | abandoned`;
at most one `pending`/`dispatching` intent per turn. The request exists if and only if the intent is `linked`.

**Hygiene (§G) on every route below:** on POSTs, first, an exact `Origin` from the origin of HIVE_PUBLIC_BASE (if set), the origin of
HIVE_PUBLIC_URL (`settings.public_url`, e.g. the cloud's tunnel address `http://127.0.0.1:8710`),
`http://127.0.0.1:<HIVE_PORT>` or `http://localhost:<HIVE_PORT>` (403 `origin_required` / `origin_refused`, checked
before any session lookup or body read; the set is fixed when the app is built, and either address setting that is set
but is not an http(s) URL with a host, or a HIVE_PORT that is not an integer from 1 to 65535, stops the hive from
starting); then `Authorization: Bearer` only (no `?token=`, no
cookie: 401 `unauthorized`); `Content-Type: application/json` (415
`bad_content_type`); bodies capped at 48 KB (record) and 1 KB (submit, abandon, links), else 413 `request_too_large`.
Record, submit and links need a named signed-in **admin** person (403 `person_required`); abandon and the reads need the
Ask person gate. Anything not the caller's own is 404 `not_available`.

| Route | Body | Answer |
|---|---|---|
| `POST /api/ask/{op}/intents` | `{kind: "code.request", request: <the r2.13 body without operation_id>}` | 201 IntentView (new), 200 IntentView (the same body as the turn's pending intent) |
| `POST /api/ask/intents/{intent_id}/submit` | none (or `{}`) | exactly the recorded r2.13 answer: status 201 and body `{request_id, receiving_goal, lease_id, state: "accepted", budget: {root, limit_usd}, until}`, byte for byte as `POST /api/requests` recorded it; every replay returns the same status and bytes (after expiry, cancel, a `links_rev` change or thread deletion). The intent's current state is read with the GET routes |
| `POST /api/ask/intents/{intent_id}/abandon` | none (or `{}`) | 200 IntentView (`abandoned`) |
| `POST /api/ask/{op}/links` | `{request_id}` (the caller's own direct request, in any swarm: links are cross-swarm and grant nothing; anyone else's 404) | 201 new, 200 already linked: `{operation_id, turn_id, request_id, to_swarm, intent_id, state: "linked", links_rev}` |
| `GET /api/ask/{op}/links` | | `{operation_id, turn_id, links_rev, links: [Link], intents: [IntentView]}` |
| `GET /api/ask/intents?state=&limit=50` | | `{intents: [IntentView]}`, the caller's own, newest first; `limit` 1–50 |
| `GET /api/ask/intents/{intent_id}` | | IntentView |

- **IntentView:** `{intent_id, turn_id, kind, state, request_operation_id, request_digest, destination: {to_swarm, task_id,
  workspace_id, repository_id}, title, instruction, instruction_digest, budget: {limit_usd}, until, last_dispatch:
  {dispatch_id, outcome: refused|not_committed|not_committed_restart, code, at} | null, last_refusal: {code, status, at} |
  null, dispatch_id, dispatch_started_at, request_id, lease_id, receiving_goal, deleted, links_rev, created_at,
  updated_at}`. After the thread is deleted the body is blanked: `title`, `instruction`, `budget` and `until` are null;
  ids and digests stay.
- **Link:** `{intent_id | null, request_id | null, state, to_swarm, last_refusal}`. `GET /api/ask/{op}` and
  `GET /api/ask/audit/{turn_id}` also carry `links` and `links_rev`.
- **Lifetime:** `lifetime.until` is clamped to the turn's creation + 24 h (the stored body, the digest and `until` carry
  the clamped time, millisecond `Z`); a clamp already past is 400 `turn_too_old`.
- **Record refusals:** 400 `bad_request` (unknown or authority keys, an `operation_id` inside `request`, any r2.13 shape
  failure, a turn more than 24 h old with `reason: "turn_too_old"`); 409 `intent_pending` (another body is pending, with
  its `intent_id`); 409 `intent_in_flight` (the turn's intent is dispatching). A `refused` predecessor becomes `abandoned`
  in the same transaction; a `linked` one stays and the new intent gets a new key.
- **Continue:** recording on a turn with `continues` follows its ancestors while each is within its 24-hour window.
  A `pending`, `dispatching` or `linked` ancestor intent with the same kind and destination returns 409
  `intent_already_handed_over`, without creating another intent. Refused and abandoned intents do not block.
  The destination is `{to_swarm, task_id, workspace_id, repository_id}` for `code.request` and `code.test`,
  `{to_swarm, maker_id, program_id}` for `studio.session`, and `{to_swarm}` for `research.request`.
  The conductor tells the person it is already handed over (or waiting for their go when pending), and tells the mind
  not to retry that hand-over. A typed request without `continues` is unaffected.
- **Submit:** claims `pending`/`refused` → `dispatching`, then calls the r2.13 admission with a link inside its
  transaction. Settling reads the row, then this key's operation record: if a matching record exists (a raced winner)
  the intent links from it and answers it. Otherwise a refusal from the admission is returned unchanged (r2.13.1 codes)
  and the intent becomes `refused`, except 409 `operation_conflict`, which, like any other failure, returns it to
  `pending` (`last_dispatch.outcome: "not_committed"`). 409 `intent_in_flight` while another
  submit holds it; 409 `intent_closed` once abandoned or deleted.
- **Abandon:** 409 `intent_in_flight` while dispatching; 409 `intent_linked` once linked (cancel the request instead).
- **Integrity:** a linked intent without its operation record, or an unlinked one with a record, is logged and answered
  409 `operation_conflict`, and nothing changes. It is checked on submit, abandon, every read that returns an intent
  or its link state (`GET /api/ask/intents`, `GET /api/ask/intents/{id}`, `GET /api/ask/{op}/links`, `GET /api/ask/{op}`,
  `GET /api/ask/audit/{turn_id}`; one inconsistent intent makes the whole read 409), a record that would return the pending intent, and a record that would abandon a `refused`
  predecessor.
- **Frames:** asker-only `ask` frames `{phase: "intent", intent_id, state, links_rev}` (plus `dispatch_id` or
  `request_id` where known), and `{phase: "link", request_id, links_rev}` for a direct link. They are hints under the turn's one shared quota (64 frames; while the turn is open, steer
  and intent frames stop at 62 so answer and done always fit; thinking stops at 60). A dropped frame is never the record.
  Refetch the link view whenever `links_rev` advances and on every reconnect.
- **Thread deletion:** `pending`/`refused` intents become `abandoned`; every intent body is blanked; a `dispatching` one
  keeps its key and state (a commit still links). The request is never cancelled by a deletion.
- **Startup:** the §L recovery's step 2 moves a `dispatching` intent left by a previous process to `pending`
  (`not_committed_restart`), or to `abandoned` if its thread was deleted.

### Tasks from Ask (`task.create`)

`POST /api/ask/{op}/intents` also accepts `{kind: "task.create", request: {title, instruction}}` from the turn's
own named person, members included. Title is plain text up to 120 characters; instruction is plain text up to
2000 characters. Extra fields are refused. The host derives the destination from the mind whose voice answers
that turn, checks that the person can see and participate there, and rechecks it on admission.
The conductor sends this kind at once. Task creation, its assignment to that mind, the operation receipt and
the linked intent commit together. Submit returns the recorded 201 `{request_id: null, lease_id: null,
receiving_goal, state: "accepted"}`; replay creates nothing. The normal assignment notice is sent after commit.
Deleting the Ask thread does not cancel the created task.

### Stopped tasks

- `GET /api/me/task-stops` returns `{stops: [{id, goal_id, mind_id, title, status, reason, stopped_at}]}`,
  oldest first. It returns only the caller's unacknowledged receipts, including for an admin. A stopped task
  remains here after reopening or removal of its holding mind. `mind_id` is the holder, else the assignee,
  when it stopped, or null if neither existed.
- `POST /api/me/task-stops/{id}/acknowledge` returns `{ok: true}`. It is idempotent for the receipt's person.
  A missing or another person's receipt returns the same 404. Acknowledgment hides that receipt in both Ask
  and the holding mind's chat; a later stop gets a new receipt.
- Every failed or stalled transition records its cause in the transition's transaction. Causes cover a mind's
  failure reason, a person marking work stopped, a deadline, repeated expired claims, repeated reviewer returns
  failure to start a researcher, and a mind that stopped answering after its replies kept being refused. Research
  tasks resolve their requester through the request record.
  A mind's failed result needs a nonempty explanation, otherwise it is 400 `no_result` and stays claimed.
  An automatic stop also keeps its cause sentence in the task result when there is no further detail.
  A manual status change with no explanation says explicitly that none was recorded.
  Ordinary task creation records its authenticated creator; older tasks recorded as the local operator cannot
  be attributed to another person retrospectively.
- These receipts are for people. They send no mind message, wake no mind, and create no model call.

### Research requests (`research.request`, `hive/core/research.py`)

Any named person (members included) may record and send one. The body is exactly `{kind: "research.request", request:
{title (1–120 characters), instruction (1–2000)}}`; any other field (an id, a swarm) is 400 `bad_request` (`reason:
"bad_fields"`). Research always goes to the hive's Research swarm, found by its foundation binding (private to the
hive's owner and admins). On submit the host creates a `research` request from the turn's swarm, its task in that swarm
and a lease for that one request (issued by the hive's owner), then spawns a fresh researcher from
`foundation.researcher.v1` for it: no memory, a brief naming only its task as its first prompt (it reads the title and
question with `hive-goal-get`, so the person's words never travel in a message), the request's whole budget as its
allocation and hard cap, the task's assignee. Its role denies every skill but `web-search`, `web-fetch` and
`hive-goal-get/claim/propose/heartbeat/fail`, and those task tools reach only its own task (a person's rule still
decides). The swarm's coordinator is refused every skill and sees no task; its controller authority (spawn, prompt,
control) is the host's alone. A researcher of research asked from another person's personal mind is hidden from an
admin's default view (its messages, traces and message reads) unless they audit, and its messages, prompts, search
queries and memory are erased when it is retired. When the task ends (done, failed, cancelled, or failed at its deadline) the researcher is retired:
lease ended, allocation released, role rules removed, the mind stopped and deleted. Defaults: budget
`HIVE_RESEARCH_BUDGET_USD` ($0.25), lifetime `HIVE_RESEARCH_MINUTES` (30), the swarm's month cap `HIVE_RESEARCH_MONTH_USD`
($5, or a lower month rule on that swarm). The submit answer is `{request_id, receiving_goal, lease_id, state:
"accepted", budget: {root, limit_usd}, until}`. The Ask conductor sends a research intent as soon as it records it.
Refusals: 409 `research_turn_used` (one per Ask turn), 409 `research_busy` (three running per person), 402 `spend_limit`
(`reason: "member_allowance"`: the person's day, month or total limit, counting their spend plus what their research
reserves; `reason: "research_budget"`: the Research swarm's month cap), 404 `not_available` (`reason:
"no_research_swarm"` or `"web_off"`), 409 `not_available` (`reason: "no_researcher"`).

The researcher finishes with a report of the task's result schema: `{summary, sections: [{heading, claims: [{text,
citations: [{url, fetched_at, title?, quote?}]}]}], open_questions?}`. The host matches each citation against the final
addresses of that researcher's successful `web-fetch` calls between its claim and its result (the web audit keeps
scheme, host and path): `exact` when neither the citation nor that fetch had a query or fragment, `path` when one did (the audit keeps
neither); a claim with no match is uncited. The checked report reaches the asker as an asker-only `ask` frame `{phase:
"research", intent_id, request_id, state, research: ResearchView}` on the asking turn (stored content-free on a personal
turn) and through:

| Route | Who | Answer |
| --- | --- | --- |
| `GET /api/research?limit=50` | a named person | `{research: [ResearchView]}`, the caller's own, newest first (`&all=1`: everyone's, admins only; research asked from another person's personal mind is hidden unless `&include=personal`) |
| `GET /api/research/{request_id}` | the asker, or an admin | ResearchView; anyone else 404 |

ResearchView: `{request_id, title, state: working | done | failed | cancelled, report: null | {summary, sections:
[{heading, claims: [{text, cited, citations: [{url, fetched_at, match: exact | path | null, verified, audited_at?,
title?, quote?}]}]}], open_questions, checks: {claims, cited, uncited, path_matched}}, by: {mind_id, name} | null,
created_at, finished_at}`. An admin's default `GET /api/swarms/{research swarm}/goals` hides tasks asked from another
person's personal mind the same way.

## First Light (onboarding), host round R1a

The host side of the onboarding journey (plan: `PLATFORM_ONBOARDING_PLAN_R1.md`). Source:
`hive/core/onboarding.py`. Every route here acts only on the signed-in **person** (a `people` row, `user:u_…`, enabled):
the loopback operator, a family sign-in without a people row and a disabled person get 403 `person_required`; a mind's
token or no session gets 401. No route takes another person's id, admins included.

Refusals are `{"error": {"code", "message", …}}` with a host-written `message` the page can show as is.

### Progress: `GET` · `PUT` · `PATCH /api/me/onboarding`

Kept on the host per person, so it survives sign-out and follows them to any device.

```
{record: "first-light.progress/1",
 status: "not_started" | "in_progress" | "finished" | "skipped",
 current_beat: Beat | null, beats_done: Beat[], beats_skipped: Beat[],
 role_path: "admin" | "coder" | "researcher" | "explorer" | null,
 monthly_spend_usd: number | null,        // what the person chose (0-10000); it sets no limit by itself
 key_choice: "own-key" | "hive-keys" | null,
 started_at, finished_at, updated_at,     // host-stamped ISO times (null until set)
 version: int,                            // 0 before the first write; +1 on every write
 beats: Beat[], role_paths: string[]}     // the shared lists, in journey order
Beat = "arrive" | "look" | "models" | "tools" | "apps" | "ask" | "tour" | "hello"
```

- `GET` returns the person's record, or a blank one (`status: "not_started"`, `version: 0`).
- `PUT` replaces it: the writable fields `{current_beat, beats_done, beats_skipped, role_path, monthly_spend_usd,
  key_choice, status}` come from the body and anything left out returns to blank. `PATCH` changes only the fields given.
- Either may carry `version`: the version the write was made against. A different current version is refused with
  409 `stale_onboarding` and `current: <the record>`, and nothing is written. Without `version` the write is unconditional.
- Any write moves `not_started` to `in_progress`. `started_at` is stamped by the first write and never moves;
  `finished_at` is stamped when `status` becomes `finished` or `skipped` and cleared when it goes back to `in_progress`.
- `beats_done` and `beats_skipped` are returned in journey order without repeats; a beat in both is refused.
- 400 `invalid` for an unknown field, an unknown beat or role path, a bad number or `status: "not_started"`; the whole
  write is refused. 413 `too_large` above 4 KB.

### The setup list: `GET /api/me/setup`

Derived on every read from the live state behind each item; nothing about it is stored.

```
{items: [{id, label, done: bool, optional: bool, route: "#/…", detail: {…}}], done: int, total: int, complete: bool}
```

| `id` | `done` when | `detail` |
|---|---|---|
| `provider_key` | the person owns a model key, or their progress says `key_choice: "hive-keys"`, or they are a guest (the host's key pays), or their personal mind thinks with free inference | `{own_keys, choice, guest, free_inference}` |
| `monthly_limit` | their progress has a `monthly_spend_usd`, or their personal mind thinks with free inference (nobody's money to limit); for a person with keys of their own, their own limit on them is set; for a guest, always | `{chosen_usd, allowance_usd, allowance_origin, enforced_by, free_inference}` (the limit in force, read live); own-key and guest shapes below |
| `ask_prefs` | they have saved Ask preferences (`PUT /api/me/ask`) | `{}` |
| `mind_awake` | their personal mind has started at least once (`last_active_at` set) or is awake or starting | `{mind_id, status}` |
| `outside_tool` (optional) | a harness invite they made has been redeemed and its member still exists | `{joined}` |
| `onboarding` | their progress `status` is `finished` or `skipped` | `{status}` |

The `monthly_limit` item also carries `enforced: bool` at its top level. It is true when a month limit really caps
the person's hive-paid spend at call time: their own `person:<id>` month rule (`enforced_by: "rule"`), or the member
default `HIVE_MEMBER_MONTHLY_USD` (`enforced_by: "member-default"`). It is false for an admin with no month rule, who
has no allowance (`enforced_by: null`). `chosen_usd` alone never enforces anything, and spend on a person's own key is
outside the allowance either way.

Own hive H1 (see "Own hive" below) changes the item for two kinds of person; everyone else's is exactly as above:
- **A person with keys of their own** (any key whose `owner` is them): the item reads their own monthly limit on all their
  keys (`PUT /api/me/key-limits/self`). `done` and `enforced` are true once it is set; `detail` adds
  `{enforced_by: "own" | null, limit_usd, spent_usd, set_route: "PUT /api/me/key-limits/self"}`, and `allowance_usd` /
  `allowance_origin` mirror `limit_usd` / `enforced_by`. The label is "Choose how much your own minds may spend a month".
- **A guest** ("use my hive"): the item reads the limit the host set on the invite, as raised by any approved request.
  `done` is true; `enforced` is true while the grant is live; `detail` adds `{enforced_by: "invite", limit_usd, spent_usd,
  host_name, ask_route: "POST /api/me/limit-requests", pending_request: {id, amount_usd, created_at} | null}`. The label
  is "Your monthly limit from your host".

`total` and `done` count the required items only; `complete` is true when every required item is done. `route` is the
page that fixes the item (`#/first-light…` is the journey Surface builds in R2).

### Wake and greet: `POST /api/me/personal-mind/hello` · `GET /api/me/personal-mind/hello`

`POST` wakes the person's own personal mind (`GET /api/me/mind`; made first if it is missing) through the ordinary
lifecycle wake, then sends it one hive note, sender `hive:first-light`, in the person's own conversation with it
(`c_<mind>~<principal>`, the chat the page opens). The note asks the mind to greet the person by name, in its own words,
with one first suggestion based on their `role_path` and the apps switched on in the hive. The mind answers through the
ordinary message path, on its own model, paid as a personal mind's calls always are (its person, from their monthly
allowance or their own key), under every limit on the model route.

```
{mind: {id, name, status}, conversation_id, message_id, requested_at,
 state: "waiting" | "greeted", greeting: {id, text, created_at} | null, created: bool, retryable: bool}
```

- **Once per person and mind.** A repeat returns the first hello with `created: false`. It wakes nothing and sends
  nothing. Once the mind has answered, `greeting` is the mind's own first message (sender `agent:<mind>`) in that
  conversation after the note.
- **A claim never sticks.** The hello is claimed before the wake; the claim records `requested_at`.
  - If the call is interrupted before the note is sent (an error, or a cancelled request), the claim is released.
  - If the note was already stored when the interruption came, it is adopted as the hello's note instead.
  - A claim left unsent by a crash is shown as `state: "waiting"`, `message_id: null`. Once it is older than 180 seconds
    it shows `retryable: true`, and the next `POST` retries it.
  - Before any retry, a First Light note already in the conversation is adopted, so the note is never sent twice.
  - Each claim carries a token: the request that made it. A retry that replaces a stale claim takes it over with a
    new token.
  - A request stores the note only if, at that moment, its token still owns an unsent claim and no First Light note
    is in the chat. That check, the note's insert and the stamp of `message_id` are one transaction.
  - So an original request that resumes after its claim was retried sends nothing, overwrites nothing, and returns
    the current hello (`created: false`).
  - Releasing an unsent claim is scoped to the token, so a superseded request never removes its successor's claim.
- `GET` returns `{hello: <the shape above> | null}`, including a hello still waiting to be sent; it is null only when
  none was asked for the person's current mind. It never wakes or sends; it may record a note already in the chat as
  the hello's.
- **Before waking anything**, the host checks, without side effects, that the mind could make a call. If not, it
  refuses and nothing is woken or sent:
  - 409 `no_model`: the model is unknown or has no price;
  - 403 `egress_refused`: the mind's swarm keeps its thinking on this machine (`HIVE_LOCAL_ONLY_SWARMS`) and its model
    isn't a local one;
  - 402 `no_key`: there is no key for the model;
  - 402 `no_budget`: there is no allowance to pay from, for example an admin with no monthly rule;
  - 402 `spend_limit`: a limit would be crossed (`period`, `limit_usd`, `spent_usd`);
  - 402 `hive_limit`: the hive's hard cap.
  The model route still applies its own checks to every real call.
- 409 `cannot_wake`: the wake was refused (for example, the mind cannot run here). Nothing is kept, and a later call
  may try again.

### Outside CLIs: Kimi, join steps and billing

- `GET /api/harnesses` (any signed-in caller) → `{harnesses: [{id, label, billing: ["own-subscription", "hive-keys"],
  default_billing: "own-subscription", setup: [{label, text}]}]}`. The ids are `claude-code`, `codex`, `hermes`, `kimi`
  and `mcp`. `setup` holds the join steps with `{url}` and `{code}` left as placeholders.
- `POST /api/harness-invites` (admins) takes `{harness, name, swarm_id, role_id?, ttl_minutes?, billing?}` →
  `{id, harness, harness_label, name, swarm_id, role_id, created_by, created_at, expires_at, redeemed_at, agent_id,
  revoked_at, status, billing, code, mcp_url, local_url, setup}`. `setup` holds the steps filled in with `mcp_url` and
  the one-time `code`; the code is shown only here. An unknown `billing` gets 400 `bad_billing`.
- `GET /api/harness-invites` and `GET /api/harness-invites/{id}` (admins) show `billing` on each invite. An invite
  made before `billing` existed reads as `own-subscription`.
- `GET /api/harness-invites/refused` (admins) → `[{at, why, invite}]`, newest first: the connections to `/mcp` the hive
  refused since it started, at most the last 100, kept in memory only. `why` is the matching invitation's status
  (`revoked`, `expired` or `connected`) with `invite: {id, name, harness_label}`, or `unknown` (a code the hive never
  issued) or `no_code`, with `invite: null`. The code itself is never kept.
- `billing` records who pays for the harness's thinking. An outside member always thinks on its own model, in its own
  process, and the hive meters only calls made through its own model route. So today `billing` is a label people
  read, and it changes no limit.

## Own hive, round H1 (`hive/core/ownhive.py`)

Plan: `PLATFORM_OWN_HIVE_CONNECTIONS_PLAN_R1.md` (Jon approved it 2026-10-13). A hive is one
person's hive: it has one owner, each person owns their keys and sets limits on them, things are public or private, and
a newcomer with no keys can be invited to use the hive. Nothing here crosses to another hive: connections (H2), grants
over them (H3) and moving out (H4) come later. Every change is additive and keeps today's access.

**The owner.** One row (`hive_owner`). An existing hive is migrated on first use: the earliest-created enabled admin
becomes the owner (`via: "first-admin"`), stored. Until a hive has a named admin, the loopback operator
(`user:operator`) is its owner and nothing is stored, so the first admin to arrive becomes the owner. Admins keep every
right they had, including demoting or disabling the owner. Owner only: hive visibility and pays, `pays: "hive-key"` on any
mind or swarm, "use my hive" invitations. **Recovery (H1.1):** when the stored owner is disabled, no longer an admin or
gone, `POST /api/hive/own/claim` lets an enabled admin claim the hive for themselves, or the operator hand it to a named
enabled admin (`{to}`); 409 `owner_present` otherwise. Each claim is written to `hive_owner_log` and the hive log.

**Limits on your own keys** (`key_limits`). A key's owner is its `owner` when that is a person; the hive's own keys (its
environment keys, the old operator-set keys) and a call with no key belong to the hive owner. A key owner sets:
- an **own limit**, `grantee: "self"`: a month limit on their own use of that key, or of all their keys (`key_id: "*"`);
  the hive owner's own use includes the hive's minds that belong to no person;
- a **grant**, `grantee: "user:u_…"`: a month limit on that person's use of the key (or all their keys), with an optional
  `ends_at`. A grant replaces the member default (`HIVE_MEMBER_MONTHLY_USD`) for that person on that owner's keys. The
  member default, and admin-set `person:<id>` rules, stay as the compatibility fallback for people with no grant.

Both are enforced at call time inside `Budgets.applicable` / `Budgets.check` as scope `keyuse:<16 hex>` (H1.1: one scope
per key owner, key or `*`, and grantee, the `scope` of the `key_limits` row), period `month`, origin `own`, `grant` or
`invite`: admission refuses with 402 `spend_limit` (`details.scope: "keyuse:…"`, `details.rule` the origin). Every
paid call's reservation records the scopes it falls in whether or not a limit exists yet, so a limit made, revoked or
remade later still counts calls admitted before it. Spend counted: this month's usage on the key (or the owner's keys)
recorded under that grantee (`usage.key_grantee`, set at record time by the same rule that admits the call, so Ask
turns, sessions and media count where they were held; rows from before H1.1 by their `payer`).

Whose scope a call falls in (`OwnHive.grantee_for`): the key owner's own (`self`) for the owner, a hive mind, anyone who
is not a named person, and anyone from before H1 with no grant from that owner; else the person (a grant, a guest, a
public visitor).

**Who pays: unchanged for everyone from before H1 (H1.1).** A call on a person's key that is for a guest, a public
visitor or someone the key's owner granted is paid by that person, not on their own key (`Hive.payer_for` → `(them,
false)`), so the grant (or visitor limit) holds it. For anyone else it is exactly as at e1717db: the key's owner pays, on
their own key.

**Who may use a key at all** (`OwnHive.use_check`, run by `Budgets.check` before any limit; 402):
- the key's owner; anyone the owner granted; anyone who was in the hive before H1 (`people.access` null): today's rules;
- a guest or public visitor with no grant: on a public mind, swarm or hive (the first public one of the three, in that
  order) whose `pays` is `hive-key`, the hive owner's key pays (the visitor limit applies); where it is `own-key`, only
  their own key may pay: `own_key_required`. Anything else: `no_key_grant`. The model route picks a guest's or public
  visitor's own key for the provider when they have one and hold no grant on the default (`Gateway.paying_key`).

**Public and private** (Jon, verbatim: "minds and swarms and hives can be set as public or private and have access granted
within both public and private"). Minds and swarms keep `private` / `shared` / `public` (`shared` is private with access
grants in `shared_with`; grants can be added to public things too) and gain `pays`: `own-key` (default) or `hive-key`.
Only the hive owner may set `hive-key` (403 `owner_only`; `pays_by` records who set it), and at use a `hive-key` counts
only when `pays_by` is the current hive owner; anyone else's reads as `own-key`.
The hive is `private` (default; invite only, as today) or `public` (a Google account Google reports verified, with no
invitation, is let in as a public visitor: role `member`, `access: "public"`, `invited_by: "public"`), with its own
`pays` and an optional `visitor_month_usd` (each public visitor's month limit on the hive's money; else the member
default). Defaults change nothing anyone can see or use.

**"Use my hive" invites.** `POST /api/invites` takes `kind`: `member` (as before) or `use` (owner only, role `member`,
`limit_usd` required). Accepting a use invitation (either sign-in path) makes the person a guest (`people.access:
"guest"`) with a grant of `limit_usd` a month on all the owner's keys (`source: "invite:<id>"`). Sign-in already makes
every person a personal mind and swarm, so a guest has both, in this hive, on the owner's key, within that limit. A guest
never sees the host's keys (`GET /api/keys` lists only their own). `terms` (a small JSON object) is kept with the
invitation for later kinds; `kind: "join"` is 501 `not_yet` until H2.

**Asking for a limit** (`limit_requests`). A person asks a key owner for a monthly limit: on a mind they can see (its
paying key's owner is asked, for that key), of a named person (all their keys), or of the hive owner (the default; how a
guest asks for more). `amount_usd` is the monthly limit asked for. The asked owner approves (that amount), adjusts
(`amount_usd`) or declines; approving or adjusting writes the grant, replacing any live one for that key and person (a
guest's invite grant keeps its `invite:` source at the new amount). One pending request per person, owner and key.

### Routes

| Route | Who | Body → result |
|---|---|---|
| `GET /api/hive/own` | any signed-in caller | → `{owner, owner_name, via: "first-admin" \| "operator", set_at, visibility: "private" \| "public", pays: "own-key" \| "hive-key", visitor_month_usd, you_are_owner, your_access: "owner" \| "legacy" \| "guest" \| "public" \| null}` |
| `PUT /api/hive/own` | owner (else 403 `owner_only`, checked before the body is read) | `{visibility?, pays?, visitor_month_usd?: number \| null}` → as GET; 400 `bad_visibility`, `bad_pays`, `bad_limit` |
| `POST /api/hive/own/claim` | an enabled admin, or the operator (H1.1) | `{to?: "user:u_…"}` → as GET with `via: "claimed"`; 409 `owner_present`, 403 `admin_only`, 400 when `to` is not an enabled admin |
| `PUT /api/agents/{id}/visibility`, `PUT /api/swarms/{id}/visibility` | its owner or an admin (as before); `hive-key` the hive owner only | adds `pays?: "own-key" \| "hive-key"` (400 `bad_pays`, 403 `owner_only`); minds' views carry `pays`, swarms' rows too |
| `GET /api/me/key-limits` | a person | → `{principal, access, keys: [{id, provider, label, hint}], own: [KeyLimit], grants: [KeyLimit], received: [KeyLimit without key_id, with keys: "all" \| "one"]}` |
| `PUT /api/me/key-limits/self` | a key owner | `{key_id?: "*" \| key id (default "*"), month_usd, ends_at?, note?}` → `KeyLimit`; 403 `key_owner_only` for a key that is not theirs |
| `POST /api/me/key-limits/grants` | a key owner | `{grantee: "user:u_…", key_id?, month_usd, ends_at?, note?}` → `KeyLimit`; 404 for a person not in this hive |
| `DELETE /api/me/key-limits/{id}` | the limit's owner (else 404) | → `KeyLimit` with `revoked_at` set, `active: false` |
| `POST /api/invites` | admins; `kind: "use"` owner only | adds `{kind?: "member" \| "use", limit_usd?, terms?}`; invite views carry `kind`, `limit_usd`, `terms`; `GET /api/auth/invite/{token}` adds `{kind, limit_usd, host_name}` |
| `POST /api/me/limit-requests` | a person | `{amount_usd, agent_id? \| owner?, note?}` → `LimitRequest`; 404 for a mind they cannot see; 409 `already_asked` |
| `GET /api/me/limit-requests` | a person | → `{asked: [LimitRequest], to_decide: [LimitRequest]}` |
| `POST /api/me/limit-requests/{id}/decide` | the asked owner (else 404) | `{decision: "approve" \| "adjust" \| "decline", amount_usd?}` → `LimitRequest`; 409 `already_decided` |

Key-limit writes (`PUT /self`, `POST /grants`, `DELETE`) refuse anyone who is not a named person or the owner with 403
`key_owner_only` before reading the body. A use invitation with no limit is refused at creation (400 `bad_limit`) and at
acceptance (410 `invite_unavailable`). Approving a request keeps a live grant's `source`.
`KeyLimit`: `{id, owner, key_id, grantee: "self" | "user:u_…", month_usd, ends_at, source: "owner" | "invite:<id>" |
"request:<id>", note, created_at, updated_at, revoked_at, spent_usd, active}`.
`LimitRequest`: `{id, requested_by, owner, key_id, agent_id, amount_usd, note, status: "pending" | "approved" | "adjusted"
| "declined", decided_by, decided_at, granted_usd, limit_id, created_at}`.
`people` views carry `access` (`null` for people from before H1). `person_request.created` / `.updated` events with
`request.kind: "limit"` reach the asker (and admins); the asked owner reads `GET /api/me/limit-requests`.

## Mind control, phase one (r2.12, r2.12.1, r2.13, r2.13.1)

A team's controller runs child minds for one request, under a lease the person who submitted that request issued in the same submission. Source: `hive/core/minds.py`. Contracts: `PLATFORM_MIND_CONTROL_R2_12_SPEC_20261005.md`, its r2.12.1 amendment, `PLATFORM_PERSON_INSTRUCTION_ROOT_R2_13_20261005.md`, its r2.13.1 amendment, and `PLATFORM_CONTROL_PLANE_SEQUENCING_20261005.md` (human routes).

**Off by default.** Spawn and resume answer 403 `spawn_disabled` until the launcher sets `HIVE_MIND_SPAWN=1`. Templates are operator-registered in the launcher: `HIVE_MIND_TEMPLATES` is a JSON list of `{template_id, harness: "native", model_id, role_id?, max_allocation_usd (0-100], overridable?: {model_id: [..]}, controls: [interrupt|stop|pause|resume|retire, always including stop and retire; steer is refused at registration until the native child's steer semantics are qualified], lifecycle_modes?: [deliver|bounded|ongoing], teams: [swarm ids]}`; an invalid entry is dropped and logged. One instruction's budget is bounded by the asker's monthly allowance, the hive cap and the caps set (`Budgets.request_bound`, "Spending limits" above).

**Errors** are `{error: {code, message, …details}}`. **operation_id** is `[A-Za-z0-9_.:-]{8,120}`, required on every write and scoped to the caller (`agent:<id>` or the person). Only a success is recorded: a retry with the same canonical payload (absent optional fields = explicit null, keys sorted) returns the original status and body byte for byte; the same id with another payload is 409 `operation_conflict`; a refusal records nothing, so a corrected retry is evaluated afresh.

**Controller** of a team swarm: its coordinator (a current member) or the mind it hangs under (holarchy). **Lease live**: not ended, before `until`, and its issuer is still a current admin person.

| Method & path | Who | Body → Response |
|---|---|---|
| `POST /api/requests` | a named, signed-in admin person (403 `person_required` otherwise, also for the local operator; a mind's bearer is 401) | `{operation_id, to_swarm, kind: "code", title (1-200 code points), instruction (1-8192 UTF-8 bytes), origin: {task_id, repository_id, workspace_id, scope_id, scope_digest: "sha256:…", generation: positive int}, budget: {limit_usd > 0}, lifetime: {until: RFC 3339 with offset, ≤ 24 h}, lease: {template_ids: 1-8 unique, max_children: 1-4}}` → 201 `{request_id, receiving_goal, lease_id, state: "accepted", budget: {root, limit_usd}, until}`. Refusals: 400 `bad_request`, 403 `origin_not_held` (you did not open the task, or it is closed), 403 `grant_inactive`, 403 `not_offered`, 409 `swarm_archived`, 409 `operation_conflict`, 402 `spend_limit` (over the person ceiling or the controller's remaining hard cap), 422 `template_unknown`. Request, receiving goal (assigned to the controller, `binding.request_id` set) and lease are one transaction. |
| `GET /api/agent/requests/{id}` | either swarm's minds | as before, plus `context_refs: {origin, instruction: {text, digest}}` and `lease: {lease_id, controller_id, template_ids, max_children, until}` when a lease exists; then `budget` also carries the live envelope `spent_usd` (children's recorded spend), `held_usd` (their unresolved S5 call holds) and `remaining_usd` (limit − spent − held). The same view is in `GET /api/requests`. |
| `POST /api/requests/{id}/cancel` | the issuing person, or an admin (404 if the request is not visible, 403 if visible but not yours; minds use /api/agent/requests/{id}/cancel) | also pauses that request's children (`request_cancelled`) and ends its lease |
| `GET /api/agent/minds/templates?team_id=` | the team's controller with a live lease | → `{templates: [{template_id, harness, model_id, role_id, max_allocation_usd, overridable: {model_id}, controls, lifecycle_modes}]}`, only those a live lease admits |
| `POST /api/agent/minds` | the controller; live lease admitting the template; open request whose `to_swarm` is the caller's swarm or the team's parent swarm | `{operation_id, request_id, team_id, template_id, model_id: null\|override, initial_prompt (1-8192 bytes of valid UTF-8, never truncated), lifecycle_mode, lifecycle_limits: null\|{until, max_iterations 1-10000, idle_minutes 1-10080} (bounded only, one set), allocation_usd (0, 100]}` → 201 `{child_id, team_id, request_id, template_id, model_id, reservation_id, prompt_rev: 1, state: "starting"}`. The allocation reserves from the request root (`allocated_usd`) in one conditional write with the child row, prompt revision 1 and the archived-swarm condition; the child's hard cap (`budget_usd`) is its allocation. Refusals add 403 `not_controller`, 403 `lease_required` (also `reason: max_children`), 404 `not_found`, 409 `request_closed`, 402 `spend_limit`, 403 `spawn_disabled`. |
| `POST /api/agent/minds/{child}/prompt` | the child's controller; live lease; open request | `{operation_id, mode: steer\|queued, text (1-8192 bytes of valid UTF-8), expected_rev}` → 202 `{prompt_rev, delivery: "accepted"}`. 409 `stale_revision` with `current_rev`; 422 `unsupported_control` (steer not in the template, or the child is stopping, stopped or retired). |
| `POST /api/agent/minds/{child}/control` | the child's controller; `resume` also needs a live lease, an open request and spawning on | `{operation_id, action: interrupt\|stop\|pause\|resume\|retire}` → 202 `{action, requested_at, observed: null}`. 422 `unsupported_control` when the template lacks the action or the state does not allow it (retire needs `stopped`). |
| `GET /api/agent/minds/status?child_id=\|team_id=\|request_id=&cursor=` | exactly one selector; `team_id` needs a controller of that team, `request_id` a controller of its team or its lease (403 `not_controller`); only children whose `controller_id` is the caller (a foreign `child_id` is 403 `not_controller`) | → `{children: [{child_id, controller_id, request_id, team_id, template_id, model_id, lifecycle_mode, lifecycle_limits, state, paused_reason, recovery_needed, prompt_rev, prompts: [{rev, mode, delivery, interrupted, by, at}], controls: [{action, requested_at, observed, by}], reservation: {reservation_id, allocated_usd, spent_usd, remaining_usd}, progress: {last_turn_at, results: [{goal_id, status, result_digest}]}}], snapshot_at, next_cursor}`. 100 per page in creation order; the cursor is bound to caller, selector and value and expires after 10 minutes (400 `bad_cursor`). Never filtered by lease or request state. |
| `GET /api/teams/{swarm}/children?cursor=` | a person who sees the team swarm (404 otherwise) | the same projection for every child of the team; each prompt carries `text` only when the person may read that child's request |
| `GET /api/teams/{swarm}/templates` | a named, signed-in person (admin or member) who sees the team swarm, under linkage §G: the `Authorization: Bearer` header only (`?token=` or no session is 401 `unauthorized`, as is a mind's bearer; the loopback operator password is 403 `person_required`); a team they cannot see and one that does not exist are the same 404; no lease needed; read-only | → `{to_swarm, templates: [{template_id, harness, model_id, role_id, max_allocation_usd, overridable: {model_id}, controls, lifecycle_modes}]}`: every template registered for that team, i.e. what an instruction's `lease.template_ids` may name for this `to_swarm` (others are 422 `template_unknown`). Each entry is exactly the projection of `GET /api/agent/minds/templates`, not narrowed to a lease. `max_children`, the budget and the lifetime are not template fields: the person sets them per request (`lease.max_children` 1-4, `budget.limit_usd` within what bounds the request (`Budgets.request_bound`), `lifetime.until` within 24 h); `max_allocation_usd` is the template's per-child ceiling. |
| `POST /api/teams/{swarm}/children/{child}/control` | a signed-in person (checked first: anyone else is 403 `person_required` before the team is looked at); a team they cannot see and one that does not exist are the same 404; then an admin, or the person who issued the request's lease (403 `forbidden`) | `{operation_id, action: stop\|retire}` → 202 `{action, requested_at, observed: null}`; cleanup only, no live lease or open request needed; recorded with the person as `by`; operation ids are the person's |
| `POST /api/agent/code/capability` | a child of an instruction request | `{delegated: true, service?}` → the hc1 capability: existing claims (`actor` = the child, `kind: agent`, origin `task_id`/`swarm_id`/`repository_id`, the issuer's `grant_id`, `member_hash` of the child's token) with `actions: [read, search, suggest]` and `delegated: {request_id, controller_id, execution_goal, issuer, origin_scope: {scope_id, scope_digest, generation}}`; lifetime the shorter of the lease and 15 minutes. 403 `not_delegated`, 403 `capability_withdrawn` with `reason`. |
| `POST /api/agent/code/capability` | the request's controller (slice 3; off unless `HIVE_COPY_APPLY_CLAIMS=on`, else 503 `copy_apply_off`) | `{service: "omegacode", copy_apply: {operation_id, request_id, proposal: {suggestion_id, suggestion_digest}, expected: {generation, tree_digest}}}` → the hc1 capability with `actions: [proposal-apply]`, `max_runs: 0`, `max_runtime_seconds: 0`, the lease's `grant_id`, exp = min(now + 300 s, lease end), and `copy_apply: {purpose: workspace-copy-apply, operation_id, request_id, lease_id, controller_id, execution_goal, issuer, origin_grant_id, origin: {task_id, repository_id, workspace_id, scope_id, scope_digest}, proposal, expected}` (origin from the request, never the body). Exclusive with `delegated` and `proposal_test` (400 `purpose_exclusive`). Idempotent under scope `capply:<controller>`: a replay returns the same binding with a fresh token (the earlier capability is revoked); one binding per proposal (409 `binding_exists`). 403 `not_controller` (`reason: delegated_child` for a child), 409 `request_closed`, 403 `lease_required`, 403 `grant_withdrawn`, 403 `origin_grant_read_only`, 409 `task_closed`, 409 `origin_invalid`. Live status (`GET /api/services/capabilities/{id}`) adds reasons `not_controller`, `request_closed`, `lease_expired`, `origin_grant_read_only` after the generic ones, and `copy_apply_status: {request_open, lease_live, controller_current}`. |
| `POST /api/agent/code/capability` | the request's controller (slice 4, linkage r3.6 §b.1/b.2; off unless `HIVE_PROPOSAL_TEST_CLAIMS=on` and `HIVE_PROPOSAL_TEST_ARGV_PREFIXES` is set, else 503 `proposal_tests_off`) | create `{service: "omegacode", proposal_test: {operation_id, request_id, proposal: {proposal_id, proposal_digest, normalized_hunks_digest}, parent: {generation, tree_digest}}}` or re-issue `{service, proposal_test: {test_id, stage?: prepare\|run\|result}}` → the hc1 capability with `actions: [proposal-test]`, `max_runs: 0`, `max_runtime_seconds: 600`, the operator's argv prefixes, exp = min(now + 900 s, lease end) (result: now + 900 s), `grant_id` = the lease's grant (result: null, with `proposal_test.origin_grant_id`), and `proposal_test: {purpose, stage, test_id, request_id, lease_id, controller_id, execution_goal, issuer, origin_scope, proposal, parent (workspace from the request's origin), fork (null for prepare; the bound fork for run), allowance}`. Idempotent under scope `ptest:<controller>`. 403 `not_controller` (`reason: delegated_child`), 409 `request_closed`, 403 `lease_required`, 403 `capability_withdrawn`, 409 `origin_invalid`, 409 `test_limit` (8 open per request), 409 `test_ended`, 409 `already_bound` (with `bound_fork`), 409 `not_bound`, 400 `bad_actions`. Live status adds `stage`, `lease`, `test`, `origin` and the c.2 reasons; a result claim skips `task_closed`. A withdrawal (request cancel, grant revoke, lease expiry/replacement, issuer demoted, controller changed) ends the test `withdrawn:<reason>`; its holds are unchanged, and `result` is issued up to 7 days after that end. |
| `POST /api/services/proposal-tests/{test_id}/preparation` | the service (token only, 16 KB) | b.5 bind `{capability_id, operation_id, fork_workspace_id, proposal, parent, test_tree_digest, preparation_digest}` → 201 `{test_id, fork_workspace_id, test_tree_digest, preparation_digest, bound_at}`; an identical body replays the recorded bytes whatever the capability or lease now; otherwise 409 `operation_conflict` / `fork_mismatch`; 403 `service_mismatch`, 403 `capability_withdrawn`. |
| `POST /api/services/proposal-tests/{test_id}/holds` | the service (token only, 16 KB) | b.6 admission `{capability_id, launch_key, argv_digest, runtime_seconds}` → 201 `{hold_id, launch_key, state: dispatched, runtime_seconds, allowance}`; a replay of the same key and body returns the recorded bytes even after withdrawal; 409 `operation_conflict`, `allowance_exhausted` (4 runs / 600 s per test, 8 runs / 1800 s per request), `admission_closed`, `not_bound`; 403 `capability_withdrawn`. |
| `GET /api/services/proposal-tests/{test_id}/holds?launch_key=` and `…/holds/{hold_id}` | the service | `{hold: HoldView, observations: [ObservationView…]}` (by key: `{hold: null, observations: []}` when never admitted), canonical bytes, no live authority. |
| `POST /api/services/proposal-tests/{test_id}/holds/{hold_id}/settle` | the service (token only, 16 KB) | b.6.1 strict settle body → 200 `{hold, observation}`; an identical body replays its own recorded bytes; 15 non-terminal observations plus 1 reserved terminal slot; 400 `bad_request` / `not_started_unproven`, 403 `service_mismatch`, 404 `not_found`, 409 `run_mismatch` / `hold_settled` (with `hold`) / `observation_limit` (with `terminal_slot_reserved`). |
| `GET /api/services/capabilities/{id}` | the service | for a delegated capability `active` also requires: the child exists and is not retired, its request and controller match, the request is open, the lease is live, the issuer's origin grant is active, the origin task is open; otherwise `reason` is `child_retired`, `child_mismatch`, `request_closed`, `lease_expired`, `grant_withdrawn` or `task_closed` |

**States.** `starting` (spawned or resumed) → `running` (its hub connected) → `paused` (by `pause`, or by the host with `paused_reason` `request_cancelled`, `lease_expired`, `budget_exhausted` or `limit_reached`; the process is stopped, the assignment kept) → `stop_requested` → `stopped` (only once the supervisor observes the process end; the stop control's `observed` becomes `{state: "stopped", at}`) → `retired` (the unused reservation returns to the request root, the child's token ends, history stays). `unknown`: a stop not observed within 60 s, or a child not observed running after a hive restart (`recovery_needed: true`). Unknown never means stopped and still counts against `max_children`. The host never restarts a child: a child that ends unasked is `stopped` with `recovery_needed: true`.

**Delivery.** `accepted` → `pending` (stored, the child is not connected; sent on its next `resume`) or `delivered` (the hub sent the frame) → `acknowledged` only when the child's own hub frame `{"type": "prompt_ack", "rev": N}` names a delivered revision (the hub answers `{"type": "prompt_ack", rev, acknowledged}`). A delivered revision whose child disconnects, is interrupted, paused or stopped before its ack stays `delivered` with `interrupted: true`. The prompt reaches the child as a hive envelope carrying `mind_prompt: {child_id, rev, mode}`; `interrupt` sends the hub frame `{"type": "mind_control", "action": "interrupt"}`.

**Event.** `mind.updated` `{swarm_id: <team>, child: <status projection without prompt text>}`, delivered to people who see the team swarm.

**Correction 2 (2026-10-05).**
- **Starts.** A queued start or resume re-checks, under the mind's lifecycle lock immediately before the process starts, that the child is still `starting`, its request open, its lease live, its allocation unspent and spawning on. Otherwise it is refused (409 `start_withdrawn`, also on `/api/agents/{id}/start`) and the child stays or becomes `paused` with the reason.
- **Retire refunds.** Retire refunds only what no S5 reserved, dispatched or unknown call of the child still holds. The refund is recomputed (never added to) on reconcile and before every spawn on that request, so a later settlement or person release refunds the difference once, and a late charge takes it back.
- **Iterations.** `max_iterations` counts recorded model calls (usage rows), not tasks.
- **`deliver` mode.** It ends only on a `done` or `submitted` goal the child claimed that belongs to its own request (the execution goal, a subgoal under it, or a goal whose binding names the request). `progress.results` lists only those goals. A submitted result is not acceptance.
- **Audit.** A host pause (`request_cancelled`, `lease_expired`, `budget_exhausted`, `limit_reached`) is recorded in `controls` as `pause` by `host:<reason>`.
- **Delegated capabilities.** A delegated capability is valid only under the exact grant its lease was issued under.
- **`prompt_ack` frames.** A non-child mind's `prompt_ack` gets no answer. A child's `prompt_ack` that names another `child_id` is not counted.
- **Runtime (`modules/channel_hive`).** See Correction 3: identity and admission replace this description.

**Correction 3 (2026-10-06).**
- **Identity.** The runtime publishes or acknowledges a `mind_prompt` envelope only when it parses and names the process's own `HIVE_AGENT_ID` (set by the supervisor). This is Code's reviewed guard e964764e. Malformed, foreign or unbound prompt envelopes stay in the raw inbox and never become native input.
- **Admission.** One atomic `admission.json` holds the inbox cursor, the admitted `(child, rev, body digest)` set and the in-flight batch, written before `getLastMessage` returns. A failed write advances nothing.
  - A batch is committed by the same process's next call.
  - After a restart, an uncommitted batch is handed out again, marked `redelivered=1`.
  - A corrupt state fails closed and shows in `status()`.
  - An altered duplicate is refused and recorded in `conflicts`.
- **ACK.** The daemon sends the child's `prompt_ack` from `admission.json` only, once per connection, until the hub confirms it.
- **Hub answer.** The hub now answers `{type: "prompt_ack", rev, acknowledged, status}`, where `status` is one of:
  - `acknowledged`: the first ack, also accepted from a revision still shown accepted or pending;
  - `duplicate`: confirmed, never re-sent;
  - `refused`: kept apart in `refused.json` and retried only after a reconnect.

## Person notices (G2) and daily spend (G4)

Details: `G2_G4_NOTICES_SPEND.md`.

| Route | Who | → |
|---|---|---|
| `POST /api/agent/notices` `{text, urgent?}` | a mind in its person's own app space | `{id, state: "delivered" \| "held", held?: "cap" \| "quiet"}`; 403 `not_your_person`, 403 `urgent_unavailable`, 413 `too_large`, 429 `rate_limited` |
| `GET /api/me/notices?after=&limit=` | a person | `{notices: [Notice], waiting, prefs}` |
| `GET` / `PUT /api/me/notices/settings` | a person | `{cap: 0\|1\|3\|5\|8, quiet_start, quiet_end, tz}` |
| `POST /api/me/notices/release` | a person | `{digest: Notice \| null}` |
| `GET /api/me/spend?days=N` (1 to 31) | the caller | `{principal, tz, days: [{date, total_usd, own_keys_usd, hive_paid_usd, by_mind, by_app}], total_usd}` |

P1 frame ops: `{"op": "notices", "after"?}` and `{"op": "spend", "days"?}`. Event `notice` goes to its person only.
