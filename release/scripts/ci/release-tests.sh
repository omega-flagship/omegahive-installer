#!/usr/bin/env bash
# release-tests.sh -- the mind-sandbox tests as production runs them: from a root-owned release under
# /opt/omegahive/releases (named "ci", two characters: the case Ubuntu 26.04's matching misses without the profile's
# {*,??}), with the launcher's AppArmor profile loaded and the restriction at 1. (T-120, R1-R3)
#
# The job has no general sudo. ci-runner-setup installs and loads deploy/apparmor/omegahive-mind-launcher as of a
# fixed commit, and installs the root-owned helper omegahive-ci-release, which copies hive/ and deploy/ into the release
# from the calling runner's own checkout, /home/$SUDO_USER/runner/_work/omegahive/omegahive, and refuses any other.
# The sudoers rule allows the helper with no argument or with --remove, and the sysctl at exactly 0 or 1. Nothing else.
#
# On GitHub's machine (RUNNER_ENVIRONMENT github-hosted) the job has general sudo and the machine is thrown away after
# it, so the script does both itself, from this checkout: it loads this commit's profile and makes the release as the
# helper does (a tar stream unpacked root-owned, modes u=rwX,go=rX).
set -euo pipefail

WS=/home/$(id -un)/runner/_work/omegahive/omegahive   # the helper's source for this runner; it takes no path
BASE=/opt/omegahive/releases/ci
R=$BASE/omegahive
PROFILE=deploy/apparmor/omegahive-mind-launcher

if [ "${RUNNER_ENVIRONMENT:-}" = github-hosted ]; then
  cd "${GITHUB_WORKSPACE:?}"
  sudo install -m 644 -o root -g root "$PROFILE" /etc/apparmor.d/omegahive-mind-launcher
  sudo apparmor_parser -r /etc/apparmor.d/omegahive-mind-launcher
  sudo rm -rf --one-file-system /opt/omegahive/releases/ci
  sudo install -d -m 755 -o root -g root /opt/omegahive /opt/omegahive/releases
  sudo install -d -m 700 -o root -g root "$BASE" "$R"
  tar -cf - hive deploy | sudo tar -C "$R" -xf - --no-same-owner --no-same-permissions
  sudo chown -hR root:root "$R"
  sudo chmod -R u=rwX,go=rX,ug-s,a-t "$R"
  sudo chmod 755 "$BASE"
else
  if [ "${GITHUB_WORKSPACE:-}" != "$WS" ]; then
    echo "::error::the checkout is at ${GITHUB_WORKSPACE:-?}, but omegahive-ci-release copies only $WS (this runner's)"
    exit 1
  fi
  cd "$WS"
  if ! cmp "$PROFILE" "/etc/apparmor.d/omegahive-mind-launcher"; then
    echo "::error::profile changed: Kabir must re-run ci-runner-setup at ${GITHUB_SHA:-this commit}" \
      "(its embedded copy of $PROFILE must be updated to this commit first)"
    exit 1
  fi
  sudo -n /usr/local/sbin/omegahive-ci-release
fi
sudo -n /usr/sbin/sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
cd "$R"
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -rs -p no:cacheprovider --basetemp="${TMPDIR:?}/pytest-release" \
  hive/tests/test_mind_sandbox_linux.py hive/tests/test_sandbox_run.py hive/tests/test_mind_sandbox.py \
  hive/tests/test_mind_sandbox_default.py
