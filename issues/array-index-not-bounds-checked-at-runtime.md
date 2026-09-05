# `Array(T, N)` indexing `arr(i)` is not bounds-checked at run time

**Status: OPEN — found 2026-09-05 while auditing `plans/FORMAL_VERIFICATION.md`
(PR #411). Independent of the verifier plan; a runtime fix is needed because
`docs/en-US/MEMORY_SAFETY.md` promises the check.**

## Symptom

Indexing a fixed-size `Array(T, N)` with a runtime index that is out of range
reads past the array silently. No panic, exit code 0.

```rust
{ println } :: import("std/fmt");
get :: (fn(a : Array(i32, usize(3)), i : usize) -> i32)(a(i));
main :: (fn() -> i32)({
  arr := Array(i32, usize(3))(i32(1), i32(2), i32(3));
  println(get(arr, usize(7)));
  i32(0)
});
export(main);
```

```
$ yo compile issues/repros/array-index-not-bounds-checked-at-runtime.yo --optimize 2 -o oob && ./oob
0
rc=0
```

Expected: a panic (`ArrayList`, `Deque` and `str` indexing all check and
panic — `docs/en-US/MEMORY_SAFETY.md` §"All indexing is bounds-checked":
"`s(i)` on a `str`, `arr.get(i)`, `list(usize(0))` either trap or return
`Option(T)` on out-of-bounds").

Reproducer: `issues/repros/array-index-not-bounds-checked-at-runtime.yo`.
Measured with `yo 0.2.24` (macOS arm64). The read is C undefined behaviour;
the printed `0` is whatever sat past the array on this run.

## Root cause

The `Index(usize)` impl for `Array(T, N)` in `std/prelude.yo` is

```rust
index : (fn(inout(self) : Self, idx : usize) -> *(Self.Output))(
  __yo_array_index(&(self), idx)
)
```

and `__yo_array_index` is an *inline builtin*: `src/codegen/exprs/generation.yo`
emits it as

```c
(&((&arr)->data[idx]))
```

with no comparison against `N`. The evaluator catches a comptime-known
out-of-range index; a runtime index gets nothing.

## Fix options

1. **Runtime check in the emitted C** — emit
   `(idx < N ? &((&arr)->data[idx]) : __yo_panic("Array: index out of bounds"))`
   (or a helper `__yo_array_index_checked(ptr, idx, N)`), `N` being a
   compile-time constant. Costs one compare per index, the same as
   `ArrayList`. `--optimize 2` hoists it out of loops in the common case.
2. Keep the unchecked fast path only under `pragma(Pragma.AllowUnsafe)`
   (matching `RawSlice`).

Option 1 is the one consistent with the documentation. Whatever shape the
check takes should be the same inline-assert shape `ArrayList` uses, so the
planned `verify+` erasure of *proved* bounds obligations
(`plans/FORMAL_VERIFICATION.md`, V3 task 6) can erase it too.

## Regression tests to add with the fix

- A test in `tests/` that indexes an `Array` with a runtime out-of-range
  index and expects a panic (cli-case with the panic message in the golden,
  since a panic aborts the test batch).
- An in-range runtime index still works, and a comptime out-of-range index
  is still a compile error.
