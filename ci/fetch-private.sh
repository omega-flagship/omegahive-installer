#!/bin/sh
# Purpose: download one file this public repo must not hold, because it is or carries the closed Assist app, from the
# r6.1-71d182fb release of the private omega-flagship/omegaassist-app into a folder (omega-flagship/omegahive#106).
# The caller checks the bytes against the pin it already has: arm-r7-catalogue.json for omegaassist.zip, and the
# ci/kit/*.sha256 files for the kits.
#
#   ASSIST_READ_TOKEN=<read-only token> sh ci/fetch-private.sh <asset name> <folder>
#
# The token stays off every command line (curl reads its header from stdin), and the asset's signed download URL is
# fetched without it, so the token never goes to another host.
set -eu
[ "$#" -eq 2 ] || { echo "usage: ASSIST_READ_TOKEN=... sh ci/fetch-private.sh <asset name> <folder>" >&2; exit 64; }
asset=$1
dest=$2
repo=omega-flagship/omegaassist-app
tag=r6.1-71d182fb
api=https://api.github.com/repos/$repo/releases

if [ -z "${ASSIST_READ_TOKEN:-}" ]; then
    echo "::error::the secret ASSIST_READ_TOKEN is not set, so $asset can't come from the private $repo. Assist is closed (omega-flagship/omegahive#106), and a pull request from a fork gets no secrets." >&2
    exit 1
fi
auth() { printf 'header = "Authorization: Bearer %s"\n' "$ASSIST_READ_TOKEN"; }

release=$(auth | curl -fsS -K - -H 'Accept: application/vnd.github+json' "$api/tags/$tag") ||
    { echo "::error::can't read release $tag of $repo; check the repo and release exist and the token can read them" >&2; exit 1; }
id=$(printf '%s' "$release" | python3 -c 'import json, sys
ids = [a["id"] for a in json.load(sys.stdin)["assets"] if a["name"] == sys.argv[1]]
print(ids[0] if len(ids) == 1 else "")' "$asset")
[ -n "$id" ] || { echo "::error::release $tag of $repo has no single asset named $asset" >&2; exit 1; }

url=$(auth | curl -fsS -K - -H 'Accept: application/octet-stream' -o /dev/null -w '%{redirect_url}' "$api/assets/$id")
[ -n "$url" ] || { echo "::error::GitHub gave no download address for $asset of $repo $tag" >&2; exit 1; }

mkdir -p "$dest"
curl -fsSL -o "$dest/$asset" "$url"
echo "fetched $asset from $repo $tag: $(wc -c < "$dest/$asset") bytes"
