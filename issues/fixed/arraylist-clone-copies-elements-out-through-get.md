# `ArrayList(T).clone` is E0901 for a move-only `Clone` element

**Severity:** S2: a valid program is rejected. `ArrayList(Box(String)).clone()` fails although `ArrayList(T) <: Clone` holds under `where(T <: Clone)`.

**Status: FIXED** 2026-10-16 (`fix/collection-clone-through-borrow`). Found 2026-10-14 by the v0.2.62 batch review. **Measured on:** develop a89b8356c and v0.2.61; both fail the same way.

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

## Fix

`ArrayList.clone` now clones each element in place through the `&T` projection
of its slot, `result.push(self(i).clone())`: nothing is copied out of the
`&Self` borrow, so a move-only or `Clone`-but-not-`Copy` element clones like a
`Copy` one. The `Index` projection this needed had already landed with V2b's
"Projections first" (#1324, #1361), so the fix did not wait for unique
buffers' Generation B.

The other std clones were checked for the same shape. `Path.clone` copied each
`String` segment out through `self._segments.get(i)` before cloning it; that
passes today only because `String` is still an implicitly copied handle, and it
would be the same E0901 once V2b makes `String` explicit-copy. It now clones
through `self._segments(i)` too. `Array(T, N).clone` was the sibling bug
(`issues/fixed/array-clone-copies-self-out-of-the-borrow.md`). `HashMap.clone`
(clones through the bucket pointer), `JsonValue`'s `_json_clone` (already
`&items(i)`), `Option`, `Result`, the tuples, `Box`, `Rc` and `derive(Clone)`
already clone in place; a probe with move-only and `Clone`-only payloads checks
clean for each. The `HashMap` probe stops earlier, at `insert`, which is the
open `issues/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`.

**Test:** `tests/collection_clone_through_borrow.test.yo`: `ArrayList(Box(String))`,
a `Clone`-only struct element, a `Drop` element (one `clone` per element, one
drop per owner), and a `derive(Clone)` struct with an `ArrayList(Box(String))`
field. Against develop's std the file fails to compile with this doc's E0901;
with the fix every test passes.
