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
