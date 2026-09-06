# `fmt.Writer.to_string` aliased the writer's live buffer

**Status: FIXED** (2026-09-06, `std/fmt/writer.yo`). Found by the std API
audit — `plans/STD_API_STABILIZATION.md` §3 item 12.

## Symptom

```rust
{ Writer } :: import("std/fmt/writer");
w := Writer.new();
w.write_str("abc");
first := w.to_string();   // "abc"
w.write_str("def");
// first is now "abcdef" — and `first` and `w` drop the SAME bytes.
```

`to_string` was `String.from_bytes(self.buf)`. `String.from_bytes` does not
copy — it stores the `ArrayList(u8)` it is given (that is the point of the
unchecked constructor) — so the returned `String` and the `Writer` shared one
buffer. Every later `write_*` mutated a value the caller already held, and a
second `to_string` returned a second alias of the same bytes.

## Fix

`to_string` hands the buffer over and gives the writer a fresh one:

```rust
to_string : (fn(self : Self) -> String)({
  bytes := self.buf;
  self.buf = ArrayList(u8).new();
  String.from_bytes(bytes)
}),
```

The String owns what it returns; the writer is empty and reusable afterwards
(`w.len() == 0`). This is the `String::from(buf)` / `mem::take` shape Rust
users expect from a builder's terminal call.

## Regression test

`tests/fmt.test.yo` — "Writer.to_string detaches the buffer: later writes
never mutate a returned String". Red on the aliasing implementation (the first
assertion sees `abcdef`), green after.
