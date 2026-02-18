# Algebraic Effects Implementation Plan for Yo

## Overview

This plan describes how to add **algebraic effects** to the Yo language in two phases:

1. **Phase 1: Implicit Parameters** — `using` and `given` keywords for contextual parameter passing
2. **Phase 2: Effect Handlers** — `ctl` keyword for effectful operations with `resume` (one-shot delimited continuations)

Both phases build on Yo's existing async/await state machine infrastructure.

## Current Status (2026-02-15)

- ✅ **Phase 1 (using/given)** is implemented and passing tests.
- ✅ Supports:
  - implicit contextual parameter declaration via `using(...)`
  - contextual values via `given(name) := ...` and `(given(name) : Type) = ...`
  - explicit contextual args via `using(...)` at call site
  - explicit skip/fallback via `using(undefined)`
  - generic `forall + using` inference in calls like `apply(41)`
- ✅ Enforces exactly one `using(...)` clause in function signature and one `using(...)` in call arguments.
- ✅ **Phase 2 (`ctl` / handlers / `return` + `abort`)** is implemented and passing tests.
- ✅ Phase 2 supports:
  - `ctl` keyword for effect operation types: `Raise :: (ctl(forall(T : Type), msg : String) -> T)`
  - Multi-parameter ctl operations: `ctl(forall(T : Type), msg : String, msg2 : String) -> T`
  - Using `ctl` effects in functions via `using(raise : Raise)` implicit parameter
  - **Resume handlers** (invoke continuation): `return(value)` inside handler body resumes the continuation with `value`
  - **Abort handlers** (discard continuation): `abort expr` inside handler body discards the continuation and returns `expr` from the enclosing function
  - Handler body may contain arbitrary function calls (e.g., `println(msg)`)
  - `forall` type parameters in ctl types with concrete type inference at call sites
  - Effect analysis pass (detecting ctl call points and capturing variables across suspension points)
  - Stack-allocated state machine generation (no RC needed — effects are synchronous one-shot)
  - Handler body inlining at call sites
  - Proper RC drop of handler parameters before abort return
  - `abort` control flow handling in `cond`, `match`, and `while` expressions
  - **Direct ctl call in handler scope** (no intermediate `using` function): `raise(...)` can be called directly in the same scope as the `given` binding, without an intermediate `fn(..., using(raise : Raise))` wrapper. The handler body is evaluated lazily with concrete types inferred from the enclosing function's return type, and the call is inlined at the call site.
  - All tests passing with AddressSanitizer (no memory leaks)
- ⏳ **Phase 2 remaining work:**
  - Nested effects (multiple ctl operations in same function body)
  - Effect propagation through call chains (caller also needs SM transformation)
  - Multiple effect types in same function
  - Runtime one-shot enforcement (double `return` detection)
  - Interaction with closures and async/await

---

## Design Decisions (Resolved)

| Question                          | Decision                             | Rationale                                                                                 |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `given` vs. auto-resolve from env | **Use `given`**                      | Explicit marking avoids ambiguity, better error messages, follows Scala 3 precedent       |
| State machine for `ctl`?          | **Yes**                              | Same architecture as async/await — effect invocation = suspension point                   |
| Transform callers too?            | **Yes**                              | All functions in the "effect scope" (between handler and effect site) must be transformed |
| One-shot vs. multi-shot           | **One-shot**                         | Fits RC model, simpler implementation, covers 99% of use cases, `resume` is linear        |
| `resume` dispatch                 | **Impl (static)**                    | Handler is lexically scoped, compiler knows types, zero overhead                          |
| `return` semantics                | **One-shot (runtime check pending)** | OCaml-style target semantics; runtime double-`return` check is TODO                       |
| `do`/`perform` keyword            | **No**                               | Type system already distinguishes `ctl` from `fn`; no ambiguity; matches Koka's design    |

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
- `given` bindings are lexically scoped, but current resolution behavior is:
  - exactly one compatible `given` required,
  - zero matches => compile-time error,
  - multiple matches => compile-time ambiguity error (must disambiguate with explicit `using(...)`).
- Resolution is by **structural type matching** (the function signature must match), not by name.
- If no matching `given` is found, it's a **compile-time error** with a clear message: `"No given value of type (fn(i32, i32) -> i32) found in scope"`.
- If multiple matching `given` values exist, it's a compile-time ambiguity error.
- Function signatures allow only one `using(...)` clause; calls allow only one `using(...)` argument expression.

### 1.3 Implementation Steps

#### ✅ Step 1: Keywords and type model

**Implemented in:**

- `src/expr.ts`
- `src/types/definitions.ts`
- `src/types/creators.ts`
- `src/env.ts`

**Completed work:**

- Added `using` and `given` built-in keywords.
- Extended function parameter model with:
  - `FunctionParameter.isImplicit`
  - `FunctionImplicitParameter`
  - `FunctionType.implicitParameters`
- Extended env variable model with `Variable.isImplicit`.

#### ✅ Step 2: Function type evaluation for `using(...)`

**Implemented in:**

- `src/evaluator/types/function.ts`

**Completed work:**

- Added dedicated `using` pass in function parameter processing.
- Enforced exactly one `using(...)` clause in function signatures.
- Parsed implicit parameters from the single `using(...)` clause and marked them compile-time + implicit.

#### ✅ Step 3: `given(...)` declarations

**Implemented in:**

- `src/evaluator/exprs/initialization-assignment.ts`
- `src/evaluator/exprs/binding.ts`

**Completed work:**

- Implemented `given(name) := value`.
- Implemented `(given(name) : Type) = value`.
- `given` variables are stored as compile-time values with `isImplicit: true`.

#### ✅ Step 4: Call-site resolution

**Implemented in:**

- `src/evaluator/calls/helper.ts`

**Completed work:**

- Supports call-site explicit contextual args via `using(...)`.
- Supports `using(undefined)` fallback for per-slot implicit lookup.
- Enforces exactly one `using(...)` argument expression per call.
- Resolves missing contextual args from `given` variables by type compatibility.
- Ambiguity handling: multiple compatible `given` values => compile-time error.
- Fixed `forall + using` bug by re-evaluating implicit parameter types in current callee env before matching (ensures `fn(a : T) -> T` resolves correctly after inference, e.g. `T = i32`).

#### ✅ Step 5: Codegen and specialization integration

**Implemented in:**

- `src/codegen/exprs/initialization-assignment.ts`
- `src/types/guards.ts`
- `src/evaluator/context.ts`
- `src/evaluator/calls/helper.ts`
- `src/types/utils.ts`

**Completed work:**

- `given(...)` assignments are skipped in runtime codegen (compile-time only declaration form).
- Functions with implicit parameters participate in specialization.
- Implicit args are included in specialization signature/cache inputs.
- Type string formatting includes `using(...)` section.

#### ✅ Step 6: Tests

**Implemented in:**

- `src/tests/fixme.yo`
- `tests/fn.test.yo`

**Covered cases:**

- Basic implicit lookup via `given`.
- Explicit contextual args via `using(...)`.
- `using(undefined)` full and partial fallback behavior.
- Multiple implicit parameters in a single `using(...)` clause.
- Ambiguous `given` error.
- No matching `given` error.
- `forall + using` inference scenario (`apply(41)` with `given(inc)` for `i32`).

---

## Phase 2: Effect Handlers (`ctl` / `return` + `abort`)

### 2.1 Syntax (Implemented)

```yo
// Define an effect operation (multi-parameter supported)
Raise :: (ctl(forall(T : Type), msg : String, msg2 : String) -> T);

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
  (given(raise) : Raise) = (ctl(forall(T : Type), msg : String, msg2 : String) -> T)({
    println(msg);
    println(msg2);
    return i32(42); // return(value) resumes the continuation with value
  });
  (i64(8) + i64(safe_divide(1, 0))) + i64(10)
};
// Returns 60 — return(42) continues after the raise call site
```

### 2.2 Semantics

- `ctl` defines an **effect operation type** — a function that can suspend computation and transfer control to a handler.
- When an effect operation is invoked, execution is **suspended** at that point. A continuation (the rest of the computation up to the handler) is captured as a stack-allocated state machine.
- The handler body receives the effect's arguments (e.g., `msg`, `msg2`).
- Inside the handler body:
  - **`return(value)`** — resumes the captured continuation with `value` as the result of the effect call. Execution continues from where the effect was invoked.
  - **`abort expr`** — discards the continuation entirely and returns `expr` from the enclosing function that installed the handler. Acts like an exception/early return.
- Two handler forms:
  - **Anonymous function handler** (no-resume): `(given(raise) : Raise) = ((msg, msg2) -> { abort expr; });` — lightweight syntax for discard-only handlers.
  - **ctl-typed handler** (with resume): `(given(raise) : Raise) = (ctl(...) -> T)({ return(value); });` — full handler that can resume the continuation.
- Continuations are **one-shot** — `return` can be called at most once.
- Enforcement is **runtime-based** (OCaml-style), not linear types:
  - Runtime check for second `return` on the same continuation is planned (not fully implemented yet).
  - When using `abort`, the continuation's captured variables are properly cleaned up.
- Effect operations compose with `using` — the effect is an implicit parameter resolved via `given`.

### 2.3 Effect Coloring / Propagation

Functions are "colored" by the effects they use:

```yo
// This function uses the Raise effect — it propagates via `using`
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

### 2.3.1 Signature-Based Detection: What Needs Transformation?

The `using` parameter with a `ctl` type is the **sole marker** for whether a function may suspend due to an effect. The rule is:

| Signature                                           | Role                                   | Needs state machine?          | Callers need transformation?            |
| --------------------------------------------------- | -------------------------------------- | ----------------------------- | --------------------------------------- |
| `fn(..., using(raise : Raise)) -> T`                | **Propagates** the effect              | Yes (within a handler scope)  | Only if they also propagate via `using` |
| `fn() -> T` (handles effect internally via `given`) | **Handles** the effect                 | Internally yes, externally no | **No** — callers see a plain function   |
| `fn(using(f : (fn() -> i32))) -> T`                 | Implicit param (plain `fn`, not `ctl`) | No                            | No                                      |

**Key insight:** The handler is the boundary. The state machine transformation is scoped to the region **between** the `given` handler site and the `ctl` invocation site. Nothing outside the handler is affected.

```yo
raise_const :: (fn() -> i32) {     // ← plain fn signature, callers unaffected
  given(raise) : Raise = ...;      // ← handler boundary (START)
  8 + safe_divide(1, 0) + 10       // ← state machine transformation here
};                                  // ← handler boundary (END)

// Callers of raise_const see (fn() -> i32) — a normal function.
// No transformation needed at the call site:
result := raise_const();  // just a regular function call
```

**Distinguishing `fn` vs `ctl` in `using`:**

```yo
// This is Phase 1 ONLY — implicit parameter passing, no effects:
X :: (fn(using(f : (fn() -> i32))) -> i32)(f() + 1);

// This is Phase 2 — effectful, ctl type triggers state machine:
Y :: (fn(using(raise : Raise)) -> i32)(raise("error"));
// where Raise :: (ctl(forall(T : Type), msg : String) -> T)
```

The `ctl` keyword in the type is what distinguishes effectful `using` from plain implicit parameters.

### 2.3.2 No `do`/`perform` Keyword for Effect Invocation

Effect operations are invoked like regular function calls — no special keyword:

```yo
// Just call the effect operation directly:
safe_divide :: (fn(x : i32, y : i32, using(raise : Raise)) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`),   // ← direct call, no do/perform
    true => (x / y)
  )
);
```

**Rationale:**

- The type system already distinguishes `ctl` from `fn` — no ambiguity for the compiler.
- The `using(raise : Raise)` in the signature already tells the reader this function uses effects.
- Matches Koka's proven design (no keyword needed).
- Reduces syntactic noise at every effect call site.
- Effects are a synchronous control flow mechanism, unlike `await` which marks an async scheduling point.

### 2.4 State Machine Transformation

The effect system reuses Yo's async/await state machine architecture:

#### Transformation Overview

1. **Effect site** (calling `raise(...)`) = suspension point (like `await`).
2. **Handler scope** = event loop (like `async { ... }`).
3. **`return(value)`** = continuation resume (like waking a future). **`abort expr`** = continuation discard (like cancellation).

#### What Gets Transformed

Every function in the call chain between the handler and the effect site must become a state machine:

```
handler scope (given(raise) : Raise = ...)
  └─ fn_a(...)                    ← state machine
       └─ fn_b(...)               ← state machine
            └─ raise(msg)         ← suspension point (effect invocation)
```

#### State Machine Struct

Similar to async state machines:

```c
typedef struct {
  int state;                     // Current state (0..N, -1 = completed)
  // Captured variables that cross effect suspension points
  int32_t local_x;
  int32_t local_y;
  // Result storage
  int32_t result;
  // Continuation info
  void* handler_ctx;             // Pointer to handler's context
  void (*on_resume)(void*, void*); // Resume callback
} safe_divide_effect_sm_t;
```

#### Resume Function

```c
int32_t safe_divide_resume(safe_divide_effect_sm_t* sm, int32_t resume_value) {
  switch (sm->state) {
    case 0:
      // Initial state — evaluate up to effect call
      if (sm->local_y == 0) {
        sm->state = 1;
        // Suspend: call handler with (msg, resume_fn)
        return handler_invoke(sm->handler_ctx, "div-by-zero", sm);
      }
      sm->result = sm->local_x / sm->local_y;
      sm->state = -1;
      return sm->result;

    case 1:
      // Resumed after raise — resume_value is the substitute result
      sm->result = resume_value;
      sm->state = -1;
      return sm->result;
  }
}
```

### 2.5 Optimization: Static Effect Resolution

When the handler and effect site are in the same compilation unit (which is common), the compiler can **inline** the effect handling:

- **No-resume handlers** (like exceptions): The state machine is unnecessary. The handler can directly return the value. Compile to a simple jump/return.
- **Always-resume handlers**: The state machine can be optimized to a direct function call where the handler wraps/transforms the result inline.
- **Known handler at compile time**: Monomorphize the entire effect chain, eliminating the `resume` closure overhead.

### 2.6 Implementation Steps

#### Step 1: Effect Type — `ctl` keyword

**Files:** `src/lexer.ts`, `src/parser.ts`, `src/evaluator.ts`

- Add `ctl` as a keyword.
- Parse `ctl(params...) -> ReturnType` as a new type form: `EffectOperationType`.
- In the evaluator, `ctl` types are similar to `fn` types but marked as effectful.
- An `EffectOperationType` carries:
  - Parameter types (including `forall` type parameters).
  - Return type.
  - A flag indicating this is an effect operation.

#### Step 2: Effect Analysis Pass

**New file:** `src/codegen/analysis/effect-analysis.ts`

Analogous to `await-point-analysis.ts`:

- Walk the AST of functions that use effects (have `using` parameters of `ctl` type).
- Identify **effect invocation points** (calls to `ctl`-typed parameters).
- Track local variables that are live across effect invocation points.
- Determine which functions in the call chain need state machine transformation.

Key data structure:

```typescript
interface EffectPoint {
  effectName: string;
  effectType: EffectOperationType;
  resultVar: string; // Variable receiving the resume value
  capturedVars: CapturedVar[];
  stateIndex: number;
}

interface EffectAnalysis {
  effectPoints: EffectPoint[];
  capturedVars: CapturedVar[];
  needsStateMachine: boolean;
}
```

#### Step 3: Effect State Machine Generation

**New file:** `src/codegen/functions/effect-statemachine.ts`

Analogous to `async-statemachine.ts`:

- For each function that needs transformation (identified by effect analysis):
  1. Generate a state machine struct (like async state machines).
  2. Generate a resume function with a `switch` statement over states.
  3. At each effect invocation point:
     - Save live variables to the state machine struct.
     - Set the next state.
     - Call the handler, passing the effect arguments and the resume function pointer.
  4. At resume entry points:
     - Restore live variables from the state machine struct.
     - Continue execution with the resume value.

#### Step 4: Handler Codegen

**Files:** `src/codegen/` (relevant files)

When a `given` binding provides a handler for a `ctl` type:

- **No-resume handler (anonymous function with `abort`):** Generate a handler that executes the handler body and uses `abort` to return a value from the enclosing function, discarding the continuation. The state machine is still generated for the effectful call chain, but the handler never resumes it.
- **Resume handler (ctl-typed with `return`):** Generate a handler that:
  - Receives the effect arguments.
  - Stores the resume value in the state machine's `resume_value` field.
  - Calls the state machine's resume function to continue execution.
  - `return(value)` sets `resume_value = value` and re-enters the state machine switch at the next state.

#### Step 5: Reference Counting for Continuations

- One-shot continuations own the state machine. Calling `return(value)` consumes ownership.
- The state machine is stack-allocated, so no heap allocation overhead.
- The `completed` flag in the state machine tracks whether the continuation has been resumed.
- Runtime checks:
  - `return(value)` resumes the continuation and sets `completed = true`.
  - `abort expr` discards the continuation — the state machine is simply abandoned on the stack.
- When using `abort`, any captured variables in the state machine that have been initialized are properly cleaned up via drop/RC decrement.
- The state machine struct includes: `state`, `completed`, `result`, `yield_0..N` (effect arguments), `resume_value`, function parameters, and captured variables that cross suspension points.

#### Step 6: Integration with `using` / `given`

Effects compose naturally with Phase 1's implicit parameters:

- `using(raise : Raise)` makes the effect an implicit parameter.
- `given(raise) : Raise = handler_fn` provides the handler.
- The evaluator resolves `ctl`-typed `using` parameters through the same `given` resolution mechanism.
- The codegen detects when a `given` binding is a `ctl` handler and generates the state machine + handler code.

#### Step 7: Tests

- **Basic effect + discard:** `Raise` effect that returns a constant (no `resume`). ✅
- **Basic effect + resume:** `Raise` effect that resumes with a value. ✅
- **Direct ctl call without `using`:** `raise(...)` called directly in handler scope, no intermediate function. ✅
- **Nested effects:** Multiple effect operations in the same function.
- **Effect propagation:** Effect passing through multiple function calls.
- **Polymorphic effects:** `ctl(forall(T : Type), ...) -> T`. ✅
- **Multiple effect types:** Function using two different effects.
- **RC correctness:** Ensure no leaks when continuations are discarded. ✅
- **RC correctness:** Ensure no leaks when continuations are resumed. ✅
- **One-shot enforcement:** Runtime error when `return` is used twice (pending implementation).
- **Interaction with async:** Using effects inside async functions (if supported).

---

## Phase 3: Advanced Features (Future Work)

### 3.1 Named Effect Instances

```yo
// Multiple instances of the same effect type
Logger :: (ctl(msg : String) -> unit);

program :: (fn(using(info : Logger), using(error : Logger)) -> unit) {
  info("starting");
  error("something went wrong");
};
```

### 3.2 Effect Polymorphism

```yo
// Functions polymorphic over effects
map :: (fn(forall(A : Type, B : Type, E : Effect),
           list : List(A),
           f : (fn(A, using(E)) -> B)
       ) -> List(B));
```

### 3.3 Effect Inference

Automatically infer `using` effect parameters from function bodies, reducing annotation burden:

```yo
// Compiler infers: using(raise : Raise)
safe_divide :: (fn(x : i32, y : i32) -> i32)(
  cond(
    (y == 0) => raise(`div-by-zero`),
    true => (x / y)
  )
);
```

### 3.4 Standard Effects Library

```yo
// std/effects/
Raise   :: (ctl(forall(T : Type), msg : String) -> T);
State   :: (ctl(forall(S : Type), op : StateOp(S)) -> S);
Reader  :: (ctl(forall(R : Type)) -> R);
Writer  :: (ctl(forall(W : Type), value : W) -> unit);
Choose  :: (ctl(forall(T : Type), options : Array(T)) -> T);
Yield   :: (ctl(forall(T : Type), value : T) -> unit);  // generators
```

---

## Implementation Order

```
Phase 1 — Implicit Parameters ✅ COMPLETE
  ├── Step 1: Keywords + type model
  ├── Step 2: Function type `using(...)` evaluation
  ├── Step 3: `given(...)` declaration forms
  ├── Step 4: Call-site implicit resolution (`using(...)` / `using(undefined)`)
  ├── Step 5: Codegen + specialization integration
  └── Step 6: Tests

Phase 2 — Effect Handlers ✅ CORE COMPLETE
  ├── Step 1: ctl keyword + effect type ✅
  ├── Step 2: Effect analysis pass ✅
  ├── Step 3: State machine generation ✅
  ├── Step 4: Handler codegen (abort + return) ✅
  ├── Step 5: RC for continuations ✅
  ├── Step 6: Integration with using/given ✅
  └── Step 7: Tests (basic cases ✅, advanced cases pending)

Phase 3 — Advanced (Future)
  ├── Named effect instances
  ├── Effect polymorphism
  ├── Effect inference
  └── Standard effects library
```

---

## Relationship to Existing Async/Await

Effects and async/await are related but independent:

| Aspect           | Async/Await                   | Algebraic Effects                        |
| ---------------- | ----------------------------- | ---------------------------------------- |
| Suspension point | `await expr`                  | `effect_op(args)`                        |
| Who resumes      | Event loop (IO completion)    | Handler (calling `return`)               |
| State machine    | Per async function            | Per effectful function chain             |
| Continuation     | Implicit (event loop manages) | Explicit (`return` / `abort` in handler) |
| Thread model     | Single-threaded event loop    | Synchronous (same thread)                |
| Use cases        | IO concurrency                | Control flow abstraction                 |

**Long-term unification:** Algebraic effects are strictly more general than async/await. In theory, async/await can be implemented _as_ an effect:

```yo
Async :: (ctl(forall(T : Type), future : Future(T)) -> T);
// await = invoking the Async effect
// event loop = handler for Async effect
```

However, this unification is a Phase 3+ goal. For now, async/await and effects coexist independently, sharing similar state machine infrastructure patterns.

---

## Risk Assessment

| Risk                                | Severity | Mitigation                                                                     |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------ |
| State machine complexity            | High     | Reuse async/await infrastructure, start with no-resume case                    |
| RC leaks in discarded continuations | Medium   | Comprehensive drop generation, test with `--sanitize address`                  |
| Compilation time increase           | Medium   | Only transform functions that actually use effects                             |
| Effect coloring ergonomics          | Low      | Plan effect inference for Phase 3                                              |
| Interaction with existing features  | Medium   | Test combinations: effects + closures, effects + generics, effects + ownership |

---

## Success Criteria

1. ✅ `using` + `given` works for plain function types (Phase 1 complete).
2. ✅ `ctl` effects with no-resume handlers work (exception-like usage via `abort`).
3. ✅ `ctl` effects with resume handlers work (continuation-like usage via `return`).
4. ✅ No memory leaks detected by AddressSanitizer in all effect scenarios.
5. Nested effects and effect propagation through call chains work correctly.
6. One-shot enforcement: runtime error on double `return` (OCaml-style).
7. Performance: no overhead for functions that don't use effects.
