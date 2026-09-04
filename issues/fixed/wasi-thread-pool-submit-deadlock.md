# ThreadPool accepted work no thread can run, then `join_all` deadlocked forever

**Found**: 2026-08-27, PR #309 run 7 — the `test-wasm32_wasi` leg ran for
**3 h 31 min** inside a single test and was killed by cancellation, leaving an
orphan `wasmtime` process spinning. **Fixed**: same day. The interim WASI skip on
`tests/control_fn_as_regular_call.test.yo` (which shipped in #309 to unblock CI)
is REMOVED by the fix — that test now runs all three of its tests on WASI.

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

## Fix

Both spawn paths now run the task **inline on the submitting thread** when its
slot has no OS thread, rather than queueing work nothing will pick up. The
alternative — failing loudly, as Rust's `thread::spawn` does on threadless wasm
— was rejected because `spawn(pool, cb)` returns `unit`, so aborting the process
is the only way it could "report", and running the task sequentially fulfils the
contract that a thread-less platform can actually keep.

- `__yo_worker_spawn`: `if (!__yo_worker_threads[thread_idx].running) { fn(closure); return; }`
  before the task node is allocated. The spawn wrapper is thread-agnostic (call
  the closure, drop its captures, free them), so nothing in it assumes a fresh
  thread. The worker entry's per-task epilogue is deliberately NOT run inline:
  `__yo_async_wait_all()` would drain the CALLER's event loop from inside a
  submission (re-entrancy), and `__yo_gc_collect()` belongs to the worker's own
  heap. The consequence — a task's async tail completes at the caller's next
  drain rather than inside `join_all` — is the honest cost of having no thread.
- `__yo_thread_spawn`: same inline call on a `pthread_create` failure, which also
  closes the capture leak (the wrapper that drops and frees the closure IS the
  thread body, so a swallowed failure leaked every captured Rc).
- `__yo_thread_join`: skips a zero handle instead of calling `pthread_join(0)`,
  which is undefined. The predicate is a new `__YO_THREAD_HANDLE_IS_NULL` macro
  emitted beside the thread typedefs in `src/codegen/types/generation.yo`, one
  definition per platform branch (`== NULL` for the Windows `HANDLE`,
  `== (pthread_t)0` for POSIX — the zero-handle convention this runtime already
  wrote on that path).

## Verification

- `tests/control_fn_as_regular_call.test.yo` — WASI skip removed; all 3 tests
  pass under `--target wasm-wasi` in seconds where the leg previously hung for
  3.4 h.
- **Vacuity-probed**: flipping the worker closure's expectation to `i32(7)` makes
  the WASI run FAIL with that closure's own assertion message, so the task body
  genuinely executes inline there rather than being skipped.
- Natively (`tests/control_fn_as_regular_call`, `tests/thread`,
  `tests/thread_pool`): 13 pass. The new branch is dead on any platform where
  thread creation succeeds, so ordinary pool behaviour is untouched.
