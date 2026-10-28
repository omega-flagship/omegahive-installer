# hello-app

The smallest useful program for the hive's adaptive app frame. It holds one
invented question in a Python dict and answers the program contract 0.1. The
full contract is in [`hive/PROGRAMS.md`](../../hive/PROGRAMS.md). The built-in
model for this example is
[`hive/plugins/contract_fixture`](../../hive/plugins/contract_fixture/program.py).

| File | What it is |
|---|---|
| `plugin.json` | The manifest: id, version, contract, module file and the capabilities the app asks for (none). |
| `program.py` | `describe()`, `view()` and `act()` over an in-memory store. |
| `tests/test_hello_app.py` | Runs the contract checker in-process and calls `view()` and `act()` directly. |

## What the host checks

- The manifest is read and the module imported by `Programs._load`
  (`hive/core/programs.py:654`). The id must match `[a-z0-9][a-z0-9-]{1,40}`
  (`hive/core/programs.py:664`), and every capability must be a known one
  (`hive/core/programs.py:93`).
- `describe()` must list kinds, each with a known role. Every relation needs a
  polarity (`hive/core/programs.py:686`, roles and polarities at
  `hive/core/programs.py:35`).
- Every `view()` result is checked by `validate_graph`
  (`hive/core/programs.py:1227`). It needs a revision, unique item ids, known
  kinds and relations, and links that stay inside the graph.
- Every `act()` result is checked by `validate_result`
  (`hive/core/programs.py:1295`). Its status must be one of `done`, `started`,
  `needs_input`, `stale`, `refused` or `error`.

## Step by step

All commands run from the repository root, with the toolchain in
[`examples/README.md`](../README.md).

1. **Run the checker.**

   ```
   python -m hive.programs_check examples/hello-app
   ```

   It loads the manifest and module, calls `describe()`, then `view()` in every
   stage (`unfold`, `map`, `compare`, `detail`). It checks that ids are stable
   and that `inspect-source` returns sources (`hive/programs_check.py:80`). The
   last line must be:

   ```
   COMPATIBLE with program contract 0.1
   ```

   If it prints `NOT COMPATIBLE: <reason>`, fix what the reason names and run it
   again. Repeat until it prints `COMPATIBLE`.

2. **Optional: the scenario check.**
   `python -m hive.programs_check examples/hello-app --scenario` also requires a
   question with supporting and opposing evidence. hello-app has both.

3. **Run the tests.**

   ```
   python -m pytest -q examples/hello-app/tests
   ```

4. **Mount it in a hive.** The hive loads extra programs from the directories in
   `HIVE_PLUGIN_DIRS`, separated by `:`. Each entry is one program directory, or
   a directory of program directories (`hive/core/programs.py:505`). For a
   disposable local hive with this app mounted, use the sandbox in
   [`examples/SANDBOX.md`](../SANDBOX.md). It sets:

   ```
   HIVE_PLUGIN_DIRS=$PWD/examples/hello-app
   ```

   Then sign in, open a swarm and pick **Hello app** from the hive's app list
   ([`hive/PROGRAMS.md`](../../hive/PROGRAMS.md), "Local live test", step 5).

5. **Change something and repeat.** Ideas:
   - add a kind with role `hypothesis` and a link to it, then rerun step 1;
   - make `view()` return a link to an id that is not in the graph, and read the
     checker's refusal;
   - add a capability to `plugin.json`. A capability the host does not know
     stops the app from loading. A capability the app uses but did not declare
     is refused at call time with `capability_missing`
     (`hive/core/programs.py:113`).

## Notes

- The store lives in the hive process. It is reset when the hive restarts.
- `add-note` changes the store and moves the revision from `r1` to `r2`. A
  request carrying an older `base_revision` gets `status: stale`.
- The checker never runs `add-note`. It only runs the mutating `correct`
  action, and only with `--allow-mutation` (`hive/programs_check.py:137`).
- Everything here is invented. The `example.org` links go nowhere.
