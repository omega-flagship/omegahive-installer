# OmegaHive private release report (2026-10-06, historical)

Prepared by the Platform lane at the project lead's request, at the 19:30 BST build cutoff. Kept as a historical record; current state is in the root `STATUS.md`. This is an honest account of what the release contains, what has been reviewed, and what has not been proven.

## 1. What this is

This is the OmegaHive platform at reviewed build `d5f608a` (as it ran on the owner's Mac hive), plus the reviewed platform fixes 9 to 13 (`a14fff3`), exported as a fresh repository. From 2026-10-06 the cloud hive on the SingularityNET server is the working hive; the Mac hive is for local testing.

**What "reviewed" means here:**
- **Changes in d5f608a:** each one went live on the Mac hive only after the native review swarm (OmegaReview) and an independent reviewer both passed it. A safe restart, a sign-in check and a written rollout receipt followed (internal receipts, not published).
- **Platform fixes 9 to 13 (below):** these passed source review and have full-suite runs. On the Mac at a14fff3 the suite showed 1029+ passed; on the server, 1009 passed with 1 expected failure. They have not yet gone live anywhere, so there is no rollout receipt for them yet.

### Live and reviewed today
- **Text Ask on every page.** You type a request; it goes to the mind that owns that area, and the answer comes back on the page.
  - Lost or unclear answers are never shown as refused.
  - Typing while the hive is still working is held and sent once.
  - Switching account cuts off old work.
  - Steering a mind mid-answer is not available yet, and the page says so.
- **Classic menu redesign.**
  - One menu model drives the rail, the More sheet and the command palette.
  - Right-click, long-press and drag-to-pin.
  - Members never see admin-only items.
- **Power modes:** Off, Quiet and Wake all.
- **Six looks:** Classic, Still, Canvas, Cosmos, Flux and Construct.
- **Commons and goals board fixes.** Uncertain outcomes are never shown as "nothing changed".
- **Mind fitness.** A shared hive-worker prompt, clear skill discovery, corrective refusal examples, chunked long revisions (contained in the mind's own folder) and an Iter toolkit.
- **App release pinning.** An app with a declared pin loads only from that frozen folder, and only if its digest matches. Apps with no pin still load under the existing reviewed contract.
- **Motivations, host side.** A "why" layer above tasks.
- **Benchmark owner rule.** A named admin stands for the hive owner.
- **Per-sign-in reference.** Attribution only, keyed, and kept consistent across tabs.
- **One-tap confirmations.** A host confirm token is required for consequential app actions.

### Platform fixes since d5f608a
| Fix | What it does | Reviews |
|---|---|---|
| **Fix 9** | Linux mind isolation: namespaces + Landlock + seccomp, fail closed. | Native source review and independent review passed |
| **Fix 10** | A restart starts the 24-hour clock on calls whose outcome is unknown, so they settle conservatively instead of being held forever. Adds a merge-review read relay. Tightens isolation: no `/dev/tty` on macOS, view folders 0755, symlinked read roots dropped. | Both independent reviews passed |
| **Fix 11** | Per-route query allow-list. Merge-review forwards only `verification_id`, keeping every value. | Both independent reviews passed |
| **Fix 12 (and its follow-up)** | The app tool-bundle runner refuses on Linux until a Linux bundle boundary is reviewed. Before this fix, fix 9 had made it crash there instead of refusing. Test fixes for slower hosts. | Both independent reviews passed (the native review's request for fixes first was answered by the follow-up) |
| **Fix 13** | The "unknown call expired" budget alert can be published. Before this fix it raised an error, and the alert was silently lost. | Both independent reviews passed |

**About the second reviewer:** on 6 Oct the native review swarm (OmegaReview) was stuck on a wording filter. The project lead approved a separate Codex reviewer, with the same brief and its own receipts, as the second reviewer. The review records are internal and are not published.

### Known limits
| Limit | Detail |
|---|---|
| **Linux mind isolation is new** | Minds run on Linux in private namespaces with Landlock (`hive/supervisor/landlock.py`, fix 9 `3f3bf20`; see `deploy/RUNBOOK.md` §5). The boundaries are its own folder, a relay to the hive's ports only, and no outside processes. **Fix 9 passed both the native review and an independent review.** The integration tests include Review's bypass probes. They pass in a Linux container (kernel 7.0), on the target server (Ubuntu 22.04, kernel 5.15, Landlock ABI 1) and on macOS (where they skip). Without Landlock or user namespaces, minds are refused (fail closed). The independent reviewer's non-blocking follow-ups (§5) ship next. |
| **Linux test suite** | The full hive suite at `a14fff3` passed on the target server (Ubuntu 22.04, kernel 5.15, 4 CPUs, as the service account): 1009 passed, 27 skipped and 1 expected failure. The failure is the Code-service release parity test, which deliberately fails until a Code release is installed beside the hive. |
| **No apps included** | Design, Purple, Fusion and Planner are owner releases and are not in this repository. Atlas and OmegaTruth were private at the time; they are now shared in the closed tier (code only, no data). |
| **Google sign-in** | Needs this server's redirect URI added to the Google OAuth client. |
| **Mind control** | Off. |
| **App tool bundles on Linux** | Refused (fail closed) until a Linux bundle boundary is reviewed. |
| **Models** | New minds default to OpenRouter Sonnet 5.5. Review minds use Sol 6.1, set per mind. |
| **Ask** | Text only. Voice ships next. |
| **Hyperon reasoning organs** | Not included. |

## 2. Not in this release (ships next)

Current status, 2026-10-06 evening:

| Item | Status |
|---|---|
| Ask voice (on-device speech first) | 3rd revision `4cc23f4`: native review passed, independent reviewer asked for fixes first; 4th revision in build |
| Resting mode | 2nd revision `090655f`: native review passed, independent reviewer asked for fixes first; 3rd revision in build |
| Design living canvas piece 1 (3rd revision, `39dcd76`) | Native review asked for fixes first |
| Ask in Cosmos, Flux and Construct | In build |
| Code workbench as a living canvas, phase 1 (`c46553c`) | Independent reviewer asked for fixes first; native review pending; recut in build |
| Design 0.4.6 (4th revision) | Native package review passed; independent review pending |
| Code service 584e | Review: ready for Platform staging |
| Code private component `166fee9` | Native review passed the bounded package; it is a separate repository and not part of this one |
| Linkage slice 1 (data-directory lock, startup recovery, mind-control merge with control off) | Native and independent reviews passed; not yet assembled |
| Linkage slice 2 | Paused until build helpers return on 9 Oct |
| Ask→task linkage design (latest revision) | Ready to freeze once its gates pass |
| Hyperon Phase A | Native and independent reviews passed; waiting on the Reason owner's operator-naming ruling |

## 3. What was removed for this release, and why

The export started from the reviewed live tree. These items were removed:
- **`hive/ui/scripts/.probe`:** local testing helpers. One wrote a sign-in session straight into a local database for the owner's account. A tool like that must never be shipped.
- **`hive/ui/scripts/.omegaui`:** local screenshot helpers with absolute paths.
- **`hive/ui/screenshots/live`:** screenshots of the live hive.
- **One absolute path in a code comment,** replaced with a description.

`memory/prompt.txt` (the base Omega prompt) is included, byte-identical to the reviewed tree. An earlier cut had dropped it by mistake because of an ignore rule.

### Never in the repository
- Runtime state, databases, OAuth files, API keys and the admin password.
- The launcher.
- Atlas and OmegaTruth code or data.

A pattern scan for secrets, keys and tokens found nothing.

### History
The release is a single new commit with no earlier history, so nothing removed above survives in git history.

## 4. Deploying

See `deploy/RUNBOOK.md`, which covers packages, runtime, the SWI-Prolog bridge check, UI build, settings, the systemd unit, the reverse proxy, health checks, backup and rollback.

The settings template is `deploy/hive.env.example`. It contains no secrets.

## 5. Follow-ups to the Linux isolation
The independent reviewer's follow-ups 1 to 4 on fix 9 are done in fix 10: view folders 0755, symlinked roots dropped in `landlock.profile()`, the hard-link scope note, and no `/dev/tty` on macOS. Still open:
- Pin runtime digests at launch, so that what runs matches what was reviewed.
- A reviewed Linux boundary for app tool bundles. Until then they are refused on Linux.

SHADOW EVIDENCE: none for minds.

**Observed so far on the server:**
- The previous private cut (`c016d64`) runs privately (loopback only, reached over SSH), with the UI served and Design 0.4.4 loaded.
- This release's full test suite passed there from a git checkout.
- The runtime (SWI-Prolog 10.1.14 with janus both ways, and PeTTa ae66fa8) was built there, and a MeTTa program ran inside a mind's Linux isolation.
- The hardened `deploy/setup_runtime.sh` (throwaway build account, root-only logs) ran end to end on the server and passed all its checks (exit 0, "RUNTIME-DONE"). Afterwards the build account no longer existed, its ACL on `/opt/omegahive` was gone, and no temporary folders remained. Reported by Platform; the evidence is in the server's root-only log.
- One SingularityNET model readiness check was made during setup; that key has since been removed.

**Not yet observed:**
- this release deployed and running;
- `deploy/setup_runtime.sh` on a completely fresh server (it has only been run on this one);
- any mind running on Linux.
