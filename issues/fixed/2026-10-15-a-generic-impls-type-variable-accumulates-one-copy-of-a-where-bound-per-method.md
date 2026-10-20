# A generic impl's type variable accumulates one copy of a where-bound per method

**Severity:** S3 — compile-time cost and rendering only: `BTreeMap`'s `K` carries its `Ord(K)` bound fifteen times, so every render of `K` (specialization signatures, diagnostics) is fifteen times longer than it needs to be.

**Status:** FIXED 2026-10-20 (branch `fix/where-bound-dedup-by-trait-instantiation`).

Found 2026-10-15 by `YO_DEBUG_TYPE_KEY_MEMO_CHECK=1` (branch `perf/type-key-memo-identity`) on `check std/collections/btree_map.yo`. Not fixed there.

## Symptom

`std/collections/btree_map.yo` declares `generic(K : Type, V : Type)` and states `where(K <: Ord(K))` on each of `_find`, `get`, `insert`, `remove`, … During `check std/collections/btree_map.yo --std-path ./std`, one live `SomeT` handle for `K` (type key `4378`) renders through `type_to_string` as

```text
K : ((< : fn(lhs : &Self : (…), rhs : &K) -> bool, …, cmp : fn(lhs : &Self, rhs : &K) -> Ordering) + (…the same record…) + …)
```

with 13 copies of the `Ord` method record at one point and 15 later. That is 3,794 bytes, then 4,376. Every copy is the same trait.

## Where

`_add_where_clause_constraint` (`src/evaluator/types/function.yo`) appends a where-bound to the SomeT's `required_trait_types` IN PLACE. That list is a reference-type `ArrayList` shared by every copy of the handle. It deduplicates by `TraitT` id (`_wcc_has_trait`). Its comment records the same growth (`V : (Send + Send + … x32)`) as fixed. The likely remaining cause is that each method's `where(K <: Ord(K))` evaluates `Ord(K)` to a `TraitT` with a fresh id, so the id check never matches. This is not confirmed: the repeated entries' ids were not printed.

The in-place growth is also why the `type_key` identity caches (`type_identity_cacheable`, `src/types/type_key.yo`) exclude every type that mentions a `SomeT`: one live handle renders differently over time.

## Fix criteria

`K`'s required traits hold one `Ord(K)` after `btree_map.yo` is checked: dedup by trait identity, comparing the trait's id together with its arguments, not by a per-evaluation id. Add a test that checks a generic impl with several methods sharing one where-bound and asserts the bound's multiplicity, for example through `type_to_string` of the binder in a `tests/internal` file.

## Root cause and fix (2026-10-20)

The likely cause above is the cause. `where(K <: Ord(K))` evaluates `Ord(K)`
once per method, and `Ord` is a comptime trait constructor whose argument is
the binder `K`, a `SomeT`. `evaluate_comptime_fn_call` (`src/evaluator/calls/comptime_fn.yo`) does not memoize a call
whose type arguments mention a `SomeT` (its checking-phase guard), so every
evaluation runs the `trait(...)` body again, and `stable_type_id` mints that
body's TraitT with an occurrence-indexed id. Each method's `Ord(K)` therefore
had a fresh id, and `_wcc_has_trait`'s id comparison never matched.

**Fix:** a trait mint now records its instantiation arguments beside its
constructor funcId (`register_trait_type_args`, `src/expr_info.yo`, stamped in
`evaluate_comptime_fn_call` next to `register_trait_ctor_fid`), and
`_wcc_has_trait` (`src/evaluator/types/function.yo`) also treats two traits as
one when they share the constructor funcId and their arguments are pairwise
equal by `type_key` (`_wcc_same_instantiation`). `Ord(K)` and `Ord(J)` stay two
bounds; two mints of `Ord(K)` for one `K` are one.

**Regression test:** `tests/internal/type_trait_methods.test.yo`, "a where-bound
restated on each method of a generic impl is recorded once": a generic impl
whose three methods each state `where(Kw <: Ord(Kw))`, analyzed through
`analyze_document`; it asserts the impl's `Kw` carries exactly one required
trait (`generic_impl_binder_bound_counts`, `src/evaluator/values/impl.yo`).
Without the fix the test fails (exit 6, the assertion); with it 18/18 pass.
