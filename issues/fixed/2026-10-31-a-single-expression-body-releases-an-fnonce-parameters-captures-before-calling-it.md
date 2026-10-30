# A single-expression body releases an `FnOnce` parameter's captures before calling it

**Severity:** S1 — a use after drop in safe code. A function whose whole body is a call of its `FnOnce` parameter (`run :: (fn(sink(body) : Impl(FnOnce() -> R)) -> R)(body())`) dropped the closure's captures before the call, so the closure body read dropped values. For a capture that owns heap memory (a `String` once B8 makes it a value) this is a read of freed memory.

**Status:** FIXED 2026-10-31 on `fix/closure-capture-mut-receiver-spill`. Found the same day on `vbd/b8-arraylist-string-flip`: `tests/fn_once.test.yo`'s "FnOnce: a generic FnOnce sink parameter is callable inside its own callee" read `s.len()` as 0 once `String` became a value. Develop `9c78fdaf0` and the v0.2.73 seed drop a move-only `Drop` capture before the call in the same shape, generic callee or not.

## Reproducer

The test "FnOnce: a single-expression body releases its parameter's captures after the call" in `tests/fn_once.test.yo`:

```yo
_once_call_tail :: (fn(sink(body) : Impl(FnOnce() -> i32)) -> i32)(
  body()
);
test("…", {
  before := g_once_disposed;
  t := _OnceTok(n : i32(4)); // Drop counts g_once_disposed
  seen := _once_call_tail(() => ((t.n * i32(10)) + (g_once_disposed - before)));
  assert(seen == i32(40), "the capture is alive while the body runs");
});
```

The seed gives 41: `t` was dropped before the closure body ran. A body written as a block (`{ r := body(); r }`) gives 40.

## Cause

A call of an `FnOnce` closure that does not release itself gets a post-call release, `___drop(body)`, appended to the call's deferred drops (`_record_fnonce_callee_release`, `src/evaluator/calls/function.yo`), for the call's post-call flush. When the call is the whole body, the body node shares its id with the call, and the function emitter flushes that node's deferred drops once before the body (`generate_deferred_drop_expressions(..., skip_param_drops = true)`, `src/codegen/functions/generation.yo`). That flush-first skips parameter-targeted drops, but `_drop_target_is_parameter` answers false for a post-call release on purpose (so the call's flush emits it even for a parameter callee), so the release ran first:

```c
drop(&(__yo_v_body).__yo_v_t);           // the flush-first
size_t r = closure(&(__yo_v_body));       // reads the dropped capture
```

## Fix

`generate_deferred_drop_expressions` (`src/codegen/exprs/drop_dup.yo`) also leaves a post-call release out of the flush-first pass, so only the call's own post-call flush emits it, after the call.
