# A tuple literal copying a field out of a value skips the dup (heap use-after-free)

**Severity:** S1 — `(i32(1), s.buf)` with `s.buf` an `ArrayList` shares the list's buffer with `s` without taking a reference, so the buffer is freed twice; safe code, no diagnostic, AddressSanitizer reports a heap use-after-free.

**Status:** open. Found 2026-10-25 on `feat/v3-std-cell-free-resources` while writing `BufWriter.into_parts` (`(inner, st.*._buf)` freed the pending bytes with the box). Pre-existing: the reproducer fails the same way with the v0.2.69 and v0.2.62 seeds. Not V3's: `std/io/bufio.yo` binds the field to a local first, which takes the dup.

## Reproducer

`issues/repros/2026-10-25-a-tuple-literal-copying-a-field-out-of-a-value-skips-the-dup.yo`:

```yo
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
S :: struct(buf : ArrayList(u8), cap : usize);
main :: (fn() -> unit)({
  l := ArrayList(u8).new();
  l.push(u8(1));
  s := S(buf : l, cap : usize(4));
  r := (i32(1), s.buf);
  println(`len ${r.1.len()} ${s.buf.len()}`);
});
export(main);
```

```text
$ yo compile repro.yo --sanitize address --allocator system -o repro && ./repro
ERROR: AddressSanitizer: heap-use-after-free ...
```

The same happens when `s` is a by-value, `sink`, `&S` or `Box(S)` parameter (`(i32(1), b.*.buf)`). Each of these is fine:

- a struct literal, `S2(a : i32(1), l : s.buf)`;
- binding the field first, `x := s.buf; (i32(1), x)`;
- returning the field alone, `b.*.buf`.

Expected: the tuple takes its own reference to the buffer (the copy every other store position makes until V2b gives the collections unique buffers), or, once a collection is move-only, E0901 "a field of another value".

## Where to look

`evaluate_tuple_value` (`src/evaluator/values/tuple.yo`) calls `set_expr_as_needs_to_call_dup(..., "field-store")` on each element, the same call the struct-literal path makes (`src/evaluator/calls/record_type.yo`), so the difference is downstream: how the tuple's element temp for a `.` projection is emitted or whether the dup/drop pair optimizer cancels it. Regression test: the reproducer as a `tests/` case under the leak verdict and AddressSanitizer.
