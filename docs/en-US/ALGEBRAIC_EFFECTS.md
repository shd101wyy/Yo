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

`Future` is **single-arg** at the type level: `Future(T, E)` where `E` is
a struct type holding the effect bundle. The bundle's type and value
mirror each other.

The closure passed to `io.async` must pin `e`'s type — the inferencer
cannot derive it from the bare closure literal. Use `typeof(effects)`
at top-level call sites, or rely on the enclosing function's annotated
return type when the closure is inside a function body.

```rust
effects := { raise, log };

// Top-level: annotate e with typeof(effects)
fut := io.async((e : typeof(effects)) => {
  e.raise("err");
  e.log("hello");
});

result := io.await(fut, effects);
```

```rust
// Inside a function with annotated return type — the return type
// pins E, so `(e)` without an annotation is fine:
do_work :: (fn(io : IO) -> Impl(Future(unit, IOErr)))(
  io.async((e) => {
    e.io.await(some_io_call(...), e.io);
    e.exn.throw(...);
  })
);
```

Single-effect futures pass the effect value directly because the effect
type is itself a struct:

```rust
// Future(T, IO) — E = IO, e = io
fut1 : Impl(Future(i32, IO));
x := io.await(fut1, io);
```

Multi-effect futures use a struct alias. Common bundles live in
`std/error.yo`:

```rust
// IOErr :: struct(io : IO, exn : Exception)
fut2 : Impl(Future(i32, IOErr));
y := io.await(fut2, { io, exn });
```

Width matching is **strict** — Yo structs are nominal. If a caller has
`e : IOErr` but the nested future only needs `IO`, the caller must
project:

```rust
// fut needs IO; project to e.io
result := io.await(fut, e.io);
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

### Handler Install-Site

The call site of a handler is the _install site_ — the function frame
where `unwind` lands. The compiler decides install vs propagate by
data flow:

| Site of binding                                          | Treatment   |
| -------------------------------------------------------- | ----------- |
| Local definition (`raise := ...`) in a begin-block frame | **Install** |
| Function parameter                                       | Propagate   |
| Closure capture of an outer handler                      | Propagate   |
| Re-binding (`r2 := r1`) — uses the innermost binding     | **Install** |

### Handler Value Escape Restrictions

A function value whose body contains `unwind` is _stack-bound_ to its
install frame. It may not outlive that frame. The compiler rejects:

- `return(handler)` from a function
- Storing a handler in a heap-allocated value (`Box`, `Rc`, etc.)
- Module-level bindings of handlers
- Closure captures where the closure may outlive the install frame

These constraints replace the old `isInsideGivenHandler` gate. They are
data-flow based — every expression that evaluates to a control-function
value carries an `originFrameId` tag, checked at escape sites.

## Code Generation

Evidence passing remains unchanged from the implicit model:

- Effect handler functions are passed as fn-ptr C parameters.
- Effect call sites emit `__yo_effect_escaped = 0; result = (fn_ptr_call)(args); if (__yo_effect_escaped) { ... }`.
- `unwind` sets `__yo_effect_escaped = 1`, stores value via `__yo_unwind_value`.
- `return` resumes normally — no flag set.
