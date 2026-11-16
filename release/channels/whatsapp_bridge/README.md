> **Closed Source for Product Consideration.** Shared privately with the SingularityNET team. Do not publish, redistribute or relicense as open source. See CLOSED_SOURCE.md.

# WhatsApp bridge

An optional Node.js process that connects the agent's WhatsApp channel to WhatsApp Web through the unofficial Baileys client. The Python side (`whatsapp.py`) talks to it over local HTTP.

- Install and run: `npm install` then `node bridge.mjs` in this folder (Node.js 22.12 or later).
- `npm install` fetches `libsignal`, which is **GPL-3.0**. Read `GPL-NOTICE.md` before you distribute this folder with its dependencies.
