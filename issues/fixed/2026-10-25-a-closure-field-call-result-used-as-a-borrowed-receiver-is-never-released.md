# A closure-field call's owned result used as a borrowed receiver is never released

**Severity:** S1 — unbounded leak: `h.cb(x).len()` with `cb : Dyn(Fn(x : i32) -> String)`, or a static `Impl(Fn …)` field, leaked the call's result once per evaluation (LeakSanitizer: one direct leak per call site run).

**Status:** FIXED 2026-10-25 (branch `fix/s1-closure-field-call-hoist`). Found while gating
`issues/fixed/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.md`,
and fixed by the same change.

## Reproducer

Built with `--std-path ./std --sanitize address --allocator system`, run with `ASAN_OPTIONS=detect_leaks=1`:

```yo
{ assert } :: import("std/assert");
{ String } :: import("std/string");
Holder :: struct(cb : Dyn(Fn(x : i32) -> String));
main :: (fn() -> unit)({
  p := String.from("ab");
  h := Holder(
    cb : dyn({ p }(x : i32) => p.clone())
  );
  assert(h.cb(i32(4)).len() == usize(2), "receiver");
  ()
});
export(main);
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 32 byte(s) in 1 object(s) allocated from:
```

The same program with a generic holder `Gen(F)` whose field is an `Impl(Fn(x : i32) -> String)`
leaks the same way.

## Root cause

The evaluator gives the call a result temp, and its scope-end drop releases that temp. A drop of a
name that was never declared is skipped (`generate_deferred_drop_expressions`). The
function-pointer / closure tail of `generate_other_function_call` (`src/codegen/exprs/other_fn_call.yo`)
declared the temp only for a call that may unwind, and a call through a field is not one. It returned
the call as an inline expression instead. A by-value argument or a binding re-declares such an
operand under its temp name. A `&self` method receiver does not, so the temp was never declared and
its release was dropped: the same class as
`issues/fixed/2026-10-16-a-downcast-result-used-as-a-method-receiver-is-never-released.md`.

## Fix

The closure tail now declares `T tv = <call>;` for every call that has a result temp, as the
registered direct call does (see the order fix linked above). The receiver then reads the declared
temp, and its scope-end drop runs.

## Test

`tests/fn_once.test.yo`, "FnOnce: a closure-field call's owned result as a borrowed receiver is
released once". The closures return a `_OnceTok`, whose `Drop` counts, through a `Dyn(Fn)` field and
through a generic `Impl(Fn)` field. Each receiver temp must be disposed exactly once. Before the fix
the count stays at `before` (the assertion fails); after it, `before + 2`.
