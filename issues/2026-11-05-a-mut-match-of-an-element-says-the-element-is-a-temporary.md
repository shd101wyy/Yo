# `match(&mut xs(i), …)` says the element is a temporary

**Severity:** S3: the diagnostic is misleading. An element access is a place, not a temporary, and the help's repair (`t := xs(i); match(&mut t, …)`) writes the arm's changes to a copy. That copy is E0901 for a move-only element, and it silently drops the write for a `Copy` one.

Found 2026-11-05 while fixing `issues/fixed/2026-11-05-a-borrowed-element-field-scrutinee-is-e0901.md`, on develop `a4071e380`.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
f :: (fn(xs : &mut ArrayList(Option(ArrayList(i32)))) -> unit)(
  match(&mut xs(usize(0)), .Some(m) => m.push(i32(1)), .None => ())
);
export(f);
```

```text
error: Cannot match `&mut xs(usize(0))`: `&mut` lends a place, and `xs(usize(0))` is a temporary.
help: bind it to a local first (`t := xs(usize(0)); match(&mut t, …)`), or match it by value
```

The v0.2.74 seed prints the same. `&mut xs(i).f` and `&mut s.xs(i)` get the same text.

## Root cause

`_decide_match_mode` (`src/evaluator/exprs/match.yo`) roots a `&mut` scrutinee with `_scrutinee_root_variable`, which follows only `.` steps. An element access `xs(i)` therefore has no root and takes the temporary branch. A local borrow of an element (`q := &mut xs(i)`) is rejected on purpose, and its error names the supported form, `for(&mut coll, x => …)`.

## Recommendation

Until a `&mut` element scrutinee is supported, say what the local-borrow error says: an element is borrowed `&mut` through `for(&mut coll, x => …)` or by taking it out (`std/mem` `replace`) and putting it back. Do not suggest a copy. Whether `match(&mut xs(i), …)` should dispatch `IndexMut` in place, as `&mut xs(i)` already does as a call argument, is a design question to decide together with the local-borrow rule.
