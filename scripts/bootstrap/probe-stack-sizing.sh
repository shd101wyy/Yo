#!/usr/bin/env bash
#
# Does a compiled Yo binary actually GET the worker stack it asks for?
#
# Codegen runs `main` on a worker thread requested at 1 GiB
# (`__yo_main_stack`, overridable via YO_MAIN_STACK_MB) and falls back SILENTLY
# to `__yo_main_thread_entry(NULL)` on the ~8 MB process stack if
# pthread_create fails:
#
#     if (pthread_attr_init(...) == 0
#         && pthread_attr_setstacksize(&attr, __yo_main_stack) == 0
#         && pthread_create(&tid, &attr, __yo_main_thread_entry, NULL) == 0) { ... }
#     else { __yo_main_thread_entry(NULL); }
#
# A build that ignored the request would therefore pass ordinary workloads and
# SIGSEGV (rc=139, no message) only on deep recursion — the Windows failure in
# issues/windows-no-main-worker-stack-rc139.md, where YO_MAIN_STACK_MB was
# silently a no-op. This matters most for the static musl bundle, whose libc
# defaults to a ~128 KB thread stack against glibc's 8 MB.
#
# WHY A SYNTHETIC PROBE RATHER THAN `check ./yo-self`: that workload needs under
# 1 MB at -O2 (LLVM stack coloring shrinks frames ~100x), so it cannot reach the
# threshold and a sweep over it returns "pass" at every size — measured, see
# plans/archive/P3_DISTRIBUTION.md item 3.
#
# THE TRAP THIS SCRIPT ENCODES: naive "non-tail" recursion is NOT enough.
# `n + recur(n - 1)` gets linearised by LLVM's accumulator tail-call transform
# because addition is associative, and the probe then reports 500,000 frames
# fitting in 1 MB — 2 bytes per frame, i.e. no recursion at all. The `inout`
# local below makes the address escape, which pins a real frame per level.
#
# Usage:  probe-stack-sizing.sh <path-to-yo>       # e.g. /tmp/seed-musl/bin/yo
# Exit:   0 = the request is HONOURED (small stack fails, large stack passes)
#         1 = ignored, or inconclusive
set -uo pipefail
YO=${1:?usage: probe-stack-sizing.sh <path-to-yo>}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/probe.yo" <<'YO'
open(import("std/fmt"));

bump :: (fn(inout(x) : i64) -> unit)({ x = (x + i64(1)); });

deep :: (fn(n : i64) -> i64)(
  cond(
    (n <= i64(0)) => i64(0),
    true => {
      local := n;
      r := recur((n - i64(1)));
      bump(local);
      (r + local)
    }
  )
);

main :: (fn() -> unit)({
  println(`ok, sum = ${deep(i64(500000))}`);
});

export(main);
YO

"$YO" compile "$WORK/probe.yo" --optimize 2 -o "$WORK/probe" > "$WORK/compile.log" 2>&1 || {
  echo "::error::probe failed to compile"; tail -20 "$WORK/compile.log"; exit 1; }

# Subshells with stderr closed: the SMALL run is EXPECTED to die on a signal,
# and bash announces that ("Bus error", "Segmentation fault") from the shell
# itself, not the program — which reads as a genuine failure in a CI log.
# Run each in a CHILD shell that reports its own exit code. The SMALL run is
# EXPECTED to die on a signal, and the announcement ("Bus error",
# "Segmentation fault") is emitted by the shell that WAITS on it — so
# redirecting the command, or even a subshell around it, does not suppress it.
# Letting a child print the rc and discarding that child's stderr does.
run_at() {  # <stack-mb> -> echoes the rc
  bash -c 'YO_MAIN_STACK_MB=$1 "$2" >/dev/null 2>&1; echo $?' _ "$1" "$WORK/probe" 2>/dev/null
}
SMALL=$(run_at 1)
LARGE=$(run_at 64)

echo "500k-deep recursion (~12 MB of frames):"
echo "  YO_MAIN_STACK_MB=1  -> rc=$SMALL"
echo "  YO_MAIN_STACK_MB=64 -> rc=$LARGE"

if [ "$LARGE" -ne 0 ]; then
  echo "::error::64 MB was NOT enough (rc=$LARGE) — the stack request is not being honoured, or the binary is broken"
  exit 1
fi
if [ "$SMALL" -eq 0 ]; then
  echo "::error::1 MB ALSO sufficed, so the size is being ignored — main is very likely running on the process stack via the silent pthread_create fallback"
  exit 1
fi
echo "HONOURED: 1 MB fails, 64 MB passes — the requested stack size takes effect"
