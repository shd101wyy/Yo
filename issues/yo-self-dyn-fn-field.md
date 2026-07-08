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
