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
- Template string returns `String` type (utf-8 encoded `object` type). Its syntax is the same as JavaScript template strings. The `${...}` interpolation is also supported for types that implement `ToString` trait.  
- `str` is a builtin type — don't use it as a variable or type name.
- **Use template strings for constant `String` values**: Instead of `String.from("hello")`, write `` `hello` ``. Template strings without interpolation produce the same result but are more concise. This applies anywhere a `String` value is needed — return values, comparisons, arguments, etc.
- Use `println` or `print` function from `std/fmt` to print instead of `printf`. You can pass template string or any value whose type implements `ToString` trait to both `println` and `print`.

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

## Compile-time only functions must use `comptime` return types

Functions that only execute at compile time (e.g., build system functions, macro-like utilities) must wrap their return type in `comptime(...)`. If the return type is not wrapped in `comptime`, the evaluator treats it as a runtime function.

```yo
// WRONG — unit return without comptime means runtime:
project :: (fn(comptime(config) : Project) -> unit) {
  __yo_build_project(config.name, config.version);
};

// CORRECT — comptime(unit) signals compile-time only:
project :: (fn(comptime(config) : Project) -> comptime(unit)) {
  __yo_build_project(config.name, config.version);
};

// CORRECT — comptime(Step) for functions returning compile-time values:
executable :: (fn(comptime(config) : Executable) -> comptime(Step)) {
  __yo_build_executable(config.name, config.root, ...);
  Step(name: config.name, kind: StepKind.Executable)
};
```

This applies to all parameters and return types in comptime-only APIs:
- Parameters: `comptime(name) : comptime_string`
- Return: `-> comptime(Step)`, `-> comptime(unit)`, `-> comptime(str)`

## Algebraic effects

- Effects are matched by **type**, not by name. A `given(raise) : Raise` handler matches any `using(my_raise : Raise)` parameter regardless of the variable name — the match is on the `Raise` type.
- `return expr` inside an effect handler **resumes** the continuation.
- `escape expr` inside an effect handler **discards** the continuation and exits the enclosing `fn`.
- Effect row variables (`forall(...(E))` with `using(...(E))`) allow functions to be polymorphic over their effects — they forward whatever effects the caller provides.
- Effect handlers use Evidence Passing (function pointer parameters) for zero-overhead calls.
- **Handler functions are standalone, not closures.** Effect handlers are compiled as standalone C functions and cannot reference variables from the enclosing scope. Pass state as explicit function arguments instead.
- For the full design document with overhead analysis and implementation details, see `docs/en-US/ALGEBRAIC_EFFECTS.md`.

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

## JoinHandle(T) — spawned task handle

`JoinHandle(T)` is a builtin generic type returned by `io.spawn`. It wraps a pointer to the spawned future and allows awaiting its result.

### API
```yo
handle := io.spawn(task, using(io, raise));  // → JoinHandle(T)
result := handle.await(using(io));            // → Option(T)
```

### Semantics
- `io.spawn(task, using(io, effects...))` cold-starts the future, injects effect handlers, returns a `JoinHandle(T)`.
- `handle.await(using(io))` polls the spawned future until completion or abort, returns `Option(T)`:
  - `.Some(result)` — task completed normally
  - `.None` — task was aborted (effect handler called `escape`)
- When used as fire-and-forget (`io.spawn(task)` without binding result), the JoinHandle is discarded with no RC overhead.
- `JoinHandle(T)` is a non-owning view — it does not increment the future's reference count. The original task variable (`task1`, etc.) owns the future.

### Definition (in prelude.yo)
```yo
JoinHandle :: (fn(comptime(T) : Type) -> comptime(Type))
  struct(__future : *(T))
;
```
The `*(T)` field is required so the type parameter `T` appears in the struct fields, enabling the type synthesizer to extract `T` bindings during generic impl matching.

## Traits with associated types

Traits use direct `trait(...)` syntax with associated types as labeled `Type` fields:

```yo
// Trait definition — Item is an associated type
Iterator :: trait(
  Item : Type,
  next : (fn(self : *(Self)) -> Option(Self.Item))
);

// impl — provide concrete values for all fields
impl(Counter, Iterator(
  Item : i32,
  next : (fn(self : *(Self)) -> Option(Self.Item))(cond(
    (self._current >= self._max) => .None,
    true => { val := self._current; self._current = (self._current + i32(1)); .Some(val) }
  ))
));

// Where clause — use `:=` to constrain associated types (not `:`)
IntoIterator :: trait(
  Item : Type,
  IntoIter : Type,
  into_iter : (fn(self : Self) -> Self.IntoIter),
  where(Self.IntoIter <: Iterator(Item := Self.Item))
);
```

- **`:` in impl** creates a TraitValue (provides all fields).
- **`:=` in where clause** creates a specialized TraitType (constrains associated types only).
- Always wrap `fn` types in parentheses inside trait field definitions: `next : (fn(...) -> T)`, not `next : fn(...) -> T`.

## Comptime/runtime function specialization

Yo does **not** support function overloading. To provide comptime variants of functions, use explicit naming with a `comptime_` prefix (e.g., `comptime_unwrap` alongside `unwrap`). For operators, the `Call :: (runtime_fn, comptime_fn)` tuple pattern inside a module provides dispatch.

Use separate `impl` blocks with `where(Self <: Comptime)` constraints for comptime method variants on generic types like `Option(T)` and `Result(T, E)`.

**Duplicate method names across impl blocks are disallowed.** Defining `unwrap` in two separate impl blocks for the same type produces an error. Use distinct names (e.g., `comptime_unwrap`) instead. This ensures unambiguous method extraction via `Type.method_name`.

**Enum type method extraction** works: `Option(i32).unwrap` returns the method as a callable function value, matching struct type behavior.
