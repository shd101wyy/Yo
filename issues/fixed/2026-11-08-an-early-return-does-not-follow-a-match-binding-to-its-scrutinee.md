# An early `return` does not follow a `&` match binding to its scrutinee (E0912), while the same value in tail position checks

**Severity:** S2. A valid program is rejected: the result is built over a `&` parameter's place, which decision 24's root rule (#1801) accepts at the tail.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) with the v0.2.76 seed, while writing `TomlValue.get -> Option(&(TomlValue, self))`.

## Reproducer

`issues/repros/2026-11-08-an-early-return-does-not-follow-a-match-binding-to-its-scrutinee.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
V :: enum(Num(n : i32), Arr(items : ArrayList(i32)));
find :: (fn(v : &V, k : &i32) -> Option(&(i32, v)))(
  match(
    v,
    .Arr(items) => {
      mut(i) := usize(0);
      while(i < items.len(), i = (i + usize(1)), {
        if(items(i) == k.*, {
          return(Option(&(i32, v)).Some(items.index(i)));
        });
      });
      Option(&(i32, v)).None
    },
    _ => Option(&(i32, v)).None
  )
);
main :: (fn() -> unit)(());
export(main);
```

```text
error[E0912]: Cannot return a value holding `(items.index)(i)`: the origin names a local of this function, and a result may name only origin parameters or reference-typed parameters' places (decision 43, plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

The same value as the arm's tail is accepted: `.Arr(items) => Option(&(i32, v)).Some(items.index(usize(0)))`.

## Where to look

The return check reached through `return(...)` resolves `items` to the match binding, a local. The tail path follows the `&` match binding into its scrutinee `v` (#1801, decision 24's root rule). The two paths should resolve origins the same way.

## Test

The fix adds the reproducer as a positive case to `tests/origins/reference_read_rule.test.yo`. It then moves this doc to `issues/fixed/`, and `JsonValue.get`/`TomlValue.get` can return from the key loop again.

## Fixed

**Root cause.** `return_check` judged the raw `origin_of` roots of the returned
value. For an enum constructor over `items.index(i)` the root is `items`, the
binding of a `match` over a reference (`match(v, .Arr(items) => ...)`), a local.
The tail form is judged after the match, where the value resolves to the
scrutinee `v`; the `return` path never followed the binding there. (Decision
24's root rule already follows such a binding, `note_borrow_match_source`,
#1801; the return check did not.)

**Fix.** `return_check` replaces each root that names a `&` match binding
(`is_borrow_match_binding` with a recorded `borrow_match_source`) by the
scrutinee's own roots (`_origin_through_match_bindings`, transitively for nested
matches), so a `return` in the arm sees `v`, a parameter. A root that names a
real local of the arm (`local := items.clone(); ... local.index(0)`) is no match
binding and is still E0912.

**Test.** `tests/origins/reference_read_rule.test.yo`: the reproducer, and the
arm-local negative.
