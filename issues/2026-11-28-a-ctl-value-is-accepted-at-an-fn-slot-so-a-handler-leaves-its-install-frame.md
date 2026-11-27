# A `ctl` value is accepted at an `fn` slot, so a handler leaves its install frame

**Severity:** S2 — a handler returned from its install frame as a plain `fn` passes `yo check`; calling it later unwinds with no installer, and `main` ends silently with rc 0, skipping the rest of the program. With F1 (`issues/2026-11-28-a-frame-that-installs-a-handler-catches-an-outer-frames-unwind.md`) the unwind can instead be caught by an unrelated frame that reads its value as its own result type: S1 then.

- Filed: 2026-11-28, finding F3 of VERDICTS-94 (Fable 5.2, §8), with its probe `p05`.
- Status: open. Closed by K-3 of [`plans/backlog/CAPABILITIES_AND_HANDLERS.md`](../plans/backlog/CAPABILITIES_AND_HANDLERS.md) (v0.2.82).

## Reproducer

`issues/repros/2026-11-28-a-ctl-value-is-accepted-at-an-fn-slot-so-a-handler-leaves-its-install-frame.yo`:

```yo
{ println } :: import("std/fmt");
{ String } :: import("std/string");

Raise :: (ctl(code : i32) -> i32);
Plain :: (fn(code : i32) -> i32);

// the install frame hands its handler out as a plain fn: the frame-bound rule
// only looks for `ctl` in the result type
make :: (fn() -> Plain)({
  (raise : Raise) = (
    code -> {
      unwind(Plain_dummy);
    }
  );
  raise
});
Plain_dummy :: (fn(code : i32) -> i32)(code);

use_later :: (fn(p : Plain) -> String)({
  r := p(i32(5));
  `use_later saw ${r}`
});

main :: (fn() -> unit)({
  p := make();
  s := use_later(p);
  println(&s);
});
export(main);
```

`yo check` (v0.2.80, its bundled std, 2026-11-28): `evaluator OK`. Compiled with `--optimize 2 --sanitize address --allocator system`: no output, rc 0.

Expected: a compile error at `raise` in `make`'s tail (a `ctl(code : i32) -> i32` value where `fn(code : i32) -> i32` is expected). The docs state the rule: "A regular `fn(T) -> R` is accepted where a `ctl(T) -> R` is expected … The reverse is unsafe and rejected" (`docs/en-US/ALGEBRAIC_EFFECTS.md`, "Typing rules for control functions", rule 5).

## Root cause

As VERDICTS-94 §8 states it: the `Func` branch of `src/types/compatibility.yo` (line 856 on `c1f2221be`) compares generic counts, parameters, modes and results, and never compares `meta.is_control`. So `ctl <: fn` holds as well as `fn <: ctl`. The frame-bound escape rules (rule 8) look for a `ctl` type in the result type, the binding type and the captures; once the value is typed `Plain` none of them sees a handler. Because any function value may be a handler in disguise, codegen also treats every call through a function value as one that may unwind (VERDICTS-94 §3: a hello-world emits 26 `if (__yo_effect_escaped)` tests).

## Fix

K-3: a `ctl` value is not an `fn` (the direction check in the `Func` branch, with a coded diagnostic); a closure at a `ctl` slot is an error (F2); a control-bound value cannot be written through a `&mut` (F6's stopgap). A call through a plain function value then never unwinds, so the may-unwind decision is exact.

## Test

None in this filing: the bug is open with no fix. The test lands with K-3: this repro as a `comptime_expect_error` case.
