# ThreadPool accepts work no thread can run, then `join_all` deadlocks forever

**Found**: 2026-08-27, PR #309 run 7 — the `test-wasm32_wasi` leg ran for
**3 h 31 min** inside a single test and was killed by cancellation, leaving an
orphan `wasmtime` process spinning. **Status**: OPEN (the runtime fix is its own
change — it re-emits the parallelism runtime for every platform and needs a full
battery). The test that tripped it is skipped on WASI in the meantime, matching
the convention already used by `tests/thread.test.yo`,
`tests/thread_pool.test.yo` and `tests/imm_threading.test.yo`.

## Symptom

`tests/control_fn_as_regular_call.test.yo`'s third test ("control fn called
from worker closures") printed nothing after its first two siblings passed:

```
11:09:22 tests/control_fn_as_regular_call.test.yo
11:09:22   ✓ control fn called as regular function from single site
11:09:22   ✓ control fn called as regular function from multiple sites
14:20:17 ##[error]The operation was canceled.
14:20:18 Terminate orphan process: pid (10085) (wasmtime)
```

The same file passes all three tests on native macOS/Linux **and** on
wasm32-emscripten (whose pthread emulation really runs the task), so this is
standalone-WASI-specific. Nothing in the suite caught it earlier only because
`--bail` stopped the leg at failures further up the alphabet; fixing those moved
the frontier onto this file.

## Mechanism

On standalone WASI there are no threads: `pthread_create` fails. The pool
handles that failure at *init* but not at *submission*.

1. `__yo_worker_pool_init` (`src/codegen/parallelism/runtime.yo:326`) checks the
   return code, and for a slot whose thread could not be created sets
   `worker->running = 0` and force-marks `worker->started = 1` — deliberately,
   so the "wait for all workers to start" loop cannot spin forever.
2. `__yo_worker_spawn` (same file, ~:480) then ignores `running` entirely: it
   allocates a task node, appends it to the selected worker's queue and signals
   `worker->cond`. No thread is waiting on that condvar, so the task simply sits
   in the queue.
3. `ThreadPool.join_all` (`std/thread.yo:149`) drains by submitting one sentinel
   task per worker and blocking on a channel until each has run:

   ```rust
   while(runtime(i < workers), { __yo_worker_spawn((io : Io) => { drained.send(true); () }); … });
   while(runtime(seen < workers), { drained.recv().unwrap(); seen = (seen + usize(1)); });
   ```

   The sentinels are queued to dead workers, `drained.recv()` blocks, and the
   process hangs — with no diagnostic, forever.

So the bug is not "threads are unavailable" (that is a platform fact the runtime
already detects). It is that the pool **silently accepts work it can never run**
and the documented drain then blocks with no error. `spawn(pool, cb)` returns
`unit`, so a caller has no channel to learn any of this.

## Reproducer

```bash
yo test ./tests/control_fn_as_regular_call.test.yo --parallel 1 --target wasm-wasi
# before the skip: hangs indefinitely after the 2nd test, kill required
```

Minimal shape (any WASI build): `pool := ThreadPool.new(usize(2)); spawn(pool,
(io) => { … }); pool.join_all();` — `join_all` never returns.

## What a fix needs

`__yo_worker_spawn` must not enqueue to a worker with `running == 0`. Two honest
options, to be decided when the fix lands:

- **Run the task inline on the submitting thread.** The work happens, `join_all`
  returns, and a thread-less platform behaves like a synchronous pool. Costs the
  documented per-task isolation (own Io event loop, own GC heap), and needs care
  about which of the worker entry's per-task epilogue (`async_wait_worker`,
  `__yo_gc_collect`) is safe to run on the caller's thread.
- **Fail loudly at submission** — the Rust posture, where
  `thread::spawn` on threadless wasm returns `Err`. Turns a silent 3-hour hang
  into an immediate, diagnosable abort, but kills programs that would have been
  correct sequentially.

Either way the deadlock goes, and `Thread.spawn`'s sibling hole should be closed
in the same pass: it also swallows a `pthread_create` failure
(`runtime.yo:176`), returning a `Thread` with a null handle whose closure never
runs and whose `join` is a no-op — the same "silently dropped work" class,
currently invisible because the whole thread test surface is skipped on WASI.
