# A string literal argument to a `*(u8)` parameter emits invalid C

**Severity:** S2 — in an `AllowUnsafe` file, passing a string literal to a
Yo function whose parameter is `*(u8)` type-checks, and the C compiler then
rejects the emitted call; spelling the conversion `*(u8)("abc")` works.

**Found:** 2026-10-23, while writing a probe for
`issues/fixed/2026-10-22-a-cond-with-a-compile-time-condition-returns-a-borrowed-handle-without-a-dup.md`.
Develop `265faa941` has it.

## Reproducer

`issues/repros/2026-10-23-a-string-literal-argument-to-a-raw-u8-pointer-parameter-emits-invalid-c.yo`:

```yo
pragma(Pragma.AllowUnsafe);
{ printf } :: import("std/libc/stdio");
show :: (fn(name : *(u8)) -> unit)({
  unsafe(printf("%s\n", name));
});
main :: (fn() -> unit)({
  show("abc");
});
export(main);
```

```text
strptr3.c:1962:46: error: operand of type '__yo_str' where arithmetic or pointer type is required
  yo_id_…((uint8_t*)((__yo_str){ .ptr = (const uint8_t*)"abc", .len = 3 }));
```

## Analysis

The argument check accepts the `str` literal for the `*(u8)` parameter, the
same coercion an extern C call such as `printf("%s", …)` gets, but the call
emitter casts the whole `__yo_str` struct to `uint8_t*` instead of taking its
`.ptr`, the rendering the explicit `*(u8)("abc")` cast gets. Either the
argument check should reject the implicit conversion for a Yo function (raw
pointers are unsafe-only, and `*(u8)("abc")` states it), or the emitter should
render it as the explicit cast does. Not investigated further: out of scope
for the branch that found it.
