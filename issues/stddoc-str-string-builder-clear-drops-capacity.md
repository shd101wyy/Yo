# `StringBuilder.clear` frees the buffer its doc promised to keep

**Status:** open (found by the `std/` `///` doc sweep, 2026-09-11)
**File:** `std/string/string_builder.yo` — `clear`

## Behaviour

The doc comment said, verbatim:

```
/**
* Clear the buffer without freeing memory.
*/
```

The body throws the buffer away:

```rust
clear : (fn(self : Self) -> unit)({
  self._buf = ArrayList(u8).new();
})
```

Assigning a fresh `ArrayList` drops the last reference to the old one, which
frees its heap block. So the capacity is NOT retained, and a builder cleared
inside a loop reallocates from zero on every pass — the opposite of what the
method exists for.

## Divergence

- Rust's `String::clear` "truncates this String, removing all contents ...
  Note that this method has no effect on the allocated capacity".
- `ArrayList.clear` in this same tree already does the right thing
  (`std/collections/array_list.yo:759`): it drops the elements, sets
  `_length = 0`, and leaves `_ptr` / `_capacity` alone.

So the correct body is one call away:

```rust
clear : (fn(self : Self) -> unit)({
  self._buf.clear();
})
```

## Why the doc was written that way

`to_string()` deliberately DETACHES the buffer (`bytes := self._buf; self._buf
= ArrayList(u8).new()`), and `clear` looks like it was copied from it. For
`to_string` handing the allocation to the returned `String` is the point; for
`clear` it is the bug.

## Reproducer

Not included: `_buf` is private and `StringBuilder` exposes no `capacity()`,
so the regression has to be observed either through an allocation counter or
by adding `capacity()` alongside the fix. The defect is visible by inspection
of the two bodies above.

## Not fixed here

Found during a documentation-only sweep. The `clear` doc comment has been
corrected to describe what the code actually does (and to point at this file);
the behaviour is untouched.
