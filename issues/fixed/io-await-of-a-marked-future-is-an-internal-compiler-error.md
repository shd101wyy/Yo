# `io.await(&f, io)` / `io.spawn(&g, io)` were an internal compiler error

**Severity:** S1 — a valid call that lends a named future with its call-site marker (decision 33: `io.await`'s `fut` is `imm`) crashed codegen with E1301 "await argument must be a Future type".

> Found 2026-10-10 by the marker sweep (plans/VALUES_BY_DEFAULT.md V3b,
> branch feat/vbd-v3b-marker-sweep): the swept `std/async/index.yo`
> (`io.await(&w, io)`, `io.spawn(&deadline_fut, io)`) stopped the compiler's
> own build. **FIXED same day.**

## Reproducer

```yo
{ yield } :: import("std/async");
answer :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io);
    return(i32(41));
  })
);
main :: (fn(io : Io) -> unit)({
  f := answer(io);
  _v := io.await(&f, io);
});
export(main);
```

```
error[E1301]: internal compiler error: await argument must be a Future type
```

## Root cause

The evaluator peels a lending marker from its own argument list
(`apply_call_site_borrow_markers`) and annotates the place `f`; the `&f` node
itself gets no ExprInfo. Ordinary calls are emitted from
`runtime_arg_exprs_in_order` (the peeled places), but the io builtins are
lowered from the RAW call: `generate_await`, `generate_state`,
`_generate_io_spawn`, the effect-bundle injection for both, the fused-await
path (`fused_await_site`, `emit_fused_await`) and the await analysis
(`await_analysis.yo`) each read `args(0)`/`args(1)` off the AST, found `&f`,
and either failed the Future check or would have emitted the address-of.

## Fix

`ast_call_args_unmarked` (`src/expr.yo`) returns a call's arguments through
their markers, and every raw reader above uses it. Test:
`tests/async_await.test.yo` ("io.await and io.spawn take a named future
through its call-site marker": a sync await, a spawn, and an await inside an
`io.async` body).
