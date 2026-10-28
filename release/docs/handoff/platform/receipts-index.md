# Platform receipts index (metadata only)

The Platform lane keeps receipts in a private receipts folder in the coordination area. They are not copied into this repository. This index lists the receipt families, roughly how many entries each has (counted by filename on 2026-10-09, about 915 entries in total), and what each family proves. Live acceptance receipts are kept separate from mock or replay demos, and each claim is bound to the command that witnessed it.

## Receipt families

| Family | Count | What it proves |
|---|---|---|
| Review owner probes and re-reviews | ~540 | The Review owner's independent probes of platform candidates: source re-reviews, focused probes of each "next" batch, final pins before deploy, Surface and Code review rounds, hotfix checks. These are the second-receipt half of the two-receipt rule |
| Deploys, rollouts and rollbacks | ~70 | Each deploy to the cloud hive and each Mac rollout: the release deployed, what changed, the review verdicts it rested on, the post-restart sign-in and render checks, and any rollback with its cause |
| Other app owners' integration receipts | ~75 | Planner, Flow, Match, Purple, Evolve and Graft candidates checked against the host: contract compatibility, custody, security batch compatibility, tool inventory, learning consumers |
| Design and Studio releases | ~30 | Studio release assemblies, original-artwork goal wiring, media deny checks, successor candidates, cloud compile runs |
| Reasoning and mind fitness | ~25 | The mind fitness audit evidence, Hyperon tuning baselines, reasoning-viewer and symbolic corrections |
| Platform feature candidates | ~13 | Candidate builds for Ask, mind chat identity, mind control, linkage slices, draft ops, motivations, Coffee Room and rooms, each with its test log |
| Suite runs | ~13 | Mac and server full-suite logs for specific candidates (host fixes, releases, linkage, Coffee Room); the evidence behind "full suite passed" |
| Surface and UI | ~11 | Frame CSP seal, browser worker slice, Surface frame kit and Ask corrections |
| Code service releases | ~4 | Code service release switches and the runtime setup run on the server |
| Library | ~3 | OmegaLibrary slice 1 receipts and its 0.1.0 install |
| Consent gates | ~2 | Copy-apply consent gates (third revision) and the copy-effect policy owner record |
| GitHub preparation | ~3 | App repositories inventory, repository prep, and the repository-ready verification (not pushed) |
| Disk and backups | ~3 | Disk recovery steps, plus one private record not indexed here |
| Miscellaneous platform | ~20 | Early acceptance (both apps on one synthetic hive), archive-never-delete, review terminal validation, rooms step 1, cloud hive setup and access, model split, a live-to-previous rollback |
| Private-app receipts | ~105 | Receipts owned by the two private apps' owners. Private; not indexed further here |

## Inbox (summary, not copied)

The coordination inbox holds about 2,300 message files (plus about 500 handled ones moved to a done folder). Kinds of message that flow there:
- owners announcing a candidate is ready, with a receipt pointer;
- review requests and review results from the Review owner and the independent reviewers;
- Platform replies, rulings relayed from the project lead, and requests to owners;
- interface questions and answers between owners (Code, Design, Surface, Tools, Atom, Reason and others);
- blockers, disk or housekeeping notices, and restart holds.

The busiest senders by volume are the Code, Review, Design, Platform and Surface lanes. Messages from the private-app owners are metadata only.

_Curated summary. Full version kept privately (source: receipts-local/ folder listing and inbox/ folder listing; no file contents read for this index)._
