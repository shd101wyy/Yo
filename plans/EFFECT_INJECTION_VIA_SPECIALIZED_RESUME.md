# Effect Injection via Specialized Resume Functions

## Problem

`using(...)` parameters on `io.await` and `io.spawn` are currently **compile-time only** — they are:

1. Marked `isCompileTimeOnly: true` in the evaluator
2. Stripped from closure environments by `stripImplicitVariablesFromEnv`
3. **Never stored** as runtime struct fields
4. **Never passed** to the async closure's generated C code

This means the async closure body calls effect functions as **bare C names** (e.g., `log()`), which link to wrong symbols (e.g., glibc's math `log`) instead of the intended effect handler.

### Example of the Bug

```rust
Log :: (fn(msg : String) -> unit);

task := io.async((using(io : Io, log : Log))=> {
  log(`Task started`);  // In generated C: log(...) → links to glibc math log!
});

(given(log1) : Log) = (msg) -> { println(`Log1: ${msg}`); };
io.await(task, using(io, log1));  // log1 is completely erased from C output
```

## Solution: Specialized Resume Function Pointer

Instead of storing `using` parameters as runtime function pointer fields in the Future struct, we store a **specialized resume function** that has concrete effect functions baked in.

### Key Insight

The `__yo_resume_fn` field on the Future struct already holds a function pointer `void (*)(void*)`. Currently it always points to the same resume function for a given async block. The new approach:

- At `io.async` time: set `__yo_resume_fn = NULL` (no effects bound yet)
- At `io.spawn(fut, using(...))` or `io.await(fut, using(...))` time: generate a **specialized wrapper** that calls the real resume function with the concrete effect handler values, and set `__yo_resume_fn` to that wrapper
- The specialized function is only set **once** — on the pending→running transition (state 0 → state 1+)
- Later `io.await` or `io.spawn` calls on the same future see `state != 0` and skip the specialization

### Set-Once Semantics

```rust
io.spawn(future, using(io, log1));   // state was 0 → sets specialized resume with log1, starts
io.await(future, using(io, log2));   // state is now > 0 → ignores log2, just waits + extracts
```

The first caller to transition the future from pending to running "wins" and binds the effects. Subsequent callers' `using(...)` parameters are ignored at runtime.

## Design

### API (unchanged)

```rust
Io :: module(
  async : (fn(forall(T : Type, ...(E)), action : Impl(Fn(using(...(E))) -> T)) -> Impl(Future(T, ...(E)))),
  await : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> T),
  state : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E)))) -> FutureState),
  spawn : (fn(forall(T : Type, ...(E)), fut : Impl(Future(T, ...(E))), using(...(E))) -> unit)
);
```

### Generated C Code (Before)

```c
// io.async generates:
sm->__yo_resume_fn = resume_fn_123;  // Always the same function

// resume_fn_123 calls closure body which uses bare `log(...)` — WRONG
void resume_fn_123(void* ptr) {
  MyFuture* sm = (MyFuture*)ptr;
  sm->result = closure_fn_456(&sm->__capture);
  // ...
}
```

### Generated C Code (After)

```c
// io.async generates:
sm->__yo_resume_fn = NULL;  // No effects bound yet

// At io.spawn(task, using(io, log1)):
// 1. Generate a specialized wrapper at the call site:
static void resume_specialized_789(void* ptr) {
  MyFuture* sm = (MyFuture*)ptr;
  sm->__capture.log = log1_value;  // Inject effect into capture struct
  resume_fn_123(ptr);              // Call the real resume function
}
// 2. Set it on the future:
if (task->state == 0) {
  task->__yo_resume_fn = resume_specialized_789;
  __yo_incr_rc(task);
  task->__yo_resume_fn(task);
}
```

### Implementation Alternative: Direct Field Injection

Instead of generating a specialized wrapper function, we can inject the effect handler values **directly into the capture struct fields** at the spawn/await call site, then call the original resume function:

```c
// At io.spawn(task, using(io, log1)):
if (task->state == 0) {
  // Inject effects into capture struct
  task->__capture.log = log1_fn_ptr;  // Set the effect field
  // Then start normally
  task->__yo_resume_fn = resume_fn_123;
  __yo_incr_rc(task);
  task->__yo_resume_fn(task);
}
```

This is simpler — no wrapper function needed. The capture struct already has fields for the using params (they're function parameters of the closure). We just need to:

1. **Not set** `__yo_resume_fn` at `io.async` time (set to NULL)
2. At `io.spawn/await`, inject effect values into capture struct fields and set `__yo_resume_fn`
3. Only do this when state == 0 (pending → running transition)

## Implementation Plan

### Phase 1: Evaluator Changes

#### 1.1 Stop marking implicit params as compile-time only for async closures

**File**: `src/evaluator/exprs/initialization-assignment.ts`

Currently, implicit params get `isCompileTimeOnly: true`, which causes them to be excluded from closure captures and from codegen. For async closures (closures passed to `io.async`), the using params need to be **runtime** values that get stored in the capture struct.

**Change**: When evaluating implicit params of a closure that's inside an `io.async` call, mark them as `isCompileTimeOnly: false` so they become runtime captures.

This is the critical evaluator change. The using params need to flow through as regular runtime captured variables so the codegen can:

- Add fields for them in the capture struct
- Generate code to set those fields at spawn/await time

#### 1.2 Track which capture fields are effect params

**File**: `src/evaluator/async/await-analysis-types.ts`

Add a flag to `CapturedVariable` or to the analysis result to mark which captured variables are effect parameters (from `using(...)`). The codegen needs this to know which fields to inject at spawn/await time rather than at io.async time.

### Phase 2: Codegen Changes

#### 2.1 `io.async` — defer resume function assignment

**File**: `src/codegen/exprs/async.ts`

- For async blocks that have effect parameters (using params beyond Io):

  - Set `sm->__yo_resume_fn = NULL` instead of `resume_fn_123`
  - Do NOT initialize effect param fields in the capture struct at allocation time
  - Still initialize non-effect capture fields normally (captured variables from outer scope)

- For async blocks with NO extra effects (only Io or no effects):
  - Keep current behavior: `sm->__yo_resume_fn = resume_fn_123`

#### 2.2 `io.spawn` — inject effects and set resume function

**File**: `src/codegen/exprs/generation.ts`

At the spawn call site, when the future has effect params:

1. Check `state == 0` (pending)
2. For each using param, generate code to set the corresponding capture field
3. Set `__yo_resume_fn` to the real resume function
4. `__yo_incr_rc` and call `__yo_resume_fn`

#### 2.3 `io.await` — inject effects and set resume function (sync path)

**File**: `src/codegen/exprs/await.ts`

Same as spawn but for the synchronous await path (outside state machines):

1. Check `state == 0`
2. Inject effect values into capture struct
3. Set `__yo_resume_fn`
4. Start and wait

#### 2.4 `io.await` — inject effects (state machine path)

**File**: `src/codegen/async/state-machine.ts`

For await inside another async state machine:

1. Before the cold-start check, inject effect values into the awaited future's capture struct
2. Set `__yo_resume_fn` on the awaited future
3. The rest of the state machine await logic remains unchanged

#### 2.5 Resume function codegen

**File**: `src/codegen/exprs/async.ts`

The resume function itself doesn't change. It still calls the closure function with `&sm->__capture`. The difference is that the capture struct's effect fields are now populated by the spawner/awaiter rather than at allocation time.

### Phase 3: Using Param Codegen Plumbing

#### 3.1 Pass using args through to codegen

The key challenge: the evaluator currently evaluates `using(...)` args as compile-time values and disappears them. For the codegen to emit code that sets capture fields, it needs to know:

- Which fields in the capture struct are effect params
- What C expressions correspond to the using args at the spawn/await call site

**Approach**: The evaluator already evaluates `using(...)` arguments and type-checks them. We need the codegen to also be able to generate C code for those arguments. The using args are regular expressions at the call site — the codegen just needs to `generateExpr` for each one and assign to the corresponding capture field.

#### 3.2 Map using params to capture struct fields

The async block's capture struct has fields for each captured variable. The using params become fields in this struct. At spawn/await time, the codegen needs to know the field names and types to generate the injection code.

**Approach**: Store the using param → capture field mapping in the async block's codegen info (e.g., in `deferredAsyncBlocks` or in the future type's metadata).

### Phase 4: Testing

#### 4.1 Update `fixme.yo`

Update the fixme.yo test to verify that effect injection works:

```rust
Log :: (fn(msg : String) -> unit);
task := io.async((using(io : Io, log : Log))=> {
  log(`Task started`);
});
(given(log1) : Log) = (msg) -> { println(`Log1: ${msg}`); };
io.await(task, using(io, log1));
// Should print "Log1: Task started"
```

#### 4.2 Add tests to `async_await.test.yo`

- Effect injection via `io.await(task, using(...))`
- Effect injection via `io.spawn(task, using(...))` then `io.await(task)`
- Set-once semantics: spawn with effects, then await with different effects — first effects win
- Multiple effects: `using(io, log, raise)`
- Effect with escape (already tested)

#### 4.3 Update `ASYNC_AWAIT.md`

Document:

- Effect injection semantics
- Set-once rule
- Examples with using params on spawn/await

## Key Decisions

1. **No new API** — `io.extract` is not needed. `io.await` handles both starting+waiting (if pending) and just waiting (if already running).

2. **Set-once** — The first `io.spawn` or `io.await` that transitions a future from pending to running binds the effects. Later calls' `using(...)` are ignored.

3. **Direct field injection** — Effects are injected as capture struct fields rather than via wrapper functions. Simpler codegen, no extra function generation.

4. **NULL resume fn** — `io.async` sets `__yo_resume_fn = NULL` for effectful futures. `io.spawn/await` sets both the effects and the resume fn at start time.

## Risks and Considerations

- **Breaking change**: This changes the internal representation of async closures with effects. All existing tests should still pass since they don't use custom effects in async.
- **Effect capture ordering**: The capture struct field order must match between the closure code and the spawn/await injection code.
- **Io effect**: The Io effect itself is special — it's the Io module, which is a compile-time constant. It doesn't need runtime injection. Only user-defined effects (Log, Raise, etc.) need runtime injection.
