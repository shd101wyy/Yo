# yo-self: ref-struct `self` captured+mutated in io.async closure — (\*self) deref + FTT cond

**Status:** OPEN — the last 2 stage-2 families (member-ref @close + FTT cond
@File.close closure; likely also the undeclared temp/get_info pair, same
method cluster). Stage-2 at 5 total.

## Repro (issues/repro-close-self-capture.yo, 40 lines)

`Thing :: ref(struct(_fd, _is_closed))` + impl method
`close : (fn(self : Self, io : Io) -> Impl(Future(unit, IoExn)))` whose
io.async closure reads AND mutates `self._is_closed`, awaits an inner future,
and conditionally throws. TS compiles + runs (`true`); yo-self emits 8 errors:

- `(*self)->_fd` in the OUTER body (`fd := self._fd`) — double-deref: the
  self VARIABLE's is_ref=true while the C param is single-pointer `__yo_t0*`.
- the whole `io.async(...)` FTT (`// Failed to transpile (io.async)(e => cond(...))`).
- `__yo_io_future_t` missing `__yo_resume_fn`/`__yo_set_effect_fn` (sync-await
  emitted against the raw io-future type — secondary).

## Analysis so far

- The `(*self)` deref comes from `v.is_ref` on the env binding
  (codegen/exprs/atom.yo:112 \_var_read_code). Set sites: helper.yo:1421
  (specialization param_is_ref propagation — requires meta.param_is_ref true)
  and anonymous_function.yo:815 (expected-type param_is_ref). close's declared
  `self : Self` parses is_ref=false (types/function.yo:3666 pushes pp.is_ref),
  so WHO sets it is unconfirmed — next probe: print at both set sites when the
  param label == "self" and the fn is close-like, or grep for a third
  ref-capture-driven set site (the closure captures self and MUTATES through
  it — suspect the ref-capture/spill machinery marks the ORIGINAL binding).
- TS captures a reference-semantics struct BY POINTER VALUE (no ref-capture,
  no spill); mutation goes through the pointer. The classification should
  exempt reference-semantics types from ref-capture treatment.
- The FTT is likely downstream of the same mis-classification (closure body
  def-eval fails on the ref-capture gate / capture struct typing → swallowed
  → whole io.async un-transpiled).

## Next steps

1. Probe the two is_ref set sites + any capture-analysis marking for `self`
   in the repro (fast: repro compiles in seconds with /tmp/yo-self-clean).
2. Exempt reference-semantics types from ref-capture/is_ref marking (mirror
   TS: pointer-by-value capture); verify (\*self) becomes self and the io.async
   transpiles.
3. Then the remaining: undeclared get_info/temp (may clear with this), and
   verify the argv(i+1) FTT (@197915 in stage2v.c) separately — Index-trait
   with computed index arg, likely a distinct small fix.
