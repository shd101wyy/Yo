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

## Addendum 2026-07-25: r3-sweep regression + the complete two-piece fix

The first fix (4bf8cb418) lowered comptime_int/float in the forall
inference UNCONDITIONALLY and regressed tests/comptime.test.yo (caught
by the r3 verification sweep, NOT the 19-file battery — comptime.test
is now permanently in the gate battery). Two pieces were missing:

1. **Gate the inference arm on the matched param being RUNTIME**
   (TS helper.ts:508 `!parameter.isCompileTimeOnly`): a
   `comptime(v) : T` param must bind T to the RAW comptime type or
   comptime-fn bodies lose ComptimeOrd/ComptimeEq dispatch.
   (\_funcval_bind_foralls now takes param_ct_flags.)
2. **The inline-FuncVal arm's spec args need the Step-4 comptime→
   runtime ARG coercion too** (mirror of
   check_if_function_parameter_matches_argument, helper.yo): with T
   lowered to f64 but rtparam0 left comptime_float, `-(x : f64)`
   minted a MIXED spec (`yo_id_124_f64_id_f64_rtparam0_comptime_float`)
   whose body bound `self : comptime_float` and dispatched
   ComptimeNeg's `__yo_comptime_float_neg` — never emitted ("call to
   undeclared function 'fn_yo_id_199'"). Pre-r3 this case never minted
   a spec at all (all-comptime → folded at CTFE), which is why it was
   green before.

r5 lesson: the arg coercion must cover comptime_int/float ONLY.
Including comptime_str re-typed the ESTABLISHED green-baseline
`..._rtparam_comptime_str...` specs (assert et al.) — str's conversion
needs the expected type (`*(char)` vs `__yo_str`), and the blanket
version crashed fs/walker at startup (instant SIGSEGV, zero output;
discriminated from phantom kills by running the r3 binary as a control
under identical load). Narrowed in r6.

Verified with the final two-piece fix (gated inference arm +
int/float-only inline-arm arg coercion): walker 6/6 restored,
comptime.test 28/28 restored, prelude 4/4 holds, box-eq repro green.
Full gate chain + fixpoint: r6 round.
