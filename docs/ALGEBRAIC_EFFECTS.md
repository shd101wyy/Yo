# Algebraic Effects and Handlers

## Overview

Yo supports **algebraic effects** — a mechanism for implicit parameter passing and one-shot delimited continuations. The system is built on two features:

1. **Implicit Parameters (`using` / `given`)** — contextual parameter passing, resolved at compile time
2. **Effect Handlers (`return` / `escape`)** — one-shot delimited continuations for control flow effects

Both features share the async/await state machine infrastructure. Effect invocations are suspension points, and the compiler transforms functions in the effect scope into state machines (the same transformation used for `io.async`/`io.await`).

## Design Principles

| Principle                  | Decision                          | Rationale                                                                                 |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| Explicit over implicit     | **Use `given`**                   | Explicit marking avoids ambiguity, better error messages, follows Scala 3 precedent       |
| State machine for effects  | **Yes**                           | Same architecture as async/await — effect invocation = suspension point                   |
| Transform callers too      | **Yes**                           | All functions in the "effect scope" (between handler and effect site) must be transformed |
| One-shot continuations     | **One-shot**                      | Fits RC model, simpler implementation, covers 99% of use cases, `resume` is linear        |
| Static dispatch            | **Impl (static)**                 | Handler is lexically scoped, compiler knows types, zero overhead                          |
| `return`/`escape` keywords | **One-shot (enforced by syntax)** | `return` and `escape` must be the last expression — can only appear once                  |

---

## Implicit Parameters (`using` / `given`)

### Syntax

```rust
// Declaring a function with implicit parameters
add_numbers :: (fn(
  x : i32,
  y : i32,
  using(add_fn : (fn(a : i32, b : i32) -> i32))
) -> i32)(
  add_fn(x, y)
);

// Providing an implicit value with `given` (:= form)
given(my_add) := (fn(x : i32, y : i32) -> i32)(
  x + y
);

{
  // Alternative `given` form with `:` binding
  (given(my_add2) : (fn(x : i32, y : i32) -> i32)) =
    (x, y) -> (x + y)
  ;

  // Calling — implicit parameter resolved automatically
  result := add_numbers(3, 4);  // resolves add_fn = my_add2

  // Calling — explicit contextual argument
  result2 := add_numbers(5, 6, using(my_add));
};

// Calling — explicit contextual argument
result3 := add_numbers(5, 6, using(my_add));

// Calling — explicitly skip provided contextual arg and fallback to `given` lookup
result4 := add_numbers(7, 8, using(undefined));
```

### Semantics

- `using(name : Type)` in a function signature marks a parameter as **implicit**.
- At call sites, the caller can omit implicit arguments. The compiler resolves them by searching the environment for a `given` binding whose type matches.
- The caller can also provide implicit arguments explicitly via `using(...)`: `add_numbers(3, 4, using(my_custom_add))`.
- `using(undefined)` at call site means: skip explicit value for this contextual slot and fallback to `given` lookup.
- `given` bindings are lexically scoped:
  - exactly one compatible `given` required,
  - zero matches => compile-time error,
  - multiple matches => compile-time ambiguity error (must disambiguate with explicit `using(...)`).
- Resolution is by **structural type matching** (the function signature must match), not by name.
- Function signatures allow only one `using(...)` clause; calls allow only one `using(...)` argument expression.
- Inner scope `given` shadows outer scope `given` of same type; ambiguity only for same-frame conflicts.

### Tests

See `tests/fn.test.yo` ("Test contextual parameters (using/given)") for examples of:

- Basic implicit lookup
- Explicit `using(...)` at call site
- `using(undefined)` fallback
- Multiple implicit params
- Ambiguous `given` error
- No matching `given` error
- `forall + using` inference

---

## Effect Handlers (`return` + `escape`)

### Syntax

```rust
// Define an effect operation (multi-parameter supported)
Raise :: (fn(msg : String, msg2 : String) -> i32);

// Use an effect in a function (effect becomes an implicit parameter)
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`, `I don't like it`),
    true => (x / y)
  )
);

// Handle the effect — without resume (discarding continuation via `escape`)
raise_const :: (fn() -> i64) {
  (given(raise) : Raise) = ((msg, msg2) -> {
    println(msg);
    println(msg2);
    escape i64(42); // escape returns from enclosing function with this value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
};
// Returns 42 — continuation is discarded

// Handle the effect — with resume (invoking continuation via `return`)
raise_resume :: (fn() -> i64) {
  (given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({
    println(msg);
    println(msg2);
    return i32(42); // return(value) resumes the continuation with value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
};
// Returns 60 — return(42) continues after the raise call site
```

### Semantics

- An effect operation type is a regular `fn` type whose handler body uses `escape` or `return` to control the continuation (the compiler detects this automatically).
- When an effect operation is invoked, execution is **suspended** at that point. A continuation (the rest of the computation up to the handler) is captured as a stack-allocated state machine.
- The handler body receives the effect's arguments (e.g., `msg`, `msg2`).
- Inside the handler body:
  - **`return(value)`** — resumes the captured continuation with `value` as the result of the effect call.
  - **`escape expr`** — discards the continuation entirely and returns `expr` from the enclosing function that installed the handler.
- Two handler forms:
  - **Anonymous function handler** (no-resume): `(given(raise) : Raise) = ((msg, msg2) -> { escape expr; });`
  - **fn-typed handler** (with resume): `(given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({ return(value); });`
- Continuations are **one-shot** — `return` can be called at most once (syntactically enforced as last expression; runtime double-resume check is planned but not yet implemented).
- Effect operations compose with `using` — the effect is an implicit parameter resolved via `given`.
- **Escape in async context**: When `escape` is called inside an `io.async` task, the Future is marked as **aborted** (state = -2). Attempting to `io.await` or `io.spawn` on an aborted Future causes a **panic** at runtime. See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md#aborted-futures) for details.

### Effect Coloring / Propagation

Functions are "colored" by the effects they use:

```rust
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(...);

// Any function calling safe_divide must either:
// 1. Handle the effect (provide `given(raise)`)
// 2. Propagate it (add `using(raise : Raise)` to its own signature)

// Option 1: Handle
handler :: (fn() -> i32) {
  given(raise) : Raise = ...;
  safe_divide(10, 0)
};

// Option 2: Propagate
wrapper :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  safe_divide(x, y)
);
```

The `using` parameter with a function type whose handler uses `escape` is the **sole marker** for whether a function may suspend due to an effect:

| Signature                                           | Role                                   | Needs state machine?          | Callers need transformation?            |
| --------------------------------------------------- | -------------------------------------- | ----------------------------- | --------------------------------------- |
| `fn(..., using(raise : Raise)) -> T`                | **Propagates** the effect              | Yes (within a handler scope)  | Only if they also propagate via `using` |
| `fn() -> T` (handles effect internally via `given`) | **Handles** the effect                 | Internally yes, externally no | **No** — callers see a plain function   |
| `fn(using(f : (fn() -> i32))) -> T`                 | Implicit param (plain `fn`, no escape) | No                            | No                                      |

The handler is the boundary. The state machine transformation is scoped to the region **between** the `given` handler site and the effect invocation site.

### State Machine Transformation

The effect system shares Yo's async/await state machine architecture (shared analysis in `src/codegen/shared/suspension-analysis.ts` and shared codegen in `src/codegen/shared/suspension-codegen.ts`):

1. **Effect site** (calling `raise(...)`) = suspension point (like `await`).
2. **Handler scope** = event loop (like `async { ... }`).
3. **`return(value)`** = continuation resume. **`escape expr`** = continuation discard.

Every function in the call chain between the handler and the effect site becomes a state machine:

```
handler scope (given(raise) : Raise = ...)
  +-- fn_a(...)                    <-- state machine
       +-- fn_b(...)               <-- state machine
            +-- raise(msg)         <-- suspension point (effect invocation)
```

The state machine struct includes: `state`, `completed`, `result`, `yield_0..N` (effect arguments), function parameters, and captured variables that cross suspension points.

### Effect Polymorphism (`...(E)` Row Spreads)

Effect row variables are declared with `...(Name)` inside `forall`. Named rows allow **independent effect sets** (like Koka's `e1 e2`).

```rust
// Single named effect row variable E
run :: (fn(forall(T : Type, ...(E)),
    f : (fn(using(...(E))) -> T),
    using(...(E))) -> T)(f());

// Two independent effect rows E1, E2
some_func :: (fn(forall(T : Type, U : Type, ...(E1), ...(E2)),
    xs : List(T),
    f1 : (fn(a : T, using(...(E1))) -> U),
    f2 : (fn(a : T, using(...(E2))) -> U),
    using(...(E1), ...(E2))) -> List(U));
```

**Effect row spread with closures** — The `...(E)` spread also works with closures (`Impl(Fn(...))`) and supports two styles for declaring the closure's effects:

```rust
Yield :: (fn(v : i32) -> i32);
Log :: (fn(v : i32) -> unit);

// traverse is polymorphic over ANY set of effects E that the callback needs
traverse :: (fn(
  forall(S : usize, ...(E)),
  arr : Array(i32, S),
  callback : (Impl(Fn(v : i32, using(...(E))) -> unit)),
  using(...(E))
  ) -> unit) {
    i := usize(0);
    while i < S, i = (i + 1), {
      callback(arr(i));
    };
  };

// Set up handlers
(given(yield) : Yield) = (v) -> { return v; };
(given(log)   : Log)   = (v) -> { println(v); };

arr := Array(i32, 5)(0, 1, 2, 3, 4);

// Style 1: Inline typed declaration — closure declares effect row with types.
// No call-site using() needed; E is inferred from the closure's declaration.
traverse(arr, (v, using(yield : Yield, log : Log)) => {
  log(v);
  result := yield(v);
  assert((result == v), "yield should return the value");
});

// Style 2: Call-site resolution — E is resolved from using(yield, log)
// at the call site, and the closure renames them with using(_yield, _log).
traverse(arr, (v, using(_yield, _log)) => {
  _log(v);
  result := _yield(v);
  assert((result == v), "yield should return the value");
}, using(yield, log));
```

At closure and call-site level, effects are listed directly in `using()` without `...(...)` wrapper. The `...(E)` syntax is only used in function type definitions where `E` is a forall-declared effect row variable.

If both the closure and call site declare effects, the types must match or the compiler reports an error.

Semantics:

- `...(E)` in `forall(...)` declares **E as an effect row variable** — ranging over sets of implicit parameters.
- `...(E)` in `using(...)` of function type definitions **spreads** the effect row's bound parameters into implicit parameters.
- At closure/call-site level, effects are listed directly: `using(yield, log)` or `using(yield : Yield, log : Log)`.
- Type unification: calling `run(might_fail)` where `might_fail : fn(using(raise : Raise)) -> i32` unifies `T = i32`, `E = (raise : Raise)`.
- Two rows: `...(E1)` and `...(E2)` are inferred independently from their respective function parameters; `using(...(E1), ...(E2))` is their union.

Type compatibility rules:

| Expected                            | Given                             | Compatible?                       |
| ----------------------------------- | --------------------------------- | --------------------------------- |
| `fn(using(...(E))) -> T`            | `fn(using(raise : Raise)) -> i32` | ✅ E = `(raise : Raise)`, T = i32 |
| `fn(using(...(E))) -> T`            | `fn() -> i32`                     | ✅ E = empty, T = i32             |
| `fn(using(r : Raise, ...(E))) -> T` | `fn(using(r : Raise)) -> i32`     | ✅ named param matches, E = empty |
| `fn(using(r : Raise)) -> T`         | `fn(using(l : Log)) -> i32`       | ❌ named params don't match       |

### Named Effect Instances

Multiple instances of the same effect type are supported via explicit `using(...)` at call sites:

```rust
Logger :: (fn(msg : String) -> unit);

program :: (fn(using(info : Logger, error : Logger)) -> unit) {
  info("starting");
  error("something went wrong");
};

program(using(info_logger, error_logger));
```

No special language support needed — this falls out of the existing `using`/`given` mechanism.

### Module-Based Effects

Effects can be organized into modules using Yo's module system. This is especially useful for grouping related effect operations:

```rust
MyException :: (fn(comptime(ErrorType) : Type) -> comptime(Module))(
  module(
    throw : (fn(forall(ResumeType : Type), error : ErrorType, resume_value : ResumeType) -> ResumeType)
  )
);

safe_divide :: (fn(x : i32, y : i32, using(exn : MyException(i32))) -> i32)(
  cond(
    (y == 0) => exn.throw(x, i32(0)),
    true => (x / y)
  )
);

// Install a module-based handler with `given`:
given(exn) := MyException(i32)(
  throw : ((val, resume_val) -> {
    return resume_val;  // resume with the provided recovery value
  })
);

result := safe_divide(10, 0);  // handler resumes with 0
```

Module effects support:

- **`forall` parameters** in effect operations (e.g., `forall(ResumeType : Type)`)
- **Nested modules** — modules containing other modules with effects
- **Labeled `using(name : ModuleType)`** — auto-destructuring of module fields into implicit parameters

### Control Flow with Effects

Effects interact correctly with all control flow constructs inside loops:

```rust
GetValue :: (fn() -> i32);

(given(get_value) : GetValue) = (() -> {
  return i32(1);
});

// break, continue, and early return all work after effect resume
while runtime(true), {
  result := get_value();  // effect invocation (suspension point)

  cond(
    (result > 10) => { break; },        // break after effect resume
    (result == 0) => { continue; },     // continue after effect resume
    true => ()
  );
};
```

Effects also work with tagged union `match` arms:

```rust
while runtime(true), {
  get_value();  // effect invocation

  opt := Option(i32).Some(counter.*);

  val := match(opt,
    .Some(v) => v,
    .None => break    // break inside match arm after effect resume
  );
};
```

### Transitive Effect Propagation

When a function is effect-polymorphic via `forall(...(E))` and contains loops with control flow, the state machine transformation applies correctly inside the function body:

```rust
Yield :: (fn(v : i32) -> i32);

apply_effect :: (fn(forall(...(E)), n : i32, using(...(E))) -> i32) {
  counter := Box(i32)(0);
  result := Box(i32)(0);

  while runtime(counter.* < n), {
    counter.* = (counter.* + 1);
    cond(
      (counter.* > i32(3)) => { break; },
      true => ()
    );
  };

  return counter.*;
};

(given(yield) : Yield) = ((v) -> { return v; });
result := apply_effect(i32(10));
```

### Tests

See `tests/algebraic_effects.test.yo` (46 tests) for comprehensive examples covering:

- Basic escape and resume via `using` parameter
- Direct effect escape/resume without intermediate `using` function
- Nested effect escape/resume inside resume handler
- While loop with effect resume (basic, break, continue, mixed continue-then-break)
- Break from cond and match arms after effect resume
- Break drops local allocations after effect resume (verified with AddressSanitizer)
- Early return inside loop after effect resume
- Two different effect types in same scope (Log + Raise)
- Single-level and two-level effect propagation via `using`
- Given variable shadowing (resume and escape variants)
- Effect polymorphism with `using` spread (resume and escape)
- Module-based effects with escape/resume (including forall handlers)
- Nested module-based effects with escape/resume
- Module destructured `using(ModuleType)` with escape/resume
- Multiple effect row spreads with resume/escape
- Closure with `using()` effect — resume and escape
- Effect row polymorphism with `...(E)` spread in closure callbacks
- Transitive state machine functions with break/continue/early return
- Break/continue in tagged union match arms after effect resume

---

## Relationship to Async/Await

| Aspect           | Async/Await                   | Algebraic Effects                         |
| ---------------- | ----------------------------- | ----------------------------------------- |
| Suspension point | `io.await(expr)`              | `effect_op(args)`                         |
| Who resumes      | Event loop (IO completion)    | Handler (calling `return`)                |
| State machine    | Per async function            | Per effectful function chain              |
| Continuation     | Implicit (event loop manages) | Explicit (`return` / `escape` in handler) |
| Thread model     | Single-threaded event loop    | Synchronous (same thread)                 |
| Use cases        | IO concurrency                | Control flow abstraction                  |

Both systems share the same state machine infrastructure (shared analysis in `src/codegen/shared/suspension-analysis.ts` and shared codegen in `src/codegen/shared/suspension-codegen.ts`). See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for the async/await documentation.
