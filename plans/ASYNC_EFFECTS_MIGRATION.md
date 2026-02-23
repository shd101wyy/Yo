# Async/Await Migration to Algebraic Effects

## Overview

This plan describes how to migrate Yo's `async`/`await` from built-in keywords to **algebraic effect operations** within an `IO` module. The async event loop becomes the built-in effect handler for the `IO` effect.

## Current Status (2026-02-23)

- ✅ Async/await with heap-allocated state machines: 54 tests passing
- ✅ Algebraic effects with stack-allocated state machines: 30 tests passing
- ✅ **Phase 0 complete**: `IO` module type defined in `prelude.yo`, `main :: (fn(using(io : IO)) -> unit)` compiles and runs
- ✅ **Phase 1 in progress**: `io.async(closure)` and `io.await(future)` generate working C code for synchronous (non-state-machine) case
- ❌ No interaction between the two systems (effect analysis skips async blocks and vice versa)
- ❌ Cannot combine effects and async in the same function

---

## Design Decisions

### Naming: `IO` (not `Async`)

**Decision: Use `IO`**

| Option  | Pros                                                          | Cons                                                              |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| `IO`    | Classic FP name (Haskell), concise, used by Zig 0.15+         | Name overlap with `std/io/` module (addressable with namespacing) |
| `Async` | Descriptive of mechanism, matches `async`/`await` terminology | Less idiomatic in FP tradition                                    |

Reasoning:

- `IO` follows the classic FP tradition (Haskell's IO monad, Zig 0.15+'s `Io`), unifying all effectful operations under one roof
- Async concurrency IS an IO effect — waiting for I/O to complete is fundamentally IO
- Potential overlap with `std/io/` module can be addressed via namespacing or module aliasing; user can write `{ IO } :: import "std/builtin/io"` vs `io :: import "std/io"`

### Module Definition

```yo
IO :: module(
  async : (fn(forall(T : Type, ...(E)), action : Impl(Fn(using(...(E))) -> T)) -> Impl(Future(T))),
  await : (fn(forall(T : Type), own(fut) : Impl(Future(T))) -> T)
);
```

**`IO.async`** — Creates a Future from a closure. Starts eager execution (runs until first `await` inside the closure). The `...(E)` effect row parameter allows the closure to carry other effects (e.g., `Raise`, `Log`). The `action` parameter is NOT `own` — the caller retains ownership of the closure and its captures, which are dropped at end of scope.

**`IO.await`** — The core suspension point. Takes `own(fut)` to consume the Future and returns its result when ready. The `own` parameter transfers ownership of the future to the await call, which frees it after extracting the result. This is the operation that makes a function "async-colored" — any function calling `await` (directly or transitively) must have `using(IO)` in its signature or handle the effect.

### Why `await` is an Effect

In the current algebraic effect model, an effect operation:

1. Suspends the current function at the call point
2. Transfers control to the handler
3. The handler can `return(value)` (resume) or `abort` (discard)

For `IO.await`:

1. The function suspends at the `await` call point
2. The handler (event loop) receives the Future argument
3. If the Future is ready → `return(result)` (resume immediately)
4. If the Future is pending → register continuation, return control to event loop (deferred resume)

The "deferred resume" is a **third handler mode** beyond `return`/`abort`:

| Handler Action  | Current Effects                       | IO Effects (via `IO.await`)                           |
| --------------- | ------------------------------------- | ----------------------------------------------------- |
| `return(value)` | Resume SM immediately                 | Resume SM immediately (future was ready)              |
| `abort expr`    | Discard SM, return from handler scope | N/A for await                                         |
| **deferred**    | N/A                                   | Register continuation on future, return to event loop |

This "deferred resume" is the key extension to the effect handler model.

### How the `IO` Handler is Provided

**Decision: `main :: (fn(using(io : IO)) -> unit)` with runtime-provided handler**

```yo
// The runtime automatically provides the IO handler to main
main :: (fn(using(io : IO)) -> unit) {
  future := io.async((using(io)) => fetch("http://example.com"));
  result := io.await(future);
  println(result);
};
```

The generated C `main()` wrapper:

1. Creates the `IO` handler (backed by the event loop)
2. Passes it to `__yo_user_main(async_handler)`
3. Runs the event loop until `main` completes

Alternative considered and rejected:

```yo
// Rejected: magic function approach
main :: (fn() -> unit) {
  given(io) := use_builtin_async();
  // ...
};
```

Rejection reasons:

- `use_builtin_async()` is a magic function with no clear semantics
- Forgetting to call it leads to runtime errors instead of compile-time errors
- The `using` approach is more principled — the effect is part of the type signature

### Sync `main` Backward Compatibility

Programs that don't use async effects can still have a plain `main`:

```yo
// This still works — no IO effect needed for sync programs
main :: (fn() -> unit) {
  println("Hello, world!");
};
```

The codegen detects whether `main` has `using(IO)` and generates the appropriate wrapper.

---

## Usage Examples

### Basic Async/Await (Before and After)

```yo
// BEFORE (current):
main :: (fn() -> unit) {
  async {
    result := await fetch("http://example.com");
    println(result);
  };
};

// AFTER (with effects):
main :: (fn(using(io : IO)) -> unit) {
  result := io.await(fetch("http://example.com"));
  println(result);
};
```

Note: with effects, `main` itself is in async context — no need for `async { ... }` wrapper.

### Concurrent Execution

```yo
// BEFORE:
main :: (fn() -> unit) {
  async {
    f1 := fetch(url1);  // async { ... } inside fetch
    f2 := fetch(url2);
    r1 := await f1;
    r2 := await f2;
  };
};

// AFTER:
main :: (fn(using(io : IO)) -> unit) {
  f1 := io.async((using(io)) => fetch(url1));
  f2 := io.async((using(io)) => fetch(url2));
  r1 := io.await(f1);
  r2 := io.await(f2);
};
```

### Defining Async Functions

```yo
// BEFORE:
fetch :: (fn(url : String) -> Impl(Future(String)))(async {
  response := await http_get(url);
  body := await response.read_body();
  return body;
});

// AFTER:
fetch :: (fn(url : String, using(io : IO)) -> String) {
  response := io.await(http_get(url));
  body := io.await(response.read_body());
  body
};
```

Key differences:

- Return type is `String` (not `Impl(Future(String))`) — the effect system handles the async coloring
- `using(io : IO)` declares the function uses async effects
- No `async { ... }` block needed — the function body IS the async body
- Callers must either propagate `using(io : IO)` or handle it

### Combining Async with Other Effects

```yo
Raise :: (fn(forall(T : Type), msg : String) -> T);

// Function uses both IO and Raise effects
fetch_or_fail :: (fn(url : String, using(io : IO, raise : Raise)) -> String) {
  result := io.await(http_get(url));
  cond(
    (result.status != i32(200)) => raise(`HTTP error`),
    true => result.body
  )
};

main :: (fn(using(io : IO)) -> unit) {
  (given(raise) : Raise) = ((msg) -> {
    println(`Error: `, msg);
    abort ();
  });

  data := fetch_or_fail("http://example.com");
  println(data);
};
```

### Effect Polymorphism with Async

```yo
// Generic function that runs an action with any effects, wrapped in a Future
spawn_task :: (fn(
    forall(T : Type, ...(E)),
    action : Impl(Fn(using(...(E))) -> T),
    using(io : IO, ...(E))
  ) -> Impl(Future(T)))(
  io.async(action)
);
```

### Cooperative Yield

```yo
// std/async.yo
yield :: (fn(using(io : IO)) -> unit) {
  io.await(immediately_ready_future());
};
```

---

## Architecture Analysis

### Current Async State Machine (heap-allocated, pre-migration)

```
┌──────────────────────────────────────────┐
│ Async State Machine (heap, RC-managed)   │  <- pre-migration
├──────────────────────────────────────────┤
│ yo_ref_header_t header;     // RC        │
│ _Atomic int state;          // 0..N, -1  │
│ ResultType result;                       │
│ _Atomic continuation_fn;   // callback   │
│ _Atomic continuation_sm;   // callback   │
│ __capture { ... };          // closures   │
│ local variables...                       │
│ await_future_0, await_result_0...        │
│ cond_branch_0, while_loop_0_active...    │
└──────────────────────────────────────────┘
```

- Allocated via `__yo_malloc`, freed by RC
- `_Atomic` fields for concurrent access from event loop
- Continuation function pointers for async wake-up
- Resume function: `void resume(SM* sm)` with `switch(sm->state)`

### Current Effect State Machine (stack-allocated)

```
┌──────────────────────────────────────────┐
│ Effect State Machine (stack, no RC)      │
├──────────────────────────────────────────┤
│ int state;                               │
│ int completed;                           │
│ ResultType result;                       │
│ YieldType yield_0;                       │
│ ResumeType resume_value;                 │
│ int effect_tag;             // multi-eff │
│ parameters...                            │
│ captured variables...                    │
│ inner SM (transitive)...                 │
└──────────────────────────────────────────┘
```

- Stack-allocated (local variable at call site)
- Plain `int` fields (synchronous, no atomics)
- Direct `resume(&sm)` calls (no event loop)
- One-shot: resume at most once

### Key Differences (Why Unification is Non-Trivial)

| Aspect       | Async SM                      | Effect SM              | Impact                                           |
| ------------ | ----------------------------- | ---------------------- | ------------------------------------------------ |
| Allocation   | Heap (RC)                     | Stack                  | Async futures must outlive creating scope        |
| State field  | `_Atomic int`                 | `int`                  | Async SMs accessed from event loop callbacks     |
| Completion   | `state == -1` (atomic)        | `sm.completed`         | Different completion protocol                    |
| Continuation | Function pointer + event loop | Direct `resume()` call | Async handler is deferred, effects are immediate |
| Lifetime     | RC-managed, arbitrary         | Scoped to call site    | Fundamentally different                          |
| Multiplicity | Multi-shot (re-awaitable)     | One-shot               | Effects enforce linearity                        |

### What Unification Means

A unified system would:

1. Use **heap allocation** for functions with `IO` effect (futures must outlive scope)
2. Use **stack allocation** for functions with only synchronous effects (one-shot, scoped)
3. Support **both async and sync effects in the same function** — heap-allocated SM with both await points and effect yield points
4. Generate **event loop integration** for async effects and **inline handler code** for sync effects

---

## Migration Phases

### Phase 0: Define the IO Module Type (Evaluator Only) — ✅ COMPLETE

**Goal**: Define the `IO` module as a built-in type that the evaluator recognizes, exposed via `prelude.yo` so it is always in scope. Minimal codegen changes to support `main :: (fn(using(io : IO)) -> unit)`.

**Implementation Summary**:

1. **`IO` module type** was already defined in `std/prelude.yo` (lines 158-162). No evaluator changes needed — the existing `module(...)` type system handles it.

2. **`extern "Yo"` functions** added to `std/prelude.yo` for the two IO operations:

   ```yo
   extern "Yo",
     __yo_io_async : (fn(forall(T : Type, ...(E)), action : Impl(Fn(using(...(E))) -> T)) -> Impl(Future(T))),
     __yo_io_await : (fn(forall(T : Type), fut : Impl(Future(T))) -> T)
   ;
   ```

   These produce `UnknownValue` at eval time and will be matched against `BuiltinYoInlineFunctions` at codegen time in later phases.

3. **`__builtin_io` given binding** added to `std/prelude.yo`:

   ```yo
   given(__builtin_io) :: IO(
     async : __yo_io_async,
     await : __yo_io_await
   );
   export __builtin_io;
   ```

   This provides the IO handler automatically to any function with `using(io : IO)` via the existing `given`/`using` resolution mechanism.

4. **Codegen fix for `main :: (fn(using(io : IO)) -> unit)`**: Functions with only module-typed implicit parameters (like `IO`) that are never specialized at call sites were silently dropped by codegen. This is now handled correctly by the three-tier function classification in `src/types/guards.ts`:

   - **`isFunctionTypeHardGeneric(FunctionType)`** — returns `true` only for comptime/forall/SomeType params; returning `false` for implicit-params-only functions. `main :: (fn(using(io : IO)) -> unit)` has `isFunctionTypeHardGeneric = false` because its only generic marker is the implicit `io` parameter.
   - **`isFunctionSpecializable(FunctionValue)`** — `isFunctionTypeGeneric(type) && specializedFunctionCaches.length > 0`. For `main`, `specializedFunctionCaches` is empty (it is never specialized at a call site), so `isFunctionSpecializable = false`.
   - The regular generation skip condition is `isFunctionTypeHardGeneric(type) || specializedFunctionCaches.length > 0`. Since both are false for `main`, it passes through to regular C generation.

   This replaces the old `isSpecializableOnlyByModuleImplicitParams` heuristic. The new design correctly generalises: any function whose implicit parameters are resolved at compile time (module-typed or otherwise) with no call-site specializations will be emitted as a plain C function. Normal effect functions (like `safe_divide(using(raise : Raise))`) still go through the specialization pipeline because their `specializedFunctionCaches` is non-empty.

5. **Tests verified**: 30 algebraic effects tests, 54 async/await tests, 16 function tests all pass. ASAN clean.

**What Phase 0 does NOT include** (deferred to Phase 1+):

- No codegen for `io.await(future)` — calling `io.await` at runtime will not produce correct async SM code yet
- No codegen for `io.async(closure)` — calling `io.async` at runtime will not produce correct future-creating code yet
- No event loop integration in the main wrapper — `main :: (fn(using(io : IO)) -> unit)` compiles but the IO effect is a no-op at runtime

### Phase 1: Codegen — `await` as Effect, `async` as Built-in (Hybrid) — IN PROGRESS

**Goal**: Generate correct C code for the new `io.await(future)` and `io.async(closure)` syntax, reusing existing async state machine infrastructure.

**Completed Steps**:

1. **`ioBuiltin` type field for detecting IO calls** — Added `ioBuiltin?: "io_async" | "io_await"` field to `Type` in `definitions.ts`. The field is propagated from `extern "Yo"` function types to IO module field types during module construction. Detection functions `isIoAsyncCall`/`isIoAwaitCall` in `await-analysis.ts` check `expr.func.$?.type?.ioBuiltin`. Removed redundant `isIoAsync`/`isIoAwait` boolean flags from `EvaluatedExprData`.

2. **Removed `ioAsyncClosureBody` from evaluator** — The old approach tried to extract the closure function body during evaluation, which only worked for inline closures (not variable references like `io.async(action)`). Completely removed all closure body extraction code from `evaluator/calls/function.ts`. Detection now happens purely in codegen.

3. **Sync future codegen (`generateIoAsyncSyncCall`)** — For `io.async(closure)` calls outside a state machine, generates a "sync future" in `codegen/exprs/async.ts`:

   - Emits a sync future struct: `{ yo_ref_header_t header, _Atomic int state, ResultType result, continuation_fn, continuation_sm }`
   - Emits a dispose function for RC cleanup
   - Calls the closure via `implClosureCallMap` (static dispatch through Impl(Fn) interface)
   - Allocates the sync future, stores result, sets `state = -1` (completed)
   - The closure is called by reference (`&(action)`) — ownership remains with the caller

4. **Synchronous `io.await` with `own(fut)` and proper cleanup** — The `io.await` codegen in `codegen/exprs/await.ts`:

   - Spins on `__sync_future->state` until `-1` (completed)
   - Extracts the result
   - Sets `state = -2` (consumed, so dispose won't double-drop the result)
   - Calls `__yo_decr_rc(__sync_future)` to free the future
   - Uses `own(fut)` parameter to signal ownership transfer — the evaluator marks `fut` as consumed (no end-of-scope drop)

5. **Codegen dispatch** — Updated `codegen/exprs/generation.ts` to route `isIoAsyncCall(expr)` to `generateIoAsyncSyncCall` (without requiring `awaitAnalysis`).

6. **Ownership design decision**: `io.async` does NOT take `own(action)` because the closure's captured variables may still be used after the async call. Dropping the closure immediately would cause use-after-free. The caller's end-of-scope drops handle the closure cleanup. `io.await` DOES take `own(fut)` because the future is fully consumed and freed after extracting its result.

7. **ASAN verified** — Tested with `--sanitize address --allocator libc`: no leaks, no memory errors for closures with captured RC types (e.g., `Box(i32)`).

**Remaining Steps**:

1. **State machine generation for `io.async(closure)` with `io.await` inside the closure**

   - When the closure body contains `io.await` calls:
     - Run await analysis (same as current `analyzeAwaitPoints`) on the closure body
     - Generate a heap-allocated SM struct with RC header, continuation fields, captured variables
     - Generate resume function with `switch(sm->state)` dispatch
     - Generate constructor and dispose functions
     - Return `Impl(Future(T))` handle
   - This replaces the current `generateIoAsyncSyncCall` path for closures that actually suspend

2. **State machine `io.await` inside a state machine**

   - When `io.await(future)` appears inside an async state machine (not at top level):
     - Store future pointer in SM field
     - Register continuation (CAS on `continuation_fn` / `continuation_sm`)
     - Advance state and return (suspend)
     - Next state: extract result from future
   - Currently only synchronous `io.await` (spin-wait outside SM) is implemented

3. **Main wrapper for `main :: (fn(using(io : IO)) -> unit)` with async body**

   - When `main` body itself contains `io.await`, generate C `main()` that:
     - Initializes the async scheduler (event loop)
     - Creates SM for `__yo_user_main`
     - Runs event loop until main completes
   - Currently `main` calls `__yo_user_main()` directly (synchronous)

4. **Backward compatibility**: Keep `async { ... }` and `await expr` working alongside new syntax

5. **Tests**: Port a subset of existing 54 async tests to new syntax, verify same behavior

**Deliverables**: Programs using `io.await(future)` and `io.async(closure)` compile to correct async SM code, supporting both synchronous (inline-resolved) and asynchronous (event-loop-driven) futures.

### Phase 2: IO + Sync Effects in Same Function

**Goal**: Allow a function to use both `IO` and synchronous effects (e.g., `Raise`, `Log`) in the same function.

**This is the hard phase.** Currently, async SM and effect SM are completely separate codegen paths.

**Design Options**:

#### Option A: Nested State Machines (Simpler, Less Efficient)

The function gets an **async SM** (heap-allocated, for `await` points) with an embedded **effect SM** (for `raise`/`log` points). At `await` points, the async SM suspends normally. At effect points, the inner SM yields to the handler.

```
┌─ IO SM (heap) ───────────────────────┐
│ yo_ref_header_t header;              │
│ _Atomic int state;                   │
│ ResultType result;                   │
│ continuation_fn, continuation_sm;    │
│                                      │
│ ┌─ Effect SM (embedded) ──────────┐  │
│ │ int state;                      │  │
│ │ int completed;                  │  │
│ │ yield_0, resume_value;          │  │
│ └─────────────────────────────────┘  │
│                                      │
│ local variables...                   │
└──────────────────────────────────────┘
```

Pros: Reuses existing SM generators with minimal changes
Cons: Double state tracking, complex control flow between inner/outer SM

#### Option B: Unified State Machine (Complex, Efficient)

One SM handles both async and sync effects. Each suspension point (whether `await` or `raise`) is a state transition. The SM has fields for both async continuation and effect yield/resume.

```
┌─ Unified SM (heap, for async) ───────┐
│ yo_ref_header_t header;              │
│ _Atomic int state;                   │
│ ResultType result;                   │
│ continuation_fn, continuation_sm;    │
│ int effect_tag;           // which?  │
│ yield_0; resume_value;    // effect  │
│ await_future_0;           // async   │
│ await_result_0;           // async   │
│ local variables...                   │
└──────────────────────────────────────┘
```

The resume function `switch(sm->state)` has both async states and effect states:

- IO/await states: store future, register continuation, return
- Sync effect states: store yield value, set effect_tag, return (handler runs inline)

Pros: Single SM, clean state enumeration, no nesting overhead
Cons: SM generator must handle both paradigms, more complex codegen

**Recommendation**: Option B (unified). Both async and effect SMs already use the same `switch(sm->state)` pattern. The differences are:

- Heap vs stack allocation → decided by presence of `IO` effect
- Atomic vs plain fields → decided by allocation mode
- Continuation registration vs inline handler → decided by effect type

**Steps**:

1. **Extend effect analysis to detect both async and sync effects**

   - `analyzeEffectCallPoints` and `analyzeAwaitPoints` are merged into a unified `analyzeSuspensionPoints`
   - Each suspension point is tagged: `kind: "await" | "effect"`
   - Captured variables and SSA remapping handled uniformly

2. **Unified SM struct generation**

   - If any effect is async → heap allocation, RC header, atomic state
   - If all effects are sync → stack allocation, no RC, plain state
   - Fields include both `await_future_N`/`await_result_N` (for async) and `yield_N`/`resume_value_N` (for sync effects)

3. **Unified resume function generation**

   - Each state is either an async (IO) state or a sync effect state
   - IO/async states: generate continuation registration code
   - Effect states: generate yield code (same as current effect SM)

4. **Call site generation**

   - For functions with only `IO`: generate heap SM + event loop integration (same as current async)
   - For functions with only sync effects: generate stack SM + inline handler (same as current effects)
   - For functions with both: generate heap SM + event loop + inline handlers for sync effects

5. **Tests**: Functions combining `IO` + `Raise`, `IO` + `Log`, `IO` + multiple sync effects

### Phase 3: Deferred Resume for Event Loop Integration

**Goal**: Extend the effect handler model with "deferred resume" to support the event loop pattern.

Currently effects support:

- `return(value)` → resume SM immediately
- `abort expr` → discard SM

For async, the event loop handler needs:

- **deferred resume** → store continuation, resume later when I/O completes

**Design**: The `IO.await` handler is always built-in. At the codegen level:

```c
// At await(future) call site in an effect-based model:
SM_resume(&sm);
if (!sm.completed) {
  // Built-in await handler:
  future_ptr = sm.yield_async_0;  // The future being awaited
  if (atomic_load(&future_ptr->state) == -1) {
    // Future already complete — resume immediately
    sm.resume_value = future_ptr->result;
    SM_resume(&sm);
  } else {
    // Future not ready — register continuation, return to event loop
    // (Deferred resume: event loop will call SM_resume later)
    atomic_store(&future_ptr->continuation_fn, SM_resume);
    atomic_store(&future_ptr->continuation_sm, &sm);
    return;  // Back to event loop
  }
}
```

This is essentially the same code as current async await, but expressed in the effect handler framework.

**Steps**:

1. Model the `IO.await` handler body as built-in codegen (not user-written Yo code)
2. Generate the deferred resume pattern at `await` effect call sites
3. Ensure RC correctness: the SM must be ref-counted since deferred resume means it outlives the call site

### Phase 4: Deprecate Old Syntax, Full Cleanup

**Goal**: Remove old `async { ... }` and `await expr` builtins in favor of the effect-based API.

**Steps**:

1. **Deprecation warnings** for `async { ... }` and `await expr`
2. **Migrate all tests** from old syntax to new syntax:
   - `tests/async_await.test.yo` (51 tests)
   - `tests/io/*.test.yo` (32 test files)
3. **Migrate `std/async.yo`** — `yield` function uses `using(io : IO)`
4. **Migrate `std/io/*.yo`** — IO operations return `IOFuture`, callers use `io.await`
5. **Remove old evaluator code**: `evaluateAsync`, `evaluateAwait` in `async-fns.ts` and `future-fns.ts`
6. **Remove old codegen code**: `src/codegen/exprs/async.ts` (replaced by effect-based codegen)
7. **Merge SM generators**: Remove `src/codegen/async/state-machine.ts` and `src/codegen/async/state-code-gen.ts`, unified into effect SM
8. **Keep event loop runtime**: `src/codegen/async/runtime-core.ts` and platform-specific IO still needed

**Deliverables**: Only the effect-based API exists. All async functionality goes through the `IO` effect module.

---

## Unresolved Design Questions

### 1. `io.async` Semantics: Effect or Regular Function?

`io.async(closure)` creates a Future and starts eager execution. It does NOT suspend the caller — it runs the closure synchronously until the first `io.await` inside the closure.

**Option A**: `async` is a regular function (not an effect operation)

- Pros: Simpler, no SM transformation at the `async` call site
- Cons: Cannot be "handled" — always uses built-in implementation

**Option B**: `async` is an effect operation

- Pros: Can be intercepted by custom handlers (e.g., deterministic testing scheduler)
- Cons: More complex, possibly unnecessary overhead

**Current recommendation**: Start with Option A (regular function). The `IO` module's `async` field is a built-in function backed by compiler codegen, not a user-handleable effect. Only `await` is a true effect (suspension point).

If we need custom schedulers in the future, we can promote `async` to an effect.

### 2. Should `io.await` Work on `IOFuture` (C-level IO futures)?

Currently, `IOFuture` wraps a C struct `yo_io_future_t` with `_Atomic int state` at offset 0. The current `await` works on both user-created futures (`async { ... }`) and IO futures (`openat`, `read`, etc.).

The effect-based `io.await` should work the same way. The `Impl(Future(T))` type encompasses both:

- User futures (from `io.async(closure)`)
- IO futures (from `openat`, `read`, etc.)

Since `IOFuture = Impl(Concrete(yo_io_future_t), Future(i32))`, and `io.await` accepts `Impl(Future(T))`, this should work by structural compatibility.

### 3. Interaction with `spawn` (Parallelism)

`spawn` creates a task on a DIFFERENT thread (true parallelism). It's fundamentally different from `IO` (same-thread concurrency). They should remain separate:

- `IO` effect: single-threaded concurrency (event loop)
- `spawn` / `Task`: multi-threaded parallelism (isolated threads)

A `spawn`-ed task could use `IO` internally (its own event loop on its thread), but the `IO` effect does not cross thread boundaries.

### 4. Nested Async Scopes

Currently, `async { ... }` creates nested scopes. With effects, nesting would look like:

```yo
main :: (fn(using(io : IO)) -> unit) {
  // main is already in async context
  // Creating a sub-task:
  future := io.async((using(io)) => {
    // This closure runs in its own state machine
    io.await(some_future)
  });
  io.await(future);
};
```

Each `io.async(closure)` creates a new heap-allocated SM. The closure captures `io` from the parent scope.

### 5. Direct Calls to `await` Without Module Prefix

For ergonomics, should we allow:

```yo
// With prefix (explicit):
result := io.await(future);

// Without prefix (destructured):
{ await, async } :: io;  // or via using destructuring
result := await(future);
```

The `using(ModuleType)` auto-destructuring already supports this. With `using(io : IO)`, the fields `io.await` and `io.async` could be auto-destructured if the module supports it.

However, `await` as a bare function name conflicts with the current `await` builtin. During the migration period, we should keep both and use distinct syntax. After Phase 4, the old `await` is removed and `await` from destructured `IO` can be used freely.

---

## Risk Assessment

| Risk                                             | Severity | Mitigation                                                                           |
| ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------ |
| Heap vs stack allocation decision complexity     | High     | Phase 2 carefully separates async (heap) from sync (stack) effects                   |
| Combining IO + sync effects in one SM            | High     | Phase 2 Option B (unified SM) addresses this; can fall back to Option A (nested)     |
| Breaking 51 async tests during migration         | High     | Phase 1 maintains backward compatibility; old syntax works alongside new             |
| Event loop integration with effect handler model | Medium   | Phase 3 models deferred resume as built-in codegen, not user-level handler           |
| Performance regression from effect overhead      | Medium   | Built-in `IO` effect uses same codegen as current async (no indirection)             |
| `IOFuture` compatibility                         | Low      | `Impl(Future(T))` structural matching handles both user and IO futures               |
| Interaction with closures (`Impl(Fn(...))`)      | Medium   | Closure + effect already works; `io.async` closure follows same pattern              |
| RC correctness for unified SM                    | High     | Test extensively with `--sanitize address`; deferred resume means SM must be heap-RC |

---

## Implementation Order

```
Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(types)     (codegen)    (unified)   (deferred)   (cleanup)

  │            │            │           │
  ├─ IO        ├─ Same      ├─ Merge    ├─ Deferred
  │  module    │  codegen   │  SM       │  resume
  │  type      │  as today  │  gens     │  handler
  ├─ using()   ├─ io.await  ├─ IO       ├─ event
  │  support   │  io.async  │  +Raise   │  loop
  └─ eval      └─ backward  └─ unified  └─ built-in
     only         compat       SM          handler
```

**Recommended start**: Phase 0 (evaluator-only changes, no codegen risk). This lets us validate the type system design before touching codegen.

---

## Success Criteria

1. ✅ `IO` module type is defined and recognized by the evaluator
2. ✅ Functions with `using(io : IO)` type-check correctly
3. ✅ `io.await(future)` generates same async SM code as current `await`
4. ✅ `io.async(closure)` generates same code as current `async { ... }`
5. ✅ `main :: (fn(using(io : IO)) -> unit)` works
6. ✅ All 51 existing async tests pass (backward compatibility)
7. ✅ New effect-based async tests pass with AddressSanitizer (no leaks)
8. ✅ Combined async + sync effects work in the same function
9. ✅ Old `async`/`await` syntax deprecated and removed
10. ✅ No performance regression in async benchmarks
