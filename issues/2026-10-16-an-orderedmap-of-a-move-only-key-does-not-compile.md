# An `OrderedMap` of a move-only key does not compile

**Severity:** S2 — valid programs are rejected: `OrderedMap(K, V).insert` fails with E0901 when `K` is a `Drop` type, a `Box`, or a plain type with neither `Copy` nor `Clone`.

**Status:** open. Found 2026-10-16 while checking the std collections for the
cause of `issues/fixed/a-hashmap-of-a-move-only-key-or-value-does-not-compile.md`.
A move-only VALUE works since that fix; a move-only KEY has a different cause.

## Symptom

```text
error[E0901]: use of moved value: `key`
note: raised here, inside the standard library
    --> std/collections/ordered_map.yo:116:30
```

## Reproducer

```yo
{ OrderedMap } :: import("std/collections/ordered_map");
Tok :: struct(id : i32);
derive(Tok, Eq(Tok), Hash);
main :: (fn() -> unit)({
  m := OrderedMap(Tok, i32).new();
  m.insert(Tok(id : i32(1)), i32(10));
});
export(main);
```

## Root cause

`OrderedMap` stores every key three times: in `_map : HashMap(K, V)`, in the
insertion-order list `_order : ArrayList(K)`, and in the position index
`_index : HashMap(K, usize)`. `try_insert` moves `key` into the first and then
uses it again for the other two, which needs a copy.

## Fix direction

Store each key once, as `IndexMap` does: the entries in insertion order in one
`ArrayList(MapEntry(K, V))`, and a hash table of positions into it (a
`HashMap` keyed by the entry's hash, or a raw table whose probes compare
`entries(i).key` in place). `remove` then shifts the tail and fixes the
positions, and `swap_remove` swaps with the last entry.
