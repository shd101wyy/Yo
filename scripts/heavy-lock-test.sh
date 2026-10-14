#!/bin/bash
# Self-test for scripts/heavy-lock.sh: every scenario runs against a throwaway
# HEAVY_ROOT, so it never touches the machine's real lock. ~1 minute.
#
#   bash scripts/heavy-lock-test.sh
set -u
LIB="$(cd "$(dirname "$0")" && pwd)/heavy-lock.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HEAVY_POLL_SECONDS=1
FAILED=0

# job <name> <hold-seconds> [exclusive]: takes a slot, logs start/end, drops.
job() {
  /bin/bash -uc '
    source "$1"; trap heavy_drop EXIT
    heavy_take "$2" ${4:-}
    echo "$(date +%s.%N) start $2" >> "$HEAVY_ROOT/events"
    sleep "$3"
    echo "$(date +%s.%N) end $2" >> "$HEAVY_ROOT/events"
  ' _ "$LIB" "$@"
}
# old_job <name> <hold-seconds>: the pre-#1363 one-slot loop (slot 0 only,
# ticket without a weight line), as gates written before it still run it.
old_job() {
  /bin/bash -uc '
    Q="$HEAVY_ROOT/.heavy-queue"; mkdir -p "$Q"; T="$Q/$(date +%s%N)-$$"; echo "$1" > "$T"
    while true; do
      head=""; for x in $(ls "$Q" | sort); do if kill -0 "${x##*-}" 2>/dev/null; then head=$x; break; fi; rm -f "$Q/$x"; done
      if [ "$head" = "$(basename "$T")" ] && mkdir "$HEAVY_ROOT/.heavy-lock" 2>/dev/null; then rm -f "$T"; break; fi
      sleep 1
    done
    echo "$(date +%s.%N) start $1" >> "$HEAVY_ROOT/events"
    sleep "$2"
    echo "$(date +%s.%N) end $1" >> "$HEAVY_ROOT/events"
    rm -rf "$HEAVY_ROOT/.heavy-lock"
  ' _ "$@"
}
# Highest number of jobs that ran at the same time.
max_concurrent() {
  sort -n "$HEAVY_ROOT/events" | awk '$2 == "start" { n++; if (n > m) m = n } $2 == "end" { n-- } END { print m + 0 }'
}
# Order in which jobs started.
start_order() {
  sort -n "$HEAVY_ROOT/events" | awk '$2 == "start" { printf "%s ", $3 }' | sed 's/ $//'
}
scenario() {
  export HEAVY_ROOT="$WORK/$1"
  mkdir -p "$HEAVY_ROOT"
  : > "$HEAVY_ROOT/events"
}
expect() {
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$3', got '$2'"; FAILED=1; fi
}

# 1. The conf file sets the slot count: 6 slots, 7 jobs -> 6 at once.
scenario six-slots
printf 'HEAVY_SLOTS=6\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
for i in 1 2 3 4 5 6 7; do job "j$i" 4 & sleep 0.2; done; wait
expect "conf HEAVY_SLOTS=6 runs six jobs at once" "$(max_concurrent)" 6

# 2. The conf file wins over each session's environment.
scenario conf-wins
printf 'HEAVY_SLOTS=4  # shared by every session\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
for i in 1 2 3; do HEAVY_SLOTS=2 job "a$i" 4 & sleep 0.2; done
for i in 1 2 3; do HEAVY_SLOTS=9 job "b$i" 4 & sleep 0.2; done
wait
expect "sessions with HEAVY_SLOTS=2 and =9 both obey the conf's 4" "$(max_concurrent)" 4

# 3. Without a conf file the environment applies; 3 is the default.
scenario env-fallback
HEAVY_SLOTS=2 HEAVY_MIN_AVAIL_MB=0 /bin/bash -uc 'source "$1"; echo "$HEAVY_SLOTS $HEAVY_MIN_AVAIL_MB"' _ "$LIB" > "$WORK/env.out"
expect "no conf: the environment sets the knobs" "$(cat "$WORK/env.out")" "2 0"
env -u HEAVY_SLOTS -u HEAVY_MIN_AVAIL_MB /bin/bash -uc 'source "$1"; echo "$HEAVY_SLOTS $HEAVY_MIN_AVAIL_MB"' _ "$LIB" > "$WORK/env.out"
expect "no conf, no environment: the defaults" "$(cat "$WORK/env.out")" "3 6144"
printf 'HEAVY_SLOTS=5' > "$HEAVY_ROOT/heavy-lock.conf"
/bin/bash -uc 'source "$1"; echo "$HEAVY_SLOTS"' _ "$LIB" > "$WORK/env.out"
expect "a last conf line without a newline still counts" "$(cat "$WORK/env.out")" 5
printf 'HEAVY_SLOTS=40\n' > "$HEAVY_ROOT/heavy-lock.conf"
/bin/bash -uc 'source "$1"; echo "$HEAVY_SLOTS"' _ "$LIB" > "$WORK/env.out"
expect "a slot count above 26 is clamped" "$(cat "$WORK/env.out")" 26

# 4. Slots past f are distinct directories (the old name table stopped at f).
scenario many-slots
printf 'HEAVY_SLOTS=9\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
for i in 1 2 3 4 5 6 7 8 9; do job "m$i" 6 & sleep 0.2; done
sleep 1.5
expect "nine jobs hold nine distinct slot directories" "$(ls -d "$HEAVY_ROOT"/.heavy-lock* | wc -l | tr -d ' ')" 9
wait

# 5. An exclusive job runs alone and later jobs wait behind it.
scenario exclusive
printf 'HEAVY_SLOTS=3\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
job w1 3 & sleep 0.2; job w2 3 & sleep 0.2
job x 2 exclusive & sleep 0.2
job w3 1 &
wait
expect "an exclusive job runs alone, FIFO around it" "$(start_order)" "w1 w2 x w3"
expect "nothing ran beside the exclusive job" "$(sort -n "$HEAVY_ROOT/events" | awk '$3 == "x" && $2 == "start" { s = 1; next } s && $2 == "start" { print "overlap"; exit } $3 == "x" && $2 == "end" { exit }')" ""

# 6. Lowering the slot count while the higher slots are busy: an exclusive
#    job still waits for every one of them.
scenario lowered
printf 'HEAVY_SLOTS=4\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
for i in 1 2 3; do job "l$i" 2 & sleep 0.2; done
job l4 6 & sleep 0.5
printf 'HEAVY_SLOTS=2\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
job x 1 exclusive &
wait
expect "the exclusive job waited for the job in slot d" "$(sort -n "$HEAVY_ROOT/events" | awk '$2 == "end" && $3 == "l4" { e = 1 } $2 == "start" && $3 == "x" { print (e ? "after" : "before") }')" after

# 7. Old one-slot waiters queued ahead keep FIFO on slot 0 and do not hold
#    back new jobs on the other slots.
scenario old-protocol
printf 'HEAVY_SLOTS=3\nHEAVY_MIN_AVAIL_MB=0\n' > "$HEAVY_ROOT/heavy-lock.conf"
old_job o1 4 & sleep 0.3; old_job o2 1 & sleep 0.3
job n1 2 & sleep 0.2; job n2 2 &
wait
expect "new jobs start beside an old holder, old waiters stay in order" "$(start_order)" "o1 n1 n2 o2"

# 8. Nothing is left behind.
expect "every slot released, every ticket gone" "$(find "$WORK" -mindepth 2 \( -name '.heavy-lock*' -o -path '*/.heavy-queue/*' \) | wc -l | tr -d ' ')" 0

exit $FAILED
