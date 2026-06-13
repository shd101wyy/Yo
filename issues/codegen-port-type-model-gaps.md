# Codegen port — yo-self type-model gaps blocking faithful emitter porting

## Status: OPEN — discovered 2026-06-13 during Phase 1 (plans/BOOTSTRAPPING_CODEGEN.md)

The codegen port reads evaluator data structures that yo-self models
differently from (or more sparsely than) TS. These gaps block a faithful
1-to-1 port of several `src/codegen/utils/index.ts` functions and will recur
across the emitter sweep. They are the concrete face of the plan's warning
that "most of the porting effort is making the evaluator produce [the
fields] and the emitters consume them."

Each gap needs an evaluator-side type-model extension (and population at
every construction site), validated against the green gates
(`check ./std`, `check ./tests`, `check ./yo-self`, the TS suite) before the
dependent codegen function can be ported.

## Gap 7 — the collection passes (and most emitters) need evaluator-produced ExprInfo/FunctionValue metadata that yo-self does not yet populate

This is the BIG one — the concrete shape of the plan's "make the evaluator
produce them" thesis, surfaced porting `types/collection.ts` +
`functions/collection.ts`.

- **CORRECTION (re-examined 2026-06-13): much smaller than first stated.**
  yo-self's `ExprInfo` (expr_info.yo) ALREADY carries the runtime-oriented
  fields the expr-walker reads: `value`, `runtime_arg_exprs_in_order`,
  `runtime_destructurings`, `control_flow`, `dyn_call_trait_values`,
  `deferred_dup_expressions`, `deferred_drop_expressions`,
  `consumed_variable_drop_expressions`, `capture_type`, `await_analysis`,
  `effect_analysis`, `closure_function_value`, `macro_expansion`, … So
  `collectTypesFromExpr` / `findFunctionCallsInExpr` are portable — they read
  fields that EXIST (possibly `.None` if the evaluator hasn't populated them
  for a given program, which is correct behaviour for simple programs).
- **The two real mechanical/Phase-coupled bits:**
  1. **ExprInfoTable threading** — every TS `expr.$` becomes an
     `ExprInfoTable` lookup, so the walkers take the table. Mechanical.
  2. **FunctionValue codegen metadata** read in a few branches:
     `isControlFunction` IS available (the `is_control_fn(func_id)` side-table
     in function_value.yo); `specializedType` and
     `calledComptimeFunctionCaches` are NOT on yo-self's `FuncVal` and have no
     side-table yet (used only for specialized generics / comptime-fn-cache
     types — Phase 3, not the tiny corpus); `resolvedConcreteType` on param
     types is Gap 6 (async/dyn, Phase 3/5).
- **Consequence:** the collection cluster CAN be ported now with
  ExprInfoTable threading + `is_control_fn`, deferring the
  specializedType/caches/resolvedConcreteType branches (Phase 3/5, not
  reached by simple programs). NOT blocked on a big evaluator sub-project as
  first feared.

## Gap 8 — the expression emitters depend on TS `value.type`; yo-self values are type-less

Surfaced assessing `exprs/comptime-value.ts` (`generateComptimeValue`) and
`exprs/atom.ts` (`generateAtom`) — the entry leaves of value emission.

- **TS:** every `Value` carries its `Type` (`value.type`). `generateComptimeValue`
  reads `value.tag` (ValueTag: I32/U64/F32/… → C literal suffixes),
  `enumValue.type` (for `canOptimizeAsNullablePointer`/`canOptimizeAsSimpleEnum`
  + `context.types[type.id].cName`), `structValue.type` (`.id`, `.isNewtype`,
  `.isReferenceSemantics`, `getRuntimeStructFields`), `value.type.ioBuiltin`,
  etc.
- **yo-self:** `EvalValue` is **type-less by design** — `IntLit`/`FloatLit`
  carry no width/ValueTag; `EnumVal`/`StructVal` carry a `ty_name` string, not
  a full `TypeValue` with `id`/variant data; there is no `ioBuiltin`. The type
  must come from the surrounding `ExprInfo` (`ei.ty` /
  `ei.converted_runtime_type`), not the value.
- **Consequence:** `generateComptimeValue`, `generateAtom`, and the
  value-construction paths throughout the expression emitters must be
  RE-ARCHITECTED to thread the expected/converted type from `ExprInfo` (and to
  derive numeric width/signedness from the type, not a value tag). This is a
  pervasive adaptation across the expression-emitter layer — the single
  largest design difference between the two codegens — done as a coordinated
  effort, not a per-function transcription.
- **Additionally** `generateAtom`'s variable-resolution body is pervasively
  async-state-machine-coupled (`stateMachineVariables` /
  `stateMachineFieldAliases`, Phase 5), and all expression emitters are
  mutually recursive through `generateExpr` (needs the registration-indirection
  pattern). So the expression-emitter core is one large coordinated block:
  `generateExpr` dispatch + `generateAtom` + `generateFuncCall` +
  `generateOtherFunctionCall` + `generateComptimeValue`, with the type-from-
  ExprInfo threading woven through — the next sustained unit toward the first
  differential-harness PASS.

## Gap 1 — `TypeValue.Struct` has no per-field `isCompileTimeOnly`

- **TS:** `StructType.fields: TypeField[]`, each `TypeField` has
  `isCompileTimeOnly: boolean`.
- **yo-self:** `TypeValue.Struct` (yo-self/types/definitions.yo:178) stores
  parallel arrays `field_labels : ArrayList(String)` /
  `field_types : ArrayList(Self)` with **no** per-field comptime-only flag.
- **Blocks:** `isComptimeOnlyStructField`, `getRuntimeStructFields`
  (consumed by types/collection.ts and functions/generation.ts).
- **RESOLVED (investigation 2026-06-13):** the gap is REAL, not a no-op.
  `evaluator/types/struct.yo` computes BOTH `field_types` (all fields) and
  `runtime_field_types` (non-comptime only, line 137-139), but the `Struct`
  TypeValue stores only `field_types` (line 202) — `runtime_field_types` is
  passed to trait auto-derivation and then discarded. So the runtime/comptime
  split IS computed but NOT retained on the type.
- **Fix direction (low blast radius — DO THIS):** a SIDE-TABLE keyed by
  struct id, `HashMap(String, ArrayList(bool))` (or runtime-field index list),
  registered in struct.yo at construction (the data is already in hand) and
  read by `getRuntimeStructFields`. This is yo-self's established pattern for
  type-attached data that doesn't fit the variant (cf. the func_id
  side-tables). AVOID adding a field to the `Struct` variant: that touches
  ~62 sites (39 positional `.Struct(...)` matches + 23 constructions across
  ~20 evaluator files) and risks the green gates. Structs reconstructed from
  runtime values (id == "") have no entry → fall back to all fields.
- **Interim:** until the side-table lands, `getRuntimeStructFields` may be
  ported as "all fields" (correct for structs with no comptime-only fields —
  the common case + the Phase-1 tiny corpus; over-emits for structs that DO
  have comptime-only fields). Document the limitation at the port site.

## Gap 2 — `FuncVal` does not store the function's `TypeValue`

- **TS:** `FunctionValue.type: FunctionType`, so
  `isComptimeFunction = fv.type.return.isCompileTimeOnly`.
- **yo-self:** `EvalValue.FuncVal` (yo-self/value.yo:69) stores raw
  components (`forall_names`, `params`, `param_type_names`,
  `evidence_params`, `body`, `cap_*`, `func_id`) — **no** `type` field. The
  function type / return-comptime flag is reached via a func_id side-table
  (`register_definition_site_return` / `get_definition_site_return` in
  yo-self/function_value.yo; cf. the "default-args side-table" memory).
- **Blocks:** `isComptimeFunction`.
- **Fix direction:** port `isComptimeFunction` to look up the function's
  return type via the func_id side-table (or reconstruct via
  `type_of_eval_value`) and read its `result_is_comptime_only`
  (the `Func` variant DOES carry this flag, definitions.yo:104).

## Gap 3 — `Type.isExtern` is general in TS, `Func`-only in yo-self

- **TS:** every `Type` carries optional `isExtern` / `externName`.
- **yo-self:** `is_extern : Option(String)` / `extern_name` live only on the
  `Func` TypeValue variant (definitions.yo:143). There is no general
  `type.is_extern` accessor for, e.g., extern-C struct types (`libc_FILE`).
- **Blocks:** the extern-C branch of `getVariableNameForCodegen`
  (`variable.type.isExtern === "c"`); `getTypeString`'s
  `type.isExtern && type.externName` early return.
- **Fix direction:** either add a general extern marker to the relevant
  TypeValue variants, or a helper `type_extern_language(t) -> Option(String)`
  that returns the marker for the variants that can be extern.

## Gap 5 — `context.types` registry key: TS universal `type.id` vs yo-self partial ids

- **TS:** every `Type` has an `id`; `context.types` (and `externFunctions`,
  the dyn/iso maps) are keyed by `type.id`, and `getTypeString` looks types
  up by `type.id` for Tuple/Struct/Union/Enum/Dyn/SomeType.
- **yo-self:** only `Struct`/`EnumT`/`SomeT`/`TraitT` carry an `id`.
  `Tuple`, `Union`, `Array`, `Pointer`, `IsoT`, `DynT` have **no id** —
  they are structural. There is no universal key to register/look them up by.
- **Blocks:** `getTypeString` (the Tuple/Union/Enum/Struct/Dyn cName
  lookups), `collectType`/`collectRequiredTypes` (types/collection.ts), and
  every registry interaction downstream.
- **Decision needed (linchpin):** define a uniform `type_key(t) -> String`
  for the registry — e.g. `.id` for named types, `type_to_string(t)` (or a
  sanitized structural string) for structural types — and use it everywhere
  TS uses `type.id`. This shapes the whole pipeline; pick once.

## Gap 6 — `getTypeString`'s SomeType/Future/Fn branch needs re-architecting

- **TS:** the SomeType branch is entirely driven by
  `someType.resolvedConcreteType` + `typeImplementsFuture`/`typeImplementsFn`
  + searching `context.types` for matching async state-machine capture
  structs.
- **yo-self:** `SomeT` has **no `resolvedConcreteType`** (deliberately —
  trait_checking.yo:1086 marks it "Phase 3"); SomeTypes resolve via
  env lookup + `substitute`. `DynT`/`IsoT` carry no `id`.
- **Blocks:** the SomeType/Future/Fn/Dyn/Iso cases of `getTypeString`.
  These are async (Phase 5) / dyn (Phase 3) coupled and not exercised by the
  Phase-1 tiny corpus (generics monomorphize to concrete types pre-codegen).
- **Decision needed:** either add `resolved_concrete_type` to `SomeT` (+
  evaluator population — high blast radius on the green gates) or adapt the
  branch to yo-self's env+substitute resolution. yo-self deferred this to
  "Phase 3"; the codegen port should align.

## Gap 4 — ExprInfo is a side-table, not `expr.$`

- **TS:** `getDeferredDropTargetVariable` reads `atom.$.env` directly.
- **yo-self:** per-node eval data lives in `ExprInfoTable` keyed by
  `ExprId`. The function must take the table and look up the atom's env.
- **Blocks:** `getDeferredDropTargetVariable` (faithful but needs the
  `ExprInfoTable` parameter — a signature divergence, not a model gap).

## Already ported (no gap)

`src/codegen/utils/index.ts` context- and gap-independent helpers are ported
in yo-self/codegen/utils/index.yo: `sanitizeForCIdentifier`,
`shouldAvoidConst`, `isFunctionValueWithOnlyBuiltinYoInlineFunctionCall`,
`canOptimizeAsNullablePointer`, `canOptimizeAsSimpleEnum`,
`getDeferredDupTargetAtomName`, `getDeferredDropTargetAtomName`,
`isDeferredDropForClosureCapture`, `findReturnedAsyncBlock`.

The context-dependent functions (`getTypeString`, `getVariableTypeString`,
`getEnumVariantCName`, and `utils/fixup.ts`'s `fixupDynImplKeys`) are
deferred to the `CodeGenContext` struct unit (ported alongside
functions/context.ts).

## Gap 9 — property-access trait/method resolution + UnknownValue.variableName (from exprs/property-access.ts)

Surfaced porting `generateFieldAccess`. Two model gaps + one Phase-5 gating:

1. **No `.trait` field on Struct/EnumT.** TS `generateFieldAccess` resolves
   method/Rc-method field accesses via `objectType.trait.fields[].assignedValue`
   (late-dispatch trait-walk lines 154-222; Rc-method ___drop/___dup/___dispose
   lookup lines 227-265). yo-self's `Struct`/`EnumT` TypeValue variants carry NO
   `.trait` field — type methods live in a *separate type-method registry*
   (cf. `_try_resolve_associated_type`, the assoc-type-on-enum-receiver work).
   - **Blocked:** the late-dispatch + Rc-method branches. Porting them must route
     through that registry, not a `.trait` field. The *primary* method path —
     the expr's own value being a `FuncVal` → emit its registered C name — IS
     ported and covers all RESOLVED methods (the common case). The deferred
     branches are fallbacks for generic-impl-specialized-after-typecheck and
     RC (Phase 4) methods.

2. **`UnknownVal(ty)` carries no variableName.** TS module-namespace access
   reads `fieldValue.variableName` (a runtime `using`/`given` member) to emit
   the param name. yo-self `UnknownVal` holds only the type, so the
   `isUnknownValue → variableName` sub-branch falls through to the plain
   `get_variable_name_for_codegen(fieldName, env)` identifier lookup. Adequate
   for resolved comptime members; revisit if runtime module members need it.

3. **Evidence-param + state-machine `sm->__capture`/`sm->var_N` routing**
   (Phase 5): FGC has no `currentEvidenceParams`, and `in_effect_state_machine`
   is absent (only `in_async_state_machine`). These branches are gated dead for
   the no-async corpus and ported with the async/effects phase.

**Ported subset (corpus path):** struct/object(`->`)/enum(`.data.V.f`)/pointer
(deref + arrow, ref-semantics extra level, newtype-through-ptr)/tuple
(label→index)/dyn(`vtable->`)/newtype(zero-cost)/module-namespace(comptime
field value) + resolved-method (FuncVal → cName). See header of
`yo-self/codegen/exprs/property_access.yo`.

## Gap 9 UPDATE — RESOLVED via the type-method registry (2026-06-13)

The "no `.trait` field on Struct/EnumT" blocker is RESOLVED for the RC layer.
yo-self stores type methods in `evaluator/values/type_trait_methods.yo` (a
`type id → [MethodEntry]` registry: `register_type_trait_method`,
`get_type_trait_methods_by_name`, `type_id_or_empty`). The faithful equivalent
of TS `type.trait.fields.find(f => f.label === "___drop").assignedValue` is
`get_type_trait_methods_by_name(type_id_or_empty(t), "___drop")` → first FuncVal
entry → registered cName. Used by `drop_dup.yo`'s get_drop/dup_function_for_type
(committed). The SAME pattern can now retire the property-access late-dispatch
+ Rc-method deferrals (issue Gap 9 item 1) when those branches are revisited.

Remaining truly-blocked: only Gap 6 (SomeType.resolvedConcreteType) — needed
for unresolved-SomeT params in Phase-3 generics; a no-op for the monomorphized
corpus.
