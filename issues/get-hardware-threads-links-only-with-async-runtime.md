# `std/thread`'s `get_hardware_threads` only links when the program also uses async

**Status:** OPEN. Pre-existing (`std/thread.yo` has exported this alias since
the module was written); found while building `ThreadPool`.

## Symptom

```
error: call to undeclared function '__yo_thread_get_hardware_threads';
       ISO C99 and later do not support implicit function declarations
note:  did you mean '__yo_get_hardware_threads'?
note:  '__yo_get_hardware_threads' declared here
```

## Reproducer

`issues/repros/get-hardware-threads-needs-async-runtime.yo` — a program that
uses threads but no async.

```
yo compile issues/repros/get-hardware-threads-needs-async-runtime.yo --release -o /tmp/r.out
```

## Root cause

There are two runtime copies of the same function under different names:

| C symbol                            | emitted by                                       | gate            |
| ----------------------------------- | ------------------------------------------------ | --------------- |
| `__yo_thread_get_hardware_threads`  | `src/codegen/async/runtime_core.yo:224`           | `uses_async`    |
| `__yo_get_hardware_threads`         | `src/codegen/parallelism/runtime.yo:404`          | `uses_parallelism` |

`std/thread.yo` declares the extern under the **async** name, so a program that
pulls in only the parallelism runtime gets a dangling reference.

## Fix options

1. Emit `__yo_thread_get_hardware_threads` from the parallelism runtime too
   (or have one alias the other), or
2. add it to `_is_threading_macro_function`'s suppression family and give the
   parallelism runtime the canonical definition.

Either way the two copies should collapse into one.

## Workaround in place

`ThreadPool.with_hardware_threads()` uses `__yo_worker_get_num_threads()`
instead — the parallelism runtime's accessor, which already falls back to
`__yo_get_hardware_threads()` when no count has been set.
