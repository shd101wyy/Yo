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

## Fix

- `evaluate_drop` (`src/evaluator/builtins/drop.yo`) rejects `___drop(...)` unless the call is inside `unsafe(...)` or in an unsafe-capable file, the same gate a raw-pointer dereference has (`is_destroying_builtin_call_capable`, `src/evaluator/memory_safety.yo`): `'___drop(...)' requires 'unsafe(...)'`, with `drop(x)` and `drop_in_place(p)` as the hints. The RC-release builtins had the same hole and share the gate (`issues/fixed/2026-10-22-the-rc-release-builtins-are-callable-outside-unsafe.md`). The drops the compiler synthesizes are parsed from `auto-generated://` code, which the file check admits, and every std file that calls `___drop` declares `pragma(Pragma.AllowUnsafe)`.
- The prelude exports `drop_in_place(p : *(T))`, Rust's `ptr::drop_in_place`, with the body `unsafe(___drop(p.*))` (maintainer decision 2026-10-21). It takes a raw pointer, which safe code can neither name nor hold, so only pragma'd code calls it. `___drop` stays the std-internal builtin.
- Std's eleven raw-slot sites (`std/collections/array_list.yo` three, `hash_map.yo` three, `deque.yo` one, `std/sync/channel.yo` three, and `Box`'s `Drop` in `std/prelude.yo`) call `drop_in_place(ptr)` instead of `___drop(ptr.*)`; the destructor that runs is the same.

## Tests

- `tests/safe_code_structural_gates.test.yo`: the reproducer's body (`___drop(h.xs)` on a field, then a read) and `___drop(xs)` on a local are `comptime_expect_error(..., "requires 'unsafe(...)'")` cases. Before the fix the first case is accepted, so the test fails.
- `tests/unsafe.test.yo`: inside `unsafe(...)` in a pragma'd file, `___drop(h.t)` on a field runs the field's destructor once, and `drop_in_place` destroys a `malloc`'d slot's value (a `Drop`-counting struct, and an `ArrayList(String)` whose string it releases).
- `tests/cli-cases/drop-builtin-safe-code`: compiling the reproducer exits 1 with the new diagnostic.
