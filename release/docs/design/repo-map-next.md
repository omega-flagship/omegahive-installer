# Repo map: where it is and where it should go

Status: design brief. Nothing here is built yet. @patham9 is invited to build it. OmegaCode wrote today's `repo-map/1` format and extractor and will support the hand-over. The work is planned for after the release candidate unless Patrick wants to start sooner.

## Ground rule: maps build themselves, with no LLM

The extractor reads git objects directly and is deterministic: the same commit always gives the same bytes. It should stay that way as maps grow, rebuilding automatically from each commit. Parsing, identity, links and evidence all come from the code, git and test runs. Any LLM-written summary stays optional, is labelled as such, sits outside the build, and is never treated as fact.

## What exists today

- The loader and read engine are in [`hive/core/repomap.py`](../../hive/core/repomap.py). The read API used by the UI is [`hive/ui/src/api/repoMap.ts`](../../hive/ui/src/api/repoMap.ts). There's a synthetic example at [`hive/tests/fixtures/repo-map-1.synthetic.json`](../../hive/tests/fixtures/repo-map-1.synthetic.json).
- A plain-language description is in omegahive-installer, in `release/docs/REPO_MAP.md`.
- The extractor lives with OmegaCode and isn't on GitHub yet.

`repo-map/1` is a well-governed **index**. It is:
- pinned to a content digest;
- admitted by an admin;
- scoped to an audience;
- tracked for drift between versions.

It covers a file inventory, Python definitions, the import graph and name-match call candidates. The atoms, however, are mostly decorative: reads are answered from SQLite, not from the space.

## Theory check, 30 Oct 2026

We asked eight independent reviewers on different model lineages: GLM, Gemini, Grok, DeepSeek, Kimi, MiniMax, Qwen and our own. The verdict was unanimous. The map is good inventory and provenance, but not yet a reasoning substrate, and it falls short of our rule that reasoning, truth and memory live in MeTTa, PeTTa, NAL and PLN.

### Where all eight agree

1. **Reads run on the space**, as bounded PeTTa queries, with SQLite kept only as the store.
2. **Identity comes first:** qualified names plus a content digest per function, built up as a Merkle tree (function → file → tree), so beliefs survive edits, renames and moves.
3. **Calls go function → function.** Today every call edge starts at a file.
4. **Uncertainty is visible.** A guessed name match must not look the same as a parsed fact.
5. **Builds are incremental and bulk-mounted.** They come from git, with no per-atom locking, as a near-free side effect of every commit.
6. **History and evidence:** git co-change, coverage and run outcomes as evidence, and NAL revision.

### The sharpest single points

- **Kimi: in MeTTa, data is code.** Maps built from outside repos and shared between hives become a code-execution channel once minds query them. Admission must therefore be hermetic before queries widen:
  - nothing evaluable;
  - no grounded-op references;
  - fuel-bounded, read-only queries;
  - signed bundles.
- **Gemini: our MeTTa code is invisible to our MeTTa minds.** `.metta` files are inventory only. Mapping MeTTa symbols, space reads and writes, and grounded-op bindings may matter more than perfecting Python call graphs.
- **DeepSeek and GLM: truth needs stable claims.** Truth values attached to today's ids would be fake, because the ids change every revision.
- **Grok:** use one small upper ontology (entity, symbol, occurrence, relation, evidence, truth, revision, audience, source) rather than flat tuples per domain.
- **Ours:** key spaces by content (the git blob per file), not by revision, and have the coding controller's reads name the map revision they read, so that `stale` becomes mechanical.

### Where they differed, and how we'd resolve it

- **Truth values everywhere, or only on non-parsed claims?** Parsed facts are observed and stay crisp. Truth values and evidence go only on heuristic, inferred, runtime and LLM-proposed claims, and their basis is an evidence atom.
- **One ontology, or one per domain?** One small upper ontology with vocabularies per domain. It should be shaped from code plus the UI inventory, not designed in the abstract.
- **Embeddings:** never as facts. They live in a separate retrieval index, linked by id.

## Proposed order

1. Function-level identity: qualified names and per-function digests, organised as a Merkle tree.
2. Function → function call edges with source spans, with heuristic matches marked as guesses.
3. Hermetic map admission, as above.
4. Bulk mount, with the presets rewritten as PeTTa queries and SQLite kept as store and pager.
5. Cross-language edges: MeTTa, TypeScript, and our registries (routes, `skills.metta`, plugin manifests) as declared facts.
6. Evidence atoms and NAL truth values on non-parsed claims only; git co-change; coverage from test runs.
7. Incremental from git: blob-keyed sub-spaces, base plus delta, and a real `stale` signal.
8. PLN impact analysis and what-to-test ranking; a MORK benchmark.

## Don't

- Treat embeddings or summaries as facts.
- Put truth values on parsed facts.
- Run PLN on today's file-level graph.
- Add more SQLite presets.
- Expose raw MeTTa patterns to minds before hermetic admission.
- Design a universal ontology in the abstract.

## Open design choices for the builder

- How should atoms and links be shaped? What is the upper ontology, and how are relations represented?
- Where should NAL and PLN be used, and where not?
- What does hermetic admission look like in PeTTa terms?
