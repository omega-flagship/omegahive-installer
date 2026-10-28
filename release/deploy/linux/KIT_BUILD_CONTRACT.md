# Browser-downloaded Linux kit

`build_kit.py` prepares one self-contained installer from reviewed local inputs.
It does not download, authenticate, install dependencies, invoke Git, execute
supplied code, build the application or UI, or publish a release. Browser access to a
private release never becomes a token or cookie for a later command.

This Source is disabled: `FINAL_RELEASE_BOUND` is false and both input-manifest
pins are null. The example is data only and cannot build a kit. Exact release,
runtime, app, bootstrap and scrub-review inputs remain required.

## Fixed local inputs

A reviewed Source successor binds only `FINAL_RELEASE_BOUND`, `INPUTS_BYTES` and
`INPUTS_SHA256`. The exact closed `kit-inputs.json` is alongside the script, and
every named local input is beneath the fixed sibling `kit-inputs/` directory.
The CLI is `python3 -I -B -S build_kit.py --build-reviewed-kit`. No arbitrary input
path, output directory, command, module or build dispatcher is accepted.

The outer `kit-inputs.json` keeps the seven-key `omegahive-linux-kit-inputs/1` schema shown by the disabled example: `schema`, `ready`, `github`, `forbidden_public_terms`, `installer_template`, `release_manifest`, and `artifacts`. Artifact pins are exact `{path, bytes, sha256}` objects. `artifacts` is the complete outer payload: `install.py`, `release-manifest.json`, the identical scrubbed source tarball, platform core/build locks, the two app archives, the bootstrap helper/seed, and both the prebuilt UI archive and its raw manifest. The fixed installer template has a separate three-field pin and is not an outer payload member. Files must be regular, single-link, owned by the current user, without group/world write access, and stable while read. Symlink ancestry is refused. All paths are canonical relative names; duplicate or extra declarations are refused. The tool does not enumerate a directory to discover inputs.

## Prebuilt UI in the release manifest

The pinned `release_manifest` artifact contains the separate release-manifest document. That document uses schema `studio-linux-user-release/2`; its `ui_prebuilt` field is nested inside the release manifest and does not add a key to `kit-inputs.json`. The release v2 contract has no `node_version` or per-platform `node` package. The historical kit packager R3 donor validates the earlier release-manifest schema. This disabled R7 Source successor implements v2 validation; its execution and release qualification remain unestablished.

`ui_prebuilt` has exactly `archive`, `manifest`, `source_revision`, and `source_tree`. Each of `archive` and `manifest` is an exact `{path, bytes, sha256}` `ArtifactSpec`. Their local files must also be included in `kit-inputs.artifacts`; the builder verifies each file against its declared path, byte count, and SHA256. `source_revision` and `source_tree` must match the raw UI manifest's `source_commit` and `source_tree`. They describe the UI build source independently from the release tarball's `github.commit` and `github.tree`.

The raw UI manifest has exactly six keys: `built_with`, `file_count`, `files`, `format`, `source_commit`, and `source_tree`. Its format is `omegahive.ui-prebuilt/1`; `files` is a complete mapping from canonical relative paths to exact `{bytes, sha256}` rows. The currently pinned owner-supplied manifest declares 223 files (7,682,459 total file bytes) from source commit `ee370059eb0f28356bc1c3fc78caaa0d2183d6c6` and tree `a56a4f732610a6b43198ac4bf0652b83a5f790e4`. Its `built_with` value records `npm ci && npm run build (node v26.0.0) on the Mini`; this is build provenance, not an installation command or a user-side prerequisite.

The packager verifies the entire UI tar against the manifest: every declared file appears once, no undeclared member appears, and each body matches its declared size and SHA256. Accept only the documented raw tar header form; reject GNU and PAX extensions, sparse members, links, special members, malformed or oversized headers, unsafe or duplicate paths, file/ancestor collisions, nonzero body for directories, missing end markers, or nonzero trailing data. Require two zero end blocks and a zero-only tail. Bound aggregate UI file bytes to 32 MiB, the complete raw tar stream to 40 MiB, and each UI file to 8 MiB; count headers, padding, and end blocks in the stream bound. Apply the existing public-text scrub rules to UI paths and eligible text bodies. The manifest is an integrity checksum list, not a signature or proof of publication authority.

The builder packages the already-built UI only after these checks. The user's installer runs no `node`, `npm`, or UI build step, and does not need Node for the UI.

The GitHub subject binds the repository, exact `release/linux-test-20261028`
branch, full commit and tree, one unsigned HTTPS release-asset tarball URL, and
one top-level tar prefix. The URL is provenance data; the builder makes no HTTP
request. Both architecture rows must reference the same source tarball object.
Their explicit `source_payload.prefix` must exactly equal `github.source_prefix`:
one nonempty canonical component, without slash or trailing slash. The reviewed
installer successor uses this same field to validate all archive paths and strip
exactly this prefix before materializing the root-relative file inventory. An
installer without that explicit prefix contract cannot be paired with this kit.
Tar directory headers must have zero body and canonical names (one optional
directory slash); file names cannot be made canonical by silently trimming a
slash. This matches the prefix-aware extractor's acceptance contract.
The tarball's entire declared file vector is verified, and its Git blob/tree
identities are recomputed from bytes and executable modes. A tarball with export
omissions does not qualify as the supplied full Git tree. Such a mismatch must
be reconciled explicitly before a final release is bound.

All module rows join both source vectors; the top-level `install.py` joins
`deploy/linux/install.py`. Both app archives keep their exact original bytes and
have closed file inventories. Source/app links, undeclared directories, duplicate
members and unsafe paths are rejected. App program digests remain subject to the
installer's separate canonical program-admission check; this packager does not
execute that check. Locks require exact versions and SHA256 hashes; the core lock
must include the six Hive roots and Janus. Both architectures need exact public
runtime artifact URLs, byte counts, hashes and versions. No private runtime URL,
credential URL, query string, fragment, missing checksum, or unbound metadata is
accepted.
Every source/app file inventory also rejects file/ancestor collisions, regardless
of row order. Directory-named app ZIP entries must have compatible directory
type (or no Unix type), zero uncompressed body/CRC, and an actually empty decoded
body; a trailing slash cannot hide a symlink, regular-file type or payload.

The local R2 source inventory verified the L0 `deploy/linux/` module paths in tree `a56a4f732610a6b43198ac4bf0652b83a5f790e4`. That inventory does not bind a later R3 deployment source or a GitHub release; each remains a separate subject requiring its own exact inventory. This builder must refuse a source inventory that lacks required module files rather than inject them or claim a different release is usable.

## Scrub review

`forbidden_public_terms` is a private, reviewed input list; it is not placed in
the output. The builder rejects those terms in public text/member names and
rejects platform user-directory paths. Reviewers must supply a complete relevant
list and inspect the release payload. This finite text check cannot establish
that every possible personal datum has been removed, especially from binary
assets. The tool's code and documentation contain no machine-specific paths or
individual account names. Archive checksums identify bytes, not signatures or
publication authority.

Text suffixes are case-insensitive and include Python/shell/config/docs plus
TS/TSX, JS/MJS/CJS/JSX, HTML, CSS, SVG and MeTTa. Every source/app file is bounded
to 8 MiB. Files with unknown or no suffix are additionally screened when their
complete bytes decode as UTF-8; non-UTF-8 binary fonts/assets are hash-checked
without being misclassified as required text. This does not make arbitrary
binary content a privacy-qualified payload. The exact official
`releases.astral.sh` runtime host is allowed alongside the existing public host
set. Actual URL/version/hash provenance still must be supplied; no equivalent
URL or checksum is guessed or fetched by the packager.

## Output and limits

The only outputs are new exclusive `kit-output/omegahive-linux.sh` and its SHA256
sidecar. The gzip/tar envelope is deterministic and contains only declared
regular members; source/app archives are copied byte-for-byte. The reviewed
installer template changes only its three existing release/size/hash literals,
then receives Base64 after its existing marker. It needs no new local-artifact
lookup hook. The installer resolves each release-manifest local `path` beneath
its extracted bundle, before any privileged dependency phase.

Limits match the reviewed installer: at most 128 outer members, 64 MiB per member
and compressed bundle, 128 MiB total outer payload, and 96 MiB final script.
Source inventory is bounded to 5,000 files / 256 MiB and its complete tar stream
to 288 MiB. Each source/app inventory file is at most 8 MiB. These stricter input
limits may refuse a larger release rather than silently expand the contract.
All supplied inputs are reread against their pins before output creation.

The existing R3 authored tests cover disabled-before-effects behavior, strict JSON and path
validation, pin types, scrub rules, URLs, independently constructed Git tree
identity, archive links/extras/modes, file/ancestor and directory-type conflicts,
the common 5,000-file boundary, lock requirements and exact wrapper binding.
`test_kit_installer_prefix.py` additionally requires the exact reviewed prefix-aware
`install.py` beside it in an admitted positive test stage. It sends identical
synthetic tar bytes through the kit's inventory/tree check and the real installer
extractor, checks root-relative Linux module paths, and requires wrong prefixes,
extra directories, links and missing files to refuse. It also compares both
catalogue count decisions at 5,000 and 5,001. There is no old-installer fallback
or skip; absent fixture Source is an unmet dependency. The installer fixture is
an independent Source reference, not a file injected into an owner tarball.
This R7 Source retains all 29 earlier case identities and adds 10 test methods for the nested v2 schema, complete UI manifest-to-tar membership and hashes, metadata, raw headers, padding and hidden tails: 39 authored case identities in total. These tests have not been run. A separately admitted job must run all cases with the exact real R7 installer fixture and perform the final
bookkeeping build. The resulting kit still requires installer and fresh Linux
journey validation plus owner review before publication. No SHIP or deployment
claim follows from creating a local kit.
