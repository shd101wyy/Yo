# Index trait: cannot index function call result (temporary)

## Description

The Index trait codegen does not handle indexing a temporary value returned by a function/method call. For example:

```rust
(ch : i32) = i32(buf.as_bytes()(usize(scan)));
```

Here, `buf.as_bytes()` returns `ArrayList(u8)` (a temporary), and `(usize(scan))` tries to index it via the Index trait. The codegen fails with:

```
Unhandled function call: (buf.as_bytes)()
```

The issue is that the Index trait desugars `value(idx)` into `Index.index(&value, idx).*`, which requires `&value` — taking a pointer to the receiver. Taking a pointer to a temporary (function call result) is not supported in C.

## Workaround

Extract the function call result into a named variable first:

```rust
(buf_bytes : ArrayList(u8)) = buf.as_bytes();
(ch : i32) = i32(buf_bytes(usize(scan)));
```

## Stack trace

```
at generateFuncCall (src/codegen/exprs/generation.ts:1073:15)
at _generateExpr (src/codegen/exprs/generation.ts:571:16)
at generateIndexTraitCall (src/codegen/exprs/generation.ts:167:22)
```

## Status

Open — workaround available.
