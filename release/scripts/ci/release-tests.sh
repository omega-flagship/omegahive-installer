#!/usr/bin/env bash
# release-tests.sh -- the mind-sandbox tests as production runs them: from a root-owned release under
# /opt/omegahive/releases (named "ci", two characters: the case Ubuntu 26.04's matching misses without the profile's
# {*,??}), with the launcher's AppArmor profile loaded and the restriction at 1. (T-120, R1-R3)
#
# The job has no general sudo. ci-runner-setup installs and loads deploy/apparmor/omegahive-mind-launcher as of a
# fixed commit, and installs the root-owned helper omegahive-ci-release, which copies hive/ and deploy/ from runner 1's
# fixed checkout path into the release. The sudoers rule allows the helper with no argument or with --remove, and the
# sysctl at exactly 0 or 1. Nothing else.
set -euo pipefail

WS=/home/ci-runner-1/runner/_work/omegahive/omegahive   # the helper's fixed source; it takes no path
R=/opt/omegahive/releases/ci/omegahive
PROFILE=deploy/apparmor/omegahive-mind-launcher

if [ "${GITHUB_WORKSPACE:-}" != "$WS" ]; then
  echo "::error::the checkout is at ${GITHUB_WORKSPACE:-?}, but omegahive-ci-release copies only $WS (runner 1)"
  exit 1
fi
cd "$WS"
if ! cmp "$PROFILE" "/etc/apparmor.d/omegahive-mind-launcher"; then
  echo "::error::profile changed: Kabir must re-run ci-runner-setup at ${GITHUB_SHA:-this commit}" \
    "(its embedded copy of $PROFILE must be updated to this commit first)"
  exit 1
fi
sudo -n /usr/local/sbin/omegahive-ci-release
sudo -n /usr/sbin/sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
cd "$R"
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -rs -p no:cacheprovider --basetemp="${TMPDIR:?}/pytest-release" \
  hive/tests/test_mind_sandbox_linux.py hive/tests/test_sandbox_run.py hive/tests/test_mind_sandbox.py \
  hive/tests/test_mind_sandbox_default.py
