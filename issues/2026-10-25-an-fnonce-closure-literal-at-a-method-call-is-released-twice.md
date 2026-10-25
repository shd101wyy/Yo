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

## Why B4-0b is blocked on it

`std/sync/refcell.yo`'s `with_mut` → `sink(body) : Impl(FnOnce(...))` (decision
37, plans/handover/VBD_LOOKAHEAD_2026-10-23.md §4.1) makes every
`g.with_mut(m => ...)` in src (~767 calls, capturing lambdas) take this shape;
each emitted call would double-release. The compiler itself calls with_mut 767
times, so a self-compiled binary corrupts its own heap. B4-0b's part 1 (the
flip) and part 3 (the ~82 capture-list conversions) are deferred until this is
fixed; branch `vbd/b4-0b-full-state` carries the working callee-side legality
fixes (see the sibling issue) plus the flip for reference.

## The fix direction

Find where the impl-method call path processes its non-receiver arguments (it
does not run `consume_argument_for_parameter`'s 4b consume for the closure
literal, or the consume does not mark the temp the emitted drop pass reads),
and make it consume an FnOnce-typed closure literal exactly as the free-fn
path does (`calls/function.yo`'s funcval argument loop, ~9947, and
`consume_argument_for_parameter`'s `(param_is_sink ||
_is_callable_value_type(...))` arm). Then re-verify `m2`/`ub2` run rc=0.

## The test

`tests/fn_once.test.yo` gains "an FnOnce closure literal at a method call
releases its captures once" when this lands (blocked with the flip: the shape
needs `Impl(FnOnce)` at a method, which the sibling bug's fix enables).
