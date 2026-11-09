# A subscript place cannot fill a `&T` payload: `Option(&T).Some(xs(i))` and `.Some(&xs(i))` are E0601

**Severity:** S2. A valid program is rejected, and the workaround is a different spelling of the same place: `xs.index(i)`.

Filed 2026-11-08 by the G2 lane (`vbd/g2-holders`) with the v0.2.76 seed, while writing `JsonValue.get -> Option(&(JsonValue, self))`.

## Reproducer

`issues/repros/2026-11-08-a-subscript-place-cannot-fill-a-reference-payload.yo`:

```yo
{ ArrayList } :: import("std/collections/array_list");
main :: (fn() -> unit)({
  y := i32(1);
  o := Option(&i32).Some(&y);
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(2));
  o2 := Option(&i32).Some(&xs(usize(0)));
  ()
});
export(main);
```

```text
error[E0601]: Incompatible types for field "value":
- Expected: &i32
- Given  : i32
```

All of these are rejected the same way: `.Some(&xs(i))`, the bare subscript `.Some(xs(i))`, and a subscript off a match binding, `match(self, .Arr(items) => .Some(&items(i)), …)`.

These are accepted:

- `.Some(&y)` for a local;
- `.Some(xs.index(i))`, the same projection spelled as a method call. It is R1's read rule (#1805): a projection call is the reference value in a `&T` payload slot.

## Where to look

`projection_call_mode_of` (`src/evaluator/utils.yo`) excludes a subscript on purpose: a call whose dispatch records the `Index` method is not a direct projection call. So R1's reference read never applies to `xs(i)`. The explicit lend `&xs(i)` also reaches the payload as the place's type, not as `&T`. Both readings should give the reference, as `xs.index(i)` does.

## Test

The fix adds the reproducer's two subscript spellings, and a subscript off a `&` match binding, to `tests/origins/reference_read_rule.test.yo`. It then moves this doc to `issues/fixed/`, and std's `JsonValue.get`/`TomlValue.get` can spell `values(i)` again.
