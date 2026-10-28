#!/bin/sh
# The tester workaround while swi-prolog.org is unreachable (guide section 3): put the exact, hash-checked SWI-Prolog
# source the installer expects into its download cache, so it does not need to fetch it. Run as yourself, not sudo.
set -e
umask 077
SHA=1a078f18b03d04a2869bc225f62b7a276c8ee7b03351c59a4f30727d2c8fbfab
cd ~
echo "$SHA  swipl-10.1.14.tar.gz" | sha256sum -c -
mkdir -p ~/.local/share/omegahive/cache
chmod 700 ~/.local/share/omegahive ~/.local/share/omegahive/cache
cp swipl-10.1.14.tar.gz ~/.local/share/omegahive/cache/$SHA
chmod 600 ~/.local/share/omegahive/cache/$SHA
echo "SWI-Prolog source is ready for the installer."
