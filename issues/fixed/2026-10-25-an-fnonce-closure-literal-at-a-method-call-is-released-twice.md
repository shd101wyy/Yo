# An FnOnce closure literal at a method call is released twice

**Severity:** S1 (silent heap corruption — a refcount underflow at program
exit — in a shape that check accepts; found by B4-0b, not reachable on develop
because a sibling bug rejects the shape at check)

## The bug

Passing an FnOnce-typed CLOSURE LITERAL (implicit or explicit captures holding
RC values) as an argument at an IMPL-METHOD call double-releases its captures:
the closure body function's own epilogue releases them once (the `FnOnce` call
consumes the closure, decision 37), and the caller's scope-end drop releases
the capture struct's fields again, because the method-call path never marks
the closure temp CONSUMED.

```yo ignore
CellM :: struct(s : String);
impl(
  CellM,
  run_once : (fn(generic(R : Type), self : &Self, body : Impl(FnOnce() -> R)) -> R)(
    body()
  )
);
main :: (fn() -> unit)({
  c := CellM(s : String.from("ab"));
  s2 := String.from("xy");
  n := c.run_once(() => s2.len()); // check OK; runs, then
  //    "tcache_thread_shutdown(): unaligned tcache chunk detected", rc=134
});
```

Measured shapes (repros preserved in `~/Workspace/Yo-wt/vbd-logs/b4-0b/`):
`m2.yo` (impl method + non-sink `Impl(FnOnce)`), `ub2.yo` (the converted
`RefCell.with_mut` with a capture-list body), `pb.yo` (with_mut through a
free-fn wrapper — CLEAN), `m3.yo` (free fn — CLEAN), `m1.yo` (impl method +
`Impl(Fn)` — CLEAN), `m4.yo` (impl method + a NAMED closure value — CLEAN).
So the hole is exactly (impl-method call) × (FnOnce-typed literal) × (RC
captures): the free-fn path consumes the temp (`consume_argument_for_parameter`
4b) and emits no caller-side drop; the method path emits the drop anyway.

The emitted C shows it directly: the callee's closure body ends with
`decr_rc(ctx->s)` AND main's epilogue ends with `decr_rc(cap.s)` for the same
count (`/tmp/m2c.c` vs `/tmp/m3c.c`, stage-2 binary of branch
`vbd/b4-0b-full-state`).

## Why it was latent on develop

The shape could not pass check on develop: the callee's own call of its
`FnOnce` parameter was the false E0901 of the sibling S2
(`issues/fixed/2026-10-25-a-generic-fnonce-sink-parameter-binds-as-a-borrow-inside-its-callee.md`).
Fixing that S2 alone turns the compile error into silent heap corruption, and
`std/sync/refcell.yo`'s planned `with_mut` → `sink(body) : Impl(FnOnce(...))`
flip (decision 37, plans/handover/VBD_LOOKAHEAD_2026-10-23.md §4.1 B4-0b)
would put every one of src's capturing `g.with_mut(m => ...)` calls into it.

## Root cause

A generic callee defers a closure-literal argument whose parameter type
mentions the callee's type parameter (`fn_literal_arg_is_deferred`); the
literal is then typed as a bare `fn(...)`, with its capture struct on the
side (`expr_info_capture_type`). A `fn(...)` type is bitwise-copyable, so
`consume_argument_for_parameter` treats the argument as a copy and never
consumes the temp: the caller keeps the closure and releases its captures at
its scope end. The free-function path (the inline FuncVal arm of
`src/evaluator/calls/function.yo`) has judged such an argument by its capture
struct since #1428 (`_fv_closure_argument_owned_type`), so the transfer moves
it and the callee binds the parameter owning. The METHOD-call path goes
through `check_if_function_parameter_matches_argument`
(`src/evaluator/calls/helper.yo`), which had no such judgment: the caller
kept the literal, while the callee's (now owning) parameter released it
again through the `FnOnce` call.

## The fix

**Status:** fixed 2026-10-27 (branch `fix/b4-0b-fnonce-compiler-half`).

- The judgment moves to `src/evaluator/calls/helper.yo` as
  `closure_argument_owned_type` (exported; the inline FuncVal arm imports it
  instead of its private copy).
- `check_if_function_parameter_matches_argument` applies it: for a by-value
  parameter, a deferred closure literal whose capture struct is not
  bitwise-copyable is retyped to that struct for the ownership transfer
  (Steps 4a–4c, so the caller's temp is consumed and no caller-side drop is
  emitted), and Step 9 binds the parameter at that struct type. Synthesis and
  the compatibility check still read the `fn(...)` type.

Verified with a build of the branch: `m2.yo` (impl method, non-sink
`Impl(FnOnce)`) and a generic-container `with_mut`-shaped method taking
`sink(body) : Impl(FnOnce(v : &mut T) -> R)` with a capture-list move, an
implicit capture and an uncalled body, all run clean under
`--sanitize address` (LeakSanitizer included); before the fix both report
heap-use-after-free.

## The test

`tests/fn_once.test.yo`: "a closure literal at an impl-method call releases
its captures once" (an impl method with a by-value `Impl(FnOnce)` parameter,
one with a `sink` parameter, and one that never calls its `sink` parameter;
implicit `String` captures and capture-list `_OnceTok` moves, with exact
`Drop` counts) and "a generic container's FnOnce sink method takes a
capture-list move once" (the `RefCell.with_mut` shape on a generic struct).
