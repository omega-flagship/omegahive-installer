# Modularity assessment (October 2026)

This is an honest map of how modular OmegaHive is today, and where a new contributor or agent should be careful. It describes the release this repo was prepared from (5617f4e), with the handover-round moves noted. Each item gives the evidence and what to look for.

## Summary

| Area | Score | One-line reason |
|---|---|---|
| Apps and services | 8/10 | Each app is its own repo and release behind a fixed contract |
| Web UI | 7/10 | Organised by feature; experiences and looks plug into a registry |
| Hive server core | 4/10 | A few very large files hold most routes and cross-cutting rules |
| Runtime packaging | 3/10 | The OmegaClaw Core runtime is copied in, not linked |

## Tier map

| Tier | Where |
|---|---|
| **Open (Apache-2.0)** | This repo (except the folders below), `omega-tools`, `omegaplanner`, `omegalibrary`, `omegahive-candidates` |
| **Closed Source for Product Consideration**, separate repos | `omegadesign` (Studio), `omegafusion`, `omegacode`, `omegasocial`, `omegapurple`, `omegaatlas`, `omegatruth`, `omegav2` (the Omega V2 mind) |
| **Closed Source for Product Consideration**, folders in this repo | `hive/plugins/omegaevolve` (Evolve), `hive/ui/src/experiences/omegatown` (OmegaTown), `channels/whatsapp_bridge` and `modules/channel_whatsapp/src/whatsapp_bridge` (GPL-3 dependency) |

Closed code is shared privately with the SingularityNET team; it must not be copied into open
code. The tier boundary follows the module boundaries described below, so open code reaches closed
code only through the app contract, the experience registry or the channel module interface.

## What is already modular

- **Apps are plug-ins.**
  - Studio (OmegaDesign), Tools, Fusion, Planner, Library and the Code service each live in their own repo, with their own release (see the tier map above, and `COMPATIBILITY.md` for versions).
  - The hive talks to them through the programs contract: actions, homes, activations and grants. See `hive/PROGRAMS.md`, `hive/core/programs.py`, `hive/core/program_actions.py` and `hive/core/program_attachments.py`.
  - You can add, update or remove an app without changing the platform.
- **The Code service is separate** and sits behind a written owner contract (the reviewed Linux interface contract plus its amendments; see `docs/handoff/`). The hive reaches it through a proxy (`hive/core/code.py`).
- **The UI is organised by feature.**
  - `hive/ui/src/features/*` has 39 feature folders.
  - Experiences (Classic, Cosmos, Construct, Flux, Still, Canvas, Town, Professional) and looks register through a registry, so you can add one without editing the others.
- **Minds run as separate processes**, in their own workspaces (`hive/supervisor/`). Iter minds can run in containers through the Docker driver.

## Where coupling is high (what to look for)

1. **The hive server core is concentrated in a few large files.**
   - `hive/core/app.py` is about 3,400 lines and holds almost every HTTP route.
   - `hive/core/hive.py` (about 2,000 lines) and `hive/core/ask.py` (about 1,300 lines) carry a lot of cross-cutting logic.
   - **Risk:** a rule that must apply everywhere, such as who may see what, has to be repeated at many call sites. A privacy fix in October had to touch 16 list and read paths, because visibility wasn't enforced in one layer. `hive/core/visibility.py` is now the shared helper; use it for every new list or read route.
   - **Look for:** new routes that return names or ids of swarms, minds, rooms, shares or assets without going through `Visibility`.
2. **The runtime is vendored.**
   - OmegaClaw Core (`src/`, `modules/`, `channels/`, `lib_*.metta`, `run.metta`) is copied into this repo instead of being pinned as a dependency on its upstream.
   - **Risk:** this repo and upstream drift apart. Fixes have to be carried by hand.
   - **Look for:** edits to runtime files that should go upstream.
3. **One app screen is still compiled into the platform UI.**
   - The design canvas (`hive/ui/src/forms/designCanvas/`) belongs to Studio but ships inside the hive UI.
   - The life-map and case-file forms **have moved out** of the platform UI into their closed app repositories (`omegaatlas` and `omegatruth`) in the handover round.
   - **Risk:** app UI changes need a platform release.
   - **Look for:** the app-frame route (apps serving their own screens), which is the intended direction.
4. **Settings sprawl.**
   - There are 93 `HIVE_*` settings, read across many modules (`hive/core/config.py` holds only some of them).
   - Defaults and validation are spread out.
   - **Look for:** settings read with `os.environ.get` outside `config.py`. Prefer adding new ones to one settings module, with a documented default.
5. **Built-in apps inside the platform.** Evolve (`hive/plugins/omegaevolve`, closed tier), Commons Explorer (`hive/plugins/commons_explorer`) and `omegabench` live in this repo instead of being separate apps like the rest.

## Suggested order to improve (planned, not started)

1. Split `hive/core/app.py` into route modules (people, minds, swarms, Ask, apps, assets). Each should own its routes and call one shared visibility layer.
2. Make OmegaClaw Core a pinned dependency instead of a copy.
3. Let apps ship their own screens through the app frame, and serve the life-map and case-file forms from their apps that way. Then move the design-canvas form out of the platform UI.
4. Turn Evolve and Commons Explorer into normal apps.
5. Create one settings module and document: every `HIVE_*` setting listed, with its default and validation.

None of these changes what users see. Each should go through the project's usual two-reviewer process and the full test suites (`hive/tests`, `tests`, and the UI's `vitest`).

See also `docs/FEATURES.md` (every feature with its state and location), `docs/STATUS.md` (done and to do) and `docs/START_HERE.md`.
