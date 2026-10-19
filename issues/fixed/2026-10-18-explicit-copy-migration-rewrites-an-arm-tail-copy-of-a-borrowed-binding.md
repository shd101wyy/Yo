# `yo fix --migrate explicit-copy` rewrites an arm-tail copy of a borrowed binding, and the migrated TOML parser loses every key

**Severity:** S2. The migration silently changes what a correct program computes. A copy that leaves a `match` arm gets `.clone()` even when the binding it flows into is written and stored back, while another copy of the value relies on sharing those lists. Bounded: the migration is a one-time rewrite whose output goes through `check`, the tests and the fixpoint; here the first `check ./src` failed at once.

**Status:** fixed on `feat/v2b-genb-b1-migration` (V2b Generation B, step B1).

> Found 2026-10-18 gating B1. After `yo fix ./std --migrate explicit-copy`,
> the tree-built compiler failed every command with
> `yo.toml: missing [package] table`.

## Symptom

`std/encoding/toml.yo`'s `TomlValue.insert` takes the payload lists out of
`self`, writes them and stores them back:

```yo ignore
keys := match(self, .Table(k, _) => k, _ => ArrayList(String).new());
values := match(self, .Table(_, v) => v, _ => ArrayList(TomlValue).new());
keys.push(key);
values.push(value);
self = Self.Table(keys, values);
```

The migration rewrote the first arm to `k.clone()`. It left `v` alone only
because `TomlValue` has no `Clone`. The parser calls `insert` on a cursor
(`cur.insert(k, t)`), which is a copy of a table inside the tree, so the
cursor's lists are the tree's lists. Before the migration a push through the
cursor grew the tree. After it, `values` still grew the tree but `keys` grew a
clone, so the root table kept its values and lost its keys, and
`root.get("package")` found nothing. Bisected to that one insertion (the other
171 std insertions and the `src/` sweep are not involved).

## Root cause

Two holes in the migration's guards:

1. The audit labels every block tail `return`, including `match`/`cond` arm
   tails and inner blocks, not only a function's result. An arm tail's value
   flows into the enclosing binding (`keys`), but the copy records no
   destination (`dst_decl` is empty), so the written-after guard cannot see
   `keys.push`.
2. The `return` split (the recommendation of
   `issues/questions/2026-10-14-explicit-copy-migration-cannot-see-writes-through-an-escaped-copy.md`)
   listed only copies rooted in a `&`/`&mut` parameter. Here `k` is a `match`
   binding through `&mut self` (`is_ref`, not a parameter).

## Fix

`_ic_place_root_borrow` (`src/evaluator/utils.yo`) now describes every root
that the copy's frame does not own: a `&`/`&mut` parameter, a `&mut` borrow (a
`&mut` local, or a `match` binding through one), a module-level binding, or a
borrowed binding (a `match`/`for` binding of a borrowed place). The driver
lists a `return` copy of any such root. Owning locals, owned parameters,
temporaries and `match` bindings of either are still rewritten.

Residual: an arm-tail copy of an owning local that is read again, flowing
into a binding that is then written
(`x := cond(c => a, true => b); x.push(..)`), still records no destination.
The fixpoint and the tests are the net for it.

Regression test: `tests/cli-cases/fix-migrate-explicit-copy-arm-tail` (the
`insert` shape; before the fix the run inserts `k.clone()` and `vs.clone()`,
and the program prints `0 1` instead of `1 1`).

## For B3

`std/encoding/toml.yo`'s parser writes through cursor copies of the tree
(`cur.insert`, `cursor.table.insert`, seven sites). It relies on sharing the
lists, so it breaks at the flip regardless of B1 and needs a hand edit (a
`&mut` projection to the table being filled).
