---
applyTo: "**/*.yo, std/**"
description: "Use when making design decisions about the Yo language, writing std library code, or working with Yo types. Covers type conventions, rune, Box, str vs String, Pointer, SomeType, and platform-specific code."
---
# Yo Language Design Decisions

## Type naming conventions

- Lowercase for value types (non-reference-counted): `rune`, `i32`, `u32`, `bool`
- Use `struct(...)` for value types
- Use `object(...)` for reference-counted types
- Use `newtype(...)` instead of `struct(...)` when the type has only a single field (e.g., `FilePermission :: newtype(mode : u32)`)

## Unicode: `rune` not `Char`

- `char` is the C character type (8-bit)
- `rune` represents Unicode code points (32-bit, like Go's rune)
- File: `std/data/rune.yo`

## Strings

- Double quote string returns `str` type (contains `[u8]` byte slice)
- Template string returns `String` type (utf-8 encoded `object` type)
- `str` is a builtin type — don't use it as a variable or type name.
- **Use template strings for constant `String` values**: Instead of `String.from("hello")`, write `` `hello` ``. Template strings without interpolation produce the same result but are more concise. This applies anywhere a `String` value is needed — return values, comparisons, arguments, etc.

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
- **Never substitute SomeType within another Type.** Because many types like struct/enum/union etc in Yo are nominal type, simple substitution can break type identity. The correct approach is to re-evaluate the type expression in an environment where the type parameter is bound to the concrete type.

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

## Algebraic effects

- Effects are matched by **type**, not by name. A `given(raise) : Raise` handler matches any `using(my_raise : Raise)` parameter regardless of the variable name — the match is on the `Raise` type.
- `return expr` inside an effect handler **resumes** the continuation.
- `escape expr` inside an effect handler **discards** the continuation and exits the enclosing `fn`.
- Effect row variables (`forall(...(E))` with `using(...(E))`) allow functions to be polymorphic over their effects — they forward whatever effects the caller provides.
- The codegen generates effect functions as state machines, similar to async/await.

## Future return types with effects

- `Future` takes the result type as the first argument and effect types as rest arguments: `Future(ResultType, Effect1, Effect2, ...)`
- When a function uses `using(io : IO)`, its return type must include `IO` in the `Future`: `Impl(Future(Result(T, E), IO))` — NOT `Impl(Future(Result(T, E)))`
- Return `io.async(...)` directly as the last expression — do NOT assign to an intermediate variable:

```yo
// WRONG — intermediate variable prevents enum variant type inference:
my_fn :: (fn(using(io : IO)) -> Impl(Future(Result(i32, IOError), IO)))({
  task := io.async((using(io)) => {
    .Ok(i32(42))
  });
  return task;
});

// CORRECT — return io.async directly:
my_fn :: (fn(using(io : IO)) -> Impl(Future(Result(i32, IOError), IO)))(
  io.async((using(io)) => {
    .Ok(i32(42))
  })
);
```
