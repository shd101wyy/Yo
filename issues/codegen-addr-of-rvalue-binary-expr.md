# Codegen: "cannot take the address of an rvalue" for `&(expr + constant)`

**Status:** open

## Symptom

```
error: cannot take the address of an rvalue of type 'unsigned long long'
    to_string((size_t*)((&(((_temp) + (1ULL))))));
                        ^
```

## Reproducer

```rust
// repro_addr_of_binary_expr.yo
{ to_string } :: import("std/fmt");

export main :: (fn() -> unit)({
  x := usize(5);
  ptr := &(x + usize(1));
  s := to_string(ptr);
  assert(s.as_str() == "6", "unexpected");
});
```

## Root cause

`&(x + 1)` generates C code `(&((x) + (1)))`. The addition `x + 1` produces
an rvalue (temporary), and C does not allow `&` on rvalues.

The `&()` codegen in `src/codegen/exprs/comptime-value.ts:360` generates
`(&${childCode})` where `childCode` is the inline result of the inner
expression. When `childCode` is a binary expression like `((temp) + (1ULL))`,
the resulting `(&((temp) + (1ULL)))` is invalid C.

The fix: before wrapping with `&()`, check if `childCode` is a complex
expression and spill it to a named temp variable first:

```c
size_t __tmp = x + 1ULL;
to_string((size_t*)(&__tmp));
```

## Investigation notes

The `generateAddressOf` function in `src/codegen/exprs/ptr-fns.ts` is never
reached for these expressions (confirmed by debug logging). The `(&...)` code
is generated from `src/codegen/exprs/comptime-value.ts:360` in the
`generateComptimeValue` function when handling pointer-typed comptime values.
