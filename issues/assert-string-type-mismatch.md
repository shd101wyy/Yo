# assert() does not accept String (template strings) as message

## Summary

The `assert(condition, message)` builtin only accepts `comptime_string` / `str` (double-quoted strings) for the message parameter. Passing a `String` (runtime template string with interpolation) causes a type unification error:

```
Cannot unify incompatible types:
Expected: "String"
Given: "comptime_string"
```

## Reproduction

```rust
open import "std/string";

main :: (fn() -> unit)({
  name := `rule1`;
  assert(false, `Invalid rule name: ${name}`);
});

export main;
```

Error: `Cannot unify incompatible types: Expected: "String", Given: "comptime_string"`

## Workaround

Use static double-quoted strings without interpolation:

```rust
assert(false, "Invalid rule name");
```

## Expected behavior

`assert` should accept both `str` and `String` for the message argument, or there should be a `panic(String)` function that accepts runtime `String` values for dynamic error messages.

## Impact

This prevents including dynamic information (like variable names, indices, etc.) in assertion messages, reducing debuggability.

## Status: Fixed

Added `assert_dyn(flag: bool, msg: String)` and `panic_dyn(msg: String)` to `std/string/string.yo` (exported via `std/string`). These wrap `assert` / `panic` by calling `.as_str()` on the message. Import `std/string` to use them.
