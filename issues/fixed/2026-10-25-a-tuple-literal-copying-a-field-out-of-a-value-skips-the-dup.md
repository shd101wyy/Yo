# A tuple literal copying a field out of a value skips the dup (heap use-after-free)

**Severity:** S1 — `(i32(1), s.buf)` with `s.buf` an `ArrayList` shares the list's buffer with `s` without taking a reference, so the buffer is freed twice; safe code, no diagnostic, AddressSanitizer reports a heap use-after-free.

**Status:** fixed (codegen). Found 2026-10-25 on `feat/v3-std-cell-free-resources` while writing `BufWriter.into_parts` (`(inner, st.*._buf)` freed the pending bytes with the box). Pre-existing: the reproducer fails the same way with the v0.2.69 and v0.2.62 seeds. Not V3's: `std/io/bufio.yo` binds the field to a local first, which takes the dup.

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

## Root cause

The evaluator was right: `evaluate_tuple_element_value` gives the element
its deferred `___dup` (a field store), keyed on the projection's temp
(`___dup(<temp of s.buf>)`). Codegen dropped it. The tuple emitter
(`_build_tuple`, `src/codegen/exprs/tuple_fn.yo`) and the array-literal emitter
(`generate_anonymous_array`, `src/codegen/exprs/array_fns.yo`) each emitted
the element with a hand-rolled copy of the store rule: render the element,
call `generate_deferred_dup_expressions`, adopt the dup's result temp. A field
read is inlined at its use (`__yo_v_s.__yo_v_buf`), so its temp is never
declared, and `generate_deferred_dup_expressions` skips a dup whose target
temp is undeclared (the guard against `__yo_incr_rc(<undeclared>)`). Its
own comment says the callers that need the +1 must apply it to the generated
value. The struct constructor, a binding and an assignment do, through
`emit_deferred_dup_or_code` (`src/codegen/exprs/drop_dup.yo`), which declares the
source's temp from the rendered code first (`T <temp> = s.buf;`). Those
paths therefore kept the reference, and the two literal paths silently lost
it: one count for two owners, freed twice.

The same skip hit every inlined read with a recorded temp, not only a field.
An indexed element, `(xs(i), …)`, and an array literal,
`Array(ArrayList(u8), 2)(s.buf, s.buf)`, were use-after-frees too
(`tests/tuple_field_copy_dup.test.yo` covers all three).

## Fix

Both literal emitters emit each element through `emit_deferred_dup_or_code`,
the store rule every other store position uses. It declares the projection's
temp, emits the dup, and returns the dup's result, or the source for an
element-wise dup (whose temp is one element and whose source it retained in
place, the case `element_wise_dup_target` used to guard). Nothing changes for
an element whose rendered code already is its temp, such as a call result or a
named local.

`std/io/bufio.yo`'s `BufWriter.into_parts` keeps binding the field first,
because std is still compiled by the seed, which lacks this fix. That
workaround can be removed once `SEED_VERSION` carries it.

## Test

`tests/tuple_field_copy_dup.test.yo` copies a `ref` handle (a `Drop`
counter) out of a local value, a `&S` parameter and a by-value parameter
into a tuple, out of a local into an array literal, and out of an
`ArrayList` by index into a tuple. Each case asserts that the handle is
disposed exactly once. All five fail under AddressSanitizer before the fix
(heap-use-after-free) and pass after it, also under `--allocator debug`.
The handles are `ref` objects because they stay copies once the collections
are values (B8). Over B8's flipped std the reproducer's `ArrayList` field is
move-only and `(i32(1), s.buf)` is E0901 ("a field of another value"). The
five cases still fail without the fix and pass with it there.
