# Emitted C `#include` block ordering differs between the TS and self-hosted compilers

**Status: RETIRED 2026-09-14 — the comparison it makes no longer has two
sides.** The TypeScript compiler was deleted in P2.5, so "byte-parity of
emitted artifacts between the two compilers" is not a property that can hold
or fail, and the fix it proposes ("worth doing if/when emitted-artifact parity
becomes a differential gate") has no gate to become. See the carry-forward
below — one of its observations is still true and should not die with it.

**Was: OPEN (cosmetic; 2026-08-10).** Surfaced by the first cli-diff case
that tree-compares a SUCCESSFULLY emitted `.c` file (`std-path-flag`, since
reworked to use `check`): the same source produces the same set of base
includes in a different order —

```
TS:   stdbool, stdint, stddef, stdarg, stdatomic, stdlib, stdio, string, errno, fcntl, ...
self: stdio, stdatomic, errno, stdint, string, stdbool, fcntl, stdarg, stdlib, stddef, ...
```

C semantics are unaffected (standard headers are order-independent), clang
accepts both, and the FIXPOINT is unaffected (it compares self-emit vs
self-emit). What it breaks is **byte-parity of emitted artifacts between the
two compilers**, which is why no `tests/cli-cases/` case can currently
tree-compare an emitted `.c`.

Likely root cause (same class as the PR #92 capture-field bug —
"first-match-by-name over hash maps"): TS `context.cIncludes` is a `Set`
(insertion order preserved); yo-self `c_includes` iterates a hash-ordered
container. A faithful fix needs BOTH the container to preserve insertion
order AND the insertion sequence (type walk, extern walk, base adds) to match
TS's — worth doing if/when emitted-artifact parity becomes a differential
gate; until then this is recorded as an accepted divergence.

---

## Carry-forward (2026-09-14): the mechanism claim is still TRUE of today's compiler

Verified before retiring, because retiring a doc should not discard a fact that
still holds:

- `c_includes` is declared `HashSet(String)` (`src/codegen/utils/index.yo:191`),
  and `emit_c_includes` emits by iterating `context.c_includes.into_iter()`
  (`src/codegen/c/collection.yo`). So the emitted `#include` block is still in
  **hash-iteration order, not insertion order**, exactly as this doc diagnosed.

What changed is only the consequence. With one compiler there is no parity to
break, and run-to-run determinism now rests on hashing being fixed-key
(SipHash-1-3 with fixed keys since the hasher redesign) rather than on any
ordering guarantee. The order is therefore reproducible for a given set of
header strings, but it is not stable under content changes and it is not
sorted.

**Cheap hardening, if anyone wants order-stability by construction:** collect
into the `HashSet` for dedup as now, then sort before emitting. That makes the
include block insensitive to hashing entirely, and costs one sort of a list
that is a few dozen entries long.

**Relevance to an OPEN issue:** `issues/emitted-c-flipped-once-under-extreme-load-unexplained.md`
is hunting a resource-pressure-sensitive source of emission churn. Its observed
churn is `__yo_tN` type-id renumbering rather than include order, so this is
NOT that bug — but "an emitted artifact whose order comes from a hash container"
is the right shape of suspect, and is recorded there as a candidate so the lead
is not lost with this file.
