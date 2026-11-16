# Singnet core with Hive extensions

Ported from omega-flagship/omegahive#49 (Patrick Hammer). `third_party/Omega` is the pinned external dependency,
`https://github.com/singnet/Omega.git` (the upstream OmegaClaw-Core repository). The hive keeps no local fallback
scheduler, provider engine, basic skill implementation, vector-memory engine, configuration resolver, NAL library or
PLN library.

## One version source

`core-dependency.json` names the repository, path and full 40-character revision. It travels with every form of the
tree: git checkout, `git archive`, the export mirror and the installer bundle. In a git checkout, `third_party/Omega`
is also a submodule gitlink. The gitlink must equal `core-dependency.json`: setup refuses a mismatch and
`tests/test_core_dependency.py` fails on one, so bump both in the same commit.

## Fetch, verify, run

```sh
python3 scripts/setup_core.py                    # fetch or move third_party/Omega to the pin, verify, prepare the cache
python3 scripts/setup_core.py --source PATH      # the same, from a local clone, bare repo or git bundle (offline hosts)
python3 scripts/setup_core.py --verify           # check only
```

`core-dependency.json` also pins the two Iter checkouts Iter minds run (`iter` in `third_party/iter` and
`iter_metta` in `third_party/iter-metta`, flagship omegahive#74). Setup clones them beside Omega, except with
`--source`: a host that passes a bundle is offline and brings Omega alone, and its first Iter mind clones Iter
(`Workspace.iter_source`). `--verify` checks them too.

Setup never runs Git in the parent checkout: it does not create `.gitmodules`, stage, commit or reset. A plain
`git submodule update --init` gives the same checkout; setup accepts either. It refuses to move a dependency that has
local edits. A copy-over of an older tree removes only retired core files whose hashes it recognizes
(`CORE_RETIRED_FILES.json`, including our own earlier versions) and refuses unknown edits.

Git runs only at setup, and in the hive process when the dependency changed since it was last checked. The hive
process then records the revision and a content digest of `third_party/Omega` in the runtime cache
(`dependency.json`). A mind never runs Git: at boot it recomputes the digest and compares it with that record. Minds
run in the OS sandbox, where Git cannot read its configuration (on macOS Apple's `/usr/bin/git` shim also wants a
cache under `/var/folders`), so a Git call there would stop the mind from booting.

Generated runtime files live under `$XDG_CACHE_HOME/omegahive/<checkout-id>` (default `~/.cache`), outside the source
tree. Set `OMEGACLAW_RUNTIME_CACHE` to choose another directory. The supervisor grants the mind read-only access to
that directory; Docker mounts it read-only at `/opt/omegahive-cache`. A read-only source tree needs the dependency and
cache prepared first.

The source installer copies its local source bundle (without `third_party/`) and runs setup, which fetches the pinned
revision. An existing workspace with a different source tree is refused, not overwritten.

## Install or replace an older checkout

A source release (`scripts/build_release.py`) is a ZIP of the tracked files under `omegahive/`, with dotfiles, CI,
tours, Docker files and Unix executable modes. Use `unzip` and `cp -a` to keep them, including the trailing `/.`:

```sh
unzip omegahive-release.zip -d /tmp/omegahive-release
# From your existing repository root:
cp -a /tmp/omegahive-release/omegahive/. .
python3 scripts/check_release.py --fix-modes
python3 scripts/setup_core.py
```

Keep `.git` and live data; no backup copies are made. `check_release.py` checks every shipped file against the
release manifest (`RELEASE_FILES.json`) and restores executable modes a graphical copy tool lost. Setup then fetches
the pins and removes only the retired core files it recognizes, as above. The public PeTTa and Singnet dependencies
need network access on first installation; `setup_core.py --source` takes the Singnet pin from a bundle instead.

## Ownership

| Service | Implementation | Hive extension |
| --- | --- | --- |
| Scheduling, requests, message lifecycle and tool dispatch | Singnet `src/loop.metta` and `src/providers.*` | Lifecycle hooks, quiet boot, mutable energy settings, chosen waits and per-command authorization |
| Provider HTTP clients, retries and response parsing | Singnet provider plugins and `providers/lib_llm_ext.py` | Hive gateway binding, legacy text reply conversion, optional cost ledger and configured OpenRouter routing |
| Configuration lookup | Singnet `src/config.py` | Existing Hive environment names and typed MeTTa assignments |
| Channel dispatch registry | Singnet `src/channels.*` | Adapters to existing authenticated Hive, WhatsApp, Telegram, IRC, Slack, Mattermost, mock and multi-channel implementations |
| Generic utilities, file I/O, shell execution and dynamic skills | Singnet `src/utils.*`, `src/fileio.py`, `src/skills.*` | Hive shell guard and explicit confirmation; Hive-specific catalogs and commands |
| Embeddings and vector remember/query | Singnet `src/memory.metta`, provider embeddings and RAG bridge | Promoted retrieval, bounded context and tolerant history lookup |
| NAL and PLN, including browser sources | Singnet `lib_nal.metta` and `lib_pln.metta` | Existing Hive reasoning skills and browser interpreter |
| Private symbolic spaces and attention | `hive/runtime/extensions/` | Existing registry, persistence, bounds, reasoning spaces, skill affordances and attention |
| Shared symbolic commons | `hive/spaces/` | Existing PeTTa service and policy |
| App creation, ITER, body/sense modules, publishing, APIs and UI | Existing Hive modules and services | Retained; imports and inventory paths updated where needed |

`src/` still contains Hive-specific features such as `omegacode/`, energy,
observation and body tools. It no longer contains `loop.metta`, `memory.metta`,
`utils.metta`, `helper.py`, or the embedded generic skill implementation.
Moving feature code into extensions is only part of the extraction: duplicate
core services were removed and their callers use the dependency.

## Composition and upstream patches

`lib_omegaclaw.metta` composes upstream services, Hive extensions, selected
modules, attention, then the scheduler. This order matters because PeTTa
compiles calls when importing definitions. `OmegaClaw-Core` remains the
historical **Hive import alias**, not a second implementation.

The pinned upstream revision lacks Hive lifecycle hooks. `native_core.py`
therefore generates external-cache files from the upstream sources with checked
adaptations: import paths, lifecycle hooks, per-agent prompt/history paths,
configuration value conversion, and the shell-policy call boundary. The native
recursive scheduler, provider engine, utilities, memory primitives and shell
execution are upstream implementations. Python services load from the clean
dependency; the history helper has a checked path adaptation.

`singnet-core.json` in the runtime cache records source and generated hashes for every
rendered file, including the foundation. The hive verifies the dependency and prepares
the cache once before starting its first Omega mind. Concurrent starts share that
preparation. A failed preparation is retried on the next start. Each mind only checks
the rendered files against that read-only receipt with SHA-256; it never runs Git or
re-renders upstream sources during boot. Missing or altered files refuse startup.
Restart the hive after updating the dependency or composition code so it prepares the
new runtime before starting minds.
The dependency itself is never patched. Generated files live outside the checkout and
must be prepared before a read-only Docker mount. Dependency upgrades require
reviewing the patches and rerunning the integration tests.

Hive retains its own authorization and supervisor sandbox. The native Landlock
policy is not applied over Hive's existing policy during boot. External provider
and channel credentials are still required for those integrations.

## Preservation and validation

`CORE_PRESERVATION.json` accounts for every source file of flagship's pre-extraction tree: unchanged, updated, moved into a Hive extension, or replaced
by its upstream implementation. `CORE_RETIRED_FILES.json` is the exact checked
copy-over cleanup list. Docker, CI, documentation, WhatsApp and all feature
modules are retained. Original closed-source notices remain in force.

See `CORE_VALIDATION.md` for measured results and untested boundaries. A passing local test suite is not a claim
that external accounts or production deployment have been exercised.
