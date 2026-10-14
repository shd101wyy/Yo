# `ArrayList(T).clone` is E0901 for a move-only `Clone` element

**Severity:** S2: a valid program is rejected. `ArrayList(Box(String)).clone()` fails although `ArrayList(T) <: Clone` holds under `where(T <: Clone)`.

**Status: OPEN.** Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c and v0.2.61; both fail the same way.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
main :: (fn() -> unit)({
  l := ArrayList(Box(String)).new();
  l.push(box(String.from("lb")));
  m := l.clone();
});
export(main);
```

`error[E0901]: use of moved value: cannot copy (_ptr.add)(index).*, whose type Box(String) is move-only`. It is raised in `ArrayList.get`'s body, which `clone` calls.

## Cause

`ArrayList.clone` loops `item_opt := self.get(i); match(item_opt, .Some(item) => result.push(item.clone()))`. `get` returns `Option(T)` by copying the element out, which is illegal for a move-only `T`. A `derive(Clone)` struct with an `ArrayList(Box(String))` field fails the same way.

## Fix direction

Clone through the element in place, via a `&T` projection of the slot (V2b's `Index`), never by copying it out first. This lands naturally once V2b Generation B's `index` projection is in the prelude. Add a test with `Box(String)` and a `Drop` element.
