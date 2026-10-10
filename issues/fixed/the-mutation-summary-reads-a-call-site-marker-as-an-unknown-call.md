# The mutation summary read a call-site marker (`&x`, `&mut x`) as an unknown call

**Severity:** S2 — an `imm` binding passed to a `mut` parameter that the callee never writes was rejected with E0908 as soon as the callee's body lent anything through a marker (and every such body got the conservative "may write everything" mask).

> Found 2026-10-10 by the marker sweep (plans/VALUES_BY_DEFAULT.md V3b,
> branch feat/vbd-v3b-marker-sweep): after `HashMap._hash`'s body became
> `key.hash(&mut h)`, `HashMap.get(imm(key))`'s `self._hash(key)` was E0908
> under the stand-in seed, v0.2.57 and the tree compiler alike, and the
> compiler itself (`token.yo`'s `g_token_intern.get(s)`) stopped building.
> **FIXED same day** in the tree; a seed must carry it before std and the
> compiler can be swept.

## Reproducer

```rust
{ String } :: import("std/string");
{ DefaultHasher } :: import("std/hash");
Table :: struct(n : u64);
impl(
  Table,
  _digest : (fn(imm(self) : Self, mut(key) : String) -> u64)({
    h := DefaultHasher.new();
    key.hash(&mut h);
    (h.finish() % self.n)
  }),
  lookup : (fn(imm(self) : Self, imm(key) : String) -> u64)(self._digest(key))
);
```

With `key.hash(h)` (the pre-marker spelling) `lookup` compiles; with
`key.hash(&mut h)` it is E0908 ("`key` is an `imm` parameter ... The callee
writes it").

## Root cause

The parameter mutation summary (`src/evaluator/effects/mutation_summary.yo`)
walks the raw AST, where markers are still present (the evaluator peels them
from its own argument lists only). `_msp_unmarked_arg` stripped `&mut` but not
`&` (written while `&x` could still be the address-of), and the classifier,
the flow collector, the strict-borrow walk, the thread-reachability walk and
the mask walk saw a `&`/`&mut` node as a call to an unknown function, so the
mask went `all` (`YO_DEBUG_BORROW_MASK=1`: `classify-unresolved: &(key)`,
`walk: &(body)`). `_msp_place_base_atom` also rooted `&mut x` at the operator.

## Fix

Since V3b step 3 a `&x` is never the address-of (`addr_of(x)` is), so every
walker reads through both markers as through a field step
(`_msp_is_borrow_marker`), `_msp_unmarked_arg` strips both, and the place base
is found under the marker. Test: `tests/parameter_modes.test.yo` ("a callee
lending through markers does not write its mut parameter").
