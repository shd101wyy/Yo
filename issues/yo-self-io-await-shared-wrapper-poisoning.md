# yo-self: async_await arm 65 layer 3 — io.await's `fut` param resolves to the closure's Fn type

State as of 2026-08-03. Two compat-layer fixes LANDED (see below) moved the
arm-65 failure from the `(task : Impl(Future(i32, Ctx)))` BINDING to the
`io.await(task, ctx)` CALL — the previously-documented "io.await drop" is in
fact this eval throw, swallowed at def time:

```
Type mismatch for parameter "fut":
- Expected: fn(e : Ctx) -> i32
- Got     : Impl : (Future[Future](i32) Ctx : Ctx)
```

## Landed this round (types/compatibility.yo — keep)

1. Future effect matching compares TYPES only (TS compatibility.ts:516-529
   never reads labels) — a declared `Impl(Future(i32, Ctx))` (label "Ctx")
   now accepts io.async's return (declared effect forall label "E").
2. `_wrapper_carrier_args_concrete`'s Future arm gates on TOP-LEVEL
   SomeT-ness after `_resolve_cell_chain` (a concrete effect bundle
   NECESSARILY contains nested SomeTs — its ctl members carry ResumeType).
3. `_resolve_cell_chain` helper + effect comparison resolves both sides
   through resolution cells before recursion.

## The remaining mechanism (diagnosed, not fixed)

`io.await`'s declared param `fut : Impl(Future(T, E))` and `io.async`'s
declared RETURN `Impl(Future(T, E))` come from the same Io declaration —
ONE wrapper SomeT lineage. `_freshen_io_builtin_callee` (per-call
freshening) rebuilds only the FORALLS (T, E); `substitute()` rebuilds the
wrapper around the fresh T/E but COPIES the resolution-cell handle
(types/substitution.yo:255 — shared lineage by design). The io.async call's
return-type stamping bridge ("stamp the call result's resolved-concrete from
the callee BODY's def-time type", calls/function.yo) then writes the
CLOSURE's Fn type (`fn(e : Ctx) -> i32`) into that shared cell — and the
LATER io.await call's param re-eval resolves `fut` through the same cell to
the Fn type instead of the Future wrapper.

## Fix directions (pick after measuring against the io_async corpus, 12 files)

- (d, contained) At the param-vs-arg check: never adopt a param-wrapper
  resolution that CONTRADICTS the wrapper's own required traits (a
  Future-constrained wrapper resolving to a bare Func is self-evidently a
  poisoned lineage — fall back to the raw wrapper + structural check).
- (a, structural) Freshen the WRAPPER SomeT (fresh id + fresh cell) in
  `_freshen_io_builtin_callee`, and apply the freshening to io.await
  callees too. Riskier: the async pipeline registers the sync-future struct
  and io.await refinement against wrapper/output SomeT ids (see the Step-6b
  comment in calls/helper.yo for which ids must stay stable).

Repro: `tmp/a65/a65.test.yo` (single-arm extraction of async_await arm 65);
measure with the batch-marker method, never rc.
