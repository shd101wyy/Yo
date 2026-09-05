# The `HashMap`/`HashSet` half of the C35 heap-corruption guard has no test, and the audit row claims it does

**Found**: 2026-09-04, by the std-API-audit coverage read — `HashMapError` and
`HashSetError` are both exported, and their `CapacityOverflow` variant is the
one name in each enum that appears nowhere under `tests/`. **Class**: papercut
(a memory-safety guard with no regression coverage, plus a doc claim that says
otherwise). **Status**: OPEN.

## Symptom

`grep -rn 'CapacityOverflow' tests --include='*.yo'` returns **nothing**.

C35 (`plans/STD_API_AUDIT.md:103`,
`issues/fixed/collection-capacity-overflow-unchecked.md`) fixed a silent
heap-corruption bug: every collection computed `sizeof(T) * count` unchecked, so
a wrapped size reached `malloc` while the container still reported the full
capacity. The fix has two observable halves:

- **ArrayList** — `with_capacity` / `ensure_total_capacity` panic. Covered:
  `tests/allocator.test.yo:15-48` pins `size_would_overflow` at its boundary and
  on the wrap-to-zero cases, and `tests/collections/array_list.test.yo` carries
  the growth-clamp guard.
- **HashMap / HashSet** — `_alloc_with_capacity` returns
  `.Err(.CapacityOverflow)` (`std/collections/hash_map.yo:78-80`,
  `std/collections/hash_set.yo:73-75`). Covered by **nothing**.

`plans/STD_API_AUDIT.md:103` credits the whole fix with "plus new
tests/allocator.test.yo (the helper had zero coverage)". That file tests
`size_would_overflow` and `layout_of` (`tests/allocator.test.yo:15-53`) and
never constructs a `HashMap` or `HashSet`. A revert of either container's guard
passes the entire suite green.

## The guard does fire, and it is directly testable

The two `_alloc_with_capacity` functions are `impl` members of the exported
`HashMap`/`HashSet` types, so a test file can call them and match the `Result`
directly — no panic-catching facility is needed (which is what made the
ArrayList half untestable and pushed it onto reproducers):

```rust
{ HashMap, HashMapError } :: import("std/collections/hash_map");
{ HashSet, HashSetError } :: import("std/collections/hash_set");
{ SIZE_MAX } :: import("std/libc/stdint.yo");
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  big := ((SIZE_MAX / usize(8)) + usize(1));
  r := HashMap(i64, i64)._alloc_with_capacity(big);
  println(match(r, .Err(e) => match(e, .CapacityOverflow => "HashMap  -> Err(CapacityOverflow)", .AllocError(_) => "HashMap  -> Err(AllocError)"), .Ok(_) => "HashMap  -> Ok (NO GUARD)"));
  s := HashSet(i64)._alloc_with_capacity(big);
  println(match(s, .Err(e) => match(e, .CapacityOverflow => "HashSet  -> Err(CapacityOverflow)", .AllocError(_) => "HashSet  -> Err(AllocError)"), .Ok(_) => "HashSet  -> Ok (NO GUARD)"));
});
export(main);
```

Observed (`yo compile … --optimize 2`, yo 0.2.24, `YO_STD=./std`):

```
HashMap  -> Err(CapacityOverflow)
HashSet  -> Err(CapacityOverflow)
```

So the guard is present and correct today. What is missing is anything that
would notice if it went away — and the emitted `.Ok(...)` arm in that same
program is exactly what a regression would print, straight into the heap
corruption C35 was filed for.

## Root cause

Nothing in the code is wrong. This is a coverage hole plus a stale record:

- `std/collections/hash_map.yo:8-12` and `std/collections/hash_set.yo:7-11`
  declare `CapacityOverflow`; the only producers are
  `hash_map.yo:79` and `hash_set.yo:74`; no test names either.
- `plans/STD_API_AUDIT.md:103` describes the fix's coverage in a way that reads
  as complete for all three containers.

## Fix

1. `tests/collections/hash_map.test.yo` — add
   `_alloc_with_capacity rejects a capacity that would overflow`, asserting
   `.Err(.CapacityOverflow)` for `(SIZE_MAX / sizeof(MapEntry(K, V))) + 1`.
   Derive the count from `sizeof` (as `tests/allocator.test.yo:33-40` derives
   its shifts from `sizeof(usize)`) so it stays meaningful on wasm32 where
   `usize` is 32 bits. Add the matching negative case — an ordinary capacity
   returns `.Ok` — so the test cannot pass by rejecting everything.
2. `tests/collections/hash_set.test.yo` — the same pair for `HashSet`.
3. Correct `plans/STD_API_AUDIT.md:103` in the same PR, per the audit's own
   re-measure convention: say which halves of C35 are covered by which file.

Both tests must be verified RED first, by temporarily removing the
`if(size_would_overflow(...), { return(.Err(.CapacityOverflow)); })` guard —
otherwise this exercise re-creates the very hole it is closing.

## Regression test

The two tests above *are* the deliverable. One authoring note: `HashMapError`
and `HashSetError` are structurally identical enums, and a module constructing
both used to conflate them — the CTFE memo matched
`Result(Self, HashSetError)` against the cached
`Result(Self, HashMapError)` because exact enum compatibility was purely
structural (`issues/fixed/structurally-identical-error-enums-in-two-generic-impls-collide.md`,
fixed 2026-08-29 by a nominal name check). Keeping each assertion in its own
container's test file avoids re-entering that shape at all; if a single
combined test is written instead, it doubles as a regression guard for that fix
and should say so.
