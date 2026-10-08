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

When the consumed callee is not a closure that owns its captures (and is not a
`Dyn`, whose call-once wrapper releases its box), `_consume_fnonce_callee`
records a release of the callee for after the call, and
`evaluate_function_call` appends it to the call's deferred drops
(`_attach_fnonce_callee_release`), which codegen flushes right after the call.
Whether the callee owns its captures is read from its concrete closure
(`is_fnonce_closure_fn`), which a specialized body knows.

## Verification

`tests/fn_once.test.yo`: an `Fn` closure called through an `FnOnce` parameter,
and one relayed by an `FnOnce` capture-list closure, each dispose their capture
exactly once. `tests/thread.test.yo`'s capture-release cases pass with
`Thread.spawn` taking `FnOnce`.
