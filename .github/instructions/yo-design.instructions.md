---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Box, str vs String, Pointer, SomeType, and platform-specific code."
---
# Yo Language Design Decisions

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
- Use `struct(...)` for value types
- Use `object(...)` for reference-counted types

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit)
- `rune` represents Unicode code points (32-bit, like Go's rune)
- File: `std/data/rune.yo`

## Strings

- Double quote string returns `str` type (contains `[u8]` byte slice)
- Template string returns `String` type (utf-8 encoded `object` type)
- `str` is a builtin type — don't use it as a variable or type name.

## Box and box

Implemented in `prelude.yo`:
```yo
Box :: (fn(comptime(V) : Type) -> comptime(Type))
  object(
    (*) : V
  )
;
box :: (fn(forall(V : Type), value : V) -> Box(V))
  Box(V)(value)
;
```

## Pointers

- `Pointer` works in both compile-time and runtime contexts (`Runtime` and `Comptime` traits in `prelude.yo`).
- Pointer arithmetic: `&+`, `&-`, `&<`, `&>`, `&<=`, `&>=`
- No NULL in Yo. Nullable pointer: `Option(*(T))` or `?*(T)`. `Option(*(T)).None` is optimized as NULL in C codegen.

## SomeType

- `SomeType` automatically implements the `Runtime` trait by default.
- Never write functions to resolve `SomeType` — struct/enum/union are nominal types, replacing SomeType causes problems.

## Platform-specific code

Use `process.yo` module `platform` and `Platform`:
```yo
AF_INET6 :: cond(
  (platform == Platform.Darwin) => i32(30),
  true => i32(10)
);
```

Current goal: make Yo work on Linux, macOS, and Windows.

## Breaking changes are acceptable

Yo is a new, evolving language. Don't worry about breaking changes when making design decisions.
