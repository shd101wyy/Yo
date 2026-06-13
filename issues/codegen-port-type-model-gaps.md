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
- **Open question first:** does the evaluator already STRIP comptime-only
  fields when building the runtime `Struct` (struct.yo:137 `if(!field.is_comptime)`,
  calls/type.yo:268)? If so, `getRuntimeStructFields ≡ all fields` and
  `isComptimeOnlyStructField ≡ false`, and the "gap" is just a
  documented-divergence no-op. If NOT, add a
  `field_is_compile_time_only : ArrayList(bool)` parallel array and populate
  it at every Struct construction site. VERIFY before choosing.

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
