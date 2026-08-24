# where-bound IntoIterator generics: a prior instantiation leaves a later one's GC trace calls ABSTRACT-keyed — C compile fails on undeclared trace fn

**Status: FIXED 2026-08-24 (the C-compile symptom; branch
`fix/where-bound-gc-trace`) — the era-copy family root stays OPEN via the
sibling issues below.** `get_trace_function_for_type`
(src/codegen/exprs/drop_dup.yo) now refuses to delegate GC traversal to a
trace spec that `should_skip_function_codegen` will never emit; the phantom
era-copy identities (zero construction sites, verified in the emitted C)
fall back to the inert field-walk. Red-first regression test:
tests/where_clause_fn_inference.test.yo (user-defined IntoIterator-shaped
trait, independent of the D3.6 std impls). Found 2026-08-24 implementing S1
D3.6 (IntoIterator trait impls on every collection, branch `s1-intoiter`). Third face of the
under-resolution family: same root class as
issues/iterator-chain-shared-stamp-cross-item-pollution.md (face 2) and the
flat_map residual in issues/varbound-combinator-receiver-impl-match.md
(face 1).

## Symptom

With real `IntoIterator` trait impls on the collections (this branch), a
TWO-statement program fails at the C compile:

```rust
sum_it :: (
  fn(generic(C : Type), c : C, where(C <: IntoIterator(Item := i32))) -> i32
)(
  c.into_iter().fold(i32(0), (acc, x) => (acc + x))
);
count_it :: (
  fn(generic(C : Type), c : C, where(C <: IntoIterator)) -> usize
)(
  c.into_iter().count()
);
// main:
sum_it(ll);     // ll : LinkedList(i32) — works alone
count_it(bt);   // bt : BTreeMap(i32, i32) — works alone; FAILS after the ll call
```

```
error: call to undeclared function
'yo_id_4084_rtparam0_R_gs_yo_id_3960_gs_yo_id_7851_2256_2257_rtparam1_...'
note: did you mean '..._i32_i32_...'?
```

Three such calls, each with a DIFFERENT raw-SomeT id pair (2256_2257,
2251_2252, 2287_2288). Either statement alone compiles and runs. Other
pairings (Deque+BTreeMap, HashSet+HashMap, ArrayList+HashMap,
HashMap+BTreeMap) pass — LinkedList-then-BTreeMap is the minimal trigger
found.

## Analysis (probes: YO_DEBUG_DISPATCH; emitted C)

- The specialized `into_iter` signature keeps the REGISTRATION-era return
  instance in BOTH the working and failing orderings
  (`[fmg-cand] method=into_iter recv=<BTreeMap(i32,i32)> spec=... ->
  <era BTreeMapIter>`), so that alone is benign: the era instance's SomeT
  cells normally resolve concretely and codegen renders one concrete C
  struct.
- In the failing ordering, THREE era copies of
  `ArrayList(BTreeEntry(K', V'))` reach codegen's emitted-type table
  (`__yo_t57/t58/t72`). Their LAYOUT renders concretely (fields resolve
  through cells), but `type_key` for the GC traverse delegation renders the
  RAW SomeT ids — those K'/V' clones (minted by the where-clause trials)
  never got their resolution cells written.
- `_generate_one_ref_struct_traversal` → `get_trace_function_for_type`
  (codegen/exprs/drop_dup.yo) then looks up `trace` under that raw-id
  type_key and FINDS a registry entry — a spec whose c_name embeds the raw
  ids and whose body codegen never emits (hard-generic skip) — so the
  traverse calls an undeclared function whose concrete twin
  (`..._i32_i32_...`) is right there.

Why LinkedList-first matters is not yet pinned: some where-trial/spec cache
warmed by the first instantiation makes the second instantiation's
where-clause validation keep unresolved clones instead of re-binding them.

## Fix direction

The root fix is the family root: per-instantiation identity for types minted
during generic trait-impl registration / where-clause validation, routed
through the ctor memo (the operator half already landed as
`canonicalize_instantiation_via_ctfe_memo`,
issues/fixed/range-op-result-era-split-blocks-iteration.md). Two narrower
seams if the root stays open:

1. Codegen guard: `get_trace_function_for_type` (and the dispose sibling)
   should not return a c_name whose function entry codegen will skip as
   hard-generic — fall back to the field-walk traversal (correct for these
   era copies, whose fields are concrete).
2. Creation side: where-clause trial clones of an impl's foralls must write
   their resolution cells (or be canonicalized away) before the instance can
   reach codegen's type table.

## Repro

Branch `s1-intoiter`, tmp scratch (LinkedList+BTreeMap pair above). All
single-collection uses, small combos, the `for` macro, tests/collections
(394), tests/iterator_combinators (32) pass with the trait impls in place —
the D3.6 std work itself is sound.
