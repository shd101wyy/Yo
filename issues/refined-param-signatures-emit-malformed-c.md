# Refined-parameter signatures emit malformed C (`// Unknown type:` inside the prototype)

## Symptom

Any function whose parameter (or return) type is a refinement —
`refine(T, p)`, i.e. `TypeValue.RefineT` — fails C compilation with
malformed prototypes:

```c
static inline int32_t yo_id_1712...(int32_t num, // Unknown type: refine(i32, @31000004) denom);
static inline int32_t yo_id_6590...(// Unknown type: refine(i32, @57000000) x);
```

clang: `'inline' can only appear on functions` / `expected ')'` — the
`// Unknown type:` fallback comment ATE the rest of the prototype line
(the same failure shape as the Array(T,N) case recorded in
`src/codegen/functions/declarations.yo:545`).

## Root cause

`get_type_string` (`src/codegen/utils/index.yo`) — the C-type chokepoint
every parameter, variable and return rendering delegates to — had NO
`.RefineT` arm. The task-3 slice-2 variant (#727) was erasure-complete at
the EVALUATOR level (guards/tags/size/compat/toString) and in the verifier,
but CODEGEN's type renderer was not in the chokepoint audit: the variant
fell through to the comptime-only wildcard, which emits the `// Unknown
type:` comment. Nothing in the in-process harness catches it — `mm_load_file`
EVALUATES fixtures and never emits C for them, so the first compile of a
refined-param function surfaced it (the rewritten `tests/spec/refine_types.test.yo`
batch compile).

## Fix

A `.RefineT(inner, _) => get_type_string(inner, context)` arm at the top of
`get_type_string`'s match — the erasure rule rendered as the C type: a
refined value's C type IS its inner's. All storage/variable/parameter
renderings (`get_storage_type_string`, `get_variable_type_string`) delegate
to it, so this one arm covers every position. Nesting terminates: a refine
chain is finite (`evaluate_refine` always wraps a previously-evaluated
type).

## Seed-generation gate

The fix is in the TREE, but `yo test`'s batch compiles with the SEED's
compiled-in codegen — so seed-path files with refined-parameter functions
(`tests/spec/refine_types.test.yo`) stay red under every seed < the release
carrying this fix, and go green the moment CI's self-hosted differential
legs build the tree binary (which has the fix). Same protocol as #713:
merge gated on the next release for the seed legs.
