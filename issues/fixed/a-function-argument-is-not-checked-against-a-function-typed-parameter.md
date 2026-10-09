# A function argument is not checked against a function-typed parameter: a by-value callee drops what its caller only lent

**Severity:** S1 — `check` and `compile` accepted a `fn(s : String)` for a `fn(imm(s) : String)` slot; since V3b's flip the callee owns and drops the argument the caller only lent, a double free (wrong output at -O2, a SIGSEGV in `tests/internal/typeof.test.yo`).

**Found:** 2026-10-10, on the V3b stack (`feat/vbd-v3b-markers-a`), when `tests/internal/typeof.test.yo`
exited 11: it passed `stub_evaluate(expr : AstExpr, env : Environment, ctx : EvalContext)` to
`set_evaluate_expression_fn(f : EvaluateExprFn)`, whose type has `imm(...)` parameters. v0.2.56 accepts
the same program (pre-existing); the flip made it a crash.
**Status:** FIXED.

## Repro

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
Hook :: (fn(imm(s) : String) -> usize);
call_hook :: (fn(f : Hook, imm(s) : String) -> usize)(f(s));
byval :: (fn(s : String) -> usize)(s.len());
main :: (fn() -> unit)({
  s := String.from("abc").concat(String.from("defghijklmnopqrstuvwxyz0123456789"));
  (i : i32) = i32(0);
  (t : usize) = usize(0);
  while(i < i32(5), {
    t = (t + call_hook(byval, s));   // ACCEPTED: byval takes s by value
    i = (i + i32(1));
  });
  println(`${t} ${s}`);
});
export(main);
```

Before: `check` exits 0, and the `--optimize 2` binary prints `36  ` — the first call's callee released
`s`, every later call read a freed string (expected `180 abcdefghijklmnopqrstuvwxyz0123456789`).
Binding the same value is rejected, so the two routes disagreed:

```
(h : Hook) = byval;
error[E0601]: Incompatible types:
- Expected: fn(imm(s) : String) -> usize
- Given   : fn(s : String) -> usize
```

After: the argument is rejected with the binding's message, plus the parameter that differs:

```
error[E0601]: Incompatible types:
- Expected: fn(imm(s) : String) -> usize
- Given   : fn(s : String) -> usize
Parameter 1 is `imm(s)` in the expected type and `s` in the given one: a parameter's mode is part of the function type.
```

## Root cause

A parameter's mode is part of a function type (`docs/en-US/DESIGN.md`, "Parameter modes are part of
the function type"), and `are_types_compatible`'s `.Func` arm compares `param_is_ref` /
`param_is_owning` — which is why binding, a struct field, an `Option(...).Some` payload and a
function's result all rejected the value. Four routes into a function-typed slot never asked:

1. **A call to a non-generic function** (`_evaluate_funcval_runtime_call`,
   `src/evaluator/calls/function.yo:3957`). Its argument check treats a FUNCTION-typed parameter as
   generic and skips it (`|| is_function_type(_ac_pty)`, line 4041: a callback slot's type variables
   live inside the `Func`). So the whole signature went unchecked — not only the modes, but a
   function returning `i32` for a `-> usize` slot, and even an `i32` for a `fn(...)` parameter.
2. **The shared argument rule** (`check_argument_for_parameter`, `src/evaluator/calls/helper.yo:1151`,
   used by the method / `try_to_call` path and the specialization arm) had no function-type rule at
   all; for an `Impl(Fn(...))` parameter it checked only that the argument is callable
   (`fn_constrained_param_requires_callable`, line 1215), and `impl_param_unmet_trait` leaves `Fn`
   traits to that check (`src/evaluator/trait_checking.yo:2327`). A by-value `fn(s : String)` passed to
   `Impl(Fn(imm(s) : String) -> usize)` was accepted.
3. **`Fn(...)` carriers compared without modes**: `_compat_impl`'s `.FnTraitT` arm
   (`src/types/compatibility.yo:1530`) compared base name, parameter types and result, never
   `call_param_is_ref` / `call_param_is_owning`. A closure typed `Fn(t : String)` passed or bound where
   `Fn(imm(t) : String)` is expected, and a `Dyn(Fn(y : i32))` passed to a `Dyn(Fn(imm(x) : A))`
   parameter, were one type.
4. **`dyn(f)` of a function value** (`_require_dyn_traits_implemented`,
   `src/evaluator/values/dyn.yo:229`/`326`) checks only nominal `TraitT` requirements: a
   `FnTraitT` requirement was assumed to be a dyn'd closure literal "which IS its own implementation".
   `dyn(byval)` was accepted into `Dyn(Fn(imm(s) : String) -> usize)`, and into
   `Dyn(Fn(x : i32) -> i32)` as well.

## Fix

One predicate, `function_value_slot_mismatch(expected, given)` (`src/evaluator/trait_checking.yo`),
applied on every route that lacked it:

- it compares the parameter MODES of a function type or an `Fn(...)` carrier (an `Impl(Fn(...))`, a
  `Dyn(Fn(...))`, a named closure) against a function type or carrier, position by position — modes
  never depend on a type variable, so it holds for generic slots too; a carrier whose flags were not
  all recorded is not judged;
- for a CONCRETE `fn(...)` slot (no type variable anywhere) and a concrete argument it applies
  `are_types_compatible`, the binding rule, to the whole signature;
- it returns the E0601 note naming the first parameter whose mode differs.

Callers: `check_argument_for_parameter` (helper.yo), the non-generic call's argument loop
(`_evaluate_funcval_runtime_call`), the typed declaration `(x : T) = rhs` (assignment.yo, for a named
closure bound to an `Impl(Fn(...))` annotation), and `dyn(...)` of a function payload (dyn.yo, which
judges a `fn(...)` value on the whole signature through `type_implements_trait_bool`, a closure on its
modes). `_compat_impl`'s `.FnTraitT` arm now compares the mode flags when both carriers record them.

`sink(x)` stays one mode with a plain by-value `x` (`FuncMeta.param_is_sink` is caller-side only and
not part of the type), so a `sink` function fills a by-value slot and the reverse; `sink` against
`imm`/`mut` is rejected like by-value. A closure LITERAL adopts the slot's modes and is accepted. An
impl member's receiver may still be written with another self mode than the trait declares (the
`imm(self)` impl of a plain-`self` trait method in `tests/parameter_modes.test.yo` passes).

Sites the rule surfaced: `tests/type_soundness.test.yo` bound `(inc : Dyn(Fn(y : i32) -> i32))` and
passed it to `_sound_apply_dyn`'s `imm(f) : Dyn(Fn(imm(x) : A) -> B)` (the V3b spelling sweep gave the
parameter `imm(x)` but left the local by value); the local is now `Dyn(Fn(imm(y) : i32) -> i32)`.
`src/` and `std/` had none.

## Verification

- `tests/parameter_modes.test.yo`: "a function argument's modes must be its function-typed
  parameter's" (a named fn, a fn-typed local, a method value, `sink` → `imm`, `imm` → by value,
  plain/`imm` → `mut`, `Impl(Fn(imm(...)))` and `Impl(Fn(mut(...)))` given a by-value fn, a by-value
  named closure for `Impl(Fn(imm(...)))`, struct field, `Option.Some`, result, binding), "a
  function-typed parameter checks the whole signature of a concrete slot" (a `-> i32` fn and an `i32`
  for a `fn(...) -> usize` slot), and the canaries "a function value whose modes are the slot's is
  accepted" (exact modes, `sink` for by value, `mut` for `mut`, a closure literal, a named closure with
  the slot's modes, a struct field). Red on the pre-fix compiler (`comptime_expect_error` saw no
  error), green after.
- `tests/dyn.test.yo`: "dyn of a function value checks its signature against the Dyn's `Fn`".
