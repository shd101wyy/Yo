# A spawn wrapper closure that forwards its `io : Io` parameter gets a stale `Io` C type

**Status:** OPEN — blocks a std-side wrapper around a user task closure
(per-task `JoinHandle`-analog, completion accounting), plans/STD_API_AUDIT.md D7.

## Symptom

`Io` is a prelude struct whose fields are generic fn types, so every closure
that uses `io.async`/`io.await` instantiates its own `Io` C struct. A wrapper
closure that forwards its own `io` parameter to a captured task closure is
emitted with one of those types and used for all of them:

```
error: passing '__yo_t17' (aka 'struct __yo_t17_struct') to parameter of
       incompatible type '__yo_t2' (aka 'struct __yo_t2_struct')
error: passing '__yo_t2'  (aka 'struct __yo_t2_struct')  to parameter of
       incompatible type '__yo_t17' (aka 'struct __yo_t17_struct')
```

Both wrappers ARE emitted (one per specialization) — they are simply **swapped**,
each calling the other specialization's task function:

```c
static inline void closure_yo_id_7119(void* closure_context, __yo_t17 io) {
  closure_yo_id_7108(&(((__yo_t16*)closure_context)->cb), io);   // wants __yo_t2
```

## Reproducer

`issues/repros/spawn-wrapper-forwarded-io-crosses-specializations.yo`

```
yo compile issues/repros/spawn-wrapper-forwarded-io-crosses-specializations.yo --release -o /tmp/r.out
```

## Partial workaround (not sufficient)

Passing `__yo_builtin_io` instead of the wrapper's own parameter makes the
two-shape case compile and run: both are a zero-initialized `Io` at runtime
(codegen passes `(Io){0}` into every spawn closure and lowers `io.async` /
`io.await` statically), and the compiler then materializes a compound literal
per specialization. With four task shapes the `__yo_builtin_io` node is itself
pinned to one `Io` type and the crossing returns:

```
closure_yo_id_8914(&(((__yo_t51*)closure_context)->cb),
                   (__yo_t27){ .async = NULL, .await = NULL, .state = NULL, .spawn = NULL });
// note: parameter 'io' here has type __yo_t46
```

`Dyn(Fn(io : Io) -> unit, Send)` does not help either — the crossing just moves
into the vtable thunk.

## Impact today

`std/thread`'s `ThreadPool` cannot wrap the user's task closure, so:

- `spawn` returns `unit` instead of a per-task handle;
- `join_all` is implemented as a **barrier** (one sentinel task per worker
  thread, relying on the runtime's round-robin distribution + per-worker FIFO
  queues) rather than as a completion counter.
