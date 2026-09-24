# Combinator-on-combinator chains share ONE under-resolved stamp — an Item-binding combinator after `.map` adopts the FIRST call's Item type

**Status: FIXED 2026-09-24** (Phase 2.4 of `plans/TYPE_SYSTEM_SOUNDNESS.md`). Found 2026-08-24 while unparking std S1 chunk 4 (Range
iteration) on branch `fix/range-op-era-split`. Pre-existing on develop —
reproduced with a develop-content binary and no ranges involved. Related to
(but distinct from) the flat_map residual in
issues/fixed/varbound-combinator-receiver-impl-match.md.

## Symptom

Two `.map` calls at DIFFERENT Item types in one module, where the second
chain continues into an Item-binding combinator (`min`, `max`, `sum`, …):

```rust
// first use of the blanket map at Item = i32
it := MyRange(_cur : i32(1), _end : i32(4)).map(x => (x * i32(2)));
it.for_each((x) => { out.push(x); });

// second use at Item = i64 — min's A binds to the FIRST call's i32:
m := MyRange64(_cur : i64(-3), _end : i64(4)).map(x => (x * i64(2))).min();
// Error: Type mismatch for type member "value": Expected: i32, Got: i64
//   at std/prelude.yo min: `.None => Option(A).Some(item)`
```

Either statement alone (or both at the SAME Item type) passes. `count` after
`.map` is fine — it binds no `A`. Combinators on a CONCRETE receiver
(`Range(i64)`, `ArrayList(T)`'s iter, a user struct) are fine — the receiver
id is per-type, so each specialization recovers its own Item.

## Root cause (probe: YO_DEBUG_DISPATCH `[fmg-cand]`)

BOTH `.map` calls stamp the SAME return instance:

```
[fmg-cand] method=map recv=MyRange   ... -> <struct:struct_yo_id_3663>
[fmg-cand] method=map recv=MyRange64 ... -> <struct:struct_yo_id_3663>
```

`struct_yo_id_3663` is the blanket `map`'s substituted declared return
(`IterMap(I, B, F)`) — deliberately NOT adopted-over by the rre return-expr
re-evaluation, because adopting the NAME-resolved re-eval clobbers the
per-call `F → __impl_fn → <capture>` identity (the iter_filter_closure
adoption hazard recorded in calls/function.yo). The per-call concretes
instead travel in the SomeT resolution CELLS of that one shared instance —
which works for a single call site but ALIASES as soon as a second call at a
different Item type resolves the same cells. `min`'s
`where(Self <: Iterator(Item := A))` recovery (the
`_bind_forall_from_type_args` cell-chain walk, PR #242) then finds the FIRST
call's terminal (i32) for the SECOND call's receiver.

This is the same under-resolution that leaves flat_map's doubly-derived `B`
broken (varbound-combinator-receiver-impl-match.md): the shared stamp cannot
represent two concurrent instantiations.

## Fix direction

Per-call instantiation identity for closure-carrying combinator returns:
route the stamped return through the ctor memo keyed by the RESOLVED
concrete arguments (receiver instantiation, Item, resolved F capture), so
each call site gets its own canonical `IterMap(...)` instance — without
resolving `F` by NAME (that was the adoption hazard; the cell chain already
holds the right per-call F). Likely the same lever unblocks flat_map.

## Workaround

Don't follow a combinator CHAIN with an Item-binding combinator at a second
Item type in one module; bind the chain's Item-binding tail to a concrete
receiver instead (e.g. `(range).min()` directly). Chunk 4's tests do this —
see tests/iterator_combinators.test.yo "ranges feed the iterator
combinators" (mapped chain checked via `count`, `min` taken on the range
receiver directly).

## Root cause (MEASURED 2026-09-24)

The shared stamp was real, but the reader that went wrong was a REGISTRY keyed by it, not the
SomeT cells. A temporary specialization-cache trace showed `min`'s specialization for the SECOND
chain keyed with `A = i32` while its receiver's `type_key` correctly said
`IterMap(MyRange64, i64, <capture 2>)`. `A` comes from `where(Self <: Iterator(Item := A))`, and
`_check_associated_type_constraints` / `resolve_assoc_type_for_target` read `Item` FIRST from the
type-trait-methods registry under the receiver's type id. That entry is the "durable assoc-type
registration" `try_match_generic_impl` makes on success — the matched generic impl's `Item : B`,
substituted, registered under `type_id_or_empty(receiver)`, first registration wins. Both `.map`
results carry the same id (`substitute()` rewrites `type_arguments` but keeps the
declaration-era id), so the first chain's `Item = i32` answered for the second.

## Fix

The durable registration is keyed by the exact instantiation — `assoc_type_registry_key`: the id,
plus the `type_key` for an instantiation (`src/evaluator/values/type_trait_methods.yo`) — and every
reader that has the type consults `get_assoc_type_entries` (exact key first, then the plain id a
concrete impl's `Item : i32` is registered under): the assoc-constraint check, the call path's
assoc resolution, the where-clause recovery in `try_match_generic_impl`, and property access.
Readers with only an id fall back to the generic-impl registry, which matches structurally.

The per-call closure-`F` identity is untouched: nothing re-resolves `F` by name.

## Verification

The reproducer prints `len=3 min=-6`. `tests/type_soundness.test.yo` ("two .map chains at
different Item types keep their own Item") fails on develop `b03c8b741` with
`Expected: i32 Got: i64` and passes now; `tests/iterator_combinators.test.yo` 49/49.
