# The value form over an `Array` of move-only elements is E0901, raised inside the prelude

**Severity:** S2 — `for(arr, x => …)` over an `Array(T, N)` whose `T` is move-only is rejected, with an error whose cause is std's `_ArrayIter`, not the program

Filed 2026-10-25 while landing VBD B7b (consuming `into_iter`,
`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.3).

## Reproducer

```yo
Tok :: struct(id : i32);
main :: (fn() -> unit)({
  toks := Array(Tok, usize(2))(Tok(id : i32(1)), Tok(id : i32(2)));
  mut(t) := i32(0);
  for(toks, k => {
    t = (t + k.id);
  });
});
export(main);
```

```
error[E0901]: use of moved value: cannot copy `(self._arr)((self._index))`, whose type `Tok` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
      --> tmp/arr_mo.yo:5:3
note: raised here, inside the standard library
      --> std/prelude.yo:10443:22
```

Measured with develop `35c72789a` before B7b and on the B7b branch: the same
error both times. B7b changed where the array goes (the iterator now owns it,
`into_iter(self : Self)` moves `toks` in), but not how `_ArrayIter.next`
yields an element.

## Root cause

`_ArrayIter(T, N).next` (`std/prelude.yo`) yields `self._arr(self._index)`,
a copy of the element. A move-only `T` cannot be copied, and it cannot be
moved out of `self._arr` either: Yo has no partial moves, and the iterator
must still drop the elements it has not yielded.

Before B7b this was out of reach anyway: `into_iter(self : &Self)` had to
copy the whole array into the iterator, which is the same E0901 one level up.
Now that the iterator owns the array, a move-out is possible in principle.

## Fix

Give `_ArrayIter` a move-out `next`/`next_back` and a `Drop` that drops only
the elements still in `[_index, N - _back_taken)`, as `ArrayList`'s consuming
iterator will after its flip (lookahead D21). Two constraints make it more
than a two-line change:

- the `_arr` field must not be dropped as a whole after the iterator's own
  `Drop` runs, so it needs uninitialized-capable storage (a `MaybeUninit`-
  style wrapper, or a raw buffer under the prelude's `AllowUnsafe`);
- `_ArrayIter` is `Copy` under `where(T <: Copy)`, and a type with `Drop`
  cannot be `Copy`, so the move-out shape is the non-`Copy` instantiation
  only (or the `Copy` impl goes, and `Array(T, N)` iteration of `Copy`
  elements keeps its by-copy `next`).

Workaround: walk the positions and borrow each element, `(i : usize) =
usize(0); while(i < N, { use(&toks(i)); … })`. `Array` has no read walk
(lookahead D19), so `for(&toks, …)` is not available.

The test lands with the fix: the reproducer above, in
`tests/array.test.yo`, asserting the sum and that each element is dropped
exactly once.
