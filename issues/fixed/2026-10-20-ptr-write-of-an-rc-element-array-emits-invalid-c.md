# `__yo_ptr_write` of an array with refcounted elements emits invalid C

**Severity:** S2 — `__yo_ptr_write(p, arr)` where `arr : Array(String, N)` (any element type with a refcount) fails at the C compiler, so unsafe std code cannot move a whole array into raw storage.

**Status:** fixed (2026-10-20, `feat/macro-b3-collection-constructors`). Found
while writing `ArrayList(T).from(sink(arr) : Array(T, N))`
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md` B3), which moves the array into the
list's buffer with one `__yo_ptr_write`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  arr := [`a`, `b`];
  mut(mu) := MaybeUninit(Array(String, 2)).new();
  raw := mu.as_ptr();
  __yo_ptr_write(raw, arr);
  got := mu.assume_init(raw);
  println(&got(1));
});
export(main);
```

```text
error: assigning to 'Array___yo_t_9952857769383863877_2' from incompatible type
'__yo_t_9952857769383863877' (aka 'struct __yo_t_6644301736545686442_struct *')
  (*(__yo_v_raw) = (_file____home_temp_171027419875381355010));
```

## Root cause

The value argument carries a deferred `___dup` (the by-value parameter's
share of a still implicitly copyable array). An ELEMENT-WISE dup of an
`Array(T, N)` lowers to `begin(__yo_dup_array_element(arr, 0), …)`: it retains
the elements of `arr` in place, and the begin block's result temp is the LAST
ELEMENT. `_generate_inline_call` (`src/codegen/exprs/generation.yo`), the
argument loop of the inline builtins (`__yo_ptr_write` among them), adopted
that temp as the argument unconditionally, so the write stored a `String`
where the pointee is an `Array(String, 2)`.

`emit_deferred_dup_or_code` (`src/codegen/exprs/drop_dup.yo`) already guards
the same adoption: a dup's result temp stands in for the source only when the
two recorded types agree. The inline-call loop now applies the same
`type_key` test, so the argument is the source value, which the in-place dup
has already retained.

## Test

`tests/collection_constructors.test.yo`, "`__yo_ptr_write` moves a whole
array of refcounted elements": fails to compile (the C error above) before the
fix, passes after, under the leak verdict. The `ArrayList(String).from` tests in
the same file cover the lowering through the constructor.
