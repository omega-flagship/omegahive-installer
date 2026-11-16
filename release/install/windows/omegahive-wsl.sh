#!/bin/bash
# Purpose: inside the Windows installer's WSL distro, unpack the release tarball the person double-clicked beside and
# run the shared hive setup from it (install/macos/Install OmegaHive.command, OMEGAHIVE_FRONT=windows). The release
# comes as one tarball rather than a folder of files because Windows' unzip keeps no Unix modes and WSL reads one
# file from the Windows disk far faster than thousands. Exits with the setup's own status.
#
#   omegahive-wsl.sh <release tarball>    (Install-OmegaHive.ps1 passes its path through WSLENV)
set -euo pipefail
umask 077

TARBALL=${1:?usage: omegahive-wsl.sh <release tarball>}
OH=${OMEGAHIVE_HOME:-$HOME/OmegaHive}
STAGE=$OH/build/release

mkdir -p "$OH/build"
chmod 700 "$OH"
echo "Unpacking this release inside WSL..."
rm -rf "$STAGE.new"
mkdir "$STAGE.new"
tar -xzf "$TARBALL" -C "$STAGE.new"
[ -f "$STAGE.new/omegahive/install/macos/Install OmegaHive.command" ] \
  || { echo "The release tarball holds no omegahive/install/macos/Install OmegaHive.command." >&2; exit 1; }
rm -rf "$STAGE"
mv "$STAGE.new" "$STAGE"

code=0
OMEGAHIVE_FRONT=windows /bin/bash "$STAGE/omegahive/install/macos/Install OmegaHive.command" || code=$?
# The setup copied what it keeps into $OH/app.
rm -rf "$STAGE"
exit "$code"
