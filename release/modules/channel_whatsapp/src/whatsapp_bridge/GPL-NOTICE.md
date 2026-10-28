# GPL notice: WhatsApp bridge

This bridge is an optional, separately installed Node.js process. The hive talks to it over local HTTP only; no hive code links against it.

## Third-party licences pulled in by `npm install`

None of these packages is committed to this repository. `npm install` fetches them from the npm registry when you choose to run the bridge.

| Package (as locked in `package-lock.json`) | Licence | Reached through |
|---|---|---|
| `libsignal` 6.0.0 | **GPL-3.0** | `@whiskeysockets/baileys` |
| `@img/sharp-libvips-*` prebuilt binaries | LGPL-3.0-or-later | `sharp`, through baileys' optional image support |
| `@whiskeysockets/baileys`, `pino`, `qrcode` | MIT | direct |
| `qrcode-terminal` | not stated in the lock file; check before redistribution | direct |

## What this means

- Anyone who **distributes** this bridge together with its installed `node_modules` (for example in a container image or a bundle) distributes GPL-3.0 code and must meet GPL-3.0's terms for that combined work.
- For that reason this folder is marked **Closed Source for Product Consideration** (see `CLOSED_SOURCE.md`) and is not part of the Apache-2.0 release of the hive. Its `package.json` says `"license": "UNLICENSED"` to match.
- SingularityNET legal should decide the final licence of this folder, or replace the GPL-3.0 dependency, before any external distribution.
- Baileys is an unofficial WhatsApp Web client. Using it may conflict with WhatsApp's Terms of Service.
