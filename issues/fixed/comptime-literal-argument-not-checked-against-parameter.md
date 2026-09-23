# A comptime literal argument was never checked against a concrete parameter type

**Status: FIXED.** Found in `yo context` C4 (`plans/reference/YO_CONTEXT.md`) as "a `str`
literal passed as a `String` argument inside template interpolation
miscompiles". The first write-up guessed at the mechanism and scoped it to
`String` in interpolation; the measurements below (tree-built binary,
2026-09-23) show both guesses were too narrow.

An earlier report of the `String` case, filed 2026-09-05 and never linked to
this one, is `issues/fixed/comptime-str-passed-where-string-is-declared-emits-invalid-c.md`.

## Symptom

A `"..."` or float literal passed to a plain function `yo check`ed clean for
ANY concrete parameter type:

| call                                   | before              | a typed bind of the same pair |
| -------------------------------------- | ------------------- | ----------------------------- |
| `f(x : i32)` ← `"a"`                   | accepted            | E0601                         |
| `f(x : i32)` ← `1.5`                   | accepted            | E0601                         |
| `f(p : Point)` ← `"a"`                 | accepted            | E0601                         |
| `f(s : String)` ← `"a"`                | accepted            | E0601                         |
| `f(x : i32)` ← `u8(1)` / `true`        | E0601 (correct)     | E0601                         |

Codegen then passed the raw `__yo_str` where the C wanted the parameter's
type — `error: passing '__yo_str' to parameter of incompatible type` — with or
without an interpolation around the call (the interpolation was only where it
was first seen). A generic method (`ArrayList(String).push("a")`) already
rejected it.

## Root cause

Two call-path pieces each assumed the other checked comptime literals:

1. `_evaluate_funcval_runtime_call`'s argument gate
   (`src/evaluator/calls/function.yo`) exempts comptime arguments ("lowered
   further down") and skips every call whose argument count differs from the
   parameter count (every call that omits a defaulted parameter).
2. The binding loop in `evaluate_function_call` — "further down" — re-typed a
   `comptime_str` argument to WHATEVER the parameter declared, unchecked, and
   did nothing at all for `comptime_float`.

`are_types_compatible` already defines the literal widenings exactly
(`comptime_int` → any integer or float, `comptime_float` → any float,
`comptime_str` → `str` / `*(u8)` / `*(char)`); nothing on this path called it.

## Fix

The binding loop — the one site where argument `pi` is aligned with its
parameter — checks each SUPPLIED comptime literal against a concrete
(no type variable, non-function) parameter type with `are_types_compatible`
(`actual` first: the widening rules key on the actual type being comptime) and
throws E0601 otherwise, flagging the flow-violation channel like the gate's
concrete-type arm. `"..."` is a `str` view, so a `String` parameter takes
`String.from("...")` or a backtick literal — which is what every call site in
`src/` and `std/` already wrote (both trees check clean under the new rule:
279/279 and 176/176).

## Test

`tests/fn.test.yo` — "A comptime literal argument is checked against a
concrete parameter type": the widenings that exist still work at runtime
(`u8` ← `1`, `f64` ← `1`, `f32` ← `1.5`, `str` ← `"abc"`, a defaulted call),
and `i32` ← `"a"`, `String` ← `"a"`, struct ← `"a"`, `i32` ← `1.5` and a
defaulted call with `"a"` are `comptime_expect_error`s. Red before the fix
(the expected errors never came), green after.
