# Chained method call on get_ptr result generates duplicate variable definition

## Summary

When chaining a field access through a `get_ptr()` result and then using the result in a `match`, the codegen emits the `get_ptr` call twice with the same variable name, causing a C "redefinition" compilation error.

## Reproduction

```rust
(tokens : ArrayList(Token)) = ...;
text = match(tokens.get_ptr(usize(i)).*.content, .Some(c) => c, .None => ``);
```

## Generated C (simplified)

```c
// First emission of get_ptr
Token* temp_901 = get_ptr(tokens, (size_t)(i));
// Second emission — DUPLICATE!
Token* temp_901 = get_ptr(tokens, (size_t)(i));
// Then access content from temp_901
Option_String temp_903 = (*temp_901).content;
```

## Root Cause

The codegen evaluates the sub-expression `tokens.get_ptr(usize(i))` twice — once for the pointer dereference `.*` and once for the field access `.content` — but assigns both to the same temp variable name, causing a redefinition.

## Workaround

Break the chained expression into separate statements:

```rust
(tok : *(Token)) = tokens.get_ptr(usize(i));
text = match(tok.*.content, .Some(c) => c, .None => ``);
```

## Impact

Affects any chained `collection.get_ptr(idx).*.field` pattern used inside match or other complex expressions.
