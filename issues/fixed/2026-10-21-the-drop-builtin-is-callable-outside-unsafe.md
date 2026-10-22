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

- `evaluate_drop` (`src/evaluator/builtins/drop.yo`) rejects `___drop(...)` unless the call is written in an unsafe-capable file (`is_destroying_builtin_call_capable`, `src/evaluator/memory_safety.yo`): `'___drop(...)' is not available in safe code`, with `drop(x)` and `drop_in_place(p)` as the hints. Unlike the raw-pointer dereference gate, an enclosing `unsafe(...)` region does not admit the call: a generic body is evaluated at its call site, so a pragma'd caller's `unsafe(f(i32(0)))` admitted a `___drop` written in a safe file's generic `f` (found in review, 2026-10-22). The RC-release builtins had the same hole and share the gate (`issues/fixed/2026-10-22-the-rc-release-builtins-are-callable-outside-unsafe.md`). The drops the compiler synthesizes are parsed from `auto-generated://` code, which the file check admits, and every std file that calls `___drop` declares `pragma(Pragma.AllowUnsafe)`.
- The prelude exports `drop_in_place(p : *(T))`, Rust's `ptr::drop_in_place`, with the body `unsafe(___drop(p.*))` (maintainer decision 2026-10-21). It takes a raw pointer, which safe code can neither name nor hold, so only pragma'd code calls it. `___drop` stays the std-internal builtin.
- `Box`'s `Drop` (`std/prelude.yo`) calls `drop_in_place(self._cell)` instead of `___drop(unsafe(self._cell.*))`; the destructor that runs is the same. The ten sites in `std/collections/array_list.yo`, `hash_map.yo`, `deque.yo` and `std/sync/channel.yo` keep `___drop(ptr.*)` for now: `drop_in_place` is a call, and a destructor that makes a call lost an unwind in flight (`issues/fixed/2026-10-22-an-unwind-is-lost-when-a-temporary-dropped-after-the-call-runs-a-destructor-that-calls-a-function.md`). The tree's codegen is fixed, but the compiler itself is built by the seed, and with `ArrayList` destroying its elements through a call the seed-built compiler crashed in its parser. The move waits for a seed with the fix (`plans/backlog/SEED_VERSION_AUTOMATION.md`, "`drop_in_place` at std's raw-slot sites"). `Box`'s `Drop` already called `_box_owner_of`, so its move adds no call to a destructor that had none.

## Tests

- `tests/safe_code_structural_gates.test.yo`: the reproducer's body (`___drop(h.xs)` on a field, then a read) and `___drop(xs)` on a local are `comptime_expect_error(..., "'___drop(...)' is not available in safe code")` cases. Before the fix the first case is accepted, so the test fails.
- `tests/unsafe.test.yo`, "unsafe(...) around a call does not admit ___drop written in a safe file": `unsafe(destroy_field_then_read(i32(0)))` calls a generic function from the pragma-free `tests/fixtures/drop_gate_generic.yo`. A gate that also accepted an enclosing `unsafe(...)` admitted it, so the test fails there.
- `tests/unsafe.test.yo`: inside `unsafe(...)` in a pragma'd file, `___drop(h.t)` on a field runs the field's destructor once, and `drop_in_place` destroys a `malloc`'d slot's value (a `Drop`-counting struct, and an `ArrayList(String)` whose string it releases).
- `tests/cli-cases/drop-builtin-safe-code`: compiling the reproducer exits 1 with the new diagnostic.
