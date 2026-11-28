# A frame that installs a handler catches an outer frame's unwind

**Severity:** S1 — a synchronous frame that installs its own handler and also forwards an outer frame's handler catches the outer handler's `unwind` and returns its value as its own result: the installer keeps running with a wrong value, and when the two frames' result types differ the program reads one type as another (ASan SEGV in safe code).

- Filed: 2026-11-28, finding F1 of VERDICTS-94 (Fable 5.2, §8), with its probes `p01` and `p01b`.
- Status: open, not fixed: retired with the mechanism at E-5 of [`plans/backlog/ERRORS_AS_VALUES.md`](../plans/backlog/ERRORS_AS_VALUES.md) (VERDICTS-96 §5). `ctl` and `unwind` are deleted, and this doc moves to `issues/retired/` with E-5.
- Related: the same root as `issues/2026-11-28-a-handler-record-built-inline-in-the-call-is-not-an-installation.md` (F4); the method-call case of the install guess was `issues/fixed/2026-10-23-an-unwind-through-a-method-call-is-not-caught-by-the-frame-that-installed-the-handler.md`.

## Reproducer

`issues/repros/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind.yo`: `outer` installs `a`; `inner` installs `b`, receives `a` and calls `leaf(which, a, b)`; `leaf` calls `a` or `b`.

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(msg : &String) -> i32);

// calls whichever handler `which` picks
leaf :: (fn(which : i32, a : Raise, b : Raise) -> i32)(
  cond(
    (which == i32(0)) => a(`a`),
    (which == i32(1)) => b(`b`),
    true => i32(7)
  )
);

// installs B locally, receives A as a parameter
inner :: (fn(which : i32, a : Raise) -> i32)({
  (b : Raise) = (
    msg -> {
      unwind(i32(200));
    }
  );
  r := leaf(which, a, b);
  println(`inner: after leaf r=${r}`);
  (r + i32(1))
});

outer :: (fn(which : i32) -> i32)({
  (a : Raise) = (
    msg -> {
      unwind(i32(100));
    }
  );
  r := inner(which, a);
  println(`outer: after inner r=${r}`);
  (r + i32(1000))
});

main :: (fn() -> unit)({
  println(`which=0 -> ${outer(i32(0))}`);
  println(`which=1 -> ${outer(i32(1))}`);
  println(`which=2 -> ${outer(i32(2))}`);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. Compiled with `--optimize 2 --sanitize address --allocator system`, rc 0:

```text
outer: after inner r=100
which=0 -> 1100
outer: after inner r=200
which=1 -> 1200
inner: after leaf r=7
outer: after inner r=8
which=2 -> 1008
```

Expected for `which=0`: `which=0 -> 100`, with no `outer: after inner` line. `a`'s unwind ends `outer`, the frame that installed `a`; `inner` caught it and returned 100 as its own result.

The second file, `issues/repros/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind-types.yo`, is the same shape with `inner : -> String` (its handler unwinds a `String`) and `outer : -> i32`. `yo check`: `evaluator OK`. Run as above, rc 1 and no program output:

```text
AddressSanitizer:DEADLYSIGNAL
=================================================================
==3366963==ERROR: AddressSanitizer: SEGV on unknown address 0x704300000069 (pc 0x74231d596432 bp 0x702319ffebb0 sp 0x702319ffeb78 T1)
==3366963==The signal is caused by a READ memory access.
```

`rsi = 0x0000704300000064`: `inner` read `outer`'s `i32(100)` from the value buffer as a `String`.

## Root cause

As VERDICTS-94 §8 states it: the install branch of `emit_effect_unwind_check` (`src/codegen/exprs/return.yo`, line 1556 on `c1f2221be`) tests only `__yo_effect_escaped`. A call is an "installation" when `_call_is_handler_installation` (`src/codegen/exprs/other-fn-call.yo`, line 1811) sees a local handler among its arguments; then any unwind that reaches the call is caught there, and the frame returns `__yo_unwind_value` as its result. `inner` passes its own `b` to `leaf`, so it catches `a`'s unwind too.

The handler records its identity before raising the flag (`_emit_unwind_target` stores `__yo_unwind_target`), and every function already has the list of its own handler literals (`context.unwind_catches`, `unwind_catches_of_body` in `src/codegen/exprs/async-completion.yo`). Only the async paths read them (`src/codegen/exprs/await.yo:532`, fixed there 2026-09-29). The docs' "A frame that only passes a handler along never catches its unwind" (`docs/en-US/ALGEBRAIC_EFFECTS.md`, "Semantics") is false for a frame that also installs one.

## Fix

Not built (VERDICTS-96 §5): no statement in `src/` or `std/` has this shape, and E-5 deletes the mechanism. The repair the doc was filed with, K-1 of [`plans/archive/CAPABILITIES_AND_HANDLERS.md`](../plans/archive/CAPABILITIES_AND_HANDLERS.md), was:

K-1: a synchronous frame catches an unwind only when `__yo_unwind_target` is one of its own handler literals (`unwind_catch_condition` over `context.unwind_catches`, as `await.yo` does); otherwise it runs its drops and re-raises. The static `_call_is_handler_installation` guess is deleted.

## Test

None: the bug is not fixed. Its reproducer stops compiling at E-5, when `ctl` and `unwind` leave the language.
