# Begin block pointer dereference RC dup codegen bug

## Summary

When a begin block's last expression is a pointer dereference (`ptr.*`) of an RC type, the generated C code attempts to `__dup` a temporary variable that hasn't been declared yet. The dup is emitted **before** the actual value computation.

## Reproduction

```rust
get_string : (fn(self: *(Self), idx: i32) -> *(String))(
  &(self.*.token_strings(usize(idx)))
)

// In a cond branch:
(href : String) = cond(
  (tok.*.href_idx >= i32(0)) => {
    (sp : *(String)) = state.*.get_string(tok.*.href_idx);
    sp.*    // <-- pointer dereference as begin block return value
  },
  true => unescaped_slice(src, tok.*.start, tok.*.end)
);
```

## Generated C (incorrect)

```c
if (condition) {
  String* sp = get_string(state, tok->href_idx);
  // BUG: tries to dup temp_195982 which doesn't exist yet
  String temp_195983 = __dup(temp_195982);  // ERROR: undeclared identifier
  temp_195983;
  result = (*sp);
}
```

The `temp_195982` is supposed to be the result of `sp.*` but it's referenced in the dup call before it's ever assigned.

## Workaround

Return the value directly instead of via pointer dereference:

```rust
// Change return type from *(String) to String
get_string : (fn(self: *(Self), idx: i32) -> String)(
  self.*.token_strings(usize(idx))
)

// Use directly without dereference
(href : String) = cond(
  (tok.*.href_idx >= i32(0)) => state.*.get_string(tok.*.href_idx),
  true => unescaped_slice(src, tok.*.start, tok.*.end)
);
```

## Impact

Found during markdown_yo InlineToken refactoring. The workaround (returning String directly instead of \*(String)) works but incurs an extra dup/drop vs borrowing through a pointer.

## Root cause (likely)

The RC dup insertion pass for begin block return values is generating the dup call before the actual value expression is emitted. The temp variable for the dereference result (`ptr.*`) is created after the dup call references it.
