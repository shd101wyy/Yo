# `consume(x)` of an `FnOnce` closure's own capture leaks it

**Status:** Fixed 2026-10-31 (`fix/arc-make-mut-leak`).

**Severity:** S2 — `consume(t)` on a by-value capture-list entry inside an `FnOnce(...)` body releases nothing, and the body's call-end drop is suppressed by the consume's mark, so the capture is never dropped: its `Drop` never runs and its memory leaks once per call; the workaround is `drop(t)` (or any other move).

**Found:** 2026-10-31. `tests/arc.test.yo` "Arc.make_mut and Arc.try_unwrap against an ArcWeak upgrade on another thread" (added by #1688) failed every local run under the leak verdict, 4800 bytes in 300 objects, with the v0.2.73 seed and a tree binary alike, while develop's CI battery was green. The leak is not in `Arc.make_mut` or `Arc.try_unwrap`: each of the 300 rounds leaks the original `Arc` cell because the worker's `ArcWeak` is never released, and the worker's body releases it only through `consume(w)`. A worker that does nothing but `consume(w)` leaks the same 16 bytes with no `make_mut` in the program.

## Reproducer

```yo
{ Thread } :: import("std/thread");
_P :: struct(a : i32, b : i32);
main :: (fn() -> unit)({
  a := Arc.new(_P(a : i32(0), b : i32(0)));
  w := Arc.downgrade(&a);
  t := Thread(i32).spawn({ w }(io) => {
    consume(w);
    i32(0)
  });
  t.join();
});
export(main);
```

```
$ yo compile repro.yo --sanitize address --allocator system -o r && ./r
Direct leak of 16 byte(s) in 1 object(s) allocated from:   (the Arc cell, from Arc.new in main)
SUMMARY: AddressSanitizer: 16 byte(s) leaked in 1 allocation(s).
```

A local `Impl(FnOnce() -> i32)` closure `({ t }() => { consume(t); i32(8) })` over a `Drop` type shows it with no sanitizer: the `Drop` never runs.

## Root cause

`_consume_releases_variable` (`src/evaluator/builtins/consume.yo`, #1416) decides whether `consume(x)` releases `x`, mirroring the scope-end drop scheduler's eligibility. It excluded every name in `ctx.captured_variables`, on the premise that "a capture of the current closure belongs to the closure's capture struct, which releases it". Decision 37 made that false for one kind of capture: an `FnOnce(...)` closure with a capture list OWNS its by-value entries, and the function-body drop pass schedules their drops at the end of the call (`mark_fnonce_capture_drop`, `src/evaluator/exprs/begin.yo`). The consume still marked the capture moved, which suppresses that call-end drop, but released nothing itself, so nobody dropped the capture. A move by call (`drop(t)`, `_once_take(t)`) was correct: the callee owns the value.

## Fix

`_consume_releases_variable` now excludes a captured name only when it is not the current closure's own `FnOnce` capture-list binding. The test is `is_own_fnonce_capture` (`src/evaluator/utils.yo`), which shares one frame walk with `_is_implicit_closure_capture` (`_closure_binding_site`): the binding sits in this closure's `FnOnce` capture frame, not an enclosing closure's. `io.async` bodies keep the old answer, because their state machine owns and disposes its captures.

Tests: `tests/fn_once.test.yo` "FnOnce: consume of a capture releases it" counts `Drop` runs, so it fails before the fix with the leak verdict off too. The `tests/arc.test.yo` row that found it is the leak witness (30/31 before, 31/31 after, verdict on).

## Why CI did not see it

Every `test.yml` job sets `YO_TEST_LEAK_VERDICT: "0"` (the staging ratchet in `issues/fixed/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`). Only the weekly `leak-verdict.yml` leg runs with the verdict on, over an allowlist that did not include `tests/arc.test.yo`. #1688's local gate also ran its language tests with `YO_TEST_LEAK_VERDICT=0`, so its "arc 31/31" was the same blind spot, not a pre-rebase pass. Its value assertions held because the leak changes no value the test reads.
