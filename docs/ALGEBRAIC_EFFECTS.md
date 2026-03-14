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
| State machine    | Per async function            | Only for SM-inlined effects (see below)   |
| Continuation     | Implicit (event loop manages) | Explicit (`return` / `escape` in handler) |
| Thread model     | Single-threaded event loop    | Synchronous (same thread)                 |
| Use cases        | IO concurrency                | Control flow abstraction, error handling  |

Both systems share the same state machine infrastructure (shared analysis in `src/codegen/shared/suspension-analysis.ts` and shared codegen in `src/codegen/shared/suspension-codegen.ts`). See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for the async/await documentation.

---

## Code Generation: Two Strategies

The compiler uses **two distinct strategies** for generating C code for effect handlers. The strategy is chosen per-function based on the effect's type.

### Strategy 1: Evidence Passing (preferred)

**When**: Module-based effects where the module has function-typed fields that can be represented as C function pointer parameters. This covers the common case — e.g., `Exception`, `Raise`, `Log`.

**How**: The effect handler function pointer is passed as an extra C parameter. No state machine is needed. The effectful function calls the handler directly via the fn ptr and checks the `__yo_effect_escaped` flag afterward.

### Strategy 2: SM-Inlining (fallback)

**When**: Evidence passing cannot be used:

- **Bare function-type effects** (e.g., `using(raise : (fn(msg : String) -> i32))` — not wrapped in a module)
- **Module effects where all functions have `forall` params** (e.g., `throw : (fn(forall(ResumeType : Type), ...) -> ResumeType)` — forall function pointers cannot be typed as C fn ptrs)
- **Effects inside non-module constructs**

**How**: The effectful function is compiled into a **state machine** struct. Effect invocation becomes a yield point — the SM pauses, yields the effect arguments, and the handler loop at the call site receives them, runs the handler body, and either resumes (setting `resume_value` and calling resume) or escapes.

### Decision flow

```
Function has using(effect : EffectType)?
  │
  ├── EffectType is a module with function fields?
  │     ├── getEvidenceParameters() returns params? ──→ EVIDENCE PASSING
  │     │   (module has non-forall function fields)
  │     │
  │     └── No evidence params? ──→ SM-INLINING
  │         (all functions have forall params)
  │
  └── EffectType is a bare function type? ──→ SM-INLINING
```

---

## Evidence Passing (Strategy 1) — Detailed

Evidence passing compiles effect handlers as **ordinary C function pointer parameters**. This eliminates state machines entirely for the effectful function — it becomes a regular C function with extra parameters.

### Key principle: modules ≡ collections of functions

A module is a **compile-time** construct — just a named collection of functions. At runtime, only function pointers exist:

- `using(exn : Exception)` where `Exception :: module(throw : fn(...))` → passes the `throw` function pointer
- `using(raise : Raise)` where `Raise :: module(raise : fn(msg : String) -> i32)` → passes the `raise` function pointer

### Generated C

For a function with module effect:

```yo
safe_divide :: (fn(x : i32, y : i32, using(exn : Exception)) -> i32)(
  cond(y == 0 => exn.throw(Error.new(`div by zero`)), true => (x / y))
);
```

The compiler generates:

```c
// Evidence parameter: throw fn ptr passed as void* (forall func)
// or typed fn ptr (non-forall func)
int32_t safe_divide(int32_t x, int32_t y, void* exn__throw) {
  if (y == 0) {
    __yo_effect_escaped = 0;
    int32_t result = ((int32_t(*)(AnyError*))exn__throw)(error_obj);
    if (__yo_effect_escaped) {
      return 0;  // dummy — caller propagates escape
    }
    return result;  // handler resumed with this value
  }
  return x / y;
}
```

### Evidence argument resolution

At each call site, the compiler resolves evidence arguments in this order:

1. **Transitive forwarding** — if the caller has matching evidence params, forward them directly
2. **From effect analysis** — if the call site has a handler (`given` binding with handler info), use the handler's C function address
3. **From `given` binding** — look up the module value in the call environment, extract the function field, and use its C name
4. **From async SM capture** — if inside an async state machine, resolve from `sm->__capture.fieldName`

### Escape handling

When a handler calls `escape`:

1. The handler function sets `__yo_effect_escaped = 1` and returns a dummy value
2. The caller checks `if (__yo_effect_escaped)` after the fn ptr call
3. If set: drops RC-typed arguments, then either:
   - **In sync context**: returns from the enclosing function with a zeroed value
   - **In async SM context**: sets `sm->state = -2` (aborted), drops SM local variables via `memset`+dispose, spawns continuation if exists, and returns

### Resume handling

When a handler calls `return value`:

1. The handler function returns `value` normally (does NOT set `__yo_effect_escaped`)
2. The caller receives the return value from the fn ptr call
3. The `if (__yo_effect_escaped)` check passes (flag is 0)
4. The caller uses the return value as the result of the effect invocation

This is the simplest path — no state machine, no yield/resume protocol. The handler is just a function call.

### Mixed escape+return handlers

A handler may `return` in one branch and `escape` in another:

```yo
given(raise_mod) := Raise(
  raise : (msg) -> cond(
    (msg == `recoverable`) => return i32(0),  // resume with 0
    true => escape i32(-1)                    // escape with -1
  )
);
```

Both paths work correctly:

- **Return path**: the fn ptr returns normally; `__yo_effect_escaped` stays 0; caller uses the resume value
- **Escape path**: the fn ptr sets `__yo_effect_escaped = 1` and returns dummy; caller checks and propagates

### Forall evidence specialization

When a module effect operation has `forall` parameters (e.g., `throw : (fn(forall(ResumeType : Type), ...) -> ResumeType)`), the handler function may be **specialized** by the evaluator — producing only type-specific versions (e.g., `throw_i32`) with no unspecialized C function.

Evidence passing handles this transparently:

- **Handler doesn't use the forall type** (e.g., `escape ()`): the unspecialized function is generated and passed directly.
- **Handler uses the forall type** (e.g., `return resume_val`): the function is specialized. Evidence resolution passes a specialized version cast to `void*` (since the evidence parameter type for forall functions is `void*`).
- **Transitive forwarding**: the `void*` evidence is forwarded as-is between callers and callees. Each callee resolves the forall call to its own specialized function directly, independent of the evidence value.

### Escape value propagation

Escape values (including non-unit values) are propagated via the thread-local `__yo_escape_value` mechanism. When `escape expr` is called inside a handler, the escape value is stored in a thread-local and can be retrieved at the handler installation site (`given`).

---

## SM-Inlining (Strategy 2) — Detailed

SM-inlining is the original effect system. It transforms the effectful function into a **state machine** and inlines the handler at the call site in a driver loop.

### When SM-inlining is used

- Bare function-type effects: `using(raise : (fn(msg : String) -> i32))`
- Module effects with only forall functions (no evidence params possible)
- Effects with `...(E)` spread in certain configurations

### State machine struct

```c
typedef struct safe_divide_sm {
  int state;                    // current state (-2=aborted, -1=complete, 0..N=running)
  int completed;                // 1 when function finished
  int32_t result;               // return value (if non-void)

  // Yielded effect arguments
  char* yield_0;                // first arg to handler (e.g., error message)

  // Resume value from handler
  int32_t resume_value;         // value passed back via `return`

  // Function parameters
  int32_t param_x, param_y;

  // Captured local variables crossing yield points
  int32_t var_temp;

  // Nested SM for transitive calls
  inner_sm_struct _inner_sm_0;
} safe_divide_sm;
```

### Resume function

The effectful function body is split at yield points into a switch-case state machine:

```c
void safe_divide_resume(safe_divide_sm* sm) {
  switch (sm->state) {
    case 0: {
      // Run body until effect invocation
      if (sm->param_y == 0) {
        sm->yield_0 = "div by zero";  // yield effect arg
        sm->state = 1;                // next state after resume
        return;                       // suspend
      }
      sm->result = sm->param_x / sm->param_y;
      sm->completed = 1;
      return;
    }
    case 1: {
      // Resumed from handler — sm->resume_value has handler's return
      sm->result = sm->resume_value;
      sm->completed = 1;
      return;
    }
  }
}
```

### Call site with inlined handler

At the call site where the handler is installed:

```c
// Escape handler (discards continuation)
{
  safe_divide_sm sm = {0};
  sm.param_x = 10; sm.param_y = 0;
  safe_divide_resume(&sm);

  while (!sm.completed) {
    // Handler body inlined here:
    printf("Error: %s\n", sm.yield_0);
    __yo_effect_escaped = 1;   // escape
    goto handler_exit;         // exit enclosing function
  }
  result = sm.result;
}
```

```c
// Resume handler (continues computation)
{
  safe_divide_sm sm = {0};
  sm.param_x = 10; sm.param_y = 0;
  safe_divide_resume(&sm);

  while (!sm.completed) {
    // Handler body inlined here:
    printf("Recovering from: %s\n", sm.yield_0);
    sm.resume_value = 42;       // resume with 42
    safe_divide_resume(&sm);    // drive SM to next state
  }
  result = sm.result;           // final result from SM
}
```

### Transitive effects

When a function calls another effectful function (transitive propagation), the inner function's SM is nested inside the outer function's SM struct as `_inner_sm_0`, `_inner_sm_1`, etc. The outer SM's resume function drives the inner SM and propagates yields/resumes.

---

## Relationship Between Strategies

The two strategies produce identical observable behavior — the choice is purely an optimization:

| Property                 | Evidence Passing           | SM-Inlining                |
| ------------------------ | -------------------------- | -------------------------- |
| State machine generated  | No                         | Yes                        |
| Handler dispatched via   | Function pointer call      | Inlined at call site       |
| Resume mechanism         | Direct return value        | `sm.resume_value` + resume |
| Escape mechanism         | `__yo_effect_escaped` flag | `__yo_effect_escaped` flag |
| Overhead                 | One indirect call          | SM struct + switch/case    |
| Supports forall effects  | No (uses `void*` param)    | Yes (type-specific inline) |
| Supports bare fn effects | No (needs module wrapper)  | Yes                        |
| Composable/transitive    | Yes (param forwarding)     | Yes (nested SM)            |

The compiler prefers evidence passing when possible because it generates simpler, faster C code with no state machine overhead.

See `issues/sync-effect-inlining-inside-async-context.md` for the full design rationale and `.github/instructions/c-codegen.instructions.md` for codegen conventions.

## Reference

- [Generalized Evidence Passing for Effect Handlers
  ](https://xnning.github.io/papers/multip.pdf)
