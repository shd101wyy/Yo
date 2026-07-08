# yo-self: Dyn(Fn) struct fields — dyn(closure) construction + field-call lowering unported

**Status:** OPEN (stage-2 family, 4 clang errors as of 2026-07-09: 2x
`/* Error: dyn() call missing trait values */` + 2x "operand of type X where
arithmetic or pointer type is required"). NOT covered by any corpus test (all
dyn corpus tests are trait-object method dispatch).

## Symptom / repro (issues/repro-dyn-fn-field.yo — 20 lines, TS runs 42/true)

A ref struct with `Dyn(Fn(...))` fields (yo-self's own
`SuspensionPointDetector`, evaluator/shared/suspension_analysis.yo:62),
constructed with `dyn((x : i32) => (x + base))` and called as `h.apply(i32(32))`:

- construction emits `__yo_new___yo_t0(/* Error: dyn() call missing trait values */, ...)`
- call emits `((int32_t (*)(int32_t))h->apply)(32)` — casting the dyn fat
  pointer STRUCT to a fn-ptr (operand-arithmetic error), no data arg, no vtable.

## TS reference lowering (from `./yo-cli compile repro --emit-c`)

1. Build capture struct -> `box(...)` it -> `__yo_dyn_XXX { .data = boxed_capture,
.vtable = &__yo_vtable_<capture>_<dyn> }`.
2. Call: `(h->apply).vtable->call((h->apply).data, 32)`.

## Analysis

- Eval sets `ExprInfo.dyn_call_trait_values` via `_resolve_dyn_trait_values`
  (evaluator/values/dyn.yo:150), which resolves methods from the
  trait-method REGISTRY keyed by the concrete type's id
  (`get_type_trait_methods_for_type`). A dyn'd CLOSURE has no registered Fn
  "impl" — the closure itself is the implementation — so trait_vals is empty
  and codegen prints the missing-trait-values marker.
- TS: `concreteType.trait.fields` carries the closure's call fn directly; the
  vtable's `call` slot is the boxed-closure wrapper.
- The call side additionally needs the dyn-Fn FIELD-call lowering
  (`(recv.field).vtable->call((recv.field).data, args...)`) — the existing
  yo-self dyn dispatch handles trait-METHOD calls, not Fn-trait field values.
- Two eval routes set dyn_call_trait_values (dyn.yo:394 expected-type route —
  the one struct-constructor args take — and dyn.yo:545); the closure/Fn case
  must populate trait values in both.

## Stage-2 sites

All in the suspension-analysis detector infra: the `detector.detect(...)` /
`detector.should_skip_body(...)` calls (await/effect analysis) and the
`SuspensionPointDetector(...)` constructions in await_analysis.yo /
effect_analysis.yo.

## Implementation pointers (for the fix session)

- Eval: `_resolve_dyn_trait_values` (evaluator/values/dyn.yo:150) matches ONLY
  `.TraitT` required traits — `Fn` traits are the `FnTraitT` VARIANT, so the
  loop falls through and trait_vals stays empty. The fix needs an FnTraitT arm
  whose single method value = the dyn'd CLOSURE FuncVal (available at the
  dyn()-eval callers, not inside \_resolve_dyn_trait_values — thread it in).
- Codegen: `generate_dyn_call` (codegen/exprs/dyn.yo:88) registers
  `DynImplEntry(dyn_type, concrete_type, data_type, trait_values)` via
  register_dyn_impl; the vtable emitter walks TraitT field_labels — FnTraitT
  has none, needs a synthetic `call` slot + a wrapper taking (data, params...)
  that unboxes the capture struct and calls the closure fn (TS names the slot
  `call`: `(h->apply).vtable->call((h->apply).data, 32)`).
- The value data path (box the capture struct) already exists: the eval route
  at dyn.yo:~370 wraps the inner expr in `box(...)` under the expected Dyn
  field type.
- Field-CALL lowering: `h.apply(args)` where `apply : Dyn(Fn(...))` must emit
  `(recv->apply).vtable->call((recv->apply).data, args...)` — the existing
  dyn method dispatch handles trait-METHOD calls on dyn receivers, not
  Fn-trait dyn FIELD values; find where the call currently degrades to the
  `((cast)recv->field)(args)` struct-to-fnptr cast.
