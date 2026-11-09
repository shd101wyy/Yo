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
