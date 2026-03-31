# Match inside function argument generates phantom drop variable

## Summary

When a `match` expression is used inline as an argument to a function call, the codegen generates a drop for a variable that doesn't exist, causing a C compilation error.

## Reproduction

```rust
(content : Option(String)) = .Some(`hello`);
some_function(match(content, .Some(c) => c, .None => ``), other_arg);
```

## Generated C (simplified)

```c
switch ((content).tag) {
case SOME: {
    String c = content.data.Some.value;
    String temp_77 = dup(c);   // temp_77 exists only in this branch
    result = temp_77;
    break;
}
case NONE: {
    String temp_80 = to_string("");
    result = temp_80;
    break;
}
}
some_function(result, other_arg);
drop(result);
drop(temp_78);   // ERROR: temp_78 is never declared!
drop(content);
```

## Root Cause

The RC drop analysis generates a drop for `temp_78` which appears to be a phantom variable — it's neither declared in the SOME branch nor the NONE branch. The codegen seems to allocate temp variable IDs for the match branches but generates drops for IDs that were never actually emitted.

## Workaround

Hoist the match expression out of the function call:

```rust
(extracted : String) = match(content, .Some(c) => c, .None => ``);
some_function(extracted, other_arg);
```

## Impact

Affects any `match(Option(...))` used inline as a function argument. Common pattern in code that migrates from `String` to `Option(String)` fields.
