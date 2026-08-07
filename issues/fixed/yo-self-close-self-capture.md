# yo-self: ref-struct `self` captured+mutated in io.async closure — (\*self) deref + FTT cond

**Status:** OPEN — the last 2 stage-2 families (member-ref @close + FTT cond
@File.close closure; likely also the undeclared temp/get_info pair, same
method cluster). Stage-2 at 5 total.

## Repro (issues/repros/repro-close-self-capture.yo, 40 lines)

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

## Probe results (2026-07-09, rounds 2-3)

- [ISREF-A/B] probes: NEITHER eval is_ref set site fires for close's `self`
  (the 54 ISREF-A hits are legit inout std methods) — yet `(*self)->` emits.
- The deref does NOT come from atom.yo `_var_read_code` (a type-gated version
  changed nothing): it comes from property_access.yo `_ptr_field_access`,
  which received object_type = **Pointer(Thing)** for the `self._fd` read —
  the `self` binding/ExprInfo the RECEIVER eval recorded carries `*(Thing)`.
- Prime suspect: the method-call receiver binding (needs_pointer_conversion
  in ReceiverMethodResult / the receiver-arg binding at t.close(io)) records
  `*(Thing)` for self, and the def-eval body read picks it up — OR env-bleed
  from a foreign frame. NEXT: probe the recorded ExprInfo ty for the `self`
  ATOM inside close's body (one [SELFTY] eprintln in property_access
  \_ptr_field_access printing object_type when field=\_fd), then fix where the
  binding/reads get the spurious pointer wrap (reference-semantics receivers
  need NO pointer conversion — they are already pointers; TS
  needsPointerConversion is for VALUE receivers).
- The io.async FTT cond + io-future member errors in the repro are further
  facets, likely downstream of the same self-typing pollution.

## RESOLVED (2026-07-09) — stage-2 5 → 3

Three faithful-port fixes (all validated: repro compiles+runs printing `true`
matching TS; corpus 104/104 DIFF 0; std check 152/152):

1. **`(*self)->` member-ref** — close's by-value `self` binding was marked
   `is_ref` by create_specialized_function_inline's env-wide name-search
   marking (a yo-self-only compensation): a 1-param std method's
   specialization (`fn(self : Self : (ToString))`) searched `callee_env` for
   "self" and marked the ENCLOSING method's binding. Fix: thread
   `param_is_ref` (from func meta) into
   `check_if_function_parameter_matches_argument` Step 9 and mark the EXACT
   Variable that binding creates (mirrors TS helper.ts:584
   `isRef/isReassignable: parameter.isRef`); DELETE the env-wide spec-block
   marking.

2. **io.async closure body FTT** (`cond` no-ExprInfo, def-eval swallowed
   "Incompatible types: unit vs ResumeType") — two missing TS mechanisms:
   - Step-10 adopt-expected-return (TS helper.ts:1593-1605): after return
     synthesis, adopt the caller's expected type when compatible and concrete
     (yo-self compat is env-free, so resolve the SomeT return via
     `get_value_of_some_type_from_env` first). This types a ctl
     `exn.throw(...)` cond-arm as `unit` so arms unify.
   - Step-6b io.async `T` pre-bind (TS helper.ts:1334-1362): bind forall `T`
     from a CONCRETE expected `Impl(Future(T,E))` output (guarded on
     concreteness to keep the unresolved-SomeT async pipeline intact for the
     no-expected case), so the closure arg's Fn type resolves to
     `Fn(e : E_conc) -> unit` and the body evals with expected `unit`.
     Plus anonymous_function.yo: clear the marked-closure body expected ONLY
     when the closure return is still a SomeT (the fresh `_ret` case).

Debug chain that found it: [RSELF] read-site probe (single-binding env,
ty=Thing, ref=true) → [SETREF-SPEC] set-site probe with fn-type
(`fn(self : Self : (ToString))` ≠ close) → TS-side [TSRET]/[TSBODYEXP]
probes showing throw ret=unit exp=unit and 13× unit bodyExpectedType.
