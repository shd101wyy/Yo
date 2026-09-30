# An allocator vtable call counts as mutating everything, so `ArrayList.clone` trips the borrowed-`for` check

**Severity:** S2 — a valid program is rejected under `pragma(Pragma.StrictBorrow)`, and panics at run time without it. Every `xs.clone()` inside `for(xs, ...)` is affected, including for lists on the global allocator.
**Found:** 2026-09-30, running the language suite on the explicit-allocators stack (`plans/archive/EXPLICIT_ALLOCATORS.md` P1). Develop passes both tests.

## Symptom

`tests/for_macro_borrow.test.yo`, "borrowed for: methods mutating only fresh storage, or iterating the collection, do not trip the flag", aborts with exit code 6. `tests/for_macro_borrow_strict.test.yo` is rejected at compile time:

```
error: Strict borrow: '(xs.clone)()' may mutate 'xs', the collection borrowed by this loop.
```

## Cause

P1 made `ArrayList.clone` allocate from its source's allocator:
`match(self.allocator(), .Some(a) => Self.with_capacity_in(a, n), .None => Self.with_capacity(n))`.
The mutation-summary analysis (`src/evaluator/effects/mutation_summary.yo`) is
a may-analysis in which an unresolvable call mutates everything. A call through
an `AllocatorVTable` slot, `((self.vtable).*).alloc(self.ctx, n)`, has no
callee it can see, so `Allocator.alloc`, `realloc` and `free` all had an `all`
mask. `YO_DEBUG_BORROW_MASK=1` shows the chain:

```
[borrow-all] classify-unresolved: (((self.vtable).(*)).alloc)((self.ctx), size + ALLOC_PREFIX_SIZE)
[borrow-all] walk: (Self.with_capacity_in)(a, n)
[borrow-all] walk: (result.push)((item.clone)())
```

`clone`'s `result` was no longer fresh, pushing into it counted as mutating
`self`, and codegen then emitted `__yo_borrow_assert_unborrowed(self)` at
`clone`'s entry. The analysis sees both branches, so the global-allocator list
tripped the flag too.

## Fix

The analysis already trusts the global allocator family by name: `__yo_malloc`
returns fresh storage, and `realloc` / `free` act on their first argument. The
explicit-allocator vtable is part of that family now, with the same contract
(`plans/archive/EXPLICIT_ALLOCATORS.md` §3). `_msp_allocator_slot` recognizes a call
through a slot of `std/allocator.yo`'s `AllocatorVTable`.

- `alloc(ctx, size)` returns a fresh block and mutates nothing a caller can
  reach. `ctx` is allocator-private state, never container storage.
- `realloc(ctx, p, n)` mutates and returns the block `p`.
- `free(ctx, p)` releases `p`.

The contract is applied in all four passes: result roots, taint, the parameter
mask, and the strict-borrow diagnostic. The two tests above fail before the fix
and pass after it, and `tests/collections/array_list.test.yo` gains an
arena-backed variant.
