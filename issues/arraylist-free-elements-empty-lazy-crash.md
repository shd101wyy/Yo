# ArrayList.\_free_elements crashes on empty lazy ArrayList with RC element types

## Status: Fixed

## Problem

`ArrayList._free_elements` calls `self._ptr.unwrap()` unconditionally when
`Type.contains_rc_type(T)` is true. If the ArrayList was created lazily
(e.g., `ArrayList(T).new()`) and never had elements pushed, `_ptr` is `.None`
and `unwrap()` panics with "Called unwrap on a None value".

This only affects ArrayLists whose element type contains RC types, because
`_free_elements` takes the no-op `true =>` branch for non-RC element types.

## Reproduction

```rust
// ArrayList(ArrayList(i32)) has RC element type (inner ArrayList is RC)
(list : ArrayList(ArrayList(i32))) = ArrayList(ArrayList(i32)).new();
list.clear();  // CRASH: unwrap on None
```

## Root cause

In `std/collections/array_list.yo`, `_free_elements` did:

```rust
_free_elements : (fn(self : Self) -> unit)(
  cond(
    Type.contains_rc_type(T) => {
      i := usize(0);
      base_ptr := self._ptr.unwrap();  // <-- crashes when _ptr is .None
      while(i < self._length, ...);
    },
    true => ()
  )
)
```

`dispose()` was safe because it guards `_ptr` with a match before calling
`_free_elements`. But `clear()` calls `_free_elements` directly, and a lazy
ArrayList with `_length == 0` and `_ptr == .None` triggers the crash.

## Fix

Added a guard `if((self._length > usize(0)), ...)` before the `unwrap()`:

```rust
_free_elements : (fn(self : Self) -> unit)(
  cond(
    Type.contains_rc_type(T) => {
      if((self._length > usize(0)), {
        i := usize(0);
        base_ptr := self._ptr.unwrap();
        while(i < self._length, i = (i + usize(1)), {
          element_ptr := (base_ptr &+ i);
          unsafe.drop(element_ptr.*);
        });
      });
    },
    true => ()
  )
)
```

When `_length == 0`, there are no elements to drop, so skipping is correct.

## Affected types

Any `ArrayList(T)` where `T` contains reference-counted fields:

- `ArrayList(ArrayList(X))`
- `ArrayList(String)`
- `ArrayList(InlineToken)` (if InlineToken has `Option(String)` fields)

Non-RC element types (`ArrayList(i32)`, `ArrayList(Delimiter)`, etc.) are
unaffected because `Type.contains_rc_type` returns false at compile time.
