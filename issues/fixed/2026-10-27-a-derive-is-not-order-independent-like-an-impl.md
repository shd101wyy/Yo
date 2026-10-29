# A `derive` is not order-independent like an `impl`

**Status: FIXED** 2026-10-29 (`src/evaluator/context.yo`: a `derive` is a pending impl of its target type).

**Severity:** S2 — a valid module is rejected with E0610 (`No method "clone"`) when a function forced before a `derive(T, Clone)` statement uses the derived method; the workaround is to move the derive above the first forward reference or write the `impl` by hand.

## Symptom

`::` definitions and `impl` registration are order-independent within a module
(`plans/reference/LAZY_TOPLEVEL_BINDINGS.md`), but a `derive(...)` statement is
still an ordered statement. When a definition above the derive references a
function below it, that function's body is forced before the derive has run,
and the derived method is missing:

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
first_user :: (fn() -> usize)(probe());
Pair :: struct(
  first : String,
  second : String
);
derive(Pair, Clone);
probe :: (fn() -> usize)({
  xs := ArrayList(Pair).new();
  xs.push(Pair(first : `a`, second : `b`));
  match(
    xs.get_cloned(usize(0)),
    .Some(p) => p.first.len(),
    .None => usize(0)
  )
});
export(first_user);
```

```text
$ yo check tmp/pair.yo --std-path ./std
error[E0610]: No method "clone" on Pair: the type has no field or method with that name.
note: raised here, inside the standard library
  note: `probe` (line 9) was evaluated here because it is referenced before its definition in the source
```

Measured 2026-10-27 with develop `f2e16f3ac` (with its own std) and with the
B6-c branch binary. Each of these makes the same module check clean:

- moving `first_user` below `probe`;
- replacing the derive with the hand-written
  `impl(Pair, Clone(clone : (fn(self : &Self) -> Self)(Pair(first : self.first.clone(), second : self.second.clone()))));`
  on the same line, because a pending `impl` is forced on the miss.

The B6-c src sweep hit this with `Pair` in `src/doc/context_index.yo`:
`_barrel_spreads` is forced from line 333 through `_mark_barrel_origins`. The
E0610 above was reproduced in-tree by adding the derive and a `get_cloned`. The
sweep reported the same symptom for `FusedLocalField` in
`src/codegen/exprs/async.yo`, but that case was not re-measured. Both sites
stayed read-in-place or `.get` and did not get the derive.

## Root cause

The lazy-binding pre-pass (`src/evaluator/context.yo`, the statement classifier
that builds `PendingDef`s) registers `impl(Receiver, ...)` as a pending impl
keyed by the receiver head name (`_make_pending_def(..., true)`), and
`force_pending_impls_for_type_name` forces it on a method miss. `derive(T, ...)`
(`BF_DERIVE`) is not classified, so it stays an ordered statement, and no miss
can force it.

## Fix direction

Classify a top-level `derive(T, Trait...)` as a pending impl of `T`, the same
way the `impl` case is classified. A miss then falls through to the "force every
pending impl of the type" pass, because `_impl_expr_declares` finds no member
label in a derive. That changes when every derive in the tree is evaluated, so the
fix needs P2's byte-identity gate (a self-emit diff) and the lazy-binding tests.
The regression test is the module above, added to `tests/lazy_toplevel_bindings.test.yo`
with the fix (it fails before the fix, so it cannot be added on its own).

## Fix (2026-10-29, branch `fix/derive-order-independence`)

One root cause for this doc and
`issues/fixed/2026-10-24-a-derive-below-its-first-method-use-is-not-forced.md`:
a top-level `derive(...)` was an ordered statement, so no lookup miss could
force it. `classify_pending_def` (`src/evaluator/context.yo`) now classifies
`derive([generic(...)], [where(...)], T, Trait...)` as a pending impl of `T`'s
head (`PendingDef.is_derive`, with `is_impl` set), exactly as it classifies
`impl(T, ...)`. A method or trait miss on `T` reaches
`force_pending_impls_for_type_name`; no derive declares a member label, so the
named pass passes it over and the "force every pending impl of the type"
fallback forces it. Three adjustments keep everything else as it was:

- **Inside an impl of `T`** the fallback used to be skipped (the in-block
  guard). A named miss there now falls back to `T`'s pending derives only: a
  derive declares its methods only once it runs, and forcing it registers
  whole impls rather than touching the half-registered block (a member calling
  `self.clone()` above `derive(T, Clone)`).
- **A derive in flight does not take the in-impl guard.** It declares no
  member and registers whole impls, so a trait-bound miss under it still forces
  later impls, as when derives were ordered: `derive(K, Ord(K))` above
  `impl(K, Eq(K)(...))` keeps checking, and above `derive(K, Eq(K))` now checks
  too (it was E0603 before).
- **Identity anchors are unchanged.** `register_module_anchors` keeps a
  derive's unnamed-statement label (`<prev>_s<n>`); naming it `impl_<T>` would
  rename every id minted in it and in the statements after it, and the next
  `impl_<T>`.

A forced derive that fails reports its own error with the note
`` `derive(T, …)` (line N) was evaluated here because a method or trait of `T`
is used before that derive in the source ``.

Regression tests: `tests/lazy_toplevel_bindings.test.yo` — "a method call
above the derive that provides it", "a definition forced before the derive its
body needs", "an impl member calls a method from a later derive of its type",
"a derive whose trait bound is met by a later derive or impl" (all but the
last case's impl half fail on develop `d25241bdf`: the module is E0610 at the
first one).

Byte identity: the compiler's own emitted C for `src/main.yo` (155 MB) is
identical before and after (sha256 `ca2f00db…`, develop `d25241bdf`'s binary
against this branch's), as are `tests/derive.test.yo`'s and
`tests/derive_clone_complex.test.yo`'s emissions: no derive in the corpus is
forced out of order.

Seed gate: `std/` and `src/` keep their derives above first use until
`SEED_VERSION` carries the release with this fix; `yo fix --migrate
explicit-copy` keeps listing (not cloning) a copy made above its type's
`derive(T, Clone)` for the same reason.
