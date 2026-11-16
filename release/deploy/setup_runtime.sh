#!/bin/bash
# Runtime for OmegaHive on Linux. Run as root, after the service account and /opt/omegahive/venv exist.
# Builds SWI-Prolog 10.1.14 (swipl-devel, the same version as the reviewed Mac build) against the hive's Python 3.12
# and installs it into /usr/local, then installs PeTTa at the reviewed pin and janus_swi, and proves both bridge
# directions and a MeTTa run with exact expected results.
#
# Trust boundaries:
# - The download and build run as a throwaway account (omegahive-build), never as root and never as the service
#   account. It is created for this run, gets only pass-through (x) on /opt/omegahive to read the hive's Python (an
#   ACL removed afterwards; it joins no group and can write nothing of the hive's), and all of
#   its processes are killed and the account deleted before root touches the build. Nothing it ran can still hold a
#   build file open, and no other account ever had write access to the build tree.
# - Root keeps its logs and check files in folders only root can write (mktemp, mode 700/755), never inside the build.
# - Root never runs the hive's Python: the service account reports the interpreter's prefix, and root only checks that
#   the path is a plain directory under the expected uv folder.
# Note: the interpreter and venv live in the service account's home (uv per user), so libpython is service-writable.
# Only the service's own processes load it; root runs no program that links it.
set -euo pipefail
SVC=omegahive
BUILDER=omegahive-build
PY=/opt/omegahive/venv/bin/python
PYBASE=$(sudo -u "$SVC" "$PY" -I -c "import sys; print(sys.base_prefix)")
case "$PYBASE" in
  /opt/omegahive/.local/share/uv/python/cpython-3.12*) ;;
  *) echo "unexpected interpreter prefix: $PYBASE" >&2; exit 1 ;;
esac
[ -d "$PYBASE" ] && [ ! -L "$PYBASE" ] || { echo "interpreter prefix is not a plain directory" >&2; exit 1; }
LOGS=$(mktemp -d /var/tmp/omegahive-setup-logs.XXXXXXXX)       # root only (mktemp gives 700)
BUILD=$(mktemp -d /var/tmp/omegahive-swipl.XXXXXXXX)
CHECK=$(mktemp -d /var/tmp/omegahive-check.XXXXXXXX)
command -v setfacl >/dev/null || { echo "install the acl package first (apt-get install -y acl)" >&2; rm -rf "$BUILD" "$CHECK"; exit 1; }
# Refuse before any cleanup is armed: an existing account of that name is never touched, killed or deleted.
if id "$BUILDER" >/dev/null 2>&1; then echo "$BUILDER already exists; remove it first" >&2; rm -rf "$BUILD" "$CHECK"; exit 1; fi
CREATED=0
cleanup() {
  if [ "$CREATED" = 1 ]; then   # only the account this run created
    setfacl -x "u:$BUILDER" /opt/omegahive 2>/dev/null || true; pkill -KILL -u "$BUILDER" 2>/dev/null || true
    userdel "$BUILDER" 2>/dev/null || true
  fi
  rm -rf "$BUILD" "$CHECK"
}
trap cleanup EXIT
useradd --system --no-create-home --home-dir "$BUILD" --shell /usr/sbin/nologin "$BUILDER"
CREATED=1
setfacl -m "u:$BUILDER:--x" /opt/omegahive       # pass through only; the Python tree below is world-readable
chown "$BUILDER:$BUILDER" "$BUILD" && chmod 700 "$BUILD"

# 1. Download and build as the throwaway account.
sudo -u "$BUILDER" env HOME="$BUILD" PYBASE="$PYBASE" BUILD="$BUILD" bash -euo pipefail -c '
  git clone -q --depth 1 --branch V10.1.14 https://github.com/SWI-Prolog/swipl-devel.git "$BUILD/src"
  cd "$BUILD/src"
  for m in clib swipy plunit json sgml http zlib libedit pcre yaml chr clpqr cpp utf8proc archive ssl; do echo packages/$m; done \
    | xargs git submodule update --init --depth 1 -q
  mkdir -p build && cd build
  # janus (packages/swipy) looks for "Python", not "Python3": without the -DPython_ flags it silently binds to the
  # system Python (no headers) and is skipped. PeTTa loads library(janus), so MeTTa cannot run without it.
  cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DSWIPL_PACKAGES_X=OFF -DSWIPL_PACKAGES_JAVA=OFF -DSWIPL_PACKAGES_ODBC=OFF \
    -DSWIPL_PACKAGES_QT=OFF -DINSTALL_DOCUMENTATION=OFF -DBUILD_TESTING=OFF -DCMAKE_INSTALL_PREFIX=/usr/local \
    -DPython3_EXECUTABLE=$PYBASE/bin/python3.12 -DPython3_ROOT_DIR=$PYBASE \
    -DPython_EXECUTABLE=$PYBASE/bin/python3.12 -DPython_ROOT_DIR=$PYBASE .. > ../cmake.log
  grep -q "^_Python_INCLUDE_DIR:INTERNAL=$PYBASE" CMakeCache.txt || { echo "janus would not build against $PYBASE" >&2; exit 1; }
  ninja > ../ninja.log
  test -f packages/swipy/janus.so || { echo "janus was not built" >&2; exit 1; }'

# 2. The throwaway account ends (every process killed, account deleted); then root takes the tree and installs.
setfacl -x "u:$BUILDER" /opt/omegahive
pkill -KILL -u "$BUILDER" 2>/dev/null || true
userdel "$BUILDER"
CREATED=0
chown -R --no-dereference root:root "$BUILD" && chmod -R go-w "$BUILD"
(cd "$BUILD/src/build" && ninja install > "$LOGS/install.log")
echo "install log: $LOGS/install.log"
# libpython lives inside uv's folder, outside the loader path: register it so library(janus) can load it.
echo "$PYBASE/lib" > /etc/ld.so.conf.d/omegahive-python.conf && ldconfig
test "$(/usr/local/bin/swipl --version | awk '{print $3}')" = "10.1.14" || { echo "wrong SWI-Prolog version" >&2; exit 1; }

# 3. PeTTa at the reviewed pin, and janus_swi, as the service account.
if [ ! -d /opt/omegahive/PeTTa/.git ]; then
  install -d -o "$SVC" -g "$SVC" /opt/omegahive/PeTTa
  sudo -u "$SVC" git clone -q https://github.com/trueagi-io/PeTTa.git /opt/omegahive/PeTTa
fi
sudo -u "$SVC" git -C /opt/omegahive/PeTTa fetch -q origin
sudo -u "$SVC" git -C /opt/omegahive/PeTTa checkout -q ae66fa8
sudo -iu "$SVC" bash -lc "PATH=/usr/local/bin:\$PATH /opt/omegahive/venv/bin/pip install -q janus-swi==1.5.3"

# 4. Prove each claim with its exact result.
RUN="env PATH=/usr/local/bin:/opt/omegahive/venv/bin:/usr/bin:/bin"
# Python -> Prolog
sudo -u "$SVC" $RUN "$PY" -c 'import janus_swi as j; r = j.query_once("X is 1+1"); assert r.get("X") == 2, r'
# Prolog -> Python (PeTTa loads library(janus) on every run)
test "$(sudo -u "$SVC" $RUN /usr/local/bin/swipl -g 'use_module(library(janus)), py_call(operator:add(20, 22), V), print(V), nl, halt' 2>/dev/null)" = "42" \
  || { echo "library(janus) Prolog->Python bridge failed" >&2; exit 1; }
# A MeTTa program through PeTTa: the last output line, without colour codes, must be exactly 42.
chmod 755 "$CHECK"
printf '(= (f $x) (+ $x 1))\n!(f 41)\n' > "$CHECK/check.metta" && chmod 644 "$CHECK/check.metta"
OUT=$(cd "$CHECK" && sudo -u "$SVC" $RUN sh /opt/omegahive/PeTTa/run.sh "$CHECK/check.metta" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -1)
test "$OUT" = "42" || { echo "PeTTa check failed: last line was '$OUT'" >&2; exit 1; }
echo RUNTIME-DONE
