# The borrow-assert mutation summary saw every index-trait read `xs(i)` as an opaque call (false panic)

**Status: FIXED (2026-09-07, PR #476, found in its third soundness pass).**

## Symptom

```rust
impl(Bag, first : (fn(self : Self) -> i32)(self.items(usize(0))));
for(bag, inout(x) => { bag.first(); });   // panic: container operation while an interior reference ... borrows from it
```

`first` only reads an element.

## Root cause

`function_may_mutate_param_storage` (`src/evaluator/effects/mutation_summary.yo`)
classifies a call by the value recorded on its FUNC expression. For an
index-trait call `xs(i)` that expression is the collection (a runtime value,
no `FuncVal`), and the method-callee side table has no entry either, so the
call fell through to "unresolvable callee → mutates". Every method that reads
an element by index carried an entry assert, and panicked inside a borrowed
`for` over the object.

## Fix

The evaluator already records the specialized `index` method on the call's
own ExprInfo (`index_method_value` — the value codegen invokes). The walker
now classifies the call by that `FuncVal`, so `ArrayList.index` (a bounds
check and a pointer add) answers "read-only" and the receiver and index
arguments are walked as usual.

## Test

`tests/for_macro_borrow.test.yo` — "borrowed for: read-only methods with typed
local declarations do not trip the flag" (`first_over` reads `self.items(i)`).
