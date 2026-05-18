# Algebraic Effects and Handlers

## Overview

Yo supports **algebraic effects** — one-shot delimited continuations for control flow. Effects are regular function parameters whose handler bodies may use `unwind` to discard the continuation or `return(value)` to resume it.

All parameters are explicit. There are no implicit (`using`/`given`) parameters.

The code generation strategy is **evidence passing** — effect handler function pointers are passed as extra C parameters.

## Design

| Principle              | Decision                                        |
| ---------------------- | ----------------------------------------------- |
| Explicit parameters    | All fn parameters are passed at every call site |
| Evidence passing       | Handler fn pointers as C params                 |
| One-shot continuations | `return` resumes, `unwind` discards             |
| Effect polymorphism    | `forall(E : Struct)` + `e : E`                  |
| Effect bundling        | Anonymous structs `{ raise, log }`              |

## Syntax

### Declaring and using effects

```rust
// Declare an effect operation type
Raise :: (fn(msg : String) -> i32);

// Function that uses it — just a regular parameter
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(
  cond(
    (y == 0) => raise("div-by-zero"),
    true => (x / y)
  )
);

// Install a handler — regular variable declaration
raise_handler := (msg) -> { unwind(42); };

// Call site — explicit parameter passing
result := safe_divide(1, 0, raise_handler);
```

### Continuation control

- **`unwind(value)`** — discards the continuation, returns from the enclosing function
- **`return(value)`** — resumes the continuation with `value`

```rust
// Unwind handler — discards continuation
handler := (msg) -> {
  println(msg);
  unwind(42);
};

// Resume handler — continues after the effect call
handler := (msg) -> {
  println(msg);
  return(0);  // safe_divide returns 0
};
```

### Effect propagation

Functions propagate effects by accepting them as parameters and forwarding to callees:

```rust
wrapper :: (fn(x : i32, raise : Raise) -> i32)(
  safe_divide(x, 0, raise)  // forward the effect
);
```

### Effect row polymorphism

Effect-polymorphic functions use `forall(E : Struct)` where `E` binds to an anonymous struct of effect handlers:

```rust
run :: (fn(forall(T : Type, E : Struct),
    f : (fn(e : E) -> T),
    e : E) -> T)(f(e));

effects := { raise : my_raise, log : my_log };
result := run(might_fail, effects);
```

No effects → empty struct `{}`:

```rust
result := run(pure_func, {});
```

### Async + effects

```rust
effects := { raise, log };

fut := io.async((e : typeof(effects)) => {
  e.raise("err");
  e.log("hello");
});

result := io.await(fut, effects);
```

## Comparison: Before vs After

| Concept            | Before (implicit)                  | After (explicit)            |
| ------------------ | ---------------------------------- | --------------------------- |
| Effect param       | `using(raise : Raise)`             | `raise : Raise`             |
| Call site          | `safe_divide(1, 0)` (implicit)     | `safe_divide(1, 0, raise)`  |
| Install handler    | `given(raise) := handler`          | `raise := handler`          |
| Handler binding    | `(given(raise) : Raise) = handler` | `(raise : Raise) = handler` |
| Continue control   | `escape(value)`                    | `unwind(value)`             |
| Resume control     | `return(value)`                    | `return(value)`             |
| Effect row         | `forall(...(E))`                   | `forall(E : Struct)`        |
| Effect polymorphic | `using(...(E))`                    | `e : E`                     |
| Effect bundle      | `using(raise, log)`                | `{ raise, log }`            |

## Effect Coloring

Functions declare the effects they use as regular parameters. There is no implicit coloring — every parameter is explicit at every call site:

```rust
// This function uses the Raise effect
safe_divide :: (fn(x : i32, y : i32, raise : Raise) -> i32)(...);

// Callers pass the effect explicitly
result := safe_divide(10, 0, my_handler);

// Functions that don't handle effects simply forward them
wrapper :: (fn(x : i32, raise : Raise) -> i32)(
  safe_divide(x, 0, raise)
);
```

## Struct-Based Effect Records

Effects can be grouped into struct records:

```rust
Logger :: struct(
  info : (fn(msg : String) -> unit),
  warn : (fn(msg : String) -> unit)
);

log_and_check :: (fn(x : i32, logger : Logger) -> i32)(
  logger.info("checking");
  cond((x < 0) => logger.warn("negative"), true => ());
  x
);

my_logger := Logger(
  info : (msg) -> { println(msg); },
  warn : (msg) -> { println("WARNING: " + msg); unwind(()); }
);

result := log_and_check(42, my_logger);
```

## Semantics

- Effect handlers are regular function values passed as parameters.
- `unwind(value)` is valid inside any function body — the compiler detects handler functions by body analysis.
- Continuations are **one-shot** — `return` can be called at most once.
- Handler functions cannot capture outer runtime variables (C codegen requirement).
- `...(E)` effect row spreads are replaced by `E : Struct` (a forall generic constraint).

## Code Generation

Evidence passing remains unchanged from the implicit model:

- Effect handler functions are passed as fn-ptr C parameters.
- Effect call sites emit `__yo_effect_escaped = 0; result = (fn_ptr_call)(args); if (__yo_effect_escaped) { ... }`.
- `unwind` sets `__yo_effect_escaped = 1`, stores value via `__yo_unwind_value`.
- `return` resumes normally — no flag set.
