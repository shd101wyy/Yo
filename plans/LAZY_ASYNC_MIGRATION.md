# Lazy Async Execution Migration Plan

## Overview

Migrate Yo's builtin `async { ... }` / `await` from **eager execution** (futures start executing immediately on creation) to **lazy execution** (futures only execute when `await`-ed or `join`-ed). This is a prerequisite for the algebraic effects async migration, where `await` becomes an effect operation and is the sole suspension point.

## Motivation

### Why Lazy?

1. **Algebraic effects prerequisite**: We are migrating async to use algebraic effects (see `ASYNC_EFFECTS_MIGRATION.md`). In that model, `await` is the effect operation (suspension point). The `async { ... }` block should be a pure value constructor — it captures the body but does NOT execute. Execution and suspension should only happen at `await`, where the effect handler (event loop) takes control. Eager execution at `async { ... }` would mean injecting effects at the wrong point.

2. **No orphan tasks**: With eager execution, a future starts running even if never awaited. The event loop holds a reference (RC=2) and the task continues to completion. With lazy, unawaited futures are simply dropped (RC=1 → 0, freed).

3. **RC simplification**: Eager requires `refcount=2` at creation (user ref + running task ref). Lazy starts at `refcount=1` (user ref only). The event loop only takes a reference when the future is actually started via `await` or `join`.

4. **Predictable side effects**: With eager, `task := async { println("start"); ... }` prints "start" immediately at the `async` line. With lazy, nothing happens until `await task` or `join(task, ...)`.

### Rust Analogy

Rust futures are lazy — `async { ... }` returns a `Future` that does nothing until `.await`-ed or spawned onto an executor. Concurrency requires explicit combinators like `join!`, `select!`, or `tokio::spawn`.

---

## Current Behavior (Eager)

### Constructor (`generateAsyncBlockConstructor` in `src/codegen/exprs/async.ts`)

```c
SM* constructor(capture) {
  SM* sm = __yo_malloc(sizeof(SM));
  sm->header.ref_count = 1;
  sm->state = 0;
  sm->__capture = __capture;

  // EAGER: increment RC and start immediately
  __yo_incr_rc((void*)sm);  // refcount: 1 → 2
  resume_fn(sm);             // Run until first await or completion

  return sm;
}
```

### Await (in `state-machine.ts`)

At an `await` point inside a state machine:

```c
int future_state = atomic_load(&sm->future_field->state);
if (future_state == -1) {
  // Already complete — yield once (microtask semantics), then resume
  yo_async_spawn_task(resume_fn, sm);
  return;
} else {
  // Not ready — register continuation and suspend
  atomic_store(&sm->future_field->continuation_fn, resume_fn);
  atomic_store(&sm->future_field->continuation_sm, sm);
  return;
}
```

### Completion (`async-completion.ts`)

When a future completes:

```c
atomic_store(&sm->state, -1);  // Mark completed
// Spawn waiting continuation if any
if (continuation_fn != NULL) {
  yo_async_spawn_task(continuation_fn, continuation_sm);
}
__yo_decr_rc((void*)sm);  // Release "running task" reference
return;
```

### Concurrency via Eager Start

Currently, concurrency works because each `async { ... }` eagerly starts executing:

```yo
task1 := async { ...; await yield(); ... };  // Runs until yield, suspends
task2 := async { ...; await yield(); ... };  // Runs until yield, suspends
// Both are now in-flight
await task1;  // Resume and complete
await task2;  // Resume and complete
```

This works with eager execution but breaks with lazy — `task1` and `task2` would be cold until `await`-ed, and `await task1` would fully complete task1 before task2 even starts.

---

## New Behavior (Lazy)

### Core Semantics Change

| Operation                 | Eager (Current)                                                              | Lazy (New)                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `async { body }`          | Allocates SM, sets RC=2, calls resume immediately (runs until first `await`) | Allocates SM, sets RC=1 only, returns cold future. **No execution.**                                                |
| `await future`            | If complete → extract result. If pending → register continuation, suspend.   | If complete → extract result. **If cold (state==0) → start it first.** If pending → register continuation, suspend. |
| Multiple concurrent tasks | Works automatically since each `async` eagerly starts                        | Requires `join(task1, task2)` to start and drive multiple futures concurrently                                      |

### Lazy Constructor

```c
SM* constructor(capture) {
  SM* sm = __yo_malloc(sizeof(SM));
  sm->header.ref_count = 1;  // Only user's reference
  sm->state = 0;             // Cold — not started
  sm->__capture = __capture;
  // NO __yo_incr_rc, NO resume call
  return sm;
}
```

### Lazy Await

At an `await` point inside a state machine:

```c
sm->state = ${nextState};

int future_state = atomic_load(&sm->future_field->state);

if (future_state == -1) {
  // Already complete — go directly to next state
  goto state_${nextState};
} else {
  // Cold or in-progress
  __yo_incr_rc((void*)sm->future_field);  // Event loop takes a reference

  if (future_state == 0) {
    // Cold — start the future
    future_resume_fn(sm->future_field);
  }

  // Re-check after starting (may have completed synchronously)
  future_state = atomic_load(&sm->future_field->state);
  if (future_state == -1) {
    // Completed synchronously — go directly to next state
    __yo_decr_rc((void*)sm->future_field);  // Release event loop ref
    goto state_${nextState};
  }

  // Still pending — register continuation and suspend
  atomic_store(&sm->future_field->continuation_fn, resume_fn);
  atomic_store(&sm->future_field->continuation_sm, sm);
  return;  // Yield to event loop
}
```

Key differences from eager await:

1. **Cold detection**: If `state == 0`, call the future's resume function to start it
2. **Sync completion fast-path**: After starting, check if it completed; if so, skip suspension
3. **No microtask yield for ready futures**: If the future is already complete, go straight to the next state (no `yo_async_spawn_task` for ready futures). This is simpler and avoids unnecessary event loop round-trips.

### Lazy Completion

Completion is almost identical to eager, but the `__yo_decr_rc` now releases the event loop's reference (acquired at `await` time, not at construction time):

```c
atomic_store(&sm->state, -1);  // Mark completed
if (continuation_fn != NULL) {
  yo_async_spawn_task(continuation_fn, continuation_sm);
}
__yo_decr_rc((void*)sm);  // Release event loop reference (acquired at await)
return;
```

---

## `join` — Concurrent Execution Primitive

### Why `join` is Needed

With lazy futures, sequential `await` provides zero concurrency:

```yo
// NO concurrency — task1 fully completes before task2 starts
task1 := async { ... };
task2 := async { ... };
r1 := await task1;  // Starts and completes task1
r2 := await task2;  // Then starts and completes task2
```

`join` starts multiple futures and waits for all of them:

```yo
// Concurrent — both tasks run in the event loop
task1 := async { ... };
task2 := async { ... };
join(task1, task2);
r1 := await task1;  // Already complete, just extract result
r2 := await task2;  // Already complete, just extract result
```

### `join` Syntax

```yo
// Builtin function: starts all futures, waits until all complete
join(future1, future2, ...);
```

`join` is a **statement** (returns `unit`). It takes ownership of nothing — the futures remain in scope and can be `await`-ed after `join` completes to extract their results. The futures are guaranteed to be in completed state (`state == -1`) after `join` returns.

This is simpler than returning a tuple/struct of results, and avoids the problem of heterogeneous return types.

### Why Statement-Style `join`

**Option A (rejected): `join` returns results**

```yo
// Problem: heterogeneous return types need tuple/struct
{ r1, r2 } := join(task1, task2);  // Would need struct(a: T1, b: T2)
```

This requires comptime variadic struct generation, which is complex and not yet supported.

**Option B (chosen): `join` is a statement, `await` extracts results**

```yo
join(task1, task2);            // Start both, wait for both
r1 := await task1;             // Extract result (already complete)
r2 := await task2;             // Extract result (already complete)
```

This reuses the existing `await` result extraction, avoids heterogeneous return types, and is straightforward to implement. Each `await` after `join` simply checks `state == -1` and extracts the result without suspension.

### `join` Implementation

```c
// Builtin join(fa, fb, ...) codegen:

// Take event loop references
__yo_incr_rc((void*)fa);
__yo_incr_rc((void*)fb);

// Start all cold futures
if (atomic_load(&fa->state) == 0) resume_fa(fa);
if (atomic_load(&fb->state) == 0) resume_fb(fb);

// Check if all already complete
if (atomic_load(&fa->state) == -1 && atomic_load(&fb->state) == -1) {
  // All done synchronously — no suspension needed
  __yo_decr_rc((void*)fa);
  __yo_decr_rc((void*)fb);
  // Continue to next statement
} else {
  // Not all complete — need to suspend and wait
  // Store join state in the caller's SM
  sm->join_pending = 2;
  sm->join_fa = fa;
  sm->join_fb = fb;

  // Decrement join_pending for already-complete futures
  if (atomic_load(&fa->state) == -1) sm->join_pending--;
  if (atomic_load(&fb->state) == -1) sm->join_pending--;

  // Register completion callbacks on pending futures
  if (atomic_load(&fa->state) != -1) {
    atomic_store(&fa->continuation_fn, __yo_join_notify);
    atomic_store(&fa->continuation_sm, sm);
  }
  if (atomic_load(&fb->state) != -1) {
    atomic_store(&fb->continuation_fn, __yo_join_notify);
    atomic_store(&fb->continuation_sm, sm);
  }

  sm->state = ${nextState};
  return;  // Yield to event loop
}
```

**Note on continuation slots**: Each future has a single `continuation_fn`/`continuation_sm` pair. With `join`, we need multiple futures to notify the same caller SM. But each future can only store ONE continuation. This works because `__yo_join_notify` decrements `join_pending` and only re-enqueues the caller when it hits 0. The `sm` pointer is the same for both futures.

However, `continuation_sm` is shared — both futures need to point back to the caller SM. And `__yo_join_notify` needs to know which future just completed to properly manage references. A cleaner approach is to store the join barrier in the caller's SM:

```c
// __yo_join_notify: called when a joined future completes
void __yo_join_notify(void* caller_sm_ptr) {
  // The caller SM has join_pending field
  // Each future's continuation_sm points to the caller SM
  // Decrement pending count
  typedef struct { yo_ref_header_t header; _Atomic int state; } generic_sm_t;
  // We access join_pending via a known offset in the caller's SM
  // This is generated per-join-site
}
```

Actually, the simplest approach: generate a **per-join-site notify function** that knows the caller SM type and the `join_pending` field. The notify function decrements `join_pending` and respawns the caller when it reaches 0:

```c
void join_site_0_notify(void* sm_ptr) {
  CallerSM* sm = (CallerSM*)sm_ptr;
  int remaining = atomic_fetch_sub(&sm->join_pending_0, 1) - 1;
  if (remaining == 0) {
    // All joined futures complete — resume caller
    // Release event loop references
    __yo_decr_rc((void*)sm->join_fa_0);
    __yo_decr_rc((void*)sm->join_fb_0);
    yo_async_spawn_task((void(*)(void*))caller_resume, sm);
  }
}
```

### `join` with IOFutures (Kernel-Level IO)

`IOFuture` values (from `file.openat`, `file.read`, etc.) are backed by io_uring/kqueue. They are always "warm" (submitted to the kernel on creation). `join` doesn't need to start them — it just registers the completion notification:

```c
// IOFuture is already submitted (state != 0)
// Just register notification
if (atomic_load(&io_future->state) == -1) {
  // Already complete
  sm->join_pending--;
} else {
  // Register notification
  atomic_store(&io_future->continuation_fn, join_notify);
  atomic_store(&io_future->continuation_sm, sm);
}
```

---

## Implementation Steps

### Step 1: Make `async { ... }` Constructor Lazy

**File**: `src/codegen/exprs/async.ts` — `generateAsyncBlockConstructor()`

**Change**: Remove the eager execution lines (around lines 830-845):

```diff
-  // Eager execution: start running the async block immediately
-  emitter.emitLine(`  __yo_incr_rc((void*)sm);  // refcount: 1 -> 2`);
-  emitter.emitLine(`  ${resumeFunctionName}(sm);`);
+  // Lazy execution: future stays cold until await/join
+  // No __yo_incr_rc, no resume call
```

The constructor now just allocates, initializes fields, and returns `sm`.

### Step 2: Update `await` to Start Cold Futures

**File**: `src/codegen/async/state-machine.ts` — await point codegen (around lines 1140-1167)

**Change**: Before checking `future_state == -1`, add cold-start logic:

```c
sm->state = ${nextState};

int future_state = atomic_load(&sm->${futureFieldName}->state);
if (future_state == -1) {
  // Already complete — skip to next state
  goto state_${nextState};
}

// Future not complete — take event loop reference and start if cold
__yo_incr_rc((void*)sm->${futureFieldName});

if (future_state == 0) {
  // Cold future — start it
  ${futureResumeFunctionName}(sm->${futureFieldName});

  // Re-check: may have completed synchronously
  future_state = atomic_load(&sm->${futureFieldName}->state);
  if (future_state == -1) {
    __yo_decr_rc((void*)sm->${futureFieldName});  // Release event loop ref
    goto state_${nextState};
  }
}

// Still pending — register continuation and suspend
atomic_store(&sm->${futureFieldName}->continuation_fn, resume_fn);
atomic_store(&sm->${futureFieldName}->continuation_sm, sm);
return;
```

**Challenge**: We need to know the future's resume function name to start it. Currently the await codegen doesn't know this because the awaited future could be any `Impl(Future(T))`. Two approaches:

**Approach A: Store resume function pointer in the SM struct**

Add a `void (*resume_fn)(void*)` field to the state machine struct. The constructor stores the resume function pointer. The `await` codegen reads it:

```c
if (future_state == 0) {
  // Start via stored resume function pointer — works for any future type
  // But we don't currently store this...
}
```

This doesn't work easily because the future's struct layout varies.

**Approach B: Call through the resume function always via `yo_async_spawn_task` and event loop**

Instead of calling the resume function directly, enqueue it:

```c
if (future_state == 0) {
  // Start the cold future by enqueueing it
  // But we need the resume function pointer...
}
```

**Approach C (Recommended): Add a `resume_fn` field to all async SM structs**

Add a `void (*__yo_resume_fn)(void*)` field to every async state machine struct. Set it in the constructor. This allows generic cold-start at await:

```c
// In the constructor:
sm->__yo_resume_fn = (void(*)(void*))resume_fn;

// At await site:
if (future_state == 0) {
  sm->${futureFieldName}->__yo_resume_fn(sm->${futureFieldName});
}
```

This is clean and works uniformly for all future types (user async blocks, IOFutures, etc.). IOFutures don't need this field since they're always warm, but it's harmless to have it set to NULL.

### Step 3: Update `async-completion.ts` — No Change Needed

The completion code already does:

1. Set state to -1
2. Spawn continuation if registered
3. Call `__yo_decr_rc(sm)`

With lazy execution, the `__yo_decr_rc` at completion releases the event loop reference that was acquired at `await` time (Step 2). This is correct.

### Step 4: Add `__yo_resume_fn` Field to SM Struct

**File**: `src/codegen/exprs/async.ts` — `emitAsyncBlockStructDefinition()`

Add after the `continuation_sm` field:

```c
void (*__yo_resume_fn)(void*);  // Resume function pointer (for lazy start at await)
```

And in the constructor, set it:

```c
sm->__yo_resume_fn = (void(*)(void*))${resumeFunctionName};
```

### Step 5: Implement `join` Builtin

This is a new builtin keyword/function. Implementation requires changes across several layers:

**5a. Parser/Evaluator**

- Add `join` as a builtin function (like `await`)
- `join(expr1, expr2, ...)` takes 2+ future arguments
- Returns `unit`
- Can only be used inside `async { ... }` context (same restriction as `await`)

**5b. Await Analysis**

- `join` is a suspension point (like `await`), so it must be detected by `analyzeAwaitPoints`
- Each `join` creates one await point (the join itself)
- The joined futures are stored as SM fields (like `await_future_X`)

**5c. SM Struct Generation**

For each `join` point, add fields to the SM struct:

```c
// For join(fa, fb) at join point index J:
_Atomic int join_pending_J;           // Count of pending futures
// The joined futures are already stored as captured variables or await_future_X
```

**5d. SM Resume Function**

At a `join` point in the switch/case:

```c
case J: {  // Join point
  // Take event loop references
  __yo_incr_rc((void*)sm->fa);
  __yo_incr_rc((void*)sm->fb);

  // Start cold futures
  if (atomic_load(&sm->fa->state) == 0) {
    sm->fa->__yo_resume_fn(sm->fa);
  }
  if (atomic_load(&sm->fb->state) == 0) {
    sm->fb->__yo_resume_fn(sm->fb);
  }

  // Count pending
  int pending = 0;
  if (atomic_load(&sm->fa->state) != -1) pending++;
  if (atomic_load(&sm->fb->state) != -1) pending++;

  if (pending == 0) {
    // All complete — release refs and continue
    __yo_decr_rc((void*)sm->fa);
    __yo_decr_rc((void*)sm->fb);
    sm->state = J + 1;
    goto state_${J+1};
  }

  // Store pending count
  atomic_init(&sm->join_pending_J, pending);
  sm->state = J + 1;

  // Register notifications on pending futures
  if (atomic_load(&sm->fa->state) != -1) {
    atomic_store(&sm->fa->continuation_fn, (void(*)(void*))join_J_notify);
    atomic_store(&sm->fa->continuation_sm, sm);
  } else {
    __yo_decr_rc((void*)sm->fa);
  }
  if (atomic_load(&sm->fb->state) != -1) {
    atomic_store(&sm->fb->continuation_fn, (void(*)(void*))join_J_notify);
    atomic_store(&sm->fb->continuation_sm, sm);
  } else {
    __yo_decr_rc((void*)sm->fb);
  }

  return;  // Suspend until all complete
}
```

**5e. Join Notify Function Generation**

For each join point, generate a per-site notify function:

```c
void join_J_notify(void* sm_ptr) {
  CallerSM* sm = (CallerSM*)sm_ptr;
  int remaining = atomic_fetch_sub(&sm->join_pending_J, 1) - 1;
  if (remaining == 0) {
    // All joined futures done — release remaining refs and resume caller
    if (atomic_load(&sm->fa->state) == -1) __yo_decr_rc((void*)sm->fa);
    if (atomic_load(&sm->fb->state) == -1) __yo_decr_rc((void*)sm->fb);
    yo_async_spawn_task((void(*)(void*))CallerSM_resume, sm);
  }
}
```

Wait — this has a subtle issue. The notify function is called as the `continuation_fn` of a completing future. But the completion code in `async-completion.ts` does:

```c
yo_async_spawn_task(continuation_fn, continuation_sm);
```

where `continuation_sm` is the caller SM. So `join_J_notify` receives `sm_ptr` pointing to the caller SM. The `__yo_decr_rc` of the completing future happens inside `emitAsyncFutureCompletion` already. So:

Actually, looking at `async-completion.ts` more carefully:

```c
if (continuation_fn != NULL) {
  yo_async_spawn_task(continuation_fn, continuation_sm);
}
__yo_decr_rc((void*)sm);  // This is the COMPLETING future's self-decrement
```

So the completing future:

1. Spawns `continuation_fn(continuation_sm)` — in our case, `join_J_notify(caller_sm)`
2. Then decrements its own RC

And `join_J_notify` decrements `join_pending`, and when it reaches 0, spawns the caller's resume function. The event loop reference on each future (from `__yo_incr_rc` at join time) will be released at the notify function's cleanup, or we could release it immediately after the future completes (in the notify). Since the future does its own `__yo_decr_rc` at completion, we just need the notify function to release the event-loop ref we took at join time.

Simplified approach: `join_J_notify` just decrements `join_pending` and respawns when ready:

```c
void join_J_notify(void* sm_ptr) {
  CallerSM* sm = (CallerSM*)sm_ptr;
  int remaining = atomic_fetch_sub(&sm->join_pending_J, 1) - 1;
  if (remaining == 0) {
    yo_async_spawn_task((void(*)(void*))CallerSM_resume, sm);
  }
}
```

The event loop refs (`__yo_incr_rc` from join time) are released at the next state (J+1) after the join completes, when the caller extracts results via `await`.

### Step 6: Update Existing Tests

**Tests that need changes** (rely on eager semantics):

| Test                                               | What It Tests                                    | Change Needed                                                               |
| -------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| Test 1 ("Test eager async")                        | `b` modified before `await`                      | Rename to "Test lazy async" — `b` should NOT be modified until `await task` |
| Test 2 ("Test async function")                     | Same eager pattern                               | Update expectations                                                         |
| Test 16 ("Test multiple async tasks interleaving") | Order: eager task1 → eager task2 → complete both | Use `join(task1, task2)` for concurrency                                    |
| Test 22 ("Test async block with no awaits")        | Completes eagerly                                | Will complete at `await` instead                                            |

Most other tests (sequential awaits, cond with await, while with await) should work unchanged because they only have one future in scope at a time and use `await` to drive it.

### Step 7: Update `docs/ASYNC_AWAIT.md`

- Change "Eager Execution" → "Lazy Execution" throughout
- Update examples to show `join` for concurrency
- Update "Execution Model" section
- Update comparison table

---

## Detailed File Changes

### `src/codegen/exprs/async.ts`

| Function                           | Change                                                        |
| ---------------------------------- | ------------------------------------------------------------- |
| `generateAsyncBlockConstructor()`  | Remove `__yo_incr_rc` + resume call. Just return the cold SM. |
| `emitAsyncBlockStructDefinition()` | Add `__yo_resume_fn` field to SM struct.                      |

### `src/codegen/async/state-machine.ts`

| Section                                | Change                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Await point codegen (lines ~1140-1167) | Add cold-start logic: check state==0, call `__yo_resume_fn`, check sync completion. |

### `src/codegen/async/runtime-core.ts`

| Change                                                           |
| ---------------------------------------------------------------- |
| No changes needed. Event loop already processes tasks correctly. |

### `src/codegen/exprs/async-completion.ts`

| Change                                                                              |
| ----------------------------------------------------------------------------------- |
| No changes needed. `__yo_decr_rc` at completion releases whatever ref was acquired. |

### New files for `join`

| File                              | Purpose                                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| Parser/evaluator changes          | Add `join` as builtin, type-check arguments                         |
| `src/codegen/async/join.ts` (new) | Generate join point codegen: notify function, SM fields, join logic |
| Await analysis changes            | Detect `join()` as a suspension point                               |

---

## Semantic Changes Summary

### Before (Eager)

```yo
async {
  task1 := async {
    printf("Task 1 started\n");  // Prints NOW (eager)
    await yield();
    printf("Task 1 done\n");
  };
  // "Task 1 started" already printed

  task2 := async {
    printf("Task 2 started\n");  // Prints NOW (eager)
    await yield();
    printf("Task 2 done\n");
  };
  // "Task 2 started" already printed
  // Both tasks suspended at yield

  await task1;  // Resumes task1, prints "Task 1 done"
  await task2;  // Resumes task2, prints "Task 2 done"
};
```

Output: `Task 1 started → Task 2 started → Task 1 done → Task 2 done`

### After (Lazy)

```yo
async {
  task1 := async {
    printf("Task 1 started\n");  // NOT printed yet
    await yield();
    printf("Task 1 done\n");
  };
  // task1 is cold, nothing happened

  task2 := async {
    printf("Task 2 started\n");  // NOT printed yet
    await yield();
    printf("Task 2 done\n");
  };
  // task2 is cold, nothing happened

  // Option A: Sequential (no concurrency)
  // await task1;  // Starts task1, runs to completion
  // await task2;  // Starts task2, runs to completion
  // Output: Task 1 started → Task 1 done → Task 2 started → Task 2 done

  // Option B: Concurrent (use join)
  join(task1, task2);  // Starts both, event loop interleaves
  await task1;         // Extract result (already complete)
  await task2;         // Extract result (already complete)
  // Output: Task 1 started → Task 2 started → Task 1 done → Task 2 done
};
```

---

## Risk Assessment

| Risk                                              | Severity | Mitigation                                                                                                    |
| ------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| Breaking 54 async tests                           | High     | Most tests use single-future patterns (await immediately after async). Only ~6 tests rely on eager semantics. |
| `__yo_resume_fn` pointer adds 8 bytes to every SM | Low      | Negligible; SM structs are already 32-500 bytes.                                                              |
| `join` interaction with cond/while await patterns | Medium   | `join` is a simple suspension point like `await`. The existing cond/while handling should work.               |
| IOFuture compatibility                            | Low      | IOFutures are always warm (state != 0). The cold-start check passes through harmlessly.                       |
| RC correctness                                    | Medium   | Test all changes with `--sanitize address`. The RC model is simpler with lazy (no dual-ref at creation).      |

---

## Migration Order

```
Step 1-2        Step 4          Step 5          Step 6
(core lazy)     (resume_fn)     (join)          (tests)

Remove eager    Add resume_fn   Implement       Update tests
from constructor field to SM    join builtin    for lazy
+ update await  structs                         semantics

     └────────────┘                  │
     Core lazy changes               │
     (tests with single              │
      future still pass)      Concurrency primitive
```

**Step 1-2** can be done together. Most existing tests should pass since they use `await` immediately after `async` (the `await` will start the cold future).

**Step 4** is a prerequisite for Step 2 (await needs `__yo_resume_fn` to start cold futures).

**Step 5** (`join`) is needed for the ~6 tests that rely on concurrent execution.

**Step 6** updates the remaining tests.

---

## Open Questions

### 1. Should `await` on an Already-Complete Future Skip the Event Loop?

With eager execution, even ready futures yield once (microtask semantics):

```c
if (future_state == -1) {
  yo_async_spawn_task(resume_fn, sm);  // Yield once, resume next tick
  return;
}
```

With lazy, if a future completes synchronously at `await` time, we can skip the yield and go directly to the next state:

```c
if (future_state == -1) {
  goto state_next;  // No yield, continue immediately
}
```

**Recommendation**: Skip the yield for ready futures. The microtask yield was only useful with eager execution to give other eagerly-started tasks a chance to run. With lazy, there are no other running tasks unless `join` started them.

### 2. Should `join` Be a Keyword or a Builtin Function?

- **Keyword**: `join task1, task2;` — more syntactic integration
- **Builtin function**: `join(task1, task2);` — simpler parser changes

**Recommendation**: Start as a builtin function. Easier to implement and consistent with `await` being a builtin function call.

### 3. Variadic `join`?

`join(a, b)` handles 2 futures. For 3+:

- Fixed-arity overloads: `join` handles 2-8 arguments (pragmatic)
- Variadic: `join(a, b, c, ...)` via comptime (more complex)

**Recommendation**: Start with variadic (any number of arguments). The codegen just loops over the arguments. The await analysis treats it as one suspension point regardless of argument count.

---

## Implementation Progress

### Completed: Core Lazy Execution (Steps 1, 2, 4, 6)

All core lazy execution changes are complete. **54/54 async tests pass.**

#### Changes Made

**Step 1: Made `async { ... }` Constructor Lazy**

File: `src/codegen/exprs/async.ts` — `generateAsyncBlockConstructor()`

- Removed `__yo_incr_rc` and resume call from constructor
- Constructor now just allocates, initializes fields, and returns the cold SM with `refcount=1`
- Also removed the sync-context eager start that was in `generateAsyncBlock()` — previously, when `!context.inStateMachine`, the call site would eagerly start the future after construction. This defeated lazy semantics. Now ALL contexts are lazy.

**Step 2: Updated `await` to Start Cold Futures**

File: `src/codegen/async/state-machine.ts`

- Added cold-start logic at await points: if `state == 0`, call `__yo_resume_fn` to start the future
- Added sync completion fast-path: after starting, if the future completed synchronously, `goto` next state (no suspension)
- Pre-completed futures (like `yield()`) still yield to the event loop via `yo_async_spawn_task` for fairness

Await codegen now follows three paths:

1. **Pre-completed** (`state == -1`): microtask yield to event loop, then resume
2. **Cold** (`state == 0`): start via `__yo_resume_fn`, check sync completion, suspend if still pending
3. **In-progress** (`state > 0`): register continuation and suspend

**Step 4: Added `__yo_resume_fn` Field to SM Structs**

File: `src/codegen/exprs/async.ts`

- Added `void (*__yo_resume_fn)(void*)` field to every async state machine struct
- Set in constructor: `sm->__yo_resume_fn = (void(*)(void*))resume_fn`
- Enables generic cold-start at await: `sm->future_field->__yo_resume_fn(sm->future_field)`

**Step 6: Updated Tests for Lazy Semantics**

File: `tests/async_await.test.yo`

13 tests updated:

- Wrapped test bodies in `async { ... }` blocks where needed (tests that were in sync context)
- Added `await task` before assertions that depend on task completion
- Added pre-await assertions verifying lazy behavior (e.g., `assert(b.* == 0, "before await (lazy)")`)
- Renamed "Test eager async" → "Test lazy async"
- Renamed "Test multiple async tasks interleaving" → "Test lazy sequential async tasks" (rewritten to test sequential lazy semantics — no interleaving without `join`)
- Fixed 4 tests that were passing vacuously (assertions only inside unawaited tasks)

**Bug Fix: Type Resolution for Async Functions in State Machine Context**

File: `src/codegen/utils/index.ts` — `getTypeString()`

When an async function definition was placed inside an `async { ... }` block (state machine context), the function's return type `Impl(Future(T))` was resolved to a generic trait type name (e.g., `yo_future_trait_i32`) instead of the specific state machine struct type. This happened because:

1. The function's return `SomeType` has a different ID than the inner async block's `SomeType`
2. The fallback chain checked the `FutureTraitType` (shared across all async blocks with the same output type) before checking `resolvedConcreteType`
3. The `FutureTraitType` was registered but pointed to a forward-declared-only struct

Fix: Reordered the type resolution fallback chain to check `resolvedConcreteType` (which points to the actual state machine struct's `SomeType`) BEFORE the `FutureTraitType` fallback.

#### RC Lifecycle with Lazy Execution

```
async { body }  →  SM allocated, refcount=1 (user ref), state=0 (cold)
await future    →  __yo_incr_rc (event loop ref), start via __yo_resume_fn
                   (refcount=2: user ref + event loop ref)
completion      →  __yo_decr_rc (release event loop ref, refcount=1)
user drop       →  __yo_decr_rc (release user ref, refcount=0, freed)
```

### Completed: `join` Builtin (Step 5)

`join` is now fully implemented as a builtin function for concurrent execution of multiple futures. **58/58 async tests pass** (54 original + 4 new join tests).

#### Changes Made

**Evaluator:**

- `src/expr.ts`: Registered `join` in `BuiltinFunctions` alongside `await`
- `src/evaluator/builtins/future-fns.ts`: Added `evaluateJoin()` — accepts 1+ Future arguments, requires async-block context, returns `unit`
- `src/evaluator/exprs/_expr.ts`: Added dispatch for `join` after `await`

**Await Analysis:**

- `src/evaluator/async/await-analysis-types.ts`: Extended `AwaitPoint` with `isJoinPoint`, `joinFutureVariableIds`, `joinFutureCount`, `joinFutureTypes`
- `src/evaluator/async/await-analysis.ts`: Added join detection in `walkExprForAwaits()` — extracts future variable IDs and types from each argument, creates a single `AwaitPoint` with `isJoinPoint: true`
- `src/expr-traversal.ts`: Added `BuiltinFunctions.join` to `exprContainsAwait()`
- `src/codegen/async/state-code-gen.ts`: Added `BuiltinFunctions.join` to `branchHasAwait()`

**Code Generation:**

- `src/codegen/exprs/async.ts`:

  - SM struct: Added `_Atomic int join_pending_N` fields for each join point
  - Filtered join points from generating `await_future_X` fields (join futures are already captured variables)
  - Generated per-join-site notify functions:
    ```c
    static void X_join_N_notify(void* sm_ptr) {
      X_state_t* sm = (X_state_t*)sm_ptr;
      int prev = atomic_fetch_sub_explicit(&sm->join_pending_N, 1, memory_order_acq_rel);
      if (prev == 1) {
        yo_async_spawn_task((void (*)(void*))X_resume, (void*)sm);
      }
      __yo_decr_rc((void*)sm);  // Release per-future event loop ref
    }
    ```

- `src/codegen/async/state-machine.ts`:

  - Added join codegen in resume function: sets state, initializes atomic counter, loops through futures
  - For each future: if pre-completed → decrement counter directly; if cold/pending → `incr_rc`, set notify as continuation, start if cold
  - Skips temp future cleanup for join points (futures remain as captured variables for later `await`)

- `src/codegen/exprs/generation.ts`: Added dispatch for `BuiltinFunctions.join` that returns empty string in state machine context

#### Join RC Lifecycle

```
join(fa, fb)    →  For each cold/pending future:
                     __yo_incr_rc(sm)      // event loop ref for notify callback
                     __yo_incr_rc(future)  // event loop ref for future
                     Set continuation_fn = join_N_notify
                     Start if cold
                   Initialize atomic counter to number of futures

notify callback →  atomic_fetch_sub(join_pending_N, 1)
                   if (prev == 1): spawn resume task
                   __yo_decr_rc(sm)  // release per-future event loop ref

await(fa)       →  Future already complete (state == -1) after join
                   Extracts result, yields to event loop for fairness
```

#### Tests Added

4 new join tests in `tests/async_await.test.yo`:

1. **Test basic join of two futures** — two cold futures started concurrently, counter incremented by both
2. **Test join single future** — edge case with one argument
3. **Test join with multi-yield futures** — futures with multiple `await yield()` inside
4. **Test code after join** — verify execution continues normally after join, including subsequent awaits
