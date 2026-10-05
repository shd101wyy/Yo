# A `String` byte index is a writable place

**Severity:** S1: safe code can break `String`'s UTF-8 invariant, and the write reaches every copy that shares the buffer.

**Status: FIXED** (String S3, `plans/STRING_VALUE_SEMANTICS.md`). `String` no longer implements `Index(usize)`: `s(i)` is E0606 and bytes are read with `byte_at(i)` / `get_byte(i)`, so safe code has no writable byte place. A read-only `s(i)` returns with the Index read/write split (`plans/VALUES_BY_DEFAULT.md` §3.1). Test: `tests/string/string.test.yo`, "A String has no writable byte place". Found 2026-10-03 while implementing S1; measured on yo 0.2.49.

## Symptom

```rust
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("abc");
  t := s;
  t(usize(0)) = u8(122);
  println(`${s} ${t}`); // prints "zbc zbc"
});
export(main);
```

- Assigning through `t(i)` writes any byte, so `t(usize(0)) = u8(0xFF)` leaves invalid UTF-8 in a `String` with no `unsafe`.
- The write also changes `s`: a copy shares the buffer, and the byte place points into it. That breaks the value semantics the plan adopts.

## Cause

`String` implements `Index(usize)` with `index : (fn(inout(self) : Self, idx : usize) -> *Self.Output)`, which returns `&bytes(idx)`, a pointer into the buffer. One pointer-returning `index` serves both reading (`ch := s(i)`) and writing (`s(i) = b`). Because the pointer escapes, `index`'s mutation mask is `all`, so the analysis cannot tell the two apart either.

## Expected

Byte indexing on `String` is read-only, as in Rust, where `String` has no writable byte index: `s(i)` yields a `u8`, and `s(i) = b` is rejected. Byte-level mutation goes through an API that keeps UTF-8 valid, or through `unsafe`. The Index trait's read/write split for copy-on-write types is part of `plans/VALUES_BY_DEFAULT.md` (V2b, `INDEX_TRAIT.md`). `String` follows it in `plans/STRING_VALUE_SEMANTICS.md` S3.
