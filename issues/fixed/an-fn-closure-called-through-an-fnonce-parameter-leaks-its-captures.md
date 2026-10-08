# An `Fn` closure called through an `FnOnce` parameter leaks its captures

**Severity:** S2: an unbounded leak. Every call of an `Fn` closure through an `FnOnce(...)` slot leaked the closure's captures: a captured value's `Dispose` never ran and a captured RC value was never released.

> Found 2026-10-08 while landing `plans/VALUES_BY_DEFAULT.md` decision 37's Generation B (`Thread.spawn` takes `sink(cb) : Impl(FnOnce(...), Send)`): three existing `tests/thread.test.yo` cases that count capture disposals failed. Introduced by decision 37's Generation A (#1266). **FIXED same day.**

## Reproducer

```rust
(g_n : i32) = i32(0);
_T :: struct(tag : i32);
impl(_T, Dispose(dispose : (fn(self : Self) -> unit)({ g_n = (g_n + i32(1)); })));
run_once :: (fn(sink(cb) : Impl(FnOnce() -> i32)) -> i32)(cb());
main :: (fn() -> unit)({
  {
    t := _T(tag : i32(7));
    _r := run_once(() => t.tag);
  };
  // g_n is 0: `t` was never disposed. Through `sink(cb) : Impl(Fn() -> i32)`
  // it is 1.
});
export(main);
```

## Root cause

An `FnOnce(...)` call consumes its callee (`_consume_fnonce_callee`,
`src/evaluator/calls/function.yo`), so the callee's binding gets no
scope-end drop. That is right for a closure whose body owns its captures (an
`FnOnce(...)` capture-list closure drops what it did not move). But `Fn`
implies `FnOnce`, so an `Fn` closure is accepted by the same slot, and its body
only borrows its captures. Nothing released such a closure after its consuming
call.

## Fix

When the consumed callee does not release itself, `_consume_fnonce_callee`
(`src/evaluator/calls/function.yo`) builds a `___drop(<callee>)` and evaluates
it before the consume (restoring the binding's `consumed_at_token`, so the drop
does not itself count as a use of a moved value).
`evaluate_function_call` appends it to the call's deferred drops
(`_attach_fnonce_callee_release`), and codegen flushes it right after the call.
A callee releases itself when it is a `Dyn` (its call-once wrapper frees the
box), a closure that owns its captures (`is_fnonce_closure_fn`), or a value of
such a closure's capture struct (`is_fnonce_capture_struct`), which a relay
like `{ cb }() => cb()` sees once specialized.

The drop is tagged (`mark_fnonce_post_call_release`, `src/expr_info.yo`). The
post-call flush skips drops whose target is a parameter, and a closure body
skips drops of its captures, both because the return points release those.
Neither applies to this release: the parameter or capture was consumed by the
call, so no return point releases it. Both filters exempt the tag
(`_drop_target_is_parameter`, `src/codegen/exprs/drop_dup.yo`;
`is_deferred_drop_for_closure_capture`, `src/codegen/utils/index.yo`).

## Verification

`tests/fn_once.test.yo`: an `Fn` closure called through an `FnOnce` parameter,
and one relayed by an `FnOnce` capture-list closure, each dispose their capture
exactly once. `tests/thread.test.yo`'s capture-release cases pass with
`Thread.spawn` taking `FnOnce`.
