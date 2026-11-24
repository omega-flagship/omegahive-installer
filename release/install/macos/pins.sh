# Purpose: the versions and sha256 checksums every download of the Mac and Windows installers and of the Mac's
# SWI-Prolog bundle build is pinned to, the release and digest of the Tools app the release carries, pin_fetch, which
# keeps a download only when its checksum matches, the checksum commands both systems share, and how far above the
# hive's port Create's Code service listens. Sourced by "Install OmegaHive.command" (on a Mac, and inside the Windows
# installer's WSL distro), setup-code.sh, setup-tools.sh, omegahive.sh (run), build-swipl-bundle.sh,
# build-swipl-bundle-linux.sh, check-swipl-bundle.sh and conda-lock.sh; plain sh, bash 3.2 too.
# The conda packages are pinned one by one in locks/ (made by conda-lock.sh), each by URL and sha256.
# shellcheck disable=SC2034  # every assignment here is read by the scripts that source this file

# micromamba, from https://github.com/mamba-org/micromamba-releases/releases/tag/2.10.0-0: the checksums are the
# release's own micromamba-<platform>.sha256 files, which matched the binaries downloaded on 10 November 2026.
MICROMAMBA_VERSION=2.10.0-0
MICROMAMBA_SHA256_osx_arm64=c547639f5caf742236641c362746abb4a3505774753ecd08fe341643670c4c01
MICROMAMBA_SHA256_osx_64=8421462a1ef1df9f7acd114f9e2a24c1332ce4f4e29f44465b4acb44e2755172
# The Windows installer's hive runs in WSL's Linux.
MICROMAMBA_SHA256_linux_64=701f39c06f8e6a670a0e186c8479b9e5c0502a2f0cda6cef65d83bdd2875e8bd
MICROMAMBA_SHA256_linux_aarch64=3bb56786e21b9b24024f599fe9185b4a59dc3f9f59937a42311ee583adbbb23c

# SWI-Prolog: the tag the hive runs (docs/omegaclaw-core.md) and the commit it names; a clone must land on this commit.
SWIPL_TAG=V10.1.14
SWIPL_COMMIT=69775434c8226897626b226aefcc8266499f1e2e
# The packages every build of it takes, the source build and both bundles alike: the ones deploy/setup_runtime.sh builds
# on Linux, janus (packages/swipy) the one PeTTa loads on every run.
SWIPL_PACKAGES="clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl"

# PeTTa at the reviewed commit, as GitHub's codeload tarball (the same bytes on two downloads, 120306 of them).
PETTA_COMMIT=ae66fa8e41dcd5539d614706bd4e5cfb34f9608d
PETTA_SHA256=de1e2474b902895f5373fc833ed45341f16e0d283ae957ccb323df42200ce397

# janus-swi, the Python side of janus, as PyPI's source release (sha256 from PyPI's JSON for 1.5.3).
JANUS_SWI_VERSION=1.5.3
JANUS_SWI_SDIST_SHA256=2ce9867bb1e0cbab7737c8e2a7af3268f2241251e5b0eb955726c829ae995f8d

# The Tools app, omega-tools 0.6.1: the dev/latest mirror (1794553) with the reviewed capability-sets.json it had
# rewritten put back, commit 4e57d67 on the local branch tools/reviewed-capability-sets for the maintainers, so the
# hive's review receipt check admits it. It rides in the release as omega-tools-4e57d67.tgz (git archive of that
# commit), unpacked by setup-tools.sh. The digest is the hive's Programs.source_digest of the
# unpacked folder and the lock sha256 that of its release-data.lock.json: omegahive.sh pins the folder to both.
OMEGA_TOOLS_VERSION=0.6.1
OMEGA_TOOLS_COMMIT=4e57d67e0d4b133b4f25deb029d60e6219145889
OMEGA_TOOLS_DIGEST=sha256:91a59354e52b83b76f6e1213a194c79e6c7236a6c7b2b3ab6269a5df381e5afc
OMEGA_TOOLS_LOCK_SHA256=694d207c1cd51baa7751de875ca4599e7ad41d43725fdb7b779ee0ee45505f26

# Studio, the app the hive shows as Create (hive/core/my_apps.py), 0.4.22: the release PhysixSNET/omegadesign's dev/latest
# mirrors (8cb0409d, 5 November) and the 9 November Linux kit carried as omegadesign.zip; Code and Create, Studio
# included, are open source since omega-flagship/omegahive#106. It rides in the release as omegadesign-0.4.22.zip,
# unpacked by setup-studio.sh into apps/omegadesign. The digest is the hive's Programs.source_digest of the unpacked folder
# and the lock sha256 that of its ui/bundle.lock.json, against which the hive checks every byte of Studio's page:
# omegahive.sh pins the folder to both.
OMEGADESIGN_VERSION=0.4.22
OMEGADESIGN_DIGEST=sha256:64abf47808a469d37154be509266977b1a3887f0d39f0b974d7d5c3bce7f6f6e
OMEGADESIGN_LOCK_SHA256=71402503b1c0d07885cfc39af26a64c74c80920d1ff2c694311f034f0f911089

micromamba_url() { printf 'https://github.com/mamba-org/micromamba-releases/releases/download/%s/micromamba-%s\n' "$MICROMAMBA_VERSION" "$1"; }
micromamba_sha256() {
  case "$1" in
    osx-arm64) printf '%s\n' "$MICROMAMBA_SHA256_osx_arm64" ;;
    osx-64) printf '%s\n' "$MICROMAMBA_SHA256_osx_64" ;;
    linux-64) printf '%s\n' "$MICROMAMBA_SHA256_linux_64" ;;
    linux-aarch64) printf '%s\n' "$MICROMAMBA_SHA256_linux_aarch64" ;;
    *) echo "no micromamba is pinned for $1" >&2; return 1 ;;
  esac
}
petta_url() { printf 'https://codeload.github.com/trueagi-io/PeTTa/tar.gz/%s\n' "$PETTA_COMMIT"; }

# Create's Code service listens this far above the hive's port: 8700 gives 8724, the port the published omegacode
# release binds, and own hives on one machine, whose ports differ by tens, never share one. setup-code.sh gives the
# service that port, and the installer takes a hive port only while the port this far above it is free too.
CODE_PORT_OFFSET=24

# sha256 [-c] FILE... and sha1 [FILE]: shasum where it is installed (it ships with macOS), else coreutils (every Linux);
# both print and check the same "<hex>  <name>" lines.
sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"; else sha256sum "$@"; fi; }
sha1() { if command -v shasum >/dev/null 2>&1; then shasum "$@"; else sha1sum "$@"; fi; }

# pin_fetch URL SHA256 OUT: download URL to OUT, keeping it only if its sha256 is SHA256.
pin_fetch() {
  _pin_got=
  curl -fsSL --retry 3 -o "$3.part" "$1" || { rm -f "$3.part"; echo "download failed: $1" >&2; return 1; }
  _pin_got=$(sha256 "$3.part" | cut -d' ' -f1)
  if [ "$_pin_got" != "$2" ]; then
    rm -f "$3.part"
    echo "checksum mismatch for $1: got $_pin_got, pinned $2" >&2
    return 1
  fi
  mv "$3.part" "$3"
}
