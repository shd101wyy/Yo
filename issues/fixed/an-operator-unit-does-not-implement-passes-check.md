# An operator `unit` does not implement passes `check`

**Severity:** S2. An invalid program is accepted. `check` and an `-O2` `compile` are green,
and the program then aborts at run time with `yo: FATAL: reached …, whose body failed to
transpile`. In `main` itself, `compile` fails with an internal compiler error.

**Status:** FIXED 2026-10-02 on branch `tss/phase6-reraise`. Found while measuring the FTT
stubs for Phase 6 step 3 of `plans/TYPE_SYSTEM_SOUNDNESS.md`. It was the only live stub found
in a specialization a call requested.

## Reproducer (measured, develop `aa772c3c9`)

```rust
{ println } :: import("std/fmt");
twice :: (fn(generic(T : Type), x : T) -> T)((x + x));
main :: (fn() -> unit)({
  y := twice(());
  println(i32(7));
});
export(main);
```

```
$ yo check main.yo            # rc 0
$ yo compile main.yo --optimize 2 -o a.out && ./a.out
yo: FATAL: reached yo_id_…_unit_id_unit_ret_…, whose body failed to transpile - …
```

At `-O0` the C compiler's `error` attribute on the stub catches the call. Without a generic,
`x := (); y := (x + x);` in `main` also passes `check`, and `compile` reports
`internal compiler error: Failed to transpile part of main's body`.

## Root cause

The operator dispatch in `_evaluate_function_call_unanchored`
(`src/evaluator/calls/function.yo`) raises `No matching call found for operator` for a
primitive receiver with no impl of the operator. It exempted `unit`, because a generic
body's trial can degrade an operand that fails to evaluate into a `unit` placeholder
(`issues/generic-trial-degrades-a-failed-evaluation-to-unit.md`). A `unit` receiver
therefore fell through to the call path. There the operator name has no binding and takes
the identifier soft fallback (`evaluator/exprs/identifer_and_operator.yo`). The call
evaluated to a `unit` with no callee, and codegen found it untranspilable.

The prelude gives `unit` `Eq` and `Ord`, so `==` and `<` dispatch normally. Only an operator
`unit` has no impl for, such as `+`, reaches the exemption.

## Fix

The exemption is kept only where a placeholder can exist. That is inside a generic body's
definition-time trial, or inside a specialization keyed on a type variable.
`SpecializingFunctionInfo.is_concrete` records, when the specialization is minted, whether
the call bound every type variable concretely: its forall bindings and runtime parameter
types. The whole cache key is not used, because it also carries the declared result, which
stays abstract until the body is evaluated. Concrete code evaluates its operands raw, so an
operand that fails throws instead of degrading. A `unit` receiver there is a real `unit`,
and the missing operator is reported:

```
error[E0610]: No matching call found for operator "+" with receiver type "unit"
  --> main.yo:2:49
note: in `twice` with T = unit, instantiated here
  --> main.yo:4:8
```

## Test

`tests/type_soundness.test.yo`, "soundness: an operator unit does not implement is rejected".
On develop both `comptime_expect_error`s see no error.
