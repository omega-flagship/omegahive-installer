# Current and legacy parts of this repo

**Current** means the parts that are the design going forward. **Legacy / reference** means outdated compared with the current hive and apps. Legacy parts are kept so the team can see where things came from, and in some cases because the current hive still runs on them. Do not treat legacy parts as the target design.

## Current
- `hive/`: the OmegaHive server, UI, Ask, minds, swarms, apps contract and supervisor.
- `deploy/` and `scripts/`: running and deploying the hive.
- `omegabench/`: benchmarks for the hive.
- These docs:
  - `docs/START_HERE.md`, `docs/FEATURES.md`, `docs/STATUS.md`, `docs/MODULARITY.md`
  - `docs/COMPATIBILITY.md`, `docs/EARLIER_EXPERIMENTS.md`, `docs/reasoning-deviations.md`
  - `docs/probes/`, `docs/theory/`
  - the root `README.md` and `STATUS.md`
- The app repos (`omega-tools`, `omegaplanner`, `omegalibrary`, `omegadesign`, `omegacode`, `omegafusion`, `omegasocial`, `omegapurple`, `omegaatlas`, `omegatruth`).

## Legacy / reference

### Inherited OmegaClaw Core runtime
`src/`, `modules/`, `channels/`, `lib_*.metta`, `lib_llm_ext.py`, `run.metta`, `memory/`, `install/`, `tests/`, `Autotests/` and `demos/`.
- The hive's minds still run on this runtime, and the NAL/PLN libraries live here.
- It is a copied snapshot of OmegaClaw Core, not the current design. Expect it to be replaced by a pinned upstream dependency or by the V2 mind (see `docs/MODULARITY.md`).

### Inherited OmegaClaw documentation
- `docs/introduction.md`, `docs/omegaclaw-core.md`, `docs/tutorial-*.md` and `docs/reference-*.md`, except four reference pages that are current: the module contract (`docs/reference-omegaclaw-module-contract.md`), the channels contract (`docs/reference-channels.md`) and the NAL and PLN library references (`docs/reference-lib-nal.md`, `docs/reference-lib-pln.md`).
- These describe the single-agent OmegaClaw loop, not the hive.

### Session history
`docs/handoff/`, `docs/review/`, `docs/retired/`, `docs/inherited-workflows/` and `docs/omegadots/`. These hold earlier plans, reviews, handoffs and research, and are dated.

### Other repos in this handover
- `omegav2`: an earlier, deeper design of the mind.
- `omegahive-candidates`: early modules.
- These are reference, not current. Useful ideas from them are listed in `docs/EARLIER_EXPERIMENTS.md`.

## Compatibility
Many of these modules and add-ons have not been fully ported to the latest hive. They are known to work in previous builds, but their compatibility with this hive is untested. See "Known issues" in `STATUS.md`.

## How legacy parts are marked
Each legacy folder has a short `LEGACY.md`, and each legacy doc starts with a one-line "Legacy / reference" note.
