# An array constructor over a reference element type emits invalid C

**Severity:** S2 — `Array(&i32, 2)(rx, rx)` over a reference binding passes `yo check` but the C compiler rejects it, and no spelling of the constructor builds an array of references.

- Filed: 2026-11-12 (tuplec lane, probing the array shape of `issues/fixed/2026-11-12-a-tuple-of-by-value-reference-parameters-emits-invalid-c.md`).
- Not R3's (#1904): the v0.2.76 seed rejected the same program in the evaluator (`Failed to evaluate right-hand side of assignment: (q.(*))`). The generic form (`Array(T, 2)(a, a)` at `T := &i32`) compiles and runs on develop `4f8f975b3`.

## Reproducer

Program: `issues/repros/2026-11-12-an-array-constructor-over-a-reference-element-type-emits-invalid-c.yo`.

```yo ignore
x := i32(1);
rx := &x;
p := Array(&i32, 2)(rx, rx);
```

clang:

```text
error: incompatible integer to pointer conversion initializing 'const int32_t *' (aka 'const int *') with an expression of type 'int32_t' (aka 'int'); take the address with & [-Wint-conversion]
```

The same with a `a : &i32` parameter in place of `rx`. The lend spelling `Array(&i32, 2)(&x, &x)` is rejected (`` `&x` lends a borrow: it is written as a call argument to a `&T` parameter, … as a tuple element … ``).

## Root cause (first read)

The array constructor's elements are neither a lend position (a tuple element, a struct constructor's reference field: decision 43 step 3, T9) nor checked by the read rule: a reference binding read where a `&i32` element is expected is not E0926 (the tuple literal `(rx, i32(1))` is), and codegen emits the binding's read (`*rx`, the `i32`) into a `const int32_t *` slot.

## Fix

Make an `Array(&U, N)(…)` element a lend position like a tuple element (`&x`, `&rx.*` accepted and lowered to the place's address; a bare reference binding E0926), or reject a reference element type in the constructor with a diagnostic. Test: the reproducer (spelled with lends) runs, or `comptime_expect_error` names the rule.
