# A fused await passes a named local without the caller's share

**Severity:** S1 — at a fused await site, a named local passed to a by-value parameter of the awaited `io.async` wrapper was released by the wrapper and again by the caller: a double release, crashing (`SIGSEGV`/`SIGTRAP`) on every run, with no diagnostic

**Status:** FIXED 2026-10-13 (feat/vbd-v3-genb). Present in the released v0.2.59 seed.

## Symptom

Found while testing `std/async` with tasks over `String` values:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
{ sleep } :: import("std/sys/timer");
slen :: (fn(ms : u64, v : String, io : Io) -> Impl(Future(usize, Io)))(
  io.async((io : Io) => {
    io.await(sleep(ms), io);
    v.len()
  })
);
main :: (fn(io : Io) -> unit)({
  f := io.async((io : Io) => {
    (t : usize) = usize(0);
    (i : i32) = i32(0);
    while(i < i32(3), {
      bb := `b${i}`;
      t = (t + io.await(slen(u64(1), bb, io), io));
      _keep := ArrayList(String).with_capacity(usize(4));
      i = (i + i32(1));
    });
    t
  });
  x := io.await(f, io);
  println(`t ${x}`);
});
export(main);
```

crashed in 20 of 20 runs with v0.2.59 and the tree compiler. Passing
`bb.clone()` avoids it, and so does `YO_ASYNC_FUSION=0`.

## Cause

Await-site fusion (`emit_fused_await`, `src/codegen/exprs/async.yo`) runs the
wrapper's prologue in the caller: it binds each wrapper parameter to the
argument's C code and builds the capture struct, and the wrapper's own drop
of its by-value parameter is emitted after the capture takes its +1. An
ordinary call passes a named local to a by-value parameter with the
argument's deferred dup (the caller's share, which the callee's drop
balances). The fused path generated the argument with `_call_generate_expr`
alone, so the dup was never emitted:

```c
__yo_t_… __yo_v_v = sm->var_bb_…;          // no incr: the caller's share is missing
… capture = {.__yo_v_v = __yo_v_v, …};
__yo_incr_rc(capture.__yo_v_v);              // the capture's +1
__yo_decr_rc(__yo_v_v);                      // the wrapper's param drop
…                                            // the capture is dropped at the tail: freed
__yo_decr_rc(sm->var_bb_…);                  // the caller's scope end: a second release
```

## Fix

An argument that carries a by-value parameter's share
(`is_by_value_param_share_dup`) takes it at the fused site through
`emit_deferred_dup_or_code`, on its own spelling, as a call inside a state
machine does (`_materialize_arg`, `src/codegen/exprs/other_fn_call.yo`). Its
other deferred dups (the caller-owned +1 of a borrowed projection, for a `&`
parameter) are not emitted in a state machine; emitting every deferred dup
named temps the state machine never declared (`remove_dir(&entry.path, …)` in
`std/fs/walker.yo`).

Regression test: `tests/async/sm_ownership.test.yo`, "a fused await keeps a
named local passed by value alive" (a `Dispose` counter: before the fix each
local was disposed during the await, under the caller).
