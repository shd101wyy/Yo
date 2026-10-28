# A `derive` is not order-independent like an `impl`

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
