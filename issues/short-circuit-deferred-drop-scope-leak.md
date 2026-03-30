# Short-circuit || with RC temporaries: deferred drops leak to outer scope

## Problem

When chaining `||` expressions that produce RC-typed temporaries (e.g., `String`),
the short-circuit evaluation generates nested `if` blocks. The deferred drops for
temporaries created inside these inner `if` blocks are incorrectly emitted at the
outer function scope, where the variables are not declared.

## Reproduction

```rust
has_match :: (fn(content: String) -> bool)(
  (content.contains(`(c)`) || content.contains(`(C)`))
);
```

## Generated C (simplified)

```c
bool has_match(String content) {
  String temp1 = to_string("(c)");
  bool r1 = contains(content, temp1, 0);
  if (!r1) {
    String temp2 = to_string("(C)");  // declared inside if
    bool r2 = contains(content, temp2, 0);
    __sc = r2;
    drop(temp2);  // correct: inside if
  }
  drop(temp2);  // BUG: temp2 not declared here!
  drop(temp1);
  return __sc;
}
```

## Workaround

Compute each `contains` call into a separate `bool` variable before combining
with `||`:

```rust
has_match :: (fn(content: String) -> bool)({
  (has_c : bool) = content.contains(`(c)`);
  (has_C : bool) = content.contains(`(C)`);
  (has_c || has_C)
});
```

## Impact

Affects any chained `||` or `&&` where the operands produce RC-typed temporaries.
Pure value-type comparisons (e.g., `rune == rune`) are not affected.
