# Isolated OmegaCode browser interaction check

From `hive/ui`, with an existing compatible Chromium executable:

```sh
node scripts/omegacode-browser-check.mjs --browser /absolute/path/to/chromium --receipt /absolute/path/to/check.json
```

Uses the retained UI dependencies (Vite and playwright-core). No browser/dependency download, no live Hive client, service token, paid model, deployment or registered repository is used. The fixture imports the real GitExportPanel, SymbolicPanel and ConfirmHost; callbacks return synthetic export metadata. The loopback server uses an ephemeral port and its own temporary optimizer cache. All browser HTTP requests outside that exact origin are blocked. Browser/server/cache cleanup runs on success or failure. At least 10 GiB free storage plus 2 MiB scratch headroom is required.

The actual browser suite checks visible approval with a later-mounted hidden Symbolic pane, cancellation without a request, original-history mode and Unicode message, frozen exact retry after a synthetic lost response and later source change, draft blocking, refusal if source changes while approval is open, and narrow viewport draft retention/Escape cancellation. Receipts bind the runner, fixture and relevant component hashes. These are synthetic component interaction checks, not service/model/deployment or comparative parity qualification. No screenshot/visual review is inferred from viewport assertions.

`--serve-check` only checks loopback HTML/component transformation; its receipt explicitly leaves browser interactions unexecuted. A missing/unusable browser refuses with exit 3 and an unexecuted receipt. Neither is a passing browser suite. This runner is intended for the candidate chain including the hidden Symbolic confirmation fix, not the earlier Symbolic-only commit.

Fixture type check with TypeScript 6:

```sh
node node_modules/typescript/bin/tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution bundler --jsx react-jsx --types vite/client scripts/fixtures/omegacode.tsx
```
