# Thread closure `own(self)` capture double-free

## Status: FIXED

## Summary

When a thread closure captures an RC-typed variable (e.g., `Vec(i32)`) and
that variable is consumed by an `own(self)` method call inside the closure
(e.g., `push`), a use-after-free occurs because both the thread and the main
function drop the same RC reference.

## Root cause

Three codegen bugs in the thread/worker spawn path:

1. **No dup on heap copy**: `*heapData = capture` shallow-copies the struct to
   the heap without calling `___dup`. Two copies share the same RC references.

2. **Raw free instead of drop**: `__yo_thread_entry` called `__yo_free(closure)`
   (no destructors) instead of properly dropping the capture struct's fields.

3. **Missing consumed-field tracking**: The evaluator marked ALL captured
   variables with `usageType: "own"` (meaning "captured by move"), making it
   impossible to distinguish truly consumed fields from merely borrowed ones.

## Fix

### Spawn wrapper (Dup + NULL consumed + Drop + Free)

Every `Thread.spawn` and `Worker.spawn` now generates a wrapper function:

```c
static void __yo_spawn_wrapper(void* closure) {
  ___dup(*(capture_t*)closure);           // RC+1 for all fields
  closure_fn(closure, ...);               // Run closure (may consume fields)
  ((capture_t*)closure)->consumed = NULL; // NULL only consumed fields
  ___drop(*(capture_t*)closure);          // Drop: skips NULLed, decrements rest
  __yo_free(closure);                     // Free heap struct
}
```

### Consumed capture tracking

Added `ownConsumedCaptures` to the evaluator context (`EvaluatorContext` in
`context.ts`). This is populated in `helper.ts` when a captured variable is
passed as an argument to a function parameter with `isOwningTheRcValue: true`
(i.e., `own(self)`). This is distinct from `usageType: "own"` which means
"captured by move" (all closures in Yo are move closures).

The tracking propagates through:

- `context.ts` → `ownConsumedCaptures: Set<string>`
- `helper.ts` → detects captured var passed to `own()` parameter
- `anonymous-function.ts` / `closure-type.ts` → `closureInfo.consumedCaptures`
- `closures.ts` → `implClosureCallMap` entry
- `parallelism.ts` → generates NULL assignments only for consumed fields

### Thread entry cleanup

Removed `__yo_free(closure)` from `__yo_thread_entry` and worker task execution
in `runtime.ts`. The wrapper now handles all cleanup. Shutdown cleanup for
never-executed worker tasks still uses raw `__yo_free` (correct because dup
never happened for unexecuted tasks).

## RC trace (correct behavior)

**Consumed field `base`** (passed to `own(self)` push):

- base RC=1 → wrapper dup → RC=2
- push(own): COW clone (RC>1) → drops original → RC=2→1
- NULL heap->base
- Drop: skip NULLed → no decrement
- Main deferred drop: base RC 1→0 → freed ✓

**Borrowed field `ch`** (only `.send()` called):

- ch RC=1 → wrapper dup → RC=2
- Closure borrows ch → no RC change
- NOT NULLed (not in consumedCaptures)
- Drop: ch RC 2→1
- Main deferred drop: ch RC 1→0 → freed ✓

## Files changed

- `src/evaluator/context.ts` — Added `ownConsumedCaptures?: Set<string>`
- `src/evaluator/calls/helper.ts` — Detect captured var → own() parameter
- `src/evaluator/calls/function-type.ts` — Initialize `ownConsumedCaptures`
- `src/evaluator/values/anonymous-function.ts` — Use `ownConsumedCaptures`
- `src/evaluator/calls/closure-type.ts` — Use `ownConsumedCaptures`
- `src/function-value.ts` — Added `consumedCaptures` to `ClosureInfo`
- `src/codegen/utils/index.ts` — Added `consumedCaptures` to map type
- `src/codegen/exprs/closures.ts` — Propagate consumedCaptures
- `src/codegen/exprs/parallelism.ts` — Generate wrapper with dup+NULL+drop+free
- `src/codegen/parallelism/runtime.ts` — Remove raw `__yo_free` from thread entry

## Tests

- `tests/imm_threading.test.yo` — 4 new tests exercising own(self) in thread closures
- `tmp/test_repro_own_thread.yo` — minimal reproduction (ASan clean)
