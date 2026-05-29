# Slice-flowability gap: borrowed `str`/`Slice` escapes via assignment to an outer-scope binding (use-after-free in safe code)

**Status:** Open — confirmed memory-safety hole in safe code (no `pragma(Pragma.AllowUnsafe)`).

## Summary

The slice-flowability check (`plans/SLICE_FLOWABILITY.md`) correctly rejects
returning a `str`/`Slice(T)` that borrows frame-local owned storage. But it
only guards the **`return` boundary**. Assigning a borrowed slice to a
binding that **outlives the slice's backing storage** (e.g. an outer-scope
variable written from inside an inner block) is **not** checked, so the
slice dangles when the backing is dropped at block exit, and a later read is
a use-after-free — all in safe code.

## Reproducer (safe code, no pragma)

```rust
open(import("std/string"));
open(import("std/fmt"));
main :: (fn() -> unit)({
  (s : str) = "";
  {
    x := `hello there friend long buffer here`;
    s = x.as_str();          // s borrows x's heap buffer
  };                          // x dropped here → buffer freed
  println(`s = ${s}`);        // use-after-free: reads freed/reused memory
});
export(main);
```

`yo check` → `evaluator OK` (no error).
Run → garbage, deterministically (3/3):

```
s = s =                           ��
s = s =                           ��
s = s =                           �!|
```

## Contrast — the return path IS caught

The identical escape via `return` is correctly rejected:

```rust
f :: (fn() -> str)({
  (s : str) = "";
  { x := `hello buffer`; s = x.as_str(); };
  return(s);
});
```

→ `'return(...)' from a function returning 'str' carries a raw pointer …;
the returned value must be rooted in caller-owned storage. … not flowable`

So the analysis understands that `s = x.as_str()` roots `s` in the
block-local `x`; it just doesn't treat **assignment to a binding that
outlives `x`** as an escape the way it treats `return`.

## Other un-checked escape vectors (same root cause, likely also holes)

- Storing a borrowed slice into an outer-scope collection
  (`outer_list.push(x.as_str())`).
- Writing a borrowed slice into a field of an outer-scope struct/object.
  (Returning a struct that _carries_ a slice IS caught — verified — but
  field-write to an already-live outer aggregate is the assignment case.)

## Root cause (where to fix)

Flowability is enforced at `return(...)` (and implicit-return) sites only.
The fix is to also enforce it at **assignment** (`=`) and any other
"store into longer-lived storage" site: when the RHS is a slice/`str`
(or a value transitively carrying a raw pointer) rooted in a binding whose
scope is _narrower_ than the assignment target's scope, reject it with the
same diagnostic. Equivalently: a borrowed slice may only be assigned to a
target whose lifetime does not exceed the slice's backing root.

This is the TS reference compiler (`src/`); the yo-self port inherits
whatever the reference does, so fix the reference first.

## Severity

Medium-high: it is a soundness hole (safe code → UB), but requires a
specific shape (slice assigned across a scope boundary, used after the
backing drops). Most real code returns owned `String`/`ArrayList` or uses
slices within a single scope, so it is unlikely to be hit by accident — but
the safety contract ("safe Yo code cannot express undefined behavior",
`docs/en-US/MEMORY_SAFETY.md`) is violated, so it should be closed.
