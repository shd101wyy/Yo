# yo-self: closure-`F` identity split — the last root behind iter_filter_closure (RED) + iterator_combinators (HOLLOW)

State as of 2026-08-02 end-of-day (feat/bootstrap-codegen `1f0cbd525`).
This is the ONLY root left behind these two files; every other layer of the
old §3.3 family (generic/where-clause impl over a comptime-constructed
struct) was fixed in `994b34099` — `v5_direct`/`v8_mono`/`v4_take`/
`v1_namedfn` all compile 0-marker and run.

## Repro

`scratchpad/w1/repro6.yo` — `CountIter` + `iter.filter(x => x.* > 2)`, then
`.next()`. TS rc=0. yo-self rc=1 with two independent C-level symptoms:

1. **Two C types for one logical instance:** the specialized `filter` returns
   `__yo_t2` but the caller declares `__yo_t12` (`initializing '__yo_t12'
with an expression of incompatible type '__yo_t2'`). Both are
   `IterFilter(CountIter, F)` — one minted through the signature-side path,
   one through the body-side construction; the CTFE memo legitimately misses
   because the two sites pass DIFFERENT `F` identities (the where-clause
   binding rebinds F to the closure's bare `fn(item : *(i32)) -> bool`; the
   arg's recorded type stays the `F` SomeT).
2. **`(self._f)(&(item))` fails to transpile** inside the specialized `next`
   body — calling a closure-typed FIELD whose type is the `F` SomeT needs the
   `impl_closure_call_map`/closure-impl-fn machinery that only the annotated
   `Impl(Fn(...))` shapes reach today.

`tests/iterator_combinators.test.yo` arm 0 (`.map(x => x*2)`) hollows on the
same family: `Type mismatch for type member "_f": Expected fn(item : i32) ->
i32 / Got F : (Fn(A) -> B)`.

## TS mechanism (all verified file:line)

- `anonymous-function.ts:1203-1216`: when the closure's expected `F` comes
  from a where clause (no Fn trait in requiredTraits), TS mints a synthetic
  `__impl_fn` SomeType (`requiredTraits: [expectedFnTraitType]`,
  `resolvedConcreteType = captureType`) and sets it as F's
  resolvedConcreteType IN PLACE — one stable `F` identity at the return-type
  mint, the body construction, and the arg check.
- `helper.ts:2242-2252`: the capture struct is unwrapped ONLY for
  runtimeParameters (the C signature), never for the comptime forall binding.
- yo-self's partial port: `anonymous_function.yo` final_lambda_ty wrapper
  adoption exists but is GATED to Fn-in-requiredTraits + CONCRETE call result
  (the c01/c06 annotation shape) and `!ctx.is_inside_io_async_call` — the
  where-clause `F` (filter: result `bool` concrete, but Fn arrives via where
  → not in required traits; map: result `B` SomeT) never takes it.

## Measured dead ends — do not re-derive

- Candidate-1 (memo-hit via resolved_concrete in `_ctfe_args_equal`) and the
  A/B ungate: both REJECTED with measurements
  (`issues/handoff-2026-08-02/01/02`); the A/B ungate KILLS all three
  canaries (helper.yo:2129/:2165 must stay).
- `capbind at the forall name-match` (rebuild exp_pt with
  resolved_concrete=capture at `_funcval_bind_foralls`): built 2026-08-02,
  ZERO wins (repro6 failure shape changed but stayed red), reverted.

## Hazards for whoever ports `__impl_fn`

- The io_async pipeline registers the sync-future struct + io.await
  refinement against the UNRESOLVED wrapper SomeT — taking on the wrapper
  for io.async closures broke all 12 io_async corpus files (measured
  2026-07-27; the gate at anonymous_function.yo:1806 records it).
- `helper.yo:2375` arc-spawn-capture-split: per-spec SomeT rebuild must stay.
- Canary set: iter_filter_closure, iterator_combinators, io_async corpus,
  issues/repros/arc-spawn-capture-split.yo, closure_capture_rc_leak.
