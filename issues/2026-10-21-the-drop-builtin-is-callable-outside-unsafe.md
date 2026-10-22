# The `___drop` builtin is callable outside `unsafe`

**Severity:** S2 — safe code can call `___drop` on a live place and keep using it, which is a heap use-after-free with no `unsafe` and no `pragma(Pragma.AllowUnsafe)` anywhere in the program.

## Reproducer

`issues/repros/2026-10-21-the-drop-builtin-is-callable-outside-unsafe.yo`:

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");

Holder :: struct(xs : ArrayList(i32));

main :: (fn() -> unit)({
  mut(h) := Holder(xs : ArrayList(i32).new());
  h.xs.push(i32(1));
  ___drop(h.xs);
  println(h.xs.len());
});
export(main);
```

- `yo check` accepts it (develop `6e76ed315`-era tree binary, 2026-10-21).
- `yo compile … --sanitize address --allocator system` and running it reports `ERROR: AddressSanitizer: heap-use-after-free`.
- On a named local, `___drop(xs)` moves `xs`, so a later use is E0901 and the hole does not open. On a field place (`h.xs`), nothing marks the place dead, so the field is read after its buffer was freed.

## Root cause

`___drop(place)` runs the place's drop glue without moving it out. It is the primitive behind std's raw-slot destruction (`std/collections/array_list.yo`, `deque.yo`, `hash_map.yo`, `std/sync/channel.yo`), and every std call site reaches it through a raw-pointer dereference that already needs `unsafe`. But the builtin itself has no unsafe gate. Since macro plan B4 (#1513) deleted the `unsafe.drop` wrapper, nothing at the call ever asked for one.

## Fix direction

- `___drop` requires an `unsafe` context, the same as Rust's `ptr::drop_in_place`, which is an `unsafe fn`.
- The maintainer decided on 2026-10-21 to add `drop_in_place(p : *(T))` as an `unsafe` std function for v0.2.69, with the body `___drop(p.*)`, and to keep `___drop` as the std-internal builtin. The fix lands with it: the gate on `___drop`, a negative test that the reproducer is rejected outside `unsafe`, and std's sites moved to `drop_in_place` where that reads better.
