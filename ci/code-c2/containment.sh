#!/bin/bash
# Outer containment gate for the runtime probe (contract R11): each case runs in its own transient systemd unit
# (KillMode=control-group). After each case: the unit's cgroup is gone or empty, no omegacode process remains,
# and port 8724 is free. Synthetic state only; prints facts, never tokens.
set -u
PROBE=$1; SRC=$2; PY=$3; RUNNER=$4
U=$(id -u "$RUNNER"); G=$(id -g "$RUNNER")
fail=0
run_unit() {  # name, extra systemd-run args..., -- command
  local name=$1; shift
  sudo systemd-run --quiet --unit="$name" --uid="$U" --gid="$G" -p KillMode=control-group -p TimeoutStopSec=10 \
    --setenv=HOME=/tmp --working-directory=/tmp "$@"
}
after() {
  local name=$1 expect=$2 result=$3
  sleep 1
  local cg; cg=$(systemctl show -p ControlGroup --value "$name.service" 2>/dev/null)
  local procs=""
  [ -n "$cg" ] && [ -e "/sys/fs/cgroup$cg/cgroup.procs" ] && procs=$(cat "/sys/fs/cgroup$cg/cgroup.procs")
  local left; left=$(pgrep -f -- '-m omegacode --config' || true)
  local port; port=$(ss -Hltn 'sport = :8724' | wc -l)
  local state; state=$(systemctl show -p ActiveState --value "$name.service" 2>/dev/null)
  echo "case=$name expect=$expect result=$result unit_state=${state:-gone} cgroup_procs=[${procs//$'\n'/,}] omegacode_left=[${left//$'\n'/,}] port8724_listeners=$port"
  if [ -n "$procs" ] || [ -n "$left" ] || [ "$port" != 0 ]; then echo "  CONTAINMENT FAIL ($name)"; fail=1; fi
  sudo systemctl reset-failed "$name.service" 2>/dev/null || true
}
# 1 success
out=$(run_unit c2-success --wait --pipe -- "$PY" "$PROBE" --source-root "$SRC" --python /tmp/runvenv/bin/python 2>&1 | tail -1)
after c2-success ok "$(echo "$out" | grep -o '"ok": [a-z]*')"
# 2 refusal before start (relative interpreter path is refused by R8)
out=$(run_unit c2-refusal --wait --pipe -- "$PY" "$PROBE" --source-root "$SRC" --python runvenv/bin/python 2>&1 | tail -1)
after c2-refusal refused "$(echo "$out" | cut -c1-120)"
# 3 timeout: the probe is killed by its own outer deadline while the service is starting
out=$(run_unit c2-timeout --wait --pipe -p RuntimeMaxSec=2 -- "$PY" "$PROBE" --source-root "$SRC" --python /tmp/runvenv/bin/python 2>&1 | tail -1)
after c2-timeout killed_by_RuntimeMaxSec "exit:$(systemctl show -p Result --value c2-timeout.service 2>/dev/null)"
# 4 termination: SIGTERM to the probe mid-run (graceful path)
run_unit c2-term -- "$PY" "$PROBE" --source-root "$SRC" --python /tmp/runvenv/bin/python
sleep 2; sudo systemctl kill --kill-whom=main --signal=TERM c2-term.service
for i in $(seq 1 20); do systemctl is-active --quiet c2-term.service || break; sleep 0.5; done
after c2-term sigterm_main "active_after=$(systemctl is-active c2-term.service)"
# 5 forced cancellation: SIGKILL to the probe only (it cannot clean up), then the unit is stopped
run_unit c2-kill -- "$PY" "$PROBE" --source-root "$SRC" --python /tmp/runvenv/bin/python
sleep 2
echo "  before kill: omegacode=[$(pgrep -f -- '-m omegacode --config' | tr '\n' ,)]"
sudo systemctl kill --kill-whom=main --signal=KILL c2-kill.service; sleep 1
echo "  after SIGKILL of probe, before stop: omegacode=[$(pgrep -f -- '-m omegacode --config' | tr '\n' ,)]"
sudo systemctl stop c2-kill.service 2>/dev/null || true
after c2-kill sigkill_main_then_stop "stopped"
echo "containment gate: $([ $fail = 0 ] && echo PASS || echo FAIL)"
exit $fail
