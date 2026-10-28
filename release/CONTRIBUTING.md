# Contributing to OmegaHive

Thanks for helping. This is short on purpose.

## Before you start

1. **Set up** with the exact versions in the README ("Prerequisites" and "Quick start"). If a step
   fails or needs a guess, that is a bug in our docs; please open an issue.
2. **Check the tier** of the folder you are changing (README, "Tiers"). Closed folders
   (`hive/plugins/omegaevolve`, the OmegaTown experience, the WhatsApp bridge folders) are shared
   privately and must not be copied into open code.

## Branch and pull request

- Branch from `main`, one change per pull request, and fill in the pull request template.
- Keep commits focused. Say what changed, why, and how you tested it.

## Tests

- Run the tests for the area you changed, plus a smoke run.
- Changes to core plumbing (auth, spaces, gateway, supervisor, policy) need the full
  `hive/tests` run with a working PeTTa.
- UI changes: `npx tsc -b --noEmit` and `npx vitest run` in `hive/ui`, and a look at the page in
  a browser.
- Changes to NAL, PLN or commons truth functions go to the reasoning domain author before merge,
  and must update `docs/reasoning-deviations.md`.

## Review: two reviewers

Every change needs **two independent reviews** before merge, and neither reviewer may be the
author. Code written with a language model must be read and understood by the person who submits
it. A review is void if the change is altered after it.

## Data and secrets

- Only synthetic data in tests, fixtures, demos and screenshots: no real people, no private
  records, no personal paths.
- No secrets: no `.env` files, keys, tokens or sign-in files (see `SECURITY.md`).

## Versioning

Each repository is versioned on its own with [Semantic Versioning](https://semver.org/):
`MAJOR.MINOR.PATCH`, tags `vX.Y.Z`, and a `CHANGELOG.md` entry for every tag. The host starts at
0.1.0 (the initial import). The app contract has its own version (`contract 0.1`, `0.2`, see
`hive/PROGRAMS.md`): an app declares the contract it implements in `plugin.json`, a breaking
contract change bumps the host's MAJOR (MINOR while below 1.0), and additive contract features
bump MINOR. Apps state the minimum host and contract version they need, and exact deployments are
pinned by digest (`HIVE_APP_PINS`), never by a version string. The current matrix is in
`docs/COMPATIBILITY.md`.

## Licence

Contributions to the open parts are under Apache-2.0 (`LICENSE`). By submitting, you confirm you
have the right to contribute the code. Contributions to closed folders follow `CLOSED_SOURCE.md`
in that folder.

## Conduct

See `CODE_OF_CONDUCT.md`.
