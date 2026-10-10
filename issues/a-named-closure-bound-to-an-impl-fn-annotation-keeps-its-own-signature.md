# A named closure bound to an `Impl(Fn(...))` annotation of another signature is accepted, and the annotation ignored

**Severity:** S2 — `(c2 : Impl(Fn(x : i32) -> i32)) = c` type-checks for a closure `c : Impl(Fn(t : String) -> usize)`; the binding silently takes `c`'s type, so the annotation states a signature the value does not have (calls through `c2` are checked against `c`'s real one, so no memory unsafety follows).

**Status:** OPEN
**Found:** 2026-10-10, probing every route a function value takes into a function-typed slot for
`issues/fixed/a-function-argument-is-not-checked-against-a-function-typed-parameter.md`. That fix
rejects a closure whose parameter MODES differ from the annotation's
(`function_value_slot_mismatch` in the typed declaration); the parameter TYPES and result are still
not compared.

## Repro

```rust
{ String } :: import("std/string");
main :: (fn() -> unit)({
  (c : Impl(Fn(t : String) -> usize)) = (t => t.len());
  (c2 : Impl(Fn(x : i32) -> i32)) = c;      // ACCEPTED
  // c2(i32(5))  -> error[E0601]: Cannot unify incompatible types: "String" and "i32"
});
export(main);
```

`yo check` exits 0. Passing `c` to a parameter `f : Impl(Fn(x : i32) -> i32)` is rejected, but
only inside the callee's body (`f(i32(1))` fails to unify `String` and `i32`), not at the argument.

## Analysis (not yet root-caused)

The declaration path (`src/evaluator/exprs/assignment.yo`, the "Type-compatibility check" of a
typed `(x : T) = rhs`) compares `are_types_compatible(rhs_type, variable.ty)`; for an `Impl(...)`
annotation the variable's SomeT is evidently resolved to the right-hand closure before the check
(both sides are then the same bound closure identity), so the comparison is vacuous. The expected
fix is to judge the closure's `Fn(...)` carrier against the annotation's
(`are_types_compatible` on the two `FnTraitT`s, which compares parameter types, result and, since
the fix above, modes) before the annotation adopts the value's type — at the binding and at an
`Impl(Fn(...))` argument (`check_argument_for_parameter`, which today compares only modes for a
closure).
