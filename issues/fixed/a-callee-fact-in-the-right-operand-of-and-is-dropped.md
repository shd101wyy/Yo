# A callee's `ensures` in the right operand of `&&` is dropped — a valid claim is refuted

**Severity:** S2 — `yo verify` refutes a correct `ensures`/`requires`/law whose
right-hand `&&`, `||` or `==>` operand calls a contracted function: the
callee's postcondition about its result is lost, so the result is
unconstrained and a counter-example "violates" it.

**Status: FIXED 2026-10-03.** Found while fixing
`issues/fixed/law-over-an-imported-callee-cannot-verify.md`; it reproduces in
one file, with every v0.2.49-era compiler.

## Reproducer

```rust
pragma(Pragma.Verify);
abs_value :: (
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((r >= i64(0)) && (r < i64(1000)))
  ) -> (r : i64)
)(cond((x >= i64(0)) => x, true => -x));
plus_abs :: (
  fn(
    x : i64,
    requires((x > i64(-1000)) && (x < i64(1000))),
    ensures((r >= i64(1)) && (abs_value(x) < i64(1000)))
  ) -> (r : i64)
)(abs_value(x) + i64(1));
export(plus_abs);
```

```
  refuted  fn@same.yo:13 [verify]
    fn@same.yo:13/ensures#0: REFUTED  counter-example: __ret_0 = #x0000000000000000, __ret_1 = #x00000000000003e8, x = #x0000000000000000
```

`__ret_1 = 1000` is the clause's own `abs_value(x)` call, a value `abs_value`'s
`ensures` (`r < 1000`) excludes. Measured: `ensures(abs_value(x) < i64(1000))`
alone proves, and so does `ensures((abs_value(x) < i64(1000)) && (r >= i64(1)))`
with the call on the LEFT. Renaming the callee's result label did not change it.

## Cause

`_expr_term` walks a short-circuit operator's right operand with the left as
a path guard (`a` for `a && b` and `a ==> b`, `!a` for `a || b`) and then
popped the path back to the guard's mark. A contracted call in that operand
had pushed its callee's `ensures` onto the same path, so the pop removed it
too, and the obligation was emitted with the fresh result unconstrained. The
comment above the `&&`/`||` walk already noted that "an ordinary binop's RHS
walk may itself push legitimate path entries (a contracted callee's ensures)".
The short-circuit pop did not keep them.

## Fix

`_pop_guard_keep_facts` (`src/verifier/vc.yo`) closes both guarded walks (`&&`/`||`
and `==>`): it pops to the mark, then re-pushes every fact the operand's walk
learned as `guard ==> fact`. The facts were derived assuming the guard, so the
implication is sound, and a fact is no longer lost where the guard holds.

Test: `tests/internal/verifier_law.test.yo` "contracts: a callee fact in the
right operand of && is kept", over `tests/spec/fixtures/valid/ensures_call_in_and.yo`
(the reproducer); refuted before, proves after.
