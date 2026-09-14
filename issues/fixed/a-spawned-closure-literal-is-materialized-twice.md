# A spawned closure literal's capture struct is built twice

**Status:** FIXED 2026-09-12 (`fix/zst-closure-fn-result`, the D18b branch).
**Found:** 2026-09-12, while making `Thread(T).spawn` generic for D18b.

## Symptom

The C emitted for `__yo_thread_spawn(<closure literal>)` builds the closure's
capture struct TWICE and uses only the second:

```c
temp_dup_struct_0 = cb; temp_dup_struct_0.tracked = __yo_incr_rc_atomic(...);
__capture_closure_…_1 = { .cb = temp_dup_struct_0, .sink = __yo_incr_rc_atomic(sink) };  // DEAD
temp_dup_struct_1 = cb; temp_dup_struct_1.tracked = __yo_incr_rc_atomic(...);
__capture_closure_…_2 = { .cb = temp_dup_struct_1, .sink = __yo_incr_rc_atomic(sink) };
*_thread_closure_data_0 = __capture_closure_…_2;
```

The dead copy's field initializers are `__yo_incr_rc` calls with no matching
release anywhere: one leaked reference per RC'd capture field, per spawn.

## Root cause

`generate_other_function_call` (`src/codegen/exprs/other_fn_call.yo`)
materializes every runtime argument into a value string, and only THEN
dispatches the `__yo_thread_spawn` / `__yo_worker_spawn` extern names to
`generate_thread_spawn_call`. But that emitter generates the callback
expression itself — it needs the capture STRUCT, not a value string — so the
argument is generated a second time.

It stayed invisible for as long as the argument was always a variable:
`Thread.spawn(cb)`'s callback reached this code as a PARAMETER of the
specialised `spawn` body, and materializing a variable emits no statement at
all. D18's `Thread(T).spawn` wraps the callback in a result-relaying closure
literal, `(io) => { sink.send(cb(io)); () }`, and a literal materializes into a
whole capture struct.

## Fix

Dispatch the two spawn primitives BEFORE the argument-materialization loop, and
delete the now-unreachable dispatch after it. The relocated block re-reads the
extern name from the same `function_type` meta; the only thing it skips is
`_maybe_emit_auto_borrow_assert`, which fires for `__yo_realloc` / `__yo_free`
only.

## Test

`tests/thread.test.yo`'s three spawn dispose-counter tests: with a closure
literal spawned (which is what `Thread(T).spawn` now does internally), the dead
copy's extra `__yo_incr_rc` keeps the counter below its expected 1.
