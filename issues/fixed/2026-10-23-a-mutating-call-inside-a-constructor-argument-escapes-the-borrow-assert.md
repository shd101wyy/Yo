# A mutating call inside a constructor argument escapes the borrow assert

**Severity:** S1 — a safe-looking program reads freed memory. A `&mut self`
method whose only write to the receiver happens inside a constructor
argument (`W(a : push_len(&mut self.items), b : 0)` or
`.Some(push_len(&mut self.items))`) gets no entry invalidation assert. Called through a second handle inside a borrowed
`for(&mut bag, …)`, it reallocates the walked buffer, and the loop then
writes through a dangling element pointer.

**Status:** fixed (branch `fix/c7-readonly-iter-receiver`). **Found:**
2026-10-23 while tracing
`issues/fixed/2026-10-23-a-read-only-method-iterating-a-value-field-asserts-its-receiver-unborrowed.md`.
The v0.2.68 seed and develop `7898d4da0` behave the same.

## Reproducer

`tests/cli-cases/inout-for-ctor-arg-mutation-struct-panics/fixture/src/main.yo`
(and its `-enum-` sibling; the `-tuple-` one already asserted and is kept as
a guard, because the fix's helper now also looks inside tuple values):

```yo ignore
W :: struct(a : usize, b : usize);
push_len :: (fn(xs : &mut ArrayList(i32)) -> usize)({
  xs.push(i32(5));
  xs.len()
});
// Bag :: ref(struct(items : ArrayList(i32))) implements BorrowedWalk.
impl(
  Bag,
  grow : (fn(self : &mut Self) -> usize)({
    w := W(a : push_len(&mut self.items), b : usize(0));
    w.b
  })
);
// main: other := bag; for(&mut bag, x => { seen = (seen + other.grow()); x = (x + i32(1)); });
```

Under `--sanitize address` the struct and enum shapes report a
heap-use-after-free on the loop's `x = (x + i32(1))` (measured with the v0.2.68
seed). Binding the call first
(`a := push_len(&mut self.items); W(a : a, …)`) panics correctly with
"container operation while an interior reference … borrows from it".

## Root cause

The PARAM-STORAGE mask walk (`_MsP.walk`,
`src/evaluator/effects/mutation_summary.yo`) skips any call whose
`ExprInfo.value` is not exactly `UnknownVal`, reading it as a compile-time
fold that never runs. A runtime construction's value is a SHELL
(`StructVal`/`EnumVal`) with an `UnknownVal` leaf, so the walk
skipped the whole construction and never visited the mutating argument.

## Fix

The gate uses `value_contains_unknown` (`src/value.yo`): a value counts as
folded only when no leaf is unknown. The walk now descends into the
construction, sees `push_len` write `self.items`, and `grow` carries the
assert. The same change fixes the false assert in the sibling doc above.

Regression tests: `tests/cli-cases/inout-for-ctor-arg-mutation-struct-panics`,
`…-enum-panics` (both failed before the fix) and the guard
`…-tuple-panics` (rc 1, the panic line).
