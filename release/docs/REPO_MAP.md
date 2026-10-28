# The repository map (repo-map/1)

## What it is

A repository map is a JSON envelope in the `repo-map/1` schema that describes one exact commit of a repository:
one node per tracked file (`file`, or `doc` for `.md`/`.rst`/`.txt`), one `def` node per Python function or class,
and edges between them (`defines`, `imports`, `calls-expression`). Every node and edge carries references
`{path, line, excerpt}` back to the source at that commit, and every file node carries the sha256 of the file's
bytes (`source_digest`).

The map is description, not authority. When an admin loads it, the host (`hive/core/repomap.py`) validates it
once, stores it, and derives inert MeTTa atoms from it (`repo-map`, `repo-node`, `repo-edge`, `repo-ref`,
`repo-unresolved`; excerpts stay in the JSON and never become atoms). The atoms are mounted in the read-only space
`repo:<repo>@<sha>`, which only the loader writes. Nothing in a map is evidence, a truth value or a permission.

Everyone reads through the same methods:

- the HTTP routes: `GET /api/repo-maps`, `GET /api/repo-maps/{repo}/{sha}`, `.../nodes`, `.../nodes/{node_id}`,
  `POST /api/repo-maps/{repo}/{sha}/query`, `GET /api/repo-maps/{repo}/presets` and
  `GET /api/repo-maps/{repo}/drift?from=&to=`;
- the minds' `repo-query` skill, which calls those routes with the mind's own token;
- the MCP tool `hive_repo_query`.

A map the caller may not see answers `404 not_found`, exactly like an unknown one.

Coverage is deliberately partial. Only Python is parsed (at most 512 files and 8 MiB of Python per map, taken in
sorted path order); other files are inventory nodes only. `calls-expression` edges are name candidates
(`basis: heuristic`), not resolved calls. Everything the extractor could not resolve is listed in
`coverage.unresolved`, so the map's `state` is `partial`.

## How to rebuild it

The generator is `build_repository_map` in `omegacode/src/omegacode/repository_map.py`. The driver reads the
tracked files of one commit straight from git objects (never the working tree, so untracked or edited files cannot
get in), uses every tracked regular file, refuses links and submodules, and stops if the census exceeds the
generator's limits (4096 files, 96 MiB). `generated_at` is the commit time, so a rebuild of the same commit gives
the same bytes.

From the OmegaDot folder:

```
.runtime/venv312/bin/python coordination/omegacode/poc/build_handoff_repo_map_20261020.py \
    --git-dir <omegahive clone> --rev 6273126f95114a0fe5b2d2aeacdd2874faa4fedf
```

It writes `REAL_repo-map-1.<short sha>.json` (the envelope), `.receipt.json` (the full census, facts and the
digests of the generator modules) and `.summary.json` into `coordination/omegacode/intake/repo-map/`.

## How an admin loads it

Loading needs an admin session. Post the envelope as the request body:

```
POST /api/admin/repo-maps?visibility=hive&pinned=false
Content-Type: application/json

<the envelope file>
```

- `visibility`: `hive` (the default: every member and mind can read it) or `swarm:<id>` of an existing swarm
  (that swarm's minds, its owner and the people it is shared with; admins always see every map).
- `pinned`: `true` (or `1`) keeps this revision past retention. Without it, the newest 5 revisions per repo are kept.
- The body limit is 32 MiB; a map holds at most 100,000 nodes and 400,000 edges.
- Loading the same content again is idempotent (`unchanged: true`); different content for a loaded
  `repo@sha` is refused with `409 map_exists`. A loaded revision is never changed in place.

## The current map

| | |
|---|---|
| repo | `physixsnet-omegahive` |
| sha | `6273126f95114a0fe5b2d2aeacdd2874faa4fedf` (branch `handoff/live-20261020b`, the code commit before this document's update) |
| envelope | `REAL_repo-map-1.6273126.json`, 24,539,814 bytes, sha256 `b5ccbc9c9bbbdf6d695fca81c18ee862fc65ea12f37b6fdafa353acbc3f3cf5b` |
| content digest (host `digest_of`) | computed by the host on load (`digest_of`); for the previous map at da60fd1 it was `sha256:ec3fbd677828be6d00fd7eb9a4a725e03a22fa27475ad1024cbc20198b791ac9` |
| snapshot digest | `sha256:385c4a2b45a2af9cbe2467faf2ebd21c789f7daaa32558d258491a0aad80ca5e` |
| state | `partial` |
| inventory | 2,459 tracked files, 68,100,541 bytes |
| Python | 580 files; 512 parsed; 68 not parsed (`python_file_limit`: 14 under `src/`, 54 under `tests/`) |
| nodes | 11,993: 2,297 file, 160 doc, 9,536 def |
| edges | 33,903: 9,536 defines, 1,864 imports, 22,503 calls-expression |
| refs | 49,579 |
| unresolved | 1,040 entries (467 files with unresolved call bindings, 448 unresolved imports, 68 not parsed, 34 computed call targets, 17 dynamic code, 6 star imports) |

Host validation: the branch's own `validate` from `hive/core/repomap.py` (the function `RepoMaps.load` calls),
run offline without a database, accepts the envelope. The node and edge limits, the 32 MiB body limit (18.4 MB as
compact JSON) and the 192 KiB coverage limit are met, and the atom encoder produces 96,322 atoms. The load itself
(database, space mount, visibility and admin checks) was not run.

Link checks, against the git objects at the mapped sha:

| check | pass | fail |
|---|---|---|
| ref path exists at the commit | 49,579 | 0 |
| ref line is within the file | 49,544 | 35 |
| excerpt equals the line, as the generator truncates it (first 240 characters) | 49,544 | 0 (the 35 above have no line) |
| file node `source_digest` equals the file's sha256 (checked at da60fd1) | 2,455 | 0 |
| def node `source_digest` equals its file's sha256 (checked at da60fd1) | 9,529 | 0 |
| def `label` is the name defined on its line (checked at da60fd1) | 9,529 | 0 |
| edge `from` and `to` are nodes of the map (checked at da60fd1) | 33,833 | 0 |
| every tracked file has a node | 1 | 0 |

The 35 line failures are all the same known defect: an empty Python file (for example `hive/core/__init__.py`)
gets a file reference at line 1 with an empty excerpt, though the file has no lines. No other reference points into
an empty file.

The Studio files are in the map: `hive/core/studio_steps.py` (70 defs, including `_same_content` at line 816),
`hive/core/studio_makers.py` (29 defs), `hive/core/program_attachments.py` (29 defs, including `host_scope` at
line 91), and all 25 files under `hive/ui/src/features/studioLive/` as file nodes (TypeScript is not parsed, so
they have no defs).
