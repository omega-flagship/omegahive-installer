# P8 host memory inside an app

P8 gives an app a way to ask the host to draw the signed-in person's local
memory. The host owns the view, its controls, confirmations and download. The
opaque app frame receives no memory statement, snapshot, export, URL or pixels.
The app's own Ask turns can still include facts recalled to answer those turns;
P8 adds no direct memory read to that separate conversation contract.

## Frame contract

On its existing exact source/origin/channel binding, a frame may send:

```js
{ type: 'memory-open', channel, id: 'review-1', topic: 'your preferences', theme: 'calm' }
{ type: 'layout', channel, mode: 'dark' }
```

`topic` is optional plain display text up to 160 characters. `theme` is an optional
identifier, `[a-z0-9-]{1,24}`. Only a declared variant name selects a variant;
an undeclared valid name selects the default. The existing framed/full layout
values continue to work; light/dark changes only the memory colour-mode signal.

An opened review produces `{type:'memory-opened',id,channel}` and a closed review
produces `{type:'memory-closed',id,channel}`. These replies are built from an
explicit allowlist, never by spreading memory or action results. Invalid,
unsupported, busy, unavailable and rate-limited requests get a content-free
`memory-refused` with id and reason. There is no memory-read, snapshot, fix,
forget or export bridge operation. App-request variants of those operations are
also unknown operations. Only the person's host controls change or export memory.

Reason cards may pass an opaque `token` instead of a topic. The host-only
`memoryReasonTokens.issue(app,swarm,digest,topic,current)` seam records the reason
and its currentness callback. `memory-open` resolves that token only for the same
app, swarm and release while its host binding remains current. Unknown tokens are
refused. The producer of reason cards is separate; P8 does not manufacture a memory
reason from app-supplied token text.

The host permits three openings per 10 minutes per app/person across frame
remounts. Extra openings require a visible, focused app frame and browser-owned
transient user activation. A frame cannot assert that activation in a message.
The rate and reason stores are bounded and cleared on identity changes. While
one opening is pending or visible, another `memory-open` is refused with `busy`
before the opening budget or local review store is called. The first panel and
its lifecycle remain intact; only a later successful opening spends a budget slot.

## Local storage and host authority

P8 uses the existing `askMemory/backend.ts` IndexedDB and `AskMemoryStore`, one
database per principal and hive. Browse and literal text search operate on local
belief statements. Export uses the existing complete local memory-file format,
including its existing conversation/journal/forget protections. None of these
memory operations calls the network, a model, a helper template or a paid API,
and no extra memory consent is required.

The actual existing browser CRUD seam is not described as a MeTTa reasoner. P8
does not calculate STV, confidence, inference, revision or retrieval ranking.
Host fixes preserve the existing stored truth value. The existing lexical recall
path and its replacement by the personal MeTTa worker are a separate change;
`lib/mindSpace` and its NAL/PLN worker are not reimplemented by this patch.

At document load the host reads the interface and its own `me()` metadata under
one identity binding. Memory requires a known enabled program whose digest
exactly matches the loaded UI release, a ready memory store whose principal/hive
matches that session, and the current document and identity. Missing metadata
fails closed. Explicit server expiry is checked on every operation and by a
timer; a monotonic deadline prevents a backward wall-clock adjustment from
extending that known expiry. An explicit null expiry preserves the server's
nonexpiring-session representation; an absent or malformed expiry is refused.

Identity/owner changes, a missing/disabled/changed program, release-change events,
pagehide, a later iframe document load or component teardown abort the view and
pending actions. The first iframe `load` is the initial document; a later `load`
invalidates the view, without treating a numeric load count as proof of authority.
The opaque sandbox prevents the host from inspecting in-frame same-document
history/hash navigation, which does not emit `load`; that gap is not
monitored. The existing session, identity, digest and event fences
still apply. An unchanged single-app reload no longer emits a release-change
notification; digest/error changes and source removal still do. The view hides
synchronously before React removes it. Current
store bindings are rechecked after awaits and inside storage mutation/transaction
guards. The content-free `program.release_changed` event is registered for the
same signed-in viewers who can already read the program's public digest. No
freshness claim is inferred from a missed remote event while disconnected; local
known state/session/identity fences stay enforced without a memory network call.

## Review, fix, forget and export

The plain host identity line is the same for every viewer: “Your memory · kept
safe in your hive”, with “OmegaHive” beneath it. It and all confirm cards are
siblings outside the themed memory body.

Every fix/forget card names the app and the topic that opened the view. It shows
the current text, and fixes also show the person's correction. A changed opening
revision or changed statement warns “This changed since you opened it”. The
statement comparison also catches older writers that reuse a timestamp.

Fix uses the existing backend `put` with its opening base and an exact displayed
statement CAS. Forget is a real removal with the existing tombstone and journal
blanking, also bound to the displayed base/text. A commit that loses CAS refreshes
the current text and requires another explicit confirmation; it is never retried
silently. Forget arms after two seconds, including again after a stale conflict.
An abort while the transaction is pending rolls it back. Ordinary pre-existing
backend callers retain their original optional-guard contract.

Export has a host confirmation and creates a host-owned local download only
after the session/document guard still holds. Its blob URL is never posted to the
frame and stays valid for the browser download handoff until document abort or
component teardown revokes it. There is no zero-delay revocation. A delayed export after an
identity change creates no download.

## Release-bound themes

`plugin.json` may declare `memory_theme` and `memory_theme_dark`. The former has
up to eight closed colour slots (`surface`, `panel`, `text`, `muted`, `accent`,
`border`, `positive`, `danger`), `radius` 0–32, `motion` none/gentle/lively and a
host font identifier (`system`, `humanist`, `serif`, `mono`). It may additionally
contain up to four named variant objects, each with optional `dark` tokens.
Default dark falls back to default light; a named variant without dark uses its
light tokens. Unknown or withdrawn render-time values fall back to host defaults.

CSS text, URLs, selectors, imports, markup, unknown fonts and nested variants are
refused before app code loads. Themes are obtained from the same manifest bytes
included in the release digest, with a final source/entry check after reading UI
files. Mutating a program context's cached theme does not replace those bytes.
Both single-file and declared-parts UI bundles carry this host-only release
metadata outside `srcdoc`.

The host substitutes foreground/background choices when needed to keep displayed
text at 4.5:1. Text on the accent is chosen by the host from white or `#0b0820`;
if neither works, the accent itself falls back. Fonts are generic local stacks,
and reduced-motion overrides the app's display-motion token. Colour mode switches
apply the checked endpoint colours together, without colour/background interpolation:
otherwise two safe palettes can pass through unreadable intermediate colours. The
host explicitly disables transitions throughout the themed body, its descendants
and their pseudo-elements, including when global reduced-motion CSS supplies a
nonzero transition duration. Host identity and confirms remain outside this rule.
Theme values cannot
request an asset or change host confirmations.

## Combined with app-scoped Ask

Programs.source_digest keeps its string result and P1's optional ui_lock_bytes parameter. P8's _source_snapshot returns the digest and the exact manifest bytes hashed into it, using that same optional captured-lock override. All declared source_digest callers retain their existing string contract. UI delivery checks the captured reviewed lock, actual returned byte hashes, current pinned digest/version, and P8's final current entry/disk digest before combining host-only display themes with the optional P1 release version.

P8 deliberately supplies display-only release metadata to legacy unpinned apps. That does not grant Ask authority: absent pinned version yields a null Ask release. The unchanged P1 _ui_identity helper retains its exact legacy response behavior.

AppFrame keeps the P1 Ask API, context, host controls, receive path, generation fence and verified-byte rekey, alongside the P8 local memory session/release/identity/store guards. A host-only closed-key projection feeds digest/version to P1's unchanged strict parser; the original safe release metadata feeds the P8 theme reader. Neither is sent into srcdoc. On later document load, Ask fences first, memory closes, then verified UI is reloaded/rekeyed.

## Tests

Python: `hive/tests/test_memory_release_p8.py`, `hive/tests/test_memory_theme_p8.py`,
`hive/tests/test_p8_p1_rebase_integrity.py`, and additions to `test_app_ui.py` and
`test_app_ui_parts.py` cover release-bound themes, manifest races, captured-lock
identity in single-file and parts UI, and returned-byte rejection despite valid
memory metadata.

UI: `AppMemory.test.ts`, `appMemory.test.ts`, `askMemory/hostReview.test.ts` and
`memoryTheme.test.ts` cover the bridge allowlist, opening budget and busy refusal,
compare-and-set fix/forget, export, and theme contrast.

Browser: `hive/ui/tests/p8/` is a separate fixture that mounts the real AppFrame,
AppMemory, identity epoch and IndexedDB with an opaque `srcdoc` app and an invented
host-only sentinel. It checks expiry and backward-clock handling, host
compare-and-set/forget/export, permission boundaries, contrast and theme sampling,
and the busy refusal. The production `build` script asserts that no
`p8-memory-browser.html` fixture is present in `dist`; it fails rather than
deleting the fixture. All data is invented.
