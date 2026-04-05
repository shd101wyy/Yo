# spawn and waitpid: str assigned to uint8_t\* pointer

## Status: Fixed

## Description

The "spawn and waitpid" test in `tests/sys/process.test.yo` fails with a C
compilation error. A `Slice(u8)` (str) value is being assigned to a `uint8_t*`
pointer, which is a type mismatch in C.

## Error

```
error: assigning to 'uint8_t *' (aka 'unsigned char *') from incompatible type
'__yo_struct_yo1c2129e9_id_19544' (aka 'Slice_uint8_t')
  (*(argv + 0ULL)) = (__yo_struct_yo1c2129e9_id_19544){ .data = (uint8_t*)"echo", .length = 4 };
```

## Root Cause

In `generateComptimeValue` (`src/codegen/exprs/comptime-value.ts`), the nullable
pointer `.Some` variant codegen recursively called `generateComptimeValue` for the
inner field value WITHOUT passing type context (no `_sourceExpr`).

When the inner value is a `comptime_string` (e.g., from `*(u8)("echo")`), the
fallback path checked `!targetType || isComptimeStringType(targetType)`.
With `targetType = undefined` (no source expr), this was always true. It then
searched `context.types` for a newtype wrapping `Slice(u8)` — which is `str`.

If `str` was registered (e.g., by importing `std/fmt`, `std/string`, or
`std/process`), the fallback emitted a `Slice_uint8_t` struct literal instead of
a plain C string pointer.

## Fix

Pass the `nullablePointerType` (e.g., `*(u8)`) as a synthetic `_sourceExpr` when
recursively generating the `.Some` variant's inner value. This ensures the
comptime_string sees `targetType = *(u8)` (a pointer type), skips the str
fallback, and generates the correct C string literal.

## Affected Tests

- `tests/sys/process.test.yo` — "spawn and waitpid"
- Any code using `.Some(*(u8)("..."))` when `std/fmt` or `std/string` is imported
