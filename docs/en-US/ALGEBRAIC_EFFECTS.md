# Algebraic Effects and Handlers

## Overview

Yo supports **algebraic effects** — a mechanism for implicit parameter passing and one-shot delimited continuations. The system is built on two features:

1. **Implicit Parameters (`using` / `given`)** — contextual parameter passing, resolved statically and passed at runtime
2. **Effect Handlers (`return` / `unwind`)** — one-shot delimited continuations for control flow effects

The code generation strategy is **evidence passing** — effect handler function pointers are passed as extra C parameters, following the approach described in [Generalized Evidence Passing for Effect Handlers (Xie et al., 2021)](https://xnning.github.io/papers/multip.pdf). All effect types are handled this way, including forall effects (passed as `void*` and cast to typed fn ptr at each call site).

## Design Principles

| Principle                  | Decision                          | Rationale                                                                           |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Explicit over implicit     | **Use `given`**                   | Explicit marking avoids ambiguity, better error messages, follows Scala 3 precedent |
| Evidence passing           | **Always**                        | Fn ptr params eliminate SM overhead; Koka-style flag propagation for unwind         |
| Forall effects             | **void\* cast**                   | `forall` fn ptrs passed as `void*` and cast to typed fn ptr at each call site       |
| One-shot continuations     | **One-shot**                      | Fits RC model, simpler implementation, covers 99% of use cases, `resume` is linear  |
| Static dispatch            | **Impl (static)**                 | Handler is lexically scoped, compiler knows types, zero overhead                    |
| `return`/`unwind` keywords | **One-shot (enforced by syntax)** | `return` and `unwind` must be the last expression — can only appear once            |

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
- `given` bindings are lexically scoped runtime evidence values:
  - exactly one compatible `given` required,
  - zero matches => compile-time error,
  - multiple matches => compile-time ambiguity error (must disambiguate with explicit `using(...)`).
- Function-typed evidence is resolved by **structural type matching** (the function signature must match), not by name. Struct-typed effect records are nominal: use one named `struct(...)` type and import it at every use site.
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

## Effect Handlers (`return` + `unwind`)

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

// Handle the effect — without resume (discarding continuation via `unwind`)
raise_const :: (fn() -> i64)({
  (given(raise) : Raise) = ((msg, msg2) -> {
    println(msg);
    println(msg2);
    unwind(i64(42)); // unwind returns from enclosing function with this value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
});
// Returns 42 — continuation is discarded

// Handle the effect — with resume (invoking continuation via `return`)
raise_resume :: (fn() -> i64)({
  (given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({
    println(msg);
    println(msg2);
    return(i32(42)); // return(value) resumes the continuation with value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
});
// Returns 60 — return(42) continues after the raise call site
```

### Semantics

- An effect operation type is a regular `fn` type whose handler body uses `unwind` or `return` to control the continuation (the compiler detects this automatically).
- When an effect operation is invoked, the handler function is called directly via a function pointer parameter.
- The handler body receives the effect's arguments (e.g., `msg`, `msg2`).
- Inside the handler body:
  - **`return(value)`** — resumes the captured continuation with `value` as the result of the effect call.
  - **`unwind(expr)`** — discards the continuation entirely and returns `expr` from the enclosing function that installed the handler.
- Two handler forms:
  - **Anonymous function handler** (no-resume): `(given(raise) : Raise) = ((msg, msg2) -> { unwind(expr); });`
  - **fn-typed handler** (with resume): `(given(raise) : Raise) = (fn(msg : String, msg2 : String) -> i32)({ return(value); });`
- Continuations are **one-shot** — `return` can be called at most once (syntactically enforced as last expression; runtime double-resume check is planned but not yet implemented).
- Effect operations compose with `using` — the effect is an implicit parameter resolved via `given`.
- **Escape in async context**: When `unwind` is called inside an `io.async` task, the Future is marked as **aborted** (state = -2). Attempting to `io.await` or `io.spawn` on an aborted Future causes a **panic** at runtime. See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md#aborted-futures) for details.

### Effect Coloring / Propagation

Functions are "colored" by the effects they use:

```rust
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(...);

// Any function calling safe_divide must either:
// 1. Handle the effect (provide `given(raise)`)
// 2. Propagate it (add `using(raise : Raise)` to its own signature)

// Option 1: Handle
handler :: (fn() -> i32)({
  given(raise) : Raise = ...;
  safe_divide(10, 0)
});

// Option 2: Propagate
wrapper :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  safe_divide(x, y)
);
```

The `using` parameter with a function type whose handler uses `unwind` is the **sole marker** for whether a function may suspend due to an effect:

| Signature                                           | Role                                   | Code generation strategy         | Callers need transformation?            |
| --------------------------------------------------- | -------------------------------------- | -------------------------------- | --------------------------------------- |
| `fn(..., using(raise : Raise)) -> T`                | **Propagates** the effect              | Evidence passing (fn ptr params) | Only if they also propagate via `using` |
| `fn() -> T` (handles effect internally via `given`) | **Handles** the effect                 | Evidence passing at handler site | **No** — callers see a plain function   |
| `fn(using(f : (fn() -> i32))) -> T`                 | Implicit param (plain `fn`, no unwind) | No — plain parameter             | No                                      |

The handler is the boundary. With evidence passing, intermediate functions simply forward the fn ptr params — no state machine transformation needed.

### How Evidence Passing Works (Brief)

With evidence passing, effect handler functions are passed as **extra C parameters** (function pointers). No state machine is needed:

1. **Effect invocation** (calling `raise(...)`) = fn ptr call through the evidence parameter
2. **`return(value)`** = handler function returns normally; caller uses the value
3. **`escape(expr)`** = handler function sets `__yo_effect_escaped = 1`, stores value in thread-local `__yo_unwind_value`, returns dummy; caller checks flag and propagates

Intermediate functions in the call chain simply forward the fn ptr parameters:

```
handler scope (given(raise) : Raise = handler_fn)
  +-- fn_a(..., raise_ptr)         <-- forwards fn ptr to fn_b
       +-- fn_b(..., raise_ptr)    <-- forwards fn ptr to raise call
            +-- raise_ptr(msg)     <-- direct fn ptr call
```

See [Code Generation: Two Strategies](#code-generation-two-strategies) for the full details.

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
  ) -> unit)({
    i := usize(0);
    while((i < S), {
      callback(arr(i));
      i = (i + 1);
    });
  });

// Set up handlers
(given(yield) : Yield) = (v) -> { return(v); };
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

program :: (fn(using(info : Logger, error : Logger)) -> unit)({
  info("starting");
  error("something went wrong");
});

program(using(info_logger, error_logger));
```

No special language support needed — this falls out of the existing `using`/`given` mechanism.

### Struct-Based Effect Records

Effects can be organized into named `struct(...)` records. This is especially useful for grouping related effect operations:

```rust
MyException :: (fn(comptime(ErrorType) : Type) -> comptime(Type))(
  struct(
    throw : (fn(forall(ResumeType : Type), error : ErrorType, resume_value : ResumeType) -> ResumeType)
  )
);

safe_divide :: (fn(x : i32, y : i32, using(exn : MyException(i32))) -> i32)(
  cond(
    (y == 0) => exn.throw(x, i32(0)),
    true => (x / y)
  )
);

// Install a struct-based handler with `given`:
given(exn) := MyException(i32)(
  throw : ((val, resume_val) -> {
    return(resume_val);  // resume with the provided recovery value
  })
);

result := safe_divide(10, 0);  // handler resumes with 0
```

Struct effect records support:

- **`forall` parameters** in effect operations (e.g., `forall(ResumeType : Type)`)
- **Nested structs** — structs containing other structs with effects
- **Labeled `using(name : EffectStruct)`** — auto-destructuring of struct fields into implicit parameters

### Control Flow with Effects

Effects interact correctly with all control flow constructs inside loops:

```rust
GetValue :: (fn() -> i32);

(given(get_value) : GetValue) = (() -> {
  return(i32(1));
});

// break, continue, and early return all work after effect resume
while(runtime(true), {
  result := get_value();  // effect invocation (suspension point)

  cond(
    (result > 10) => { break; },        // break after effect resume
    (result == 0) => { continue; },     // continue after effect resume
    true => ()
  );
});
```

Effects also work with tagged union `match` arms:

```rust
while(runtime(true), {
  get_value();  // effect invocation

  opt := Option(i32).Some(counter.*);

  val := match(opt,
    .Some(v) => v,
    .None => break    // break inside match arm after effect resume
  );
});
```

### Transitive Effect Propagation

When a function is effect-polymorphic via `forall(...(E))` and contains loops with control flow, evidence passing works correctly inside the function body:

```rust
Yield :: (fn(v : i32) -> i32);

apply_effect :: (fn(forall(...(E)), n : i32, using(...(E))) -> i32)({
  counter := Box(i32)(0);
  result := Box(i32)(0);

  while(runtime((counter.* < n)), {
    counter.* = (counter.* + 1);
    cond(
      (counter.* > i32(3)) => { break; },
      true => ()
    );
  });

  return(counter.*);
});

(given(yield) : Yield) = ((v) -> { return(v); });
result := apply_effect(i32(10));
```

### Handler Functions Are Not Closures

Effect handler functions are compiled as **standalone C functions** — they are not closures. A handler function cannot reference variables from the enclosing scope. This is by design: evidence passing transforms handlers into explicit function pointer parameters, which must be standalone callable functions in C.

```rust
// WRONG — handler references outer variable `threshold`, compile error:
threshold := i32(10);
(given(raise) : Raise) = ((msg) -> {
  unwind((threshold * i32(2)));  // ERROR: threshold is not in scope
});

// CORRECT — pass state as explicit arguments via the effect function itself:
check :: (fn(x : i32, threshold : i32, using(raise : Raise)) -> i32)(
  cond(
    (x > threshold) => raise(`too large`),
    true => x
  )
);
(given(raise) : Raise) = ((msg) -> { unwind(i32(-1)); });
result := check(i32(15), i32(10));
```

If you need the handler to carry state, encode that state as explicit function arguments or store it in a `Box` allocated outside the handler.

### Tests

See `tests/algebraic_effects.test.yo` (57 tests) for comprehensive sync examples covering:

| Category                                       | Tests |
| ---------------------------------------------- | ----- |
| Basic fn-type effects (unwind/resume)          | 4     |
| Direct handler calls (no `using`)              | 2     |
| Nested handlers                                | 2     |
| While loops + effects                          | 6     |
| Multiple fn-type effects                       | 1     |
| Effect propagation (1-level, 2-level, 3-level) | 5     |
| Handler shadowing                              | 2     |
| Effect polymorphism (forall spread)            | 2     |
| Struct effect records                          | 6     |
| Multiple effect row spreads                    | 2     |
| Closures with effects                          | 2     |
| Effect row polymorphism                        | 2     |
| Mixed unwind+return handler                    | 1     |
| Transitive SM (break/continue/return)          | 5     |
| Struct-record forall handlers                  | 5     |
| Option match + effects                         | 3     |
| Struct-record non-unit unwind value            | 1     |
| Multi-member struct effect records             | 1     |
| Multiple struct effect records in scope        | 1     |
| Conditional resume/unwind                      | 1     |
| Recursive functions + effects                  | 2     |
| Effect with enum return type                   | 1     |
| Struct-record effect polymorphism              | 1     |
| Transitive SM + struct effect records          | 1     |

See `tests/async_await.test.yo` (9 async+effects tests) for async integration:

| Scenario                                       | Tests |
| ---------------------------------------------- | ----- |
| Effect resume inside async closure             | 1     |
| Effect resume across multiple yields           | 1     |
| Two effects injected via `io.await`            | 1     |
| Two effects injected via `io.spawn`            | 1     |
| Effect resume in async while loop              | 1     |
| Effect resume in async while loop with break   | 1     |
| Escape via injected effect aborts future       | 1     |
| JoinHandle unwind via spawn-injected effect    | 1     |
| Given handler inside async closure with yields | 1     |

---

## Relationship to Async/Await

| Aspect           | Async/Await                   | Algebraic Effects                         |
| ---------------- | ----------------------------- | ----------------------------------------- |
| Suspension point | `io.await(expr)`              | `effect_op(args)` (fn ptr call)           |
| Who resumes      | Event loop (IO completion)    | Handler (calling `return`)                |
| Code generation  | State machine (always)        | Evidence passing (always)                 |
| Continuation     | Implicit (event loop manages) | Explicit (`return` / `unwind` in handler) |
| Thread model     | Single-threaded event loop    | Synchronous (same thread)                 |
| Use cases        | IO concurrency                | Control flow abstraction, error handling  |

Async/await uses state machine infrastructure (`src/codegen/shared/suspension-analysis.ts`, `src/codegen/shared/suspension-codegen.ts`). Algebraic effects do NOT use state machines — they use evidence passing exclusively. See [ASYNC_AWAIT.md](./ASYNC_AWAIT.md) for the async/await documentation.

---

## Code Generation: Evidence Passing

The compiler generates C code for effect handlers using **evidence passing** — effect handler function pointers are passed as extra C parameters.

**When**: All effect types — struct-based effect records, bare function-type effects, effect row spreads (`...(E)`), and forall effects (via `void*` parameter casting).

**How**: The effect handler function pointer is passed as an extra C parameter. The effectful function calls the handler directly via the fn ptr and checks the `__yo_effect_escaped` flag afterward. Based on [Generalized Evidence Passing for Effect Handlers (Xie et al., 2021)](https://xnning.github.io/papers/multip.pdf).

---

## Evidence Passing (Strategy 1) — Detailed

Evidence passing compiles effect handlers as **ordinary C function pointer parameters**. This eliminates state machines entirely for the effectful function — it becomes a regular C function with extra parameters.

### Key principle: effects ≡ function pointers

At runtime, all effects reduce to function pointers. Struct effect records are evidence records — at the C level, each function field becomes a separate fn ptr parameter:

- `using(exn : Exception)` where `Exception :: struct(throw : fn(...))` → passes the `throw` function pointer
- `using(raise : Raise)` where `Raise :: struct(raise : fn(msg : String) -> i32)` → passes the `raise` function pointer
- `using(raise : (fn(msg : String) -> i32))` → passes `raise` directly as a fn ptr parameter
- `using(...(E))` effect row spread → expanded at specialization time into concrete fn ptr parameters

### Generated C

For a function with struct-record effect:

```rust
safe_divide :: (fn(x : i32, y : i32, using(exn : Exception)) -> i32)(
  cond((y == 0) => exn.throw(Error.new(`div by zero`)), true => (x / y))
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
      return 0;  // dummy — caller propagates unwind
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
3. **From `given` binding** — look up the struct evidence value in the call environment, extract the function field, and use its C name
4. **From async SM capture** — if inside an async state machine, resolve from `sm->__capture.fieldName`

### Escape handling

When a handler calls `unwind`:

1. The handler function sets `__yo_effect_escaped = 1` and returns a dummy value
2. The caller checks `if (__yo_effect_escaped)` after the fn ptr call
3. If set: drops RC-typed arguments, then either:
   - **In sync context**: returns from the enclosing function with a zeroed value
   - **In async SM context**: sets `sm->state = -2` (aborted), drops SM local variables via `memset`+dispose, spawns continuation if exists, and returns

### Resume handling

When a handler calls `return(value)`:

1. The handler function returns `value` normally (does NOT set `__yo_effect_escaped`)
2. The caller receives the return value from the fn ptr call
3. The `if (__yo_effect_escaped)` check passes (flag is 0)
4. The caller uses the return value as the result of the effect invocation

This is the simplest path — no state machine, no yield/resume protocol. The handler is just a function call.

### Mixed unwind+return handlers

A handler may `return` in one branch and `unwind` in another:

```rust
given(raise_mod) := Raise(
  raise : (msg) -> cond(
    (msg == `recoverable`) => return(i32(0)), // resume with 0
    true => unwind(i32(-1))                   // unwind with -1
  )
);
```

Both paths work correctly:

- **Return path**: the fn ptr returns normally; `__yo_effect_escaped` stays 0; caller uses the resume value
- **Escape path**: the fn ptr sets `__yo_effect_escaped = 1` and returns dummy; caller checks and propagates

### Forall evidence specialization

When an effect operation has `forall` parameters (e.g., `throw :: (fn(forall(T : Type), msg : str, resume_val : T) -> T)`), C cannot represent the function pointer directly since C has no parametric polymorphism. Evidence passing handles this via **`void*` casting**:

1. **Evidence parameter type**: The evidence parameter for a forall function is `void*` (opaque pointer)
2. **Handler passed as `void*`**: At the handler installation site, the specialized handler is cast to `void*`: `(void*)handler_specialized_cname`
3. **Cast at call site**: Each call site casts the `void*` back to the concrete function pointer type needed: `((int32_t(*)(char*, int32_t))evidence_ptr)(msg, resume_val)`
4. **Specialization**: The evaluator creates specialized handler versions via `evaluateCtlFunctionBodyInline`, which produces both a specialized function body and a `specializedType` with forall parameters substituted
5. **Collection**: Specialized handler versions (stored in `specializedFunctionCaches`) are collected alongside the original handler in `collection.ts`

**Example — forall effect with resume:**

```rust
Throw :: (fn(forall(T : Type), msg : str, resume_val : T) -> T);

safe_divide :: (fn(x : i32, y : i32, using(throw : Throw)) -> i32)(
  cond((y == 0) => throw(`div by zero`, 0), true => (x / y))
);
```

Generated C:

```c
// Evidence param is void* (forall fn ptr)
int32_t safe_divide(int32_t x, int32_t y, void* throw) {
  if (y == 0) {
    __yo_effect_escaped = 0;
    // Cast void* to concrete fn ptr type at call site
    int32_t result = ((int32_t(*)(__yo_string, int32_t))throw)(msg, 0);
    if (__yo_effect_escaped) return 0;
    return result;
  }
  return x / y;
}
```

**Forall-only fallback condition**: When a function has a `specializedType` that strips implicit parameters, the compiler only falls back to the original type's evidence params if they contain forall function types (`ep.fieldFunctionType.forallParameters.length > 0`). Non-forall `using` params (contextual parameters) are resolved at specialization time and don't need evidence passing.

**Additional behaviors:**

- **Handler doesn't use the forall type** (e.g., `unwind()`): the unspecialized function is generated and passed directly
- **Transitive forwarding**: the `void*` evidence is forwarded as-is between callers and callees

### Escape value propagation

Escape values (including non-unit values) are propagated via the thread-local `__yo_escape_value` mechanism. When `unwind(expr)` is called inside a handler, the unwind value is stored in a thread-local and can be retrieved at the handler installation site (`given`).

---

## Overhead Analysis

### Per-Call-Site Overhead (Happy Path — No Escape)

Each effect call site adds exactly three operations:

| Operation                          | Cost    | Notes                                                       |
| ---------------------------------- | ------- | ----------------------------------------------------------- |
| `__yo_effect_escaped = 0` (reset)  | ~1-2 ns | Thread-local store                                          |
| Indirect call via fn ptr           | ~2-5 ns | vs ~1 ns for direct call; well-predicted after warm-up      |
| `if (__yo_effect_escaped)` (check) | ~1-2 ns | Thread-local load + branch (always not-taken on happy path) |

**Total happy-path overhead: ~4-9 ns per effect call site.**

The unwind branch is never taken on the happy path, so the CPU branch predictor learns this quickly and the check amortizes to near-zero.

### Per-Call-Site Overhead (Escape Path)

When an unwind occurs:

| Step                                              | Cost               |
| ------------------------------------------------- | ------------------ |
| Handler sets `__yo_effect_escaped = 1`            | ~1 ns              |
| Handler stores value via `memcpy` (≤64 bytes)     | ~5-20 ns           |
| Each transitive caller checks flag + drops locals | ~5-10 ns per level |
| Installation site extracts value via `memcpy`     | ~5-20 ns           |

**Total: ~15-50 ns + ~5-10 ns per transitive call level.**

Escape is the exceptional path and replaces what would otherwise be `longjmp`, `throw`, or an equivalent mechanism.

### Extra C Parameters

Each `using(name : EffectType)` in a function signature adds:

- **Function-type effect**: 1 pointer parameter (8 bytes on x86-64/ARM64)
- **Struct-record effect**: 1 pointer per effect record member function
- **Nested struct effect record**: flattened — 1 pointer per leaf function

Parameters are passed in registers (up to 6 on x86-64 SysV, 8 on ARM64), so most single-effect functions pay zero stack overhead.

### Thread-Local Storage

Two thread-local variables are used globally:

```c
static _Thread_local int __yo_effect_escaped = 0;                     // 4 bytes
static _Thread_local _Alignas(16) char __yo_unwind_value[64];  // 64 bytes
```

TLS access latency by platform:

- **Linux (ELF)**: `%fs`-relative — 1 instruction, ~1 ns
- **macOS (Mach-O)**: `__thread` — ~2-3 ns
- **Windows**: `__declspec(thread)` — ~1-2 ns

No locks or atomic operations are needed — effects are single-threaded (within an event loop task).

### Code Size per Call Site

| Component                        | Size             |
| -------------------------------- | ---------------- |
| Flag reset instruction           | ~4-8 bytes       |
| Flag check + conditional branch  | ~8-12 bytes      |
| Escape cleanup block (cold path) | ~20-50 bytes     |
| **Total per call site**          | **~30-70 bytes** |

### Comparison with Alternatives

| Approach                  | Happy-path overhead          | Escape/throw overhead | Code size         | Async-safe |
| ------------------------- | ---------------------------- | --------------------- | ----------------- | ---------- |
| **Evidence passing (Yo)** | ~4-9 ns per call site        | ~15-50 ns             | +30-70 B/site     | ✅ Yes     |
| `setjmp`/`longjmp`        | ~5-15 ns at handler install¹ | ~5-15 ns (longjmp)    | +20-40 B/site     | ❌ No      |
| C++ zero-cost exceptions  | ~0 ns                        | ~1000-5000 ns         | Large `.eh_frame` | ❌ No      |
| Koka evidence vectors     | ~3-5 ns per call site        | ~10-30 ns             | Similar           | ✅ Yes     |
| OCaml 5 fibers            | ~0 ns (native)               | ~50-200 ns            | Runtime overhead  | ✅ Yes     |

¹ `setjmp` always pays its setup cost (~5-15 ns) at the handler installation point even when no unwind ever occurs.

**Happy path** — Evidence passing wins: it pays ~4-9 ns only at actual effect call sites, with zero cost at handler installation. `setjmp` always pays ~5-15 ns at installation regardless of whether effects fire.

**Escape path** — `longjmp` (~5-15 ns) is faster than evidence passing (~15-50 ns) for a single unwind. The tradeoff: evidence passing supports async-safe composability and doesn't prevent compiler optimizations around the protected region, while `setjmp`/`longjmp` disables many optimizations.

**Amortized** — When effects are called N times per `given` installation, evidence passing total cost is `N × 4-9 ns`, vs `setjmp` total is `5-15 ns + escape_count × 5-15 ns`. For N > ~2 effect calls with no escapes, evidence passing is cheaper overall.

---

## Reference

- [Generalized Evidence Passing for Effect Handlers
  ](https://xnning.github.io/papers/multip.pdf)
