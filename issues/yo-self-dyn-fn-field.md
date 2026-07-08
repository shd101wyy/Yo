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

## WIP attempt (2026-07-09) — saved as issues/wip-dyn-fn-field.patch

Three-part change (eval FnTraitT marker TraitVal + codegen closure-call-map
wrapper path + other*fn_call.yo dyn-Fn vtable call lowering) BUILT clean and
moved the pipeline past the missing-trait-values bail, exposing the NEXT
layer: **the dyn'd closure is never auto-boxed** in this shape — the
DynImplEntry's concrete type reaches codegen as the RAW fn type, so
generate_dyn_box_functions emits malformed identifiers
(`__yo_dyn_box_unknown_fn(x : i32) -> bool`, from `unknown*<type_key>` with an
unsanitized type string). Reverted to keep the tree green.

Remaining work, in order:

1. Make the eval auto-box route (dyn.yo:~366 gate + `_create_boxed_type`)
   actually box a CLOSURE payload (inner type is FnTraitT/Impl(Fn) — check
   whether the synthetic `box(inner)` eval fails/swallows for closures, and
   whether the executing-mode route 2 boxes at all).
2. Sanitize `_concrete_c_name`/`unknown_<key>` fallbacks through
   `sanitize_for_c_identifier` (defensive, independent of 1).
3. Re-apply the saved patch and iterate on the repro
   (issues/repro-dyn-fn-field.yo): expect wrapper
   `return closure_c((void*)&box-><field>, args)` + vtable `.call` slot +
   call-site `(recv.field).vtable->call(...)`, then binary prints 42/true.
4. Gates: corpus 103/103 DIFF 0, std 152/152, stage-2 (baseline 18, family = 4).

## Round 2 (2026-07-09, patch updated in-place)

Added route-1 closure→capture-struct boxing (`get_closure_capture_info` on the
inner FuncVal → `_create_boxed_type(cci.capture_type)`). RESULT: the capturing
closure (`apply`, captures `base`) now boxes its capture struct correctly.
LAYER 3 exposed — **capture-free closures**:

- `get_closure_capture_info` returns `capture_type = unit` for a no-capture
  closure → `Box(unit)` emits `void _u42_;` (field has incomplete type) and
  `__yo_dyn_box_unknown_unit`.
- The capture-free closure's C value repr emits as a bare fn-ptr cast
  (`(__yo_t19)(closure_yo_id_5820)`) where the box ctor expects the capture
  struct value.
- TS reference: capture-free closures still box an EMPTY STRUCT
  (`(__yo_struct_..._id_126){}` — struct(), 0 fields), and the vtable wrapper
  passes `&box->_u42_` as closure_context regardless.

Fix direction for round 3: make the dyn route treat a unit capture_type as the
closure's EMPTY capture struct (or register a 0-field capture struct for
capture-free closures at creation, matching TS), and make the box() arg emit
the capture-struct VALUE (`(capture){}` for capture-free) rather than the fn
pointer. Then re-run issues/repro-dyn-fn-field.yo (expect 42/true) and gates.

## Round 3 scoping (context-limited session end)

Layer-3 root REFINED: `create_capture_type_and_value` DOES build a real
0-field capture Struct for capture-free closures (utils/closure.yo:207+,
`Struct(capture_<id>, "", [], [], ...)`). The `Box(unit)`/`void _u42_` C came
from yo-self's EMPTY-STRUCT ≈ unit equivalence: type printing/`get_type_string`
render a 0-field struct as unit/void (see also compatibility.yo:338's
`Unit ≈ empty struct` non-exact rule). TS instead emits a real named empty C
struct (`__yo_struct_..._id_126 {}`) and boxes `(that){}`.

Round-3 work items:

1. Make `get_type_string`/box-payload emission preserve a 0-field capture
   struct's identity (emit the struct typedef, not void) — check how TS's
   getTypeString handles empty structs and mirror; the capture struct IS
   collected (it appeared as `__yo_t6 <struct:capture_yo_id_5829>` with an
   empty body in the round-2 C, so the DECL side already works — the VALUE/
   field-type side collapses).
2. Make the box() arg for a capture-free closure emit the capture-struct
   value (`(capture){}`), not the closure fn pointer
   (`(__yo_t19)(closure_yo_id_5820)` in round-2 C).
3. Re-apply issues/wip-dyn-fn-field.patch (round-2 version, includes the
   route-1 capture-struct boxing) and iterate on issues/repro-dyn-fn-field.yo.

Round-3 note: `inner_expected` (dyn.yo:306) is ALREADY a SomeT wrapping the
Dyn's required traits (an Impl(Fn) equivalent), so the closure eval gets a
correct expected type. The `Box(unit)` source for the CAPTURE-FREE closure is
therefore either `get_closure_capture_info` returning capture_type=unit, or
the closure's ExprInfo ty degenerating to unit in this flow — probe
`[DYNBOX] ne_value_type=... cci=...` at the route-1 boxing site (one rebuild)
to pick between them before implementing.

## Round 3 probe results (2026-07-09)

`[DYNBOX]` at the route-1 boxing site shows BOTH closures resolve correct
capture structs (`cci=<struct:capture_yo_id_5818> vt=fn(x : i32) -> i32`,
`cci=<struct:capture_yo_id_5829> vt=fn(x : i32) -> bool`) — the unit collapse
is NOT at the boxing-input site. In the same emission, ONE Box instantiation
is correctly shaped (`struct_yo_id_5830 { _u42_ : capture_5829 }`) while the
OTHER emits `Box(unit) { void _u42_ }` — so the collapse happens INSIDE the
Box CTFE (`_create_boxed_type` → `struct(* : V)` field eval), and it is
order/frame-dependent (first call collapses, second works, or vice versa).
Next probe: print `type_to_string(box_ty)` at `_create_boxed_type`'s return +
inside the Box CTFE the resolved V — suspect the pre-bound `V` env frame
(cenv.push_frame + add_variable_to_env at dyn.yo:78-91) not being visible to
the field eval on the first call, or a comptime-fn cache interaction.
Also still open: the box-ARG emission for whichever closure emits
`(__yo_tN)(closure_yo_id_X)` (fn-ptr) instead of the capture-struct value.

## Round 3b probe (2026-07-09) — collapse point PINNED

`[CBT]` at `_create_boxed_type`'s return: BOTH calls produce CORRECT boxes
(`inner=capture_5818 box=struct_5819`, `inner=capture_5829 box=struct_5830`)
— the Box CTFE and its V pre-binding are fine. The `Box(unit)` in the C comes
from the synthetic `box(inner)` CALL's specialization: its func-id reads
`yo_id_3511_unit_rtparam0_capture_yo_id_58XX_ret_gs_yo_id_3506_...` — the
FORALL segment is "unit" (V bound to unit at the call) while the rtparam and
resolved-return segments are correct. So the box() call's forall-V synthesis
binds V := unit for one of the closures despite ctx.expected_type =
Box(capture) — likely the def-eval UnknownValue→unit soft-fallback in forall
binding when the arg's ExprInfo value is unknown, or V synthesis ignoring the
expected return. NEXT: in try_to_call/helper.yo forall binding for the box
call, make V bind from the EXPECTED RETURN (Box(T) → V=T, TS behavior), or
pass V explicitly in the synthetic call. Also noted: capture-struct ids CHURN
across eval passes (5818/5822/5829 for two closures) — codegen may read a mix;
if the C shows mismatched capture ids between box specialization and capture
decl, the durable-id fix (g_capture_struct_ids keying) may need to cover this
flow.

## Round 4 (2026-07-09) — V env-pre-binding INERT

Pre-binding `V := capture_struct` in a scoped env frame around the synthetic
`box(inner)` call did NOT change the emission (`Box(unit)` persists). Unlike
the io.async E-binding (which is honored because helper.yo's io.async
pre-bind code itself checks the env), the GENERAL call-path forall binding for
`box`'s `forall(V)` does not consult env bindings — it computes V from the
ARG value/type, and for a dyn'd closure under def-eval the arg value is
unknown → V collapses to unit.

NEXT (round 5): fix inside the call path — find where forall arg VALUES are
computed for runtime calls (try_to_call/helper.yo forall-binding loop) and,
when the computed forall value is unknown/unit AND ctx.expected_type matches
the declared return shape (`Box(V)` vs expected `Box(T)`), bind the forall
from the EXPECTED-RETURN synthesis (TS behavior — helper.ts:1302's
tempReturnType/expectedEnv synthesis). Alternatively drive the box call
directly with explicit forall_args (ArgValues) instead of re-evaluating a
synthetic FnCall. The box arg fn-ptr emission issue also still pending.

## Round 5 (2026-07-09) — V = Impl(Fn) SomeT (TS shape) — box stamp fixed, bridge broken

Boxing with V = the `inner_expected` Impl(Fn) SomeT + registering
`register_some_resolved_concrete(SomeT id → capture struct)` produced the
TS-shaped boxes (`Box(fn(x : i32) -> i32)` — no more Box(unit)), BUT:

- the box payload emits `void* _u42_` — the SomeT→concrete bridge did NOT
  resolve; the Box instantiation's field V SomeT is a CLONE with a different
  id than the one registered (Box CTFE → substitute/intern re-mint), so the
  id-keyed global misses. Same per-object-identity root class as the
  intern-key and tracer families.
- generate*dyn_box_functions still emits unsanitized
  `__yo_dyn_box_unknown_fn(x : i32) -> bool` identifiers (independent bug:
  `unknown*${type_key(...)}` fallbacks must go through
  sanitize_for_c_identifier).

## CONVERGED DIAGNOSIS (after 5 rounds)

Every layer of this family (and the shared-Bucket-tracer family) fails on the
same structural divergence: yo-self keys type identity by SHARED/CLONED ids
where TS uses per-object fields (`resolvedConcreteType`) and per-object
caches. The durable fix is the SomeT `resolved_concrete_type` field
(definitions.ts:191 mirror) so resolutions travel WITH the type object through
clone/substitute/intern — this dissolves: the box-payload bridge here, the
Bucket-tracer receiver identity, and retires the g_some_resolved_concrete
global (plus its IoExn gating hacks in evaluator/types/function.yo:3926-64).
TypeValue is ref(enum) now, so the field is implementable (mutation via a
ref-struct cell or rebuild-on-set). Estimated as a dedicated refactor session:
add field to SomeT (definitions.yo:249, 11th field), update creators/clone/
positional matches, EXCLUDE from type_key/intern-key/compatibility identity,
convert write sites (synthesizer.yo:1262/1336, function.yo:3313,
closure_type.yo:298, helper.yo:1355, async.yo:1541/2132) and read sites
(await.yo:384+, utils/index.yo:807, closures.yo:53, state_machine.yo:56+,
async.yo multiple) to prefer the field with the global as fallback, then
delete the global once stage-2 is stable.
