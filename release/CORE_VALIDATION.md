# V8 validation

This replaces the V7 validation report. Counts below are from V8, not carried
forward from earlier archives. No live external model, real channel account,
manual UI session, Windows/macOS execution or Docker daemon was exercised.

- Core Python suite: 425 tests ran; 397 passed, 28 skipped.
- New review regressions: 6 passed (approval default, config log privacy,
  external cache reuse, response error classification, local-source installer,
  single upstream add-skill owner).
- Dependency/composition checks: 14 passed, including no parent Git creation
  or index mutation, dependency pin verification and symbolic-memory retention.
- Real PeTTa native integration: 4 passed (symbolic restart, authorization,
  guarded file/shell behavior, vector-memory restart).
- Focused Hive auth and policy checks: 18 passed with PeTTa.

- Native malformed-tool-call retry: passed through the real PeTTa loop and a
  fake OpenAI-compatible HTTP server; the second call arrived within 15 seconds.
- Existing quiet-wait suite: 6 passed across the initial run and a focused rerun
  after installing the test environment's missing SOCKS proxy dependency.
- Source installer tests: 33 passed.
- Focused image-route and policy regression suite: 111 passed after explicitly
  listing existing image/repository capabilities in the defaults.
- Source ZIP extracted with all 2,310 manifested files and modes verified;
  official dependency setup created no parent `.git` or `.runtime`; the four
  native integration tests passed again from that fresh extraction.
- UI source content is unchanged from V7; browser/TypeScript checks were not rerun.

## Full Hive suite and reruns

The full `hive/tests` suite ran in two file shards: 2,667 tests collected.
After fixing the default-policy regressions and rerunning affected tests,
2,578 passed, 82 skipped, and 7 sandbox/process tests remain failing in this
environment. All seven were rerun against the untouched original archive and
failed there too. The initial run also exposed that the validation fixture had no
Git commit; code-API checks passed after committing that fixture.

Focused reruns: code API/proxy 31 passed, 4 skipped; image route/policy 111
passed; discovery/policy 16 passed; repository-map and code-source-review run
45 passed with two policy failures subsequently corrected; final
code-source-review/policy 19 passed. No application tests were weakened.

Remaining failures:
- `test_local_driver_adopt.py`: restarted-mind adoption and two descendant cleanup cases.
- `test_mind_sandbox_linux.py`: SIGTERM cleanup of a running launcher.
- `test_sandbox_run.py`: timeout descendant cleanup and cancelled launcher cleanup.
- `test_mind_sandbox.py`: Hugging Face cache/token probe under the stripped mind environment.

## Packaging

The archive preserves `.gitignore`, `.dockerignore`, `.gitattributes`, `.github/`
and `.tours/`. All ten original executable files retain their original modes
(V7 had lost eight). No `.DS_Store`, bytecode, generated `.runtime`, dependency
checkout, parent Git repository, private environment file or key is packaged.
Docker ignore rules also exclude nested secrets and runtime memory. CI explicitly
fetches the pinned dependency for core tests and browser imports; the existing
PeTTa composite action is preserved.

`RELEASE_FILES.json` and `scripts/check_release.py` verify every shipped source
file and Unix mode. `scripts/build_release.py` rejects generated/private tracked
files and preserves dotfiles. CRC and saved-file SHA256 round-trip verification
are performed on the delivered ZIP.

The source baseline is the supplied original ZIP, not the inaccessible current
private repository. PR #45 could not be fetched: GitHub required authentication.
The AccountAttempts docstring now explicitly describes both unknown-entry expiry
and eviction, correcting the reported misleading equivalence; this is not a
claim to have recovered PR #45's exact text.

Upstream HEAD was inspected for hooks. The generated adapter remains necessary;
see docs/upstream-core-hooks.md. No upstream changes have been published.
