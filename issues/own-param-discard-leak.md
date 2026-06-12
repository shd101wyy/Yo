# `own` param discarded via `___ := victim` / `consume(victim)` leaks the object

**Found:** 2026-06-12, via CI LeakSanitizer on
`tests/ref_field_borrow.test.yo` ("ref and own arguments of distinct
objects are allowed").

## Repro (minimal)

```rust
open(import("std/fmt"));
open(import("std/string"));
Holder :: object(s : String, n : i32);
main :: (fn() -> unit)({
  use_and_sink :: (fn(ref(x) : String, own(victim) : Holder) -> usize)({
    ___ := victim;        // ALSO leaks with: consume(victim);
    x.len()
  });
  a := Holder(s : String.from("abcde"), n : i32(1));
  b := Holder(s : String.from("other"), n : i32(2));
  n := use_and_sink(a.s, b);
  consume(n);
});
export(main);
```

`leaks --atExit`: 3 leaks / 112 bytes (the Holder `b` + its String).
With the body reduced to just `x.len()` (own param UNUSED → drops at
callee scope end): **0 leaks**. So the scope-end drop of an own param
works, but both explicit-discard idioms detach the value from the drop
machinery:

- `___ := victim;` — the new local apparently never receives a
  scope-end drop (`_`-family naming?), while `victim`'s own-drop is
  cancelled by the move.
- `consume(victim);` — marks consumed (no scope-end drop) but no drop
  is emitted at the consume site either.

## Expected

Either idiom should release the owned object exactly once.

## Notes

- The affected test now uses the unused-param shape (leak-free).
- Check whether `consume(x)` on owned LOCALS has the same gap or it is
  own-PARAM-specific.
