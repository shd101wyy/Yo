# `ArrayList(ZST).reserve` was a no-op, and the arm it skipped double-freed its anchor

**Severity:** S2 — on a zero-sized element type, `reserve`/`ensure_total_capacity`/`resize_with_byte` on an empty list did nothing (`resize_with_byte` then panicked), and the code that should have run adopted a buffer its temporary freed, a double free that the evaluator bug below kept unreachable.

> Found 2026-10-13 by the std allocator hand-off audit (the buffer-ownership
> sites that rebuild a list "from parts"). **FIXED** on
> `fix/allocator-tag-handoffs`.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  ys := ArrayList(unit).new();
  ys.resize_with_byte(usize(3), int(0));
  println(`len ${ys.len()}`);
});
export(main);
```

On develop (`c2fe7d0e1`, seed v0.2.60):

```text
ArrayList.resize_with_byte: no ptr after ensure (at …/std/collections/array_list.yo:973:20)
```

`xs.reserve(usize(5))` on `ArrayList(unit).new()` left `ptr()` and
`spare_capacity()` at `.None`, against `spare_capacity`'s own doc ("`reserve`
first").

## Root cause: two defects, one hiding the other

`ensure_total_capacity` had, in order:

```yo ignore
((size_of(T) == usize(0)) && self._ptr.is_some()) => (),
…
(size_of(T) == usize(0)) => {
  anchor := Self._zst_anchor();
  self._ptr = anchor._ptr;
  self._capacity = anchor._capacity;
},
```

1. **The guard never let the anchor arm run.** For `T = unit` the left operand
   of `&&` is compile-time `true` and the evaluator folds the whole guard to
   that `true` even though `self._ptr.is_some()` is a runtime `false`
   (`issues/comptime-identity-operand-folds-and-or-to-a-constant.md`). The arm
   was emitted as taken; the emitted C body of `ensure_total_capacity` for
   `ArrayList(unit)` was `if (min_cap <= cap) {} else {}`.
2. **The anchor arm was wrong anyway.** `anchor` is a whole `ArrayList`
   object. The arm copied its raw `_ptr` into `self` and then let `anchor` die,
   so `anchor`'s `Dispose` freed the very buffer `self` kept, and `self`'s own
   drop freed it again. It also overwrote `self._capacity` without the
   allocator tag, a second way for a list to lose its owner bit (unreachable for
   an owned list, which always carries its anchor from `with_capacity_in`).

Measured with the guard restructured but the copy kept (macOS, `--allocator
system`): the plain run dies with `Trace/BPT trap` (rc 133), and under Guard
Malloc

```text
GuardMalloc[…]: attempted free of pointer 0x340030000 that was not claimed by any registered malloc zone
```

So fixing the evaluator fold alone would have turned a no-op into a double
free in every `reserve` on an empty ZST list.

## Fix

`std/collections/array_list.yo`:

- The ZST case is one arm, `(size_of(T) == usize(0)) => cond(self._ptr.is_some() => (), true => …)`:
  a nested `cond` rather than a `comptime && runtime` guard, so it does not
  depend on the fold.
- The anchor is stored straight into the list: a new private
  `_zst_anchor_buf()` returns the raw one-byte global block (`_zst_anchor`
  wraps it), and the arm writes `self._ptr = .Some(Self._zst_anchor_buf())` and
  `self._capacity = _CAP_MASK` (untagged: the block is a plain global one).
  No temporary list exists, so nothing frees the buffer behind the list's back.

## Verification

`tests/collections/array_list.test.yo`, "reserve on an empty zero-sized-element
list takes the anchor and drops it once": `reserve(5)` must leave
`spare_capacity()` `.Some` and the list untagged, a later `push`/`reserve` and
the drop must be clean, and `resize_with_byte(3, 0)` on a fresh list must
reach length 3.

- develop std: fails (exit 6 at the `spare_capacity` assertion).
- guard restructured, copy kept: double free, as above.
- this fix: passes, and the standalone probe is clean under
  `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib`.
