# A disposable local hive

One command starts a disposable local hive: fresh state each run, offline
models, loopback only. It is **not** a security sandbox. Read its limits
before you use it:

- **It runs as you, with your real `HOME`.** The hive and any mind it starts
  run as your user, with your home folder (`run-sandbox.sh` passes `HOME`
  through). Anything they write outside the temporary data directory, such as
  caches, tool configuration or the shared core checkout a module changes,
  stays after the hive stops.
- **Minds get no OS isolation.** `HIVE_MIND_SANDBOX` is not set, so a mind
  started in this hive runs without the OS sandbox: it can read and write what
  you can, and open network connections (`hive/supervisor/drivers.py:184`).
- **Imported apps are trusted host code.** `hello-app`, and any folder in
  `HIVE_PLUGIN_DIRS`, is imported into the hive process itself
  (`hive/core/programs.py:672-675`). An app can do anything the hive process
  can.
- **Loopback is not a wall.** `127.0.0.1` keeps other machines out, not other
  programs or users on this machine.

**For adversarial exercises,** such as probing isolation, running a hostile app
or module, or letting untrusted model output drive skills, use a disposable VM
or container, or OS isolation you have verified separately (see
`omegahive-schematics/05-governance/04-isolation.md` and launch item ISO3 in
`omegahive-schematics/09-security-and-launch/02-launch-readiness-checklist.md`).
This hive is for learning and for exercises with invented data that trust
their own code.

Start it:

```
examples/run-sandbox.sh            # port 8790
examples/run-sandbox.sh 8795       # or any free port you choose
```

Set up the toolchain first ([`examples/README.md`](README.md)). Then, from the
repository root:

```
export PYTHON=/path/to/python3.12 PETTA_PATH=/path/to/PeTTa PATH=/path/to/swipl-10.1.14/bin:$PATH
examples/run-sandbox.sh
```

## What it starts

[`run-sandbox.sh`](run-sandbox.sh) starts one hive process (`python -m hive`)
in the foreground and nothing else. No mind, UI build or other service is
started.

| Setting | Value | Why |
|---|---|---|
| `HIVE_HOST` | `127.0.0.1` | Reachable from this machine only. |
| `HIVE_PORT` | the first argument, default `8790` | Stays clear of a hive you may already run on the default port. A port in use is refused. |
| `HIVE_DATA_DIR` | a new temporary folder | Fresh state every run. It is deleted when the hive stops, unless `SANDBOX_KEEP=1`. |
| `HIVE_DEFAULT_MODEL` | `mock/echo` | The built-in offline model (`hive/core/gateway.py`, `mock_reply`). No API key. |
| `HIVE_EMBEDDING_MODEL` | `mock/hash` | Offline embeddings for mind memory. |
| `HIVE_OFFLINE` | `1` | No provider catalogue fetches at start-up. |
| `HIVE_PLUGIN_DIRS` | `examples/hello-app` | Mounts the hello-app exercise. |

The hive runs in a clean environment. Only `PATH`, `HOME`, `USER`, `LANG`,
`TMPDIR`, `PETTA_PATH`, and `HIVE_PROVIDERS_FILE` and `HIVE_CHROMADB_LIB` if
set, are passed on. Provider keys and other `HIVE_*` settings in your shell do
not reach it. `HIVE_ADMIN_PASSWORD` is not passed on, so the hive generates a
password.

## What it prints

Before the hive starts, the script prints:
- the URL, `http://127.0.0.1:<port>`;
- the admin password file, `<data dir>/admin-password`. The hive writes it on
  start-up when no password is set (`hive/core/app.py:107`). Read it with
  `cat`; the hive never prints the password itself (`hive/__main__.py:42`).

Stop the hive with Ctrl-C.

## Try the exercises in it

1. **hello-app.** Sign in with the password. Create a swarm. Open
   **Hello app** from the app list. Try **Open source** on a piece of evidence
   and **Add note** on the claim. See [`hello-app/README.md`](hello-app/README.md).
2. **hello-model.** Stop the sandbox, then start it again with
   `HIVE_PROVIDERS_FILE=$PWD/examples/hello-model/providers.json`. The model
   picker now lists `labbox/tiny-chat-7b`. A mind on it needs a real
   OpenAI-compatible server at the sample's address. See
   [`hello-model/README.md`](hello-model/README.md).
3. **hello-module.** Enabling a module changes the core checkout the hive's
   minds share, so do it in a scratch clone, then run the sandbox from that
   clone. See [`hello-module/README.md`](hello-module/README.md).

## Limits

- **No UI without a build.** The hive serves the UI from `hive/ui/dist`
  (`hive/core/app.py:42`). If that folder is missing, only the API answers.
  Build it once with `(cd hive/ui && npm ci && npm run build)`, which needs
  Node.js 22.12 or later.
- **Minds need PeTTa.** Without a working `PETTA_PATH` and SWI-Prolog bridge,
  the hive starts but native minds do not run.
- **Not for real data.** The app store, swarms and minds are all thrown away
  with the data directory. Use invented data only.
- **Not a security boundary.** See the four limits at the top of this page.
- **One process per data directory.** The hive locks its data directory for
  its lifetime ([`hive/README.md`](../hive/README.md), `HIVE_DATA_DIR`). Each
  sandbox run has its own, so two sandboxes on two ports do not collide.
