# Patch Series Review Map

This directory is a review staging area for current research work. It is not a
claim that the patches are ready to submit as-is.

The goal is to separate the work by cognitive/body boundary so reviewers can see
what belongs in core, what belongs in optional organs, and what should
remain local to a deployment.

## Generated Patch Bundles

Regenerate these bundles from the live tree with:

```bash
python3 docs/review/patch-series/regenerate_patch_series.py
```

The generator excludes runtime memory, credentials, WhatsApp auth sessions, and
`node_modules` directories. After regeneration, verify the bundles with a clean
temporary worktree:

```bash
tmp=$(mktemp -d /tmp/omega-patchcheck-XXXXXX)
git worktree add --detach "$tmp" HEAD
for p in docs/review/patch-series/patches/*.patch; do
  git -C "$tmp" apply --check "$PWD/$p"
done
git worktree remove "$tmp" --force
```

Or run the review gate, which performs the clean apply check plus boundary,
secret, local-library import, patch-ownership, and ignored-runtime-memory import
checks:

```bash
python3 docs/review/review_audit.py
```

On the integrated readiness branch, the audit runs boundary and secret checks by
default. Patch ownership and patch application are strict baseline checks, so run
them with an explicit baseline ref when preparing a patch-series submission:

```bash
OMEGACLAW_REVIEW_STRICT_PATCH_SERIES=1 \
OMEGACLAW_REVIEW_PATCH_BASELINE=<baseline-ref> \
python3 docs/review/review_audit.py
```

### 00-repo-boundary-runtime-state.patch

Source/runtime boundary:

- removes tracked default runtime memory files from source control
- keeps local `memory/history.metta` and `memory/prompt.txt` available in a live
  instance through `.gitignore`
- excludes logs, inbox/outbox media, web sessions, auth state, generated media,
  and local credentials
- adds a repository boundary test so runtime state and obvious provider tokens
  cannot accidentally become tracked source again

Review note: this is the first clean PR-sized patch. It intentionally changes
no cognition behavior.

### 01a-syntax-command-membrane.patch

Command syntax and write-surface hardening:

- MeTTa-declared `SkillSignature` command surface
- parser membrane that lowers natural command text into valid MeTTa calls
- fail-closed handling for unknown/narrative command heads
- multiline/rich text write lowering through base64
- smoke corpus covering colons, quotes, multiple commands, narration, typed
  args, and known historical syntax failures

Review note: this is the smallest syntax patch. Python is only the
parser/membrane; the command surface is declared as MeTTa atoms.

### 01b-runtime-memory-context-boundary.patch

Runtime memory spaces and context boundary:

- runtime memory files are created/imported during memory initialization rather
  than source import
- runtime space registry/load/save/bound/query membrane for `&persistent`,
  `&agenda`, `&beliefs`, `&world`, `&events`, and `&activity`
- promoted memory/history/promotion/reboot helper modules
- stable `helper.*` compatibility facade for existing MeTTa calls
- bounded history/result surfacing and promoted memory hints in loop context
- memory reference docs and space-transform/memory-shape smokes

Review note: this keeps identity/memory local at runtime while preserving the
existing helper surface. Runtime-space registration lives here because
`initMemory` depends on it; NAL/PLN reasoning remains separate.

### 01c-provider-runtime-energy.patch

Provider/runtime and energy controls:

- provider timeout/routing/cost-hook membrane
- energy/sleep budget controls
- provider tests and cycle smokes

Review note: this patch changes provider/runtime behavior, so it is
intentionally separate from syntax and memory/context.

### 01d-symbolic-reasoning-space-skills.patch

Symbolic reasoning skill membranes:

- NAL/PLN/MeTTa reasoning helper surfaces
- reasoning catalog/affordance declarations
- smoke tests for reasoning space examples and NARS assimilation

Review note: this is the “language of thought” skill surface, distinct from
provider/runtime, memory persistence, and body organs.

### 02a-assume-symbolic-graph-engine.patch

Symbolic graph engine:

- symbolic Assume atom parsing
- sparse feature/action graph extraction
- deterministic prediction/audit helpers
- graph caps and malformed atom rejection
- pure AtomSpace causal-coding smoke

Review note: this is the non-daemon substrate. It should be readable as
AtomSpace-first prediction logic before any FabricPC runtime is considered.

### 02b-assume-fabricpc-daemon-membrane.patch

FabricPC daemon membrane:

- `assume_client.py`
- `assume_fabricd.py`
- daemon lifecycle, timeout, load/reload/status, predict/audit/learn/writeback
- FabricPC-specific tests and smokes

Review note: Fabric/JAX is the warm executable view. This patch should not own
identity or canonical graph truth.

### 02c-assume-metta-skill-and-mutation-review.patch

MeTTa skill and mutation-review membrane:

- `lib_omegaclaw_assume.metta`
- `src/skills_assume.metta`
- final `src/skills.metta` import of `src/skills_assume.metta`
- `&assume` / `&assume_work` spaces
- canonical-first structural/evidence writes
- mutation pressure, symbolic review, acceptance, and trace atoms

Review note: this is where the agent presses the buttons. Python proposes and
executes membrane operations; MeTTa exposes the language-of-thought affordances
and review atoms.

### 02d-assume-demo-space-and-tests.patch

Demo space and public proof:

- SmartHabitat demo graph
- demo story/benchmark tests
- demo import/predict/audit/learn/writeback checks
- review notes for the demo

Review note: this should be persuasive without using private household data.
It demonstrates prediction, evidence, mutation pressure, and inspectable trace.

### 03-attention-ecan-lite-immune-organ.patch

Attention/immune hygiene support:

- attention ledger
- bounded ECAN-like scans
- review-before-retire workflow
- agenda/persistent hygiene tests

Review note: this should stay conservative. It must propose and trace cleanup;
it must not make hidden destructive memory choices.

### 04a-module-contract.patch

Generic module/membrane contract:

- module manifests represented as inspectable MeTTa atoms
- module entrypoints that declare kind, version, provides, dependencies, trace
  writes, runtime state, and optional/default status
- fixture examples proving a module can be a channel, surface, simulation, or
  opaque executable behind the same cognitive contract
- smoke tests showing the contract is queryable without depending on
  deployment-specific organs

Review note: this is the upstream-facing boundary for shareable organs. It
keeps the package mechanics boring while making the cognitive contract visible
to MeTTa.

### 04b-body-organs-and-channels.patch

This bundle has been split. See `04b` through `04f`.

### 04b-body-skill-surface.patch

Optional body skill surface:

- body/channel `SkillSignature` declarations
- body/channel catalog/help declarations
- `src/skills_body.metta` command implementations
- syntax smokes for body/channel commands
- docs explaining where custom skills and IO affordances live

Review note: this patch declares the body language, but the concrete organs are
introduced later so reviewers can inspect the surface separately from devices.

### 04c-communication-channels.patch

Communication channels:

- Telegram file/media send and receive helpers
- Mattermost environment-based configuration cleanup
- channel router and web-control bridge
- WhatsApp Python wrapper
- WhatsApp Baileys bridge and npm lockfile

Review note: this is intentionally just the communication membrane. Auth/session
state and installed `node_modules` remain outside the patch series.

### 04d-situated-senses-and-apps.patch

Situated senses and app organs:

- home, glucose, audio, webcam, vision, image/video/publishing organs
- observation router
- terminal mirror support
- dry tests for glucose, observation routing, and terminal mirroring

Review note: these are apps/senses available to an agent body. They should
remain thin membranes; they should not decide what the agent cares about.

### 04e-shareable-runtime-modules.patch

Shareable runtime modules:

- installed examples for body container, coding hand, Game Boy, tiny VM,
  publishing, and VM policy
- module-local manifests, signatures, catalogs, skills, README files, and tests
- compatibility facades for the current flat `py-call` import surface

Review note: this patch exercises the module contract with real organs. It is
larger than ideal because each module includes its own code, declaration files,
and tests.

### 04f-body-composition-loader.patch

Body composition loader:

- `lib_omegaclaw_body.metta`
- final `src/skills.metta` import of `src/skills_body.metta`
- body status smoke and cross-cutting patch-contract tests

Review note: this is deliberately last in the body sequence. It wires together
organs that have already been introduced, instead of importing files before a
reviewer has seen them.

### 90-local-web-ui-not-for-upstream.patch

Local web UI / spatial OS experiment:

- webhost/admin/workbench
- spatial OS prototype files
- Spline/spatial UI notes
- retired Three.js prototype

Review note: this is intentionally marked local-only. Deployment-specific web
work should not be uploaded as part of the core patch.

### 91-local-runtime-composition-not-for-upstream.patch

Local runtime composition:

- `run.metta` for the current deployment
- no-Agentverse local composition library
- local core-skill variant without Agentverse calls

Review note: this is local policy, not an upstream proposal. Upstream may choose
to keep Agentverse; this deployment does not load it.

## Current Boundary Assessment

Clean enough for internal review:

- Assume/FabricPC conceptual architecture
- mutation trace atoms
- canonical-first writeback
- provider optional energy hook
- side-effect-free promoted memory context
- restored Agentverse compatibility surface
- split body/module review sequence
- patch ownership and local-library import audit checks

Not clean enough for upstream PR yet:

- FabricPC dependency strategy needs a final reviewer decision: bundled,
  optional external repo, or submodule-style dependency
- body/channel/module patches are cleaner, but still need reviewer choice on
  whether they belong in core, example modules, or a plugin/organ library

## Recommended Upstream Sequence

1. Submit the syntax/write membrane first if reviewers want that narrow fix.
2. Submit provider/runtime energy separately.
3. Submit runtime memory/facade cleanup separately.
4. Submit Assume/FabricPC as an experimental organ with a demo space and tests.
5. Submit ECAN-lite attention hygiene separately.
6. Submit the generic module contract before body organs.
7. Treat communication/sense/runtime modules as optional organ examples or a
   plugin library, not mandatory core cognition.
8. Keep web/spatial OS and local runtime composition out of upstream.

## Review Principle

The runtime should remain a cognitive orchestration substrate:

- MeTTa/AtomSpace remains the language of thought.
- Python is a membrane for execution, IO, numerical engines, and devices.
- The LLM provider is not the agent.
- Memory, reasoning, action, and identity remain separable.
- Every mutation that could matter to cognition should be inspectable as trace.
