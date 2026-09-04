# yo-self: align modules to TS's struct representation
> **ARCHIVED 2026-09-04 — TS-ERA PORTING DOC.** The TypeScript reference it
> aligns to is retired (tag src-attic-final); the struct module representation
> it describes is the shipped model (src/module_manager.yo).


## Why

TS has **no module type**: anonymous modules (`impl({...})`, `extern` blocks)
and imported modules are both **structs**:

- `SourceNamespaceType = StructType & { isSourceNamespace: true }`
  (src/types/definitions.ts:514-518), created by `createSourceNamespaceType`
  (creators.ts:755) from `evaluateAnonymousModule` (anonymous-module.ts:57).
- The per-module value is a `StructValue` (evaluator/index.ts:49
  `moduleValue: StructValue`), returned by `import(...)`
  (exprs/import.ts:256-260).

yo-self diverged with a dedicated `TypeValue.ModuleT(id, name, field_labels,
field_types)` + `EvalValue.ModuleVal(names, values)` pair (33 non-test
consumer files). This blocks faithful ports that dispatch on the TS struct
shape — first concretely: the ModuleT/Call overload dispatch
(`(!) :: impl({ ... Call :: (not, comptime_not); })`, TS function.ts:527-555),
where TS finds the `Call` field on a source-namespace STRUCT.

One structural caveat that stays: TS rides field VALUES on the type
(`StructType.fields[i].assignedValue`) — yo-self's `TypeValue` layer cannot
reference `EvalValue` (types/ ↔ value.yo import cycle), so the type/value
split remains: the aligned representation is `Struct` (type, with an
`is_source_namespace` flag) paired with `StructVal` (values). Consumers that
read TS `assignedValue` read the paired `StructVal` instead.

## Phases

- **A. Flag**: add `is_source_namespace : bool` to the `Struct` TypeValue
  (12 construction sites; positional patterns updated).
- **B. Producers**: switch `values/anonymous_module.yo`, `exprs/import.yo`,
  `types/record.yo` + `calls/record_type.yo` to produce
  `Struct(is_source_namespace: true)` + `StructVal`.
- **C. Consumers (compiler-guided)**: DELETE `ModuleT` and `ModuleVal` from
  definitions.yo/value.yo and fix every compile error until green — the
  variant deletion forces completeness (no silently-stale arms).
- **D. Validate**: std 151 / yo-self 228 / tests 171-11 identical set.
- **E. Call-overload dispatch port** (the original goal) on the aligned
  representation: source-namespace struct callee → `Call` field → tuple of
  candidates → trial-call (cloned exprs, swallowing exn; the helper path
  never CTFE-executes, so trials are side-effect-free) → winner re-dispatched
  through the ordinary FuncVal arm.

## Status

- [x] A. Flag on Struct
- [x] B. Producers switched
- [x] C. Consumers migrated (ModuleT/ModuleVal deleted)
- [x] D. Zero-regression validation (std 151/151, yo-self 228/228, tests 171-11 identical)
- [x] E. Call-overload dispatch
