#!/bin/bash
# Purpose: rebuild hive/plugins/create_acceptance_check/tools/vendor/happy-dom.mjs, the one-file happy-dom Create's play
# check runs in the sandbox, from the versions scripts/dev/happy-dom-vendor/package-lock.json pins, with the bundled
# packages' licences beside it, then rewrite the bundle's lock (tools/bundle.lock.json) for every file in tools/.
# Needs Node 22 and npm with registry access; writes nothing outside a scratch copy and tools/. --lock-only rewrites
# the lock alone, after an edit to probe.mjs or run.py.
#   scripts/dev/vendor_happy_dom.sh [--lock-only]
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
src=$repo/scripts/dev/happy-dom-vendor
tools=$repo/hive/plugins/create_acceptance_check/tools

# the lock sandbox_run.verify_bundle checks before every run: every file in tools/ and its sha256, nothing else
lock() {
  python3 -c '
import hashlib, json, pathlib, sys
tools = pathlib.Path(sys.argv[1])
files = {str(p.relative_to(tools)): hashlib.sha256(p.read_bytes()).hexdigest()
         for p in sorted(tools.rglob("*")) if p.is_file() and p.name != "bundle.lock.json"}
(tools / "bundle.lock.json").write_text(json.dumps({"files": files}, indent=2) + "\n")
print("\n".join(f"{h}  {f}" for f, h in files.items()))
' "$tools"
}

if [ "${1:-}" = --lock-only ]; then
  lock
  exit 0
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/happy-dom-vendor.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$src/package.json" "$src/package-lock.json" "$src/entry.mjs" "$work/"
cd "$work"
npm ci --no-audit --no-fund --silent
version=$(node -p 'require("happy-dom/package.json").version')
esbuild_version=$(node -p 'require("esbuild/package.json").version')
mkdir -p "$tools/vendor"
# The bundle is ESM for Node; the CommonJS packages inside it (ws among them) call require for Node's own modules,
# which an ESM bundle has no require for, so the banner makes one with Node's createRequire.
npx esbuild entry.mjs --bundle --platform=node --format=esm --target=node22 --minify --legal-comments=none \
  --metafile=meta.json --log-level=warning \
  --banner:js="// happy-dom $version (MIT), bundled by scripts/dev/vendor_happy_dom.sh with esbuild $esbuild_version. Generated: do not edit; licences in THIRD_PARTY_LICENSES.txt.
import { createRequire as __vendorRequire } from 'node:module'; const require = __vendorRequire(import.meta.url);" \
  --outfile="$tools/vendor/happy-dom.mjs"
# every package the bundle took code from, with its licence file's text
node --input-type=module -e '
import fs from "node:fs"
import path from "node:path"
const meta = JSON.parse(fs.readFileSync("meta.json", "utf8"))
const names = new Set()
for (const input of Object.keys(meta.inputs)) {
  if (!input.includes("node_modules/")) continue
  const rest = input.split("node_modules/").pop().split("/")
  names.add(rest[0].startsWith("@") ? rest.slice(0, 2).join("/") : rest[0])
}
const parts = []
for (const name of [...names].sort()) {
  const dir = path.join("node_modules", name)
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"))
  const file = fs.readdirSync(dir).find(f => /^licen[cs]e/i.test(f))
  if (!file) throw new Error(`${name} ships no licence file`)
  parts.push(`${name} ${pkg.version} (${pkg.license})\n\n${fs.readFileSync(path.join(dir, file), "utf8").trim()}\n`)
}
fs.writeFileSync(process.argv[1], parts.join("\n" + "-".repeat(78) + "\n\n"))
' "$tools/vendor/THIRD_PARTY_LICENSES.txt"
lock
