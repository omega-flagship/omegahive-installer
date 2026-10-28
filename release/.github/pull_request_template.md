## What changed and why

## Tier
- [ ] Only open (Apache-2.0) code is touched, or the closed folder's `CLOSED_SOURCE.md` rules are followed

## How it was tested
Commands run and their counts (for example `hive/tests/test_policy*.py`: N passed; `npx vitest run`: N passed).
- [ ] Tests for the changed area pass
- [ ] Full `hive/tests` with PeTTa (needed for auth, spaces, gateway, supervisor, policy changes)
- [ ] UI: `tsc -b --noEmit` and `vitest run`, and the page checked in a browser

## Checklist
- [ ] I have read and understood all of the code, including any written with a language model
- [ ] Synthetic data only; no secrets, real names or personal paths
- [ ] Docs and `CHANGELOG.md` updated where behaviour changed
- [ ] Two independent reviewers requested
