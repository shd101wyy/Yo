# yo-self: comptime_int leaks into forall inference (prelude batch)

## Symptom

`box(1) == box(1)` (tests/prelude.test.yo "Test 'Box'"):

```
error: call to undeclared function 'fn_yo_id_173'
```

Repro: `issues/repros/box-eq-comptime-int-forall-leak.yo` (7 lines) —
TS green, s1 red (all s1 generations through the capture-split round).

## Root cause

yo-self infers `box(1)`'s forall `T` from the argument's PRE-coercion
type: `comptime_int` (spec keys say `R_gs_yo_id_2743_comptime_int`; TS's
say `box_i32_idi32` — TS's inference sees the converted runtime type).
The C type mapping hides this (comptime_int renders int32_t), until the
Box `Eq` impl's `lhs.* == rhs.*` dispatches `==` on comptime_int
operands: that resolves to `ComptimeEq(comptime_int).==` —
`__yo_comptime_int_eq`, a comptime-only builtin that can never be
emitted — so the call site references `fn_yo_id_173` and the definition
is (correctly) skipped. TS's `T = i32` dispatches to the runtime i32
`==` and inlines to `(a == b)` (verified in /tmp/box_eq_ts.c).

yo-self DOES port the arg-binding coercion
(`convert_comptime_type_to_runtime_type_with_expected`,
calls/helper.yo:547, mirroring helper.ts:508-519) — the leak is earlier,
in the forall-binding loop that infers `T` from the raw arg type.

## Fix direction

In the forall inference (function.yo fa_bound_types build, and any
helper-path equivalent), lower comptime_int→i32 / comptime_float→f64
(same converter) before binding `T` — for RUNTIME-param-derived
inferences only, so `comptime(...)`-param foralls keep exact comptime
types.

## Status

- Identified 2026-07-24 while gating the capture-split fix.
- NOT addressed by the capture-split fix nor by the staged inline-arm
  spec-gate broadening (verified against /tmp/cf3probe_s1).
- Blocks: tests/prelude.test.yo (sole failure there). Possibly related:
  derive_clone_complex.
