# The borrow-assert mutation summary read a typed local declaration as a store (false panic)

**Status: FIXED (2026-09-07, PR #476, found in its second soundness review).**

## Symptom

```rust
for(xs, inout(x) => { xs.index_of(x); });   // panic: container operation while an interior reference ... borrows from it
```

`ArrayList.index_of` is read-only. Its body declares `(result : Option(usize)) = .None`.

## Root cause

`function_may_mutate_param_storage` (`src/evaluator/effects/mutation_summary.yo`)
classifies every `=` by its lhs. The typed declaration form `(name : T) = init`
has a colon PAIR as its lhs; the root walk stripped the call shape down to the
atom `:`, found no such variable, and answered "unresolvable → mutates". Every
method with a typed local was flagged, and its compiler-emitted entry assert
fired inside a borrowed `for`.

## Fix

The `=` rule recognises a colon-pair lhs as a declaration and walks only the
initializer, exactly like `:=`.

## Test

`tests/for_macro_borrow.test.yo` — "borrowed for: read-only methods with typed
local declarations do not trip the flag" (`index_of` and a user method).
