# `__yo_cleanup_thread_gc` force-dispose walk double-frees tracked objects (exit-after-work rc=134/133)

## Status: FIXED (2026-07-17) — TS `src/codegen/functions/generation.ts` + yo-self mirror `yo-self/codegen/functions/gc_runtime.yo`

This was "Bug 3" of the yo-self test-runner era
(`issues/yo-self-test-runner-remaining-bugs.md`): any yo-self binary calling
`exit(1)` after real work (a failing `test` suite, a failing `check`) died
with SIGABRT (rc=134) in the atexit teardown instead of exiting 1 —
`__yo_process_cleanup → __yo_cleanup_thread_gc → malloc "POINTER BEING FREED
WAS NOT ALLOCATED"`. It was previously attributed to an RC imbalance in
yo-self/std source on the spawn/await path. It is NOT — it is an upstream
bug in the TS-emitted C runtime, reproducible with a 13-line program.

## Minimal reproducer (TS-compiled, pre-fix: SIGTRAP rc=133; post-fix: rc=1)

```rust
pragma(Pragma.AllowUnsafe);
{ exit } :: import("std/libc/stdlib");
List :: ref(
  struct(
    value : i32,
    next : Option(Self)
  )
);
main :: (fn() -> unit)({
  a := List(1,.Some(List(2,.None)));
  unsafe(exit(int(1)));
});
export(main);
```

The inner node's ONLY reference is the outer node's `next` field, and
`exit()` skips scope cleanup, so both tracked objects are still alive when
the atexit walk runs.

## Root cause

`__yo_cleanup_thread_gc` force-disposes every tracked object:

```c
while (current != NULL) {
  next = current->gc_next;
  if (current->dispose_fn) current->dispose_fn(current);  // ← side effects!
  __yo_free(current);
  current = next;
}
```

`dispose_fn(current)` decrements children via `__yo_decr_rc`. If that drops
the LAST reference on another tracked object, decr_rc frees + unlinks it
mid-walk; when that object was the captured `next`, the walk then disposes
and frees it AGAIN (double free → libmalloc abort). Objects earlier in the
walk are also re-decremented after having been force-freed (use-after-free).
`__yo_gc_collect` protects itself from exactly this with the
`__yo_gc_collecting` flag (decr_rc skips tracked objects while set) — the
cleanup walk simply lacked the same protection.

Small programs never noticed: the bug needs tracked (cycle-capable) objects
still alive at exit whose dispose order hits the topology. yo-self's
evaluator heap made it a certainty, which is why every failing `s1/s2 test`
or `check` run exited 134 instead of 1.

## Fix

Set `__yo_gc_collecting = 1` before the force-dispose walk (left set — the
thread is exiting; any later decrement on tracked memory would be UAF).
Every tracked object is disposed and freed exactly once by the walk;
untracked objects still go through normal refcounting. Applied identically
to the TS emitter and the yo-self port; fixpoint re-verified after.

## Regression test

`tests/gc_cleanup_exit.test.yo` — self-spawns (argv[0] + `YO_GC_EXIT_CHILD`
env sentinel) and asserts the child EXITS non-zero (signal == 0) rather than
dying on a signal. Pre-fix: child dies signal 5, and the parent's own
assert-failure exit path aborts too (the same bug biting the runner's
fail-exit — Bug 3's rc=134 in miniature).
