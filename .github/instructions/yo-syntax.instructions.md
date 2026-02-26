---
applyTo: "**/*.yo"
description: "Use when writing or editing Yo language code. Covers critical syntax rules: curly brace semantics, cond/match parentheses, function definitions, parsing ambiguities, and expression vs block distinctions."
---
# Yo Language Syntax Rules

## Curly braces `{...}` behave differently based on separators

- `{ expr }` without semicolons creates an **anonymous struct value**, NOT a block!
- `{ expr; }` with semicolons creates a **begin block** (sequence of statements)
- If you want a single expression, write `expr` directly. Don't wrap it in `{...}` unless you need a struct.

```yo
// WRONG - creates a struct:
result := { .Ok(()) }

// CORRECT - just the expression:
result := .Ok(())

// CORRECT - begin block with statements:
result := { x := 1; y := 2; .Ok(()) }

// WRONG - invalid anonymous struct value:
print_bool :: (fn(value: bool) -> i32)({
  cond(
    value => i32(1),
    true => i32(0)
  )
});

// CORRECT - just the expression:
print_bool :: (fn(value: bool) -> i32)(
  cond(
    value => i32(1),
    true => i32(0)
  )
);
```

## Always write `cond(...)` and `match(...)` with parentheses

- `cond(...)` - NOT `cond ...`
- `match(...)` - NOT `match ...`
- The parentheses are **required** and must not be omitted.
- Always write `cond(condition => result, true => default)`

## Function definitions

- `(fn(param1 : Type1, param2 : Type2) -> ReturnType)({ body; return expr; })`
- No space between `(fn() -> ReturnType)` and `({ body; })`
- Method definitions in struct use double parentheses: `method :: ((fn(self: Self) -> ReturnType) body)`
- Use `Self` instead of the type name in method signatures

## Return value rules

- The last expression in `{ ... }` without semicolon is the return value of the struct or enum constructor.
- With semicolon, like `{ expr; }`, the return value is `unit`.

## Always add `()` after function name to avoid parsing ambiguity

Because we didn't write `await(...`, code like:

```yo
cond(
  (fd >= i32(0)) => await file.close(fd),
  true => ()
);
```

gets parsed as:

```yo
cond(
  (fd >= i32(0)) =>
  await(
    file.close(fd),
    true => ()
  )
);
```

Always add `()` after function name to prevent this.

## No operator precedence

Always use parentheses to group operations: `((a + b) * c)` not `a + b * c`

Example: `((value <= 0x10FFFF) && ((value < 0xD800) || (value > 0xDFFF)))`

## Other syntax notes

- `unit` is a type not value, `()` is the unit value.
- There is no `loop` function. Use `while runtime(true), body` for runtime, or `while true, body` for comptime.
- When calling `assert`, always add 2nd argument: `assert(condition, "error message");`
- Pointer arithmetic uses `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=` operators with `&` prefix.
