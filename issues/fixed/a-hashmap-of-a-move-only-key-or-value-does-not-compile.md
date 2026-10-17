# A `HashMap` of a move-only key or value does not compile

**Severity:** S2 — valid programs are rejected: no `HashMap` can hold a `Dispose` value or a `Box` key, so the unique `Box` and every resource type are unusable as map keys or values.

**Status:** fixed 2026-10-16 (branch `fix/hashmap-move-only-key-value`).
Found 2026-10-12 while testing the unique `Box` (V1 step 2); it is not
`Box`-specific and reproduced on the v0.2.59 seed and on develop `36c41e62b`.

## Symptom

```text
error[E0901]: use of moved value: cannot copy `(data_ptr.add)(probe_index).*`, whose type `MapEntry(K : …, V)` is move-only, and it cannot be moved either: it is the value a pointer or reference points to, and that storage still owns it (a dereference copies, it never moves).
note: raised here, inside the standard library
    --> std/collections/hash_map.yo:374:48
    |
374 |           bucket := (data_ptr.add(probe_index)).*;
```

## Reproducer

```yo
{ HashMap } :: import("std/collections/hash_map");
{ println } :: import("std/fmt");
Fd :: struct(n : i32);
impl(Fd, Drop(drop : (fn(self : &mut Self) -> unit)(())));
main :: (fn() -> unit)({
  m := HashMap(i32, Fd).new();
  m.insert(i32(1), Fd(n : i32(2)));
  println(m.len());
});
export(main);
```

`yo check` fails with the error above; `HashMap(Box(P), i32)` fails the same
way through its key.

## Root cause

`HashMap`'s probe loops read each bucket by value
(`bucket := (data_ptr.add(probe_index)).*`), a copy of a `MapEntry(K, V)`.
Since V3 a dereference of a move-only value cannot be copied (E0901), so any
`K` or `V` that is move-only makes the whole map unusable.

## Fix direction

The probes must read the bucket in place (a borrow of the slot, or field
reads through the slot pointer) instead of copying it. This is the
non-copying element access of decision 20, which V2b gives the collections
(`plans/VALUES_BY_DEFAULT.md` §6 V2b); the regression test is the reproducer
above as a `tests/` case, plus a `HashMap(Box(K), V)` insert/get in
`tests/rc.test.yo`'s unique-`Box` section.

## Fix

Every slot access in the collections that a move-only key, value or element
reaches now reads in place or moves bitwise; nothing copies a slot.

- **`HashMap`** (`std/collections/hash_map.yo`). `_find_bucket` and `_probe`
  compare `(data_ptr.add(i)).*.key == key` in place. `_resize` moves each
  entry with `__yo_ptr_write(new, __yo_ptr_read(old))` and frees the old array
  without dropping anything, which also deletes the dup-then-drop loop the copy
  needed for a counted `K` or `V`. `try_insert`'s overwrite moves the old entry
  out (`__yo_ptr_read(p)`) and a new `MapEntry(key, value)` in
  (`__yo_ptr_write`), then a struct-pattern `match` moves the old value out of
  the old entry and drops its key. `remove` moves the entry out the same way
  and keeps its value; `remove_entry` moves the whole entry out instead of
  copying it through `get_key_value`; `retain` drops a rejected entry in place.
  The whole entry moves, never one field through `addr_of`: `HashSet`'s value
  is `unit`, and the v0.2.63 seed, which compiles this std into the compiler,
  lowers a pointer move of a `unit` place to invalid C (the codegen bug below).
  Freeing a slot is one helper, `_vacate`, shared by the three. `get` copies
  only the value, so a move-only `K` with a copyable `V` keeps `get`.
  `HashMapEntry.and_modify` replaces the value alone instead of rebuilding the
  entry from a copy of its key.
- **`HashSet`** is `HashMap(T, unit)`, so it is fixed by the map. Its
  overwrite path first moved a `unit` value through a field pointer, which
  exposed a codegen bug: `addr_of` of a `unit` place and
  `__yo_ptr_read`/`__yo_ptr_write` of a `unit` pointee emitted invalid C
  (`(&)`, `*(void*)p = ()`). It is fixed in the same change
  (`issues/fixed/2026-10-16-a-pointer-move-of-a-unit-place-emits-invalid-c.md`).
- **The other collections had the same cause** and are fixed the same way:
  `Deque` grows and pops by bitwise moves; `PriorityQueue` compares in place
  and sifts with `ArrayList.swap`, and `pop` swaps the root to the end and pops
  it; `BTreeMap` binary-searches in place, overwrites by moving the old entry out and
  a new one (the stored key, the new value) in, shifts a new entry into place with `swap`, `remove`s through the
  list's `remove` and a struct-pattern `match` that moves the value out of the
  entry, and `pop_first`/`pop_last`/`contains_key` no longer copy. `OrderedMap`
  of a move-only VALUE works once its three `match`es over the inner map's
  results borrow instead of consuming them.

The accessors that return a copy by design (`get`, `front`, `peek`,
`get_key_value`, the by-value iterators, the entry API's `or_insert`) still
need a copyable element, as decision 20 specifies; the same E0901 names them
at the call. Two collections do not share this cause and stay open:
`issues/2026-10-16-a-linkedlist-of-a-move-only-element-cannot-pop-or-clear.md`
(the value sits in a shared node) and
`issues/2026-10-16-an-orderedmap-of-a-move-only-key-does-not-compile.md` (the
key is stored three times).

## Verification

- `tests/move_only_collections.test.yo` (new): `HashMap` of a move-only value
  through two rehashes, overwrite, `Index` read, `remove`, `remove_entry`,
  `retain`, `clear` and `and_modify`; a move-only key with a copyable value
  (`get`); `HashSet`, `BTreeMap` (value and key), `OrderedMap`, `Deque` past a
  grow, and `PriorityQueue` of move-only types. The value tests count the
  value drops (each value exactly once, by its own value), and two tests
  count the drops of a `Drop` key `_McKd` through `HashMap` overwrite,
  `remove`, `remove_entry` and `retain`, `HashSet` insert and remove, and
  `BTreeMap` overwrite, `remove` and `pop_first`: every key made, stored or
  probed, is dropped exactly once. It fails to compile on develop
  `36c41e62b` with the E0901 above.
- `tests/rc.test.yo`'s unique-`Box` section builds a
  `HashMap(Box(UBoxPoint), Box(i32))`: insert, lookup by an equal payload,
  `contains_key`, `remove`.
