# std's dropck exemption skips a std `Drop` type whose origin is elided

**Severity:** S2: a std type that holds a `&mut` field (an elided origin parameter) and implements `Drop` gets no drop-liveness, so a safe caller may write or move the borrowed place after the holder's last use while the holder still lives, or store the holder where it outlives the place. Latent before A1: no std type had that shape until `FixedBufferAllocator`, where the write corrupts blocks placed in the buffer.

Found 2026-11-24 while building VERDICTS-79's A1 PR 1 (`heap/a1-registry-fixed-buffer`). VERDICTS-79's probes
(`b1`, `b4`, `b6`) had the right errors because their `Fba` type lived in the probe's own file; the same type in
std had none.

## Reproducer

With `FixedBufferAllocator` (`std/heap/fixed-buffer.yo`, `struct(buf : &mut [u8], ticket : usize)` with a `Drop`
impl):

```yo
{ FixedBufferAllocator } :: import("std/heap/fixed-buffer");
main :: (fn() -> unit)({
  mut(buf) := Array(u8, 64).fill(u8(0));
  fba := FixedBufferAllocator.new(&mut buf.*);
  _a := fba.allocator();
  buf(usize(0)) = u8(9);
});
export(main);
```

Before the fix, `yo check` passes (rc 0). Moving `buf` (`moved := buf`) and storing the handle in an outer
`Option(FixedBufferAllocator)` from an inner block are accepted the same way. The same struct and `Drop` impl
copied into a user module gives E0911 for all three.

After the fix (rc 1):

```text
error[E0911]: Cannot read `buf` here: `fba` borrows `((buf.deref_mut))()` with `&mut` and is still live, and a `&mut` borrow is exclusive: while it is live, `((buf.deref_mut))()`, the places inside it and the places containing it are reached only through `fba`.
  --> m1.yo:7:3
  |
7 |   buf(usize(0)) = u8(9);
  |   ^^^
help: make the access after `fba`'s last use, or make it through `fba`
```

## Root cause

`nominal_drop_uses_roots` (`src/evaluator/values/impl.yo`) answers whether a `Drop` may read the places a type's
origins name (D1, `plans/backlog/REFERENCES_AND_ORIGINS.md` O3 "Drops that use no root"). Outside std it always
may. A std impl was trusted not to (Rust's `#[may_dangle]`, right for std's containers and cells, which free
their storage without reading through it) unless the type has an origin parameter of its own, a borrowing guard,
tested by `_type_has_own_origin_argument`: an `OriginSet` among the instance's type arguments, so only a SPELLED
`G(T, p)`. A struct whose `&` field leaves its origin to elision has an origin parameter of its own too (the
nominal row of O2, `nominal_has_hidden_origin`), but carries no type argument for it, so it read as a
container: its drop used no root, the holder was live only to its last use, and the loan ended there.

## Fix

The std branch also counts an elided origin: `_type_has_own_origin_argument(ty) || nominal_has_hidden_origin(ty)`.
std's containers and cells hold raw pointers, not references, so they have no hidden origin and keep the
exemption.

## Verification

- `std/heap/fixed-buffer.test.yo`'s compile-error rows (the buffer written and moved after the handle's last
  use, the handle stored in an outer slot) fail on a develop binary without the fix (`comptime_expect_error`:
  the expected error is not raised) and pass with it.
- The other rows (returned past the buffer E0912; an `Rc`, a module-level binding and a thread capture E0909)
  held before and after.
