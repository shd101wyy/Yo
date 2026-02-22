# Algebraic Effects for Yo

## Overview

This plan describes how to add **algebraic effects** to the Yo language in two phases:

1. **Phase 1: Implicit Parameters** — `using` and `given` keywords for contextual parameter passing
2. **Phase 2: Effect Handlers** — effectful operations with `resume` and `abort` (one-shot delimited continuations)

Both phases build on Yo's existing async/await state machine infrastructure.

## Current Status (2026-02-21)

- ✅ **Phase 1 (using/given)** — fully implemented and tested.
- ✅ **Phase 2 (handlers / return + abort)** — fully implemented and tested.
- ✅ **Effect polymorphism** — `...(E)` effect row spreads in `forall`/`using` implemented and tested.
- ✅ **29 tests passing** with AddressSanitizer (no memory leaks or use-after-free).
- ⏳ **Remaining:** One-shot runtime enforcement (double-resume check), async/await unification.

---

## Design Decisions (Resolved)

| Question                          | Decision                          | Rationale                                                                                 |
| --------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- |
| `given` vs. auto-resolve from env | **Use `given`**                   | Explicit marking avoids ambiguity, better error messages, follows Scala 3 precedent       |
| State machine for effects?        | **Yes**                           | Same architecture as async/await — effect invocation = suspension point                   |
| Transform callers too?            | **Yes**                           | All functions in the "effect scope" (between handler and effect site) must be transformed |
| One-shot vs. multi-shot           | **One-shot**                      | Fits RC model, simpler implementation, covers 99% of use cases, `resume` is linear        |
| `resume` dispatch                 | **Impl (static)**                 | Handler is lexically scoped, compiler knows types, zero overhead                          |
| `return` semantics                | **One-shot (enforced by syntax)** | `return` and `abort` are keywords that must be the last expression — can only appear once |
| `ctl` keyword                     | **Removed**                       | Effect handler status inferred from `abort` usage; no separate keyword needed             |

---

## Phase 1: Implicit Parameters (`using` / `given`)

### 1.1 Syntax

```yo
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

// Alternative `given` form with `:` binding
(given(my_add2) : (fn(x : i32, y : i32) -> i32)) =
  (x, y) -> (x + y)
;

// Calling — implicit parameter resolved automatically
result := add_numbers(3, 4);  // resolves add_fn = my_add

// Calling — explicit contextual argument
result2 := add_numbers(5, 6, using(my_add));

// Calling — explicitly skip provided contextual arg and fallback to `given` lookup
result3 := add_numbers(7, 8, using(undefined));
```

### 1.2 Semantics

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

### 1.3 Implementation ✅

**Step 1: Keywords and type model** — `src/expr.ts`, `src/types/definitions.ts`, `src/types/creators.ts`, `src/env.ts`

- Added `using` and `given` built-in keywords.
- Extended function parameter model: `FunctionParameter.isImplicit`, `FunctionImplicitParameter`, `FunctionType.implicitParameters`.
- Extended env variable model with `Variable.isImplicit`.

**Step 2: Function type evaluation** — `src/evaluator/types/function.ts`

- Dedicated `using` pass in function parameter processing.
- Enforced exactly one `using(...)` clause in function signatures.

**Step 3: `given(...)` declarations** — `src/evaluator/exprs/initialization-assignment.ts`, `src/evaluator/exprs/binding.ts`

- `given(name) := value` and `(given(name) : Type) = value` forms.
- `given` variables stored as compile-time values with `isImplicit: true`.

**Step 4: Call-site resolution** — `src/evaluator/calls/helper.ts`

- Explicit contextual args via `using(...)`, `using(undefined)` fallback.
- Resolves missing contextual args from `given` variables by type compatibility.
- Fixed `forall + using` bug by re-evaluating implicit parameter types in current callee env.

**Step 5: Codegen and specialization** — `src/codegen/exprs/initialization-assignment.ts`, `src/types/guards.ts`, `src/evaluator/context.ts`, `src/types/utils.ts`

- `given(...)` assignments skipped in runtime codegen (compile-time only).
- Implicit args included in specialization signature/cache inputs.

**Step 6: Tests** — `tests/fn.test.yo`

- Basic implicit lookup, explicit `using(...)`, `using(undefined)` fallback, multiple implicit params, ambiguous `given` error, no matching `given` error, `forall + using` inference.

---

## Phase 2: Effect Handlers (`return` + `abort`)

### 2.1 Syntax

```yo
// Define an effect operation (multi-parameter supported)
// Effect handlers are regular `fn` functions whose body uses `abort` or `return`
Raise :: (fn(forall(T : Type), msg : String, msg2 : String) -> T);

// Use an effect in a function (effect becomes an implicit parameter)
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`, `I don't like it`),
    true => (x / y)
  )
);

// Handle the effect — without resume (discarding continuation via `abort`)
raise_const :: (fn() -> i64) {
  (given(raise) : Raise) = ((msg, msg2) -> {
    println(msg);
    println(msg2);
    abort i64(42); // abort returns from enclosing function with this value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
};
// Returns 42 — continuation is discarded

// Handle the effect — with resume (invoking continuation via `return`)
raise_resume :: (fn() -> i64) {
  (given(raise) : Raise) = (fn(forall(T : Type), msg : String, msg2 : String) -> T)({
    println(msg);
    println(msg2);
    return i32(42); // return(value) resumes the continuation with value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
};
// Returns 60 — return(42) continues after the raise call site
```

### 2.2 Semantics

- An effect operation type is a regular `fn` type whose handler body uses `abort` or `return` to control the continuation (the compiler detects this automatically).
- When an effect operation is invoked, execution is **suspended** at that point. A continuation (the rest of the computation up to the handler) is captured as a stack-allocated state machine.
- The handler body receives the effect's arguments (e.g., `msg`, `msg2`).
- Inside the handler body:
  - **`return(value)`** — resumes the captured continuation with `value` as the result of the effect call.
  - **`abort expr`** — discards the continuation entirely and returns `expr` from the enclosing function that installed the handler.
- Two handler forms:
  - **Anonymous function handler** (no-resume): `(given(raise) : Raise) = ((msg, msg2) -> { abort expr; });`
  - **fn-typed handler** (with resume): `(given(raise) : Raise) = (fn(...) -> T)({ return(value); });`
- Continuations are **one-shot** — `return` can be called at most once (syntactically enforced as last expression; runtime double-resume check is planned but not yet implemented).
- Effect operations compose with `using` — the effect is an implicit parameter resolved via `given`.

### 2.3 Effect Coloring / Propagation

Functions are "colored" by the effects they use:

```yo
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

The `using` parameter with a function type whose handler uses `abort` is the **sole marker** for whether a function may suspend due to an effect:

| Signature                                           | Role                                  | Needs state machine?          | Callers need transformation?            |
| --------------------------------------------------- | ------------------------------------- | ----------------------------- | --------------------------------------- |
| `fn(..., using(raise : Raise)) -> T`                | **Propagates** the effect             | Yes (within a handler scope)  | Only if they also propagate via `using` |
| `fn() -> T` (handles effect internally via `given`) | **Handles** the effect                | Internally yes, externally no | **No** — callers see a plain function   |
| `fn(using(f : (fn() -> i32))) -> T`                 | Implicit param (plain `fn`, no abort) | No                            | No                                      |

The handler is the boundary. The state machine transformation is scoped to the region **between** the `given` handler site and the `ctl` invocation site.

### 2.4 State Machine Transformation

The effect system reuses Yo's async/await state machine architecture:

1. **Effect site** (calling `raise(...)`) = suspension point (like `await`).
2. **Handler scope** = event loop (like `async { ... }`).
3. **`return(value)`** = continuation resume. **`abort expr`** = continuation discard.

Every function in the call chain between the handler and the effect site becomes a state machine:

```
handler scope (given(raise) : Raise = ...)
  +-- fn_a(...)                    <-- state machine
       +-- fn_b(...)               <-- state machine
            +-- raise(msg)         <-- suspension point (effect invocation)
```

The state machine struct includes: `state`, `completed`, `result`, `yield_0..N` (effect arguments), function parameters, and captured variables that cross suspension points.

### 2.5 Effect Polymorphism (`...(E)` Row Spreads) ✅

Effect row variables are declared with `...(Name)` inside `forall`. Named rows allow **independent effect sets** (like Koka's `e1 e2`).

```yo
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

Semantics:

- `...(E)` in `forall(...)` declares **E as an effect row variable** — ranging over sets of implicit parameters.
- `...(E)` in `using(...)` **spreads** the effect row's bound parameters into implicit parameters.
- Type unification: calling `run(might_fail)` where `might_fail : fn(using(raise : Raise)) -> i32` unifies `T = i32`, `E = (raise : Raise)`.
- Two rows: `...(E1)` and `...(E2)` are inferred independently from their respective function parameters; `using(...(E1), ...(E2))` is their union.

Type compatibility rules:

| Expected                            | Given                             | Compatible?                       |
| ----------------------------------- | --------------------------------- | --------------------------------- |
| `fn(using(...(E))) -> T`            | `fn(using(raise : Raise)) -> i32` | ✅ E = `(raise : Raise)`, T = i32 |
| `fn(using(...(E))) -> T`            | `fn() -> i32`                     | ✅ E = empty, T = i32             |
| `fn(using(r : Raise, ...(E))) -> T` | `fn(using(r : Raise)) -> i32`     | ✅ named param matches, E = empty |
| `fn(using(r : Raise)) -> T`         | `fn(using(l : Log)) -> i32`       | ❌ named params don't match       |

### 2.6 Named Effect Instances

Multiple instances of the same effect type are supported via explicit `using(...)` at call sites:

```yo
Logger :: (fn(msg : String) -> unit);

program :: (fn(using(info : Logger, error : Logger)) -> unit) {
  info("starting");
  error("something went wrong");
};

program(using(info_logger, error_logger));
```

No special language support needed — this falls out of the existing `using`/`given` mechanism.

### 2.7 Implementation ✅

**Step 1: Effect type** — `src/lexer.ts`, `src/parser.ts`, evaluator

- Effect operation types are regular `fn` types. The compiler infers `isControlFunction` when the function body uses `abort` (checked after body evaluation).
- No separate `ctl` keyword — effect handler status is a property of the function value, not its type declaration.

**Step 2: Effect analysis pass** — `src/evaluator/effects/effect-analysis.ts`

- Walks AST of effectful functions to identify effect call points and capture variables across suspension points.
- Determines which functions in the call chain need state machine transformation.
- Supports module-based effects via `effectFieldPath` for `using(ModuleType)` auto-destructuring.

**Step 3: State machine generation** — `src/codegen/effects/effect-state-machine.ts`

- SM struct generation, resume function with switch/case, call site generation, handler body inlining.
- Closure support: SM struct includes `void* closure_context`; closure-captured variables excluded from SM struct (accessed via context pointer).
- Multi-effect SM architecture for functions using multiple effect types.

**Step 4: Handler codegen** — `src/codegen/exprs/generation.ts`, `src/codegen/exprs/other-fn-call.ts`

- Abort handlers: `abort expr` generates pending deferred drops + return from enclosing function.
- Resume handlers: `return(value)` resumes continuation via SM resume function.
- Direct effect call in handler scope (no intermediate `using` function) — both abort and resume paths.
- `handlerBodyContainsExplicitReturn()` guard prevents implicit resume for handlers with explicit `return(value)`.

**Step 5: RC correctness**

- SM arguments passed without dup (ownership transferred). `effectSmConsumedArgCNames` tracks consumed args to prevent double-free in `generatePendingDeferredDrops`.
- `pendingDeferredDrops` cleared during handler body codegen to avoid dropping caller-scope variables.
- Applied to SM call sites, multi-effect call sites, and direct effect calls.

**Step 6: Effect polymorphism** — `src/evaluator/types/function.ts`, `src/evaluator/types/synthesizer.ts`, `src/evaluator/calls/helper.ts`, `src/types/`

- `...(E)` in `forall` creates `EffectsRow` SomeType; `...(E)` in `using` stored with `isEffectRowSpread: true`.
- Type synthesis matches named params first, then binds row variable to remainder.
- Call site resolution looks up each bound `FunctionImplicitParameter[]` from callee env.

**Step 7: Integration with using/given**

- `using(raise : Raise)` makes the effect an implicit parameter resolved via `given`.
- `using` params marked `isImplicit` in env for automatic nested resolution.
- Fn trait types support `using()` implicit parameters: `Fn(v: i32, using(log: Log)) -> i32`.
- Anonymous function `=>` syntax parses `using()` parameters.
- `using(ModuleType)` auto-destructuring with `isModuleDestructured` flag.

**Step 8: Tests** — `tests/algebraic_effects.test.yo` (29 tests)

- Basic abort and resume via `using` parameter ✅
- Direct effect abort/resume without intermediate `using` function ✅
- Nested effect abort/resume inside resume handler ✅
- While loop with effect resume (basic, break, continue, mixed continue-then-break) ✅
- Break from cond after effect resume ✅
- Break drops local allocations after effect resume ✅
- Early return inside loop after effect resume ✅
- Two different effect types in same scope (Log + Raise) ✅
- Single-level and two-level effect propagation via `using` ✅
- Given variable shadowing (resume and abort variants) ✅
- Effect polymorphism with `using` spread (resume and abort) ✅
- Module-based effect with abort/resume ✅
- Nested module-based effect with abort/resume ✅
- Module destructured `using(ModuleType)` with abort/resume ✅
- Multiple effect row spreads with resume/abort ✅
- Closure with `using()` effect — resume and abort ✅

---

## Phase 3: Future Work

### 3.1 Async/Await Unification via Async Effect

Async/await can be reimplemented as an algebraic effect, unifying the two systems:

```yo
Async :: (fn(forall(T : Type), future : Future(T)) -> T);
// await = invoking the Async effect
// event loop = handler for Async effect
```

This would eliminate the separate async/await state machine infrastructure and allow user-defined async runtimes via custom Async effect handlers.

### 3.2 One-Shot Runtime Enforcement

Currently one-shot is enforced syntactically (`return` and `abort` must be the last expression). A runtime check for double-resume (calling `return` twice on the same continuation) is planned but not yet implemented.

### 3.3 Optimization: Static Effect Resolution

When the handler and effect site are in the same compilation unit, the compiler could **inline** the effect handling:

- **No-resume handlers**: eliminate the state machine, compile to a simple jump/return.
- **Always-resume handlers**: optimize to a direct function call with inline result wrapping.
- **Known handler at compile time**: monomorphize the entire effect chain.

---

## Relationship to Existing Async/Await

| Aspect           | Async/Await                   | Algebraic Effects                        |
| ---------------- | ----------------------------- | ---------------------------------------- |
| Suspension point | `await expr`                  | `effect_op(args)`                        |
| Who resumes      | Event loop (IO completion)    | Handler (calling `return`)               |
| State machine    | Per async function            | Per effectful function chain             |
| Continuation     | Implicit (event loop manages) | Explicit (`return` / `abort` in handler) |
| Thread model     | Single-threaded event loop    | Synchronous (same thread)                |
| Use cases        | IO concurrency                | Control flow abstraction                 |

For now, async/await and effects coexist independently, sharing similar state machine infrastructure patterns. See Phase 3.1 for planned unification.

---

## Risk Assessment

| Risk                                | Severity | Mitigation                                                                     |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------ |
| State machine complexity            | High     | Reuse async/await infrastructure, start with no-resume case                    |
| RC leaks in discarded continuations | Medium   | Comprehensive drop generation, test with `--sanitize address`                  |
| Compilation time increase           | Medium   | Only transform functions that actually use effects                             |
| Effect coloring ergonomics          | Low      | Explicit `using` is preferred — no inference planned                           |
| Interaction with existing features  | Medium   | Test combinations: effects + closures, effects + generics, effects + ownership |

---

## Success Criteria

1. ✅ `using` + `given` works for plain function types (Phase 1).
2. ✅ Effects with no-resume handlers work (exception-like usage via `abort`).
3. ✅ Effects with resume handlers work (continuation-like usage via `return`).
4. ✅ No memory leaks detected by AddressSanitizer in all effect scenarios.
5. ✅ Nested effects, effect propagation, and effect polymorphism work correctly.
6. ✅ One-shot enforcement: `return` and `abort` are keywords, syntactically enforced as last expression.
7. ✅ Closures with `using()` effect parameters work (both resume and abort).
8. Performance: no overhead for functions that don't use effects.
