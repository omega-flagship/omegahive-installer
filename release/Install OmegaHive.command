#!/bin/sh
# Purpose: the one thing a Mac tester double-clicks in the unzipped folder, at the repository's root or as the release's
# "Install Omega.command" above omegahive/: it runs install/macos/Install OmegaHive.command, which sets up their own hive
# in ~/OmegaHive and opens it signed in, or says plainly why this copy cannot run where it is.
here=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
inner="$here/install/macos/Install OmegaHive.command"
[ -e "$inner" ] || inner="$here/omegahive/install/macos/Install OmegaHive.command"
stop() {
  echo "$1"
  echo "Download the newest Mac test build from https://github.com/omega-flagship/omegahive-installer/releases,"
  echo "unzip it in Downloads and double-click Install Omega there."
  printf "Press Return to close this window. "
  read -r _answer || true
  exit 1
}
# macOS keeps Terminal out of the Trash and of folders it protects: a tester's old copy in ~/.Trash failed with only
# "Operation not permitted". A real read, not test -r, since access() can allow a file the sandbox then refuses to open.
case "$here/" in
  */.Trash/*) stop "This copy of Omega is in the Trash, which macOS doesn't let Terminal open." ;;
esac
head -c 1 "$inner" >/dev/null 2>&1 || stop "This copy of Omega is in a folder macOS doesn't let Terminal read: $here"
exec /bin/bash "$inner" "$@"
