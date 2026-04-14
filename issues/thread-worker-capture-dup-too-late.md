# Thread/Worker closure heap copy duplicated captures too late

## Bug

The thread/worker spawn code heap-copied closure capture structs with a plain C
assignment, then duplicated captured RC fields only inside the spawned wrapper
function.

That meant the heap copy did **not** own its captured RC values during the
window between `Thread.spawn`/`Worker.spawn` returning and the spawned thread or
worker task actually starting.

## Impact

If the creator dropped its local captures before the spawned closure began
executing, the wrapper would call `___dup` on already-freed RC values. This is a
real use-after-free.

The bug is easy to reproduce with a queued worker task:

1. Saturate all worker threads with blocking tasks.
2. Create a local `ImmString` in an inner block.
3. Queue a worker task that captures that `ImmString`.
4. Exit the block so the creator drops the local string.
5. Let the queued task start.

Before the fix, ASAN reports a heap-use-after-free in
`__yo_spawn_wrapper_*` when it tries to duplicate the freed capture.

## Root cause

In `src/codegen/exprs/parallelism.ts`:

- `generateThreadSpawnCall` and `generateWorkerSpawnCall` did:

  ```c
  *heapData = closure_value;
  __yo_thread_spawn(wrapper, heapData);
  ```

- `generateSpawnWrapper` then did:

  ```c
  ___dup(*closure);
  closure_fn(closure);
  ___drop(*closure);
  __yo_free(closure);
  ```

The duplication happened in the wrong place. Ownership must be transferred to
the heap copy **before** spawn/enqueue, not when the spawned thread/task starts.

## Fix

Move the `___dup` call to the creator side:

```c
*heapData = closure_value;
___dup(*heapData);
__yo_thread_spawn(wrapper, heapData);
```

Then the wrapper only needs to:

1. Call the closure
2. Null out consumed captures
3. Drop the heap copy
4. Free the heap allocation

## Regression coverage

Add a regression test that queues a worker task while all workers are blocked,
captures an `ImmString` from an inner block, exits the block before the task can
start, then releases the workers. The task must still read the captured string
correctly.
