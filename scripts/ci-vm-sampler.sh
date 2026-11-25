# Source this from a CI step's bash; do not execute it.
#
#   source scripts/ci-vm-sampler.sh
#   vm_sampler_start "<label>"
#
# Starts a background loop that prints one block every 30 s: the time, `df -h /`,
# the first lines of `vm_stat`, `sysctl vm.swapusage`, the process count and the
# five processes with the largest RSS. The step's stdout is the job log, which
# the runner streams while the step runs, so the blocks survive up to the last
# flushed chunk when the VM is lost and the final log blob never lands
# (issues/2026-11-05-the-macos-26-intel-test-runner-repeatedly-loses-communication.md).
# The loop is stopped by an EXIT trap, so it ends with the step.
#
# macOS only (`vm_stat`, `sysctl vm.swapusage`, BSD `ps`); the workflow calls it
# on the macos-26-intel leg alone.

_vm_sampler_block() {
  # Each command is guarded: the step runs under `bash -eo pipefail`, which the
  # loop must not inherit (a `head` closing a pipe early is not an error here).
  echo "=== vm-sampler $1 $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
  df -h / 2>&1 || true
  vm_stat 2>&1 | head -6 || true
  sysctl vm.swapusage 2>&1 || true
  echo "processes: $(ps -A 2>/dev/null | wc -l | tr -d ' ')"
  echo "top 5 by RSS (KiB, pid, command):"
  ps -Ao rss=,pid=,comm= 2>/dev/null | sort -rn | head -5 || true
}

vm_sampler_start() {
  local label="${1:-step}"
  (
    set +e +o pipefail
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    while true; do
      # One printf of a captured block, so the lines of a sample stay together
      # next to the step's own output.
      printf '%s\n' "$(_vm_sampler_block "$label")"
      sleep 30 &
      sleeper=$!
      wait "$sleeper"
    done
  ) &
  VM_SAMPLER_PID=$!
  trap 'vm_sampler_stop' EXIT
}

vm_sampler_stop() {
  if [ -n "${VM_SAMPLER_PID:-}" ]; then
    kill "$VM_SAMPLER_PID" 2>/dev/null || true
    wait "$VM_SAMPLER_PID" 2>/dev/null || true
    VM_SAMPLER_PID=""
  fi
}
