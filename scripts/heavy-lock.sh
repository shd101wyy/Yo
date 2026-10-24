#!/bin/bash
# FIFO heavy lock shared by every session and agent working on one machine.
# Heavy steps (`yo build`, `check ./src`, `compile src/main.yo`, the language
# suite, `tests/internal`, fixpoint) take a slot; light work needs none.
# Background: .github/instructions/testing.instructions.md ("The heavy lock").
#
#   source scripts/heavy-lock.sh
#   heavy_take "<who>: <job>"            # weight 1: may share the machine with other jobs
#   heavy_take "<who>: <job>" exclusive  # runs alone: timings, A/B, profiles, >5 GB steps
#                                        # (a compiler-sized tests/internal file: up to 6.5 GB)
#   heavy_take "<who>: <job>" priority   # queues ahead of every ordinary ticket
#                                        # (also HEAVY_PRIORITY=1; combines with exclusive)
#   ... heavy step ...
#   heavy_drop                           # releases whatever this caller holds
#
# Slots: slot 0 is the original `.heavy-lock` dir, so a waiter that still runs
# the one-slot loop (mkdir .heavy-lock once its ticket is the oldest live one)
# keeps working. Slots 1.. are `.heavy-lock-b`, `.heavy-lock-c`, ...
#
# Admission for a weight-1 ticket at queue position p (0 = oldest live ticket):
#   - no exclusive ticket is ahead of it and no held slot is exclusive;
#   - slot 0 goes only to p == 0, so an old-protocol head waiter is never starved;
#   - slots 1.. go in FIFO order among new-protocol tickets: q < number of free
#     slots 1.., where q counts only the tickets ahead that carry a weight line
#     (an old-protocol waiter can only ever take slot 0, so it does not compete);
#   - when any slot is already held, at least HEAVY_MIN_AVAIL_MB of memory must be
#     available (Linux MemAvailable; macOS free + inactive + speculative +
#     purgeable pages). The check runs at admission only: a job that grows past
#     ~5 GB must take the lock `exclusive`.
# An exclusive ticket must be the oldest; it claims slots as they free up and
# runs once it holds all of them (holding some drains the others).
# A priority ticket (release blockers only) sorts ahead of every ordinary
# ticket, FIFO among priority tickets, so it takes the next free slot. It never
# overtakes a live exclusive ticket: that one may already hold some slots while
# it drains the rest, and a ticket queued ahead of it could neither start beside
# those slots nor let it finish (the backdating deadlock). The order lives in
# the ticket NAME, so waiters running an older copy of this script, which sort
# the same names, honour it too. A running job is never preempted.
# A held slot counts as exclusive only when its ticket declared it: the owner
# line carries the "[EXCLUSIVE]" marker heavy_take writes for `exclusive`. A
# label is free text and never decides it (until 2026-10-21 any owner line
# naming "timed", "A/B", "measure", "profile" or "sample" serialized the
# machine, which a weight-1 "leak A/B" test run did for 30 minutes on a
# 64 GB box with six slots).
#
# Configuration: every session on the machine must agree on it, so it lives in
# `$HEAVY_ROOT/heavy-lock.conf`, which the script re-reads on every pass of
# the wait loop (an edit reaches waiters already in the queue):
#
#   HEAVY_SLOTS=6              # concurrent weight-1 jobs, 1..26 (default 3)
#   HEAVY_MIN_AVAIL_MB=6144    # memory needed to start beside another job
#
# The file wins over environment variables of the same name, which only
# apply when it does not set a key (throwaway HEAVY_ROOTs in tests).
# The script runs under macOS's bash 3.2 and under `set -u`: an empty array is
# expanded as `${a[@]+"${a[@]}"}`, which both accept
# (scripts/heavy-lock-test.sh runs every job under /bin/bash -u).
# HEAVY_ROOT itself has to come from the environment; every copy of this
# script, in any worktree, must agree on it. The default is the worktree root
# that AGENTS.md prescribes.
HEAVY_ROOT="${HEAVY_ROOT:-$HOME/Workspace/Yo-wt}"
HEAVY_LOCK="$HEAVY_ROOT/.heavy-lock"
HEAVY_QUEUE="$HEAVY_ROOT/.heavy-queue"
HEAVY_CONF="$HEAVY_ROOT/heavy-lock.conf"
# Slot k >= 1 is `.heavy-lock-<letter k>`: b, c, ... z.
HEAVY_SLOT_LETTERS="abcdefghijklmnopqrstuvwxyz"
HEAVY_MAX_SLOTS=26
_HEAVY_ENV_SLOTS="${HEAVY_SLOTS:-}"
_HEAVY_ENV_MIN_AVAIL_MB="${HEAVY_MIN_AVAIL_MB:-}"

# Sets HEAVY_SLOTS and HEAVY_MIN_AVAIL_MB from the conf file, else the
# environment, else the defaults. The file is parsed, never sourced.
_heavy_load_conf() {
  local conf_slots="" conf_avail="" key val
  if [ -r "$HEAVY_CONF" ]; then
    while IFS='=' read -r key val || [ -n "$key" ]; do
      key="${key//[[:space:]]/}"; val="${val%%#*}"; val="${val//[[:space:]]/}"
      case "$val" in '' | *[!0-9]*) continue ;; esac
      case "$key" in
        HEAVY_SLOTS) conf_slots="$val" ;;
        HEAVY_MIN_AVAIL_MB) conf_avail="$val" ;;
      esac
    done < "$HEAVY_CONF"
  fi
  HEAVY_SLOTS="${conf_slots:-${_HEAVY_ENV_SLOTS:-3}}"
  HEAVY_MIN_AVAIL_MB="${conf_avail:-${_HEAVY_ENV_MIN_AVAIL_MB:-6144}}"
  [ "$HEAVY_SLOTS" -ge 1 ] 2>/dev/null || HEAVY_SLOTS=1
  [ "$HEAVY_SLOTS" -le $HEAVY_MAX_SLOTS ] || HEAVY_SLOTS=$HEAVY_MAX_SLOTS
}
_heavy_load_conf

_heavy_slot_dir() {
  if [ "$1" = 0 ]; then echo "$HEAVY_LOCK"; else echo "$HEAVY_LOCK-${HEAVY_SLOT_LETTERS:$1:1}"; fi
}
_heavy_avail_mb() {
  if [ -r /proc/meminfo ]; then
    awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo
    return
  fi
  vm_stat | awk '
    /page size of/ { ps = $8 }
    /^Pages free/ { gsub(/\./, "", $3); f = $3 }
    /^Pages inactive/ { gsub(/\./, "", $3); i = $3 }
    /^Pages speculative/ { gsub(/\./, "", $3); s = $3 }
    /^Pages purgeable/ { gsub(/\./, "", $3); p = $3 }
    END { print int((f + i + s + p) * ps / 1048576) }'
}
# Seconds since the epoch at which the machine booted (empty if unknown).
_heavy_boot_epoch() {
  if [ -r /proc/stat ]; then
    awk '/^btime / { print $2 }' /proc/stat
  else
    sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p'
  fi
}
# A held slot whose owner can no longer release it: the owner's pid is gone (a
# `kill -9`, a crashed session), or the slot was taken before the machine last
# booted (a pid that a reboot reused belongs to someone else). Without this a
# reboot left every slot held forever and deadlocked every later waiter.
# A slot without an owner line yet (between its mkdir and the owner write) or
# taken by the old one-slot loop (no owner file) is never judged orphaned.
_heavy_slot_orphaned() {
  local pid mtime boot
  pid="$(sed -n 's/.*(pid \([0-9]*\))$/\1/p' "$1/owner" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 0
  boot="$(_heavy_boot_epoch)"
  mtime="$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)"
  [ -n "$boot" ] && [ -n "$mtime" ] && [ "$mtime" -lt "$boot" ]
}
# Ticket names sort by this: nanoseconds from GNU date, seconds * 1e9 from
# BSD date (which prints a literal N), so both spellings have the same width.
_heavy_now_ns() {
  local t
  t="$(date +%s%N)"
  case "$t" in *N) t="${t%N}000000000" ;; esac
  echo "$t"
}
# Name of a priority ticket (the caller appends "-<pid>"). Ordinary tickets are
# _heavy_now_ns, 19 digits starting with 1 (until 2033), so "0" + now sorts
# ahead of all of them under any collation. Behind a live exclusive ticket the
# name is that ticket's own plus a suffix, which sorts right after it and ahead
# of every ordinary ticket queued later.
_heavy_priority_name() {
  local t last_excl=""
  for t in $(ls "$HEAVY_QUEUE" 2>/dev/null | sort); do
    kill -0 "${t##*-}" 2>/dev/null || continue
    grep -q '^weight=2$' "$HEAVY_QUEUE/$t" 2>/dev/null && last_excl="$t"
  done
  if [ -n "$last_excl" ]; then echo "$last_excl.p$(_heavy_now_ns)"; else echo "0$(_heavy_now_ns)"; fi
}
_heavy_slot_exclusive() {
  grep -qF '[EXCLUSIVE]' "$1/owner" 2>/dev/null
}
_heavy_claim() {
  if mkdir "$1" 2>/dev/null; then
    echo "$2, started $(date +%H:%M) (pid $$)" > "$1/owner"
    return 0
  fi
  return 1
}

heavy_take() {
  local who="$1" weight=1 prio="${HEAVY_PRIORITY:-0}" arg
  shift
  for arg in "$@"; do
    case "$arg" in exclusive) weight=2 ;; priority) prio=1 ;; esac
  done
  [ $weight = 2 ] && who="$who [EXCLUSIVE]"
  [ "$prio" = 1 ] && who="$who [PRIORITY]"
  mkdir -p "$HEAVY_QUEUE"
  local ticket_name ticket
  if [ "$prio" = 1 ]; then
    ticket_name="$(_heavy_priority_name)-$$"
  else
    ticket_name="$(_heavy_now_ns)-$$"
  fi
  ticket="$HEAVY_QUEUE/$ticket_name"
  printf '%s\nweight=%s\n' "$who" "$weight" > "$ticket"
  HEAVY_HELD_SLOTS=""
  while true; do
    local live=() t pid pos=-1 newpos=0 excl_ahead=0
    for t in $(ls "$HEAVY_QUEUE" 2>/dev/null | sort); do
      pid="${t##*-}"
      if kill -0 "$pid" 2>/dev/null; then live+=("$t"); else rm -f "$HEAVY_QUEUE/$t"; fi
    done
    local k
    for k in ${live[@]+"${!live[@]}"}; do
      if [ "${live[$k]}" = "$ticket_name" ]; then pos=$k; break; fi
      grep -q '^weight=2$' "$HEAVY_QUEUE/${live[$k]}" 2>/dev/null && excl_ahead=1
      grep -q '^weight=' "$HEAVY_QUEUE/${live[$k]}" 2>/dev/null && newpos=$((newpos + 1))
    done
    _heavy_load_conf
    # Scan every possible slot, not just the configured ones: after the slot
    # count is lowered, a job still running in a higher slot keeps counting
    # as held, so nobody (an exclusive job least of all) starts over it.
    local s dir free=() free_hi=0 held=0 held_excl=0
    for ((s = 0; s < HEAVY_MAX_SLOTS; s++)); do
      if [ $s = 0 ]; then dir="$HEAVY_LOCK"; else dir="$HEAVY_LOCK-${HEAVY_SLOT_LETTERS:$s:1}"; fi
      if [ -d "$dir" ] && _heavy_slot_orphaned "$dir"; then
        rm -rf "$dir"
      fi
      if [ -d "$dir" ]; then
        case " $HEAVY_HELD_SLOTS " in *" $s "*) ;; *)
          held=$((held + 1)); _heavy_slot_exclusive "$dir" && held_excl=1 ;;
        esac
      elif [ "$s" -lt "$HEAVY_SLOTS" ]; then
        free+=("$s")
        [ "$s" != 0 ] && free_hi=$((free_hi + 1))
      fi
    done
    if [ $weight = 2 ]; then
      if [ "$pos" = 0 ]; then
        for s in ${free[@]+"${free[@]}"}; do
          _heavy_claim "$(_heavy_slot_dir $s)" "$who" && HEAVY_HELD_SLOTS="$HEAVY_HELD_SLOTS $s"
        done
        # Done once nobody else holds any slot, configured or not.
        local mine=0
        for s in $HEAVY_HELD_SLOTS; do [ -d "$(_heavy_slot_dir $s)" ] && mine=$((mine + 1)); done
        if [ $held = 0 ] && [ $mine -ge "$HEAVY_SLOTS" ]; then
          rm -f "$ticket"; HEAVY_HELD=1; return 0
        fi
      fi
    elif [ $excl_ahead = 0 ] && [ $held_excl = 0 ] && [ "$pos" -ge 0 ] \
      && { [ $held = 0 ] || [ "$(_heavy_avail_mb)" -ge "$HEAVY_MIN_AVAIL_MB" ]; }; then
      for s in ${free[@]+"${free[@]}"}; do
        if [ "$s" = 0 ]; then [ "$pos" = 0 ] || continue
        else [ "$newpos" -lt "$free_hi" ] || continue
        fi
        if _heavy_claim "$(_heavy_slot_dir $s)" "$who"; then
          HEAVY_HELD_SLOTS=" $s"; rm -f "$ticket"; HEAVY_HELD=1; return 0
        fi
      done
    fi
    sleep "${HEAVY_POLL_SECONDS:-10}"
  done
}

heavy_drop() {
  local s dir
  for s in ${HEAVY_HELD_SLOTS:-}; do
    dir="$(_heavy_slot_dir $s)"
    grep -q "(pid $$)" "$dir/owner" 2>/dev/null && rm -rf "$dir"
  done
  # A caller that took the lock with the one-slot loop sets only HEAVY_HELD and holds slot 0.
  if [ "${HEAVY_HELD:-0}" = 1 ] && [ -z "${HEAVY_HELD_SLOTS:-}" ] && grep -q "(pid $$)" "$HEAVY_LOCK/owner" 2>/dev/null; then
    rm -rf "$HEAVY_LOCK"
  fi
  HEAVY_HELD=0; HEAVY_HELD_SLOTS=""
}
