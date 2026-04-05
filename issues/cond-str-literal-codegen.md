# str literal codegen emits bare C string instead of Slice struct

## Status: Fixed (verified — both cond branches and struct field assignments emit correct Slice struct)

## Description

When assigning `str` literals in certain contexts, the C codegen emits bare C string literals (e.g., `"h1"`) instead of proper `Slice_uint8_t` struct initializers. This affects:

1. **`cond`/`if` branch results** — `cond(x => "h1", true => "h2")` emits bare `"h1"`
2. **Struct field assignment** — `token.*.tag = "s"` emits bare `"s"`

Both correctly emit `Slice_uint8_t` struct when used in **function call arguments** or **local variable assignment/initialization**.

## Reproduction

### Case 1: cond branches

```rust
(h_tag : str) = cond(
    (level == i32(1)) => "h1",
    (level == i32(2)) => "h2",
    true => "h6"
);
```

### Case 2: struct field assignment

```rust
(token : *(Token)) = tokens.get_ptr(idx);
token.*.tag = "strong";  // ERROR in generated C
```

## Generated C (incorrect)

```c
// Case 1 (cond):
temp = "h1";  // ERROR: assigning char[] to Slice_uint8_t

// Case 2 (field assignment):
(*token).tag = "strong";  // ERROR: assigning char[] to Slice_uint8_t
```

## Expected C

```c
temp = (Slice_uint8_t){ .data = (uint8_t*)"h1", .length = 2 };
(*token).tag = (Slice_uint8_t){ .data = (uint8_t*)"strong", .length = 6 };
```

## Working contexts

- **Function call arguments**: `Token.new(.TT_P_OPEN, "p", i32(1))` → correctly generates `{ .data = (uint8_t*)"p", .length = 1 }`
- **Local variable initialization/assignment**: `(h_tag : str) = "h1"` → correctly generates struct
- **`if` body with local variable**: `if(cond, { h_tag = "h2"; })` → correctly generates struct

## Workarounds

1. For cond: use `if` chains with local variable assignment
2. For field assignment: assign to local variable first, then assign to field:
   ```rust
   (s_tag : str) = "s";
   token.*.tag = s_tag;  // works
   ```

## Impact

Prevents using `str` type directly in `cond` expressions and struct field assignments. Common pattern for tag name selection (heading levels, emphasis tags, etc.).
