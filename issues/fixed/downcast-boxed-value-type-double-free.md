# Downcast boxed value type double-free (use-after-free)

## Status: Fixed

## Summary

`downcast(dyn_value, T)` for boxed value types (e.g., `String`) produced a use-after-free because the extracted value was copied out of the box without duping its inner RC references.

## Reproduction

```rust
open import "std/string";
open import "std/error";

main :: (fn() -> unit)({
  (err : AnyError) = dyn(`something went wrong`);

  match(downcast(err, String),
    .Some(s) => assert(s == `something went wrong`, "match"),
    .None => assert(false, "none")
  );
});

export main;
```

Compile with `--sanitize address` → `heap-use-after-free` in `__yo_decr_rc`.

## Root cause

When `dyn()` wraps a value type like `String`, it auto-boxes it into `Box(String)`. The `downcast` codegen extracts the String from the box. The code checked `isObjectType` and recursively unwrapped newtypes looking for an object, but String is `newtype(_bytes: Option(ArrayList(u8)))` — the unwrapped type is `Option(ArrayList(u8))` which is an **enum**, not an object. So `needsRcDup` was `false`, and the value was copied without incrementing any RC.

This caused a double-free:

1. `Option(String)` drop → drops the extracted String → decrements ArrayList RC
2. `AnyError` drop → box decr_rc → box dispose → drops String inside box → decrements the already-freed ArrayList RC

## Fix

In `src/codegen/exprs/downcast.ts`: instead of only checking `isObjectType` on the unwrapped type, first check if the target type has a `___dup` function via `getDupFunctionForType()`. This correctly handles:

- Newtypes wrapping enums with RC fields (String)
- Enums containing RC-typed variants
- Any type with generated RC management

The fix emits the type's `___dup` function call when extracting from a box, ensuring proper RC increment for all inner references.

## Files changed

- `src/codegen/exprs/downcast.ts` — Added `getDupFunctionForType` check before falling back to `isObjectType` unwrap logic
