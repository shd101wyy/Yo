# yo-self self-compile: "type not collected before lowering" panic on pointer-field pointees

**Status:** ✅ FIXED + VALIDATED (2026-06-23) — corpus 83/83, panic gone,
`stage2.c` emitted. Fix = a separate `collect_pointer_pointees` pass in
`compile_module` (`yo-self/codegen/types/collection.yo` + `codegen_c.yo`). NOT a
redesign regression: a pre-redesign build (`cead3db9f`) SIGABRTs identically, so
this is a pre-existing bug (most plausibly introduced by `98b95a9dd`, the
default-arg codegen fix). Uncommitted (in working tree) pending the user's commit.
With the panic gone, the genuine 564-marker recursive-self-shell tail is revealed
— see `issues/yo-self-p1-transpile-tail.md`.

## Symptom

After the overloading redesign unblocked `run_compile`'s codegen, the full
self-compile (`yo-self-bin compile yo-self/main.yo --emit-c`) no longer completes
with eval markers — it **SIGABRTs in codegen**:

```
get_type_string: no C type name found for <struct:struct_yo_id_NNNNN> (type not collected before lowering)
get_type_string: type not registered in context.types (see stderr)
```

The abort is the `panic(...)` in `_lookup_named_c_type` (codegen/utils/index.yo)
when `get_type_string` lowers a struct that was never registered in
`context.types`.

## Diagnosis

Instrumenting the panic site to enumerate ALL uncollected types (register a
`void` fallback + continue) surfaced **12 distinct uncollected structs**, all from
yo-self's OWN async / effects / closure codegen subsystem:

- anonymous `{ key : K, value : V }` structs = HashMap **`Bucket(K,V)`** entries
  (`HashMap(String, CapturedVariable)`, `HashMap(usize, WhileLoopInfo)`,
  `HashMap(String, EvidenceParameter)`, …).
- the map VALUE types themselves: `CapturedVariable`, `WhileLoopInfo`,
  `EvidenceParameter`, `AsyncCondBranchInfo`, `ImplClosureCallInfo`,
  `WhereClauseConstraints`, plus `EffectCallPoint`, `EffectHandlerInfo`,
  `EffectCapturedVariable`, `CondBranch`, `ChainedCondBranches`,
  `ClosureParamSlot`.

These are fields of the per-function `FunctionGenerationContext` (e.g.
`state_machine_variables : Option(HashMap(String, CapturedVariable))`,
`async_while_loop_info : Option(HashMap(usize, WhileLoopInfo))`).

**Only the self-compile hits this** — a compiler is the only program that uses
`FunctionGenerationContext` at runtime, so per-module surveys + the corpus never
exercised these HashMaps. (TS compiles main.yo cleanly and emits all 12 types.)

### Root cause

`HashMap(K,V)` stores its entries as `data : ?*(Bucket(K,V))` — a **pointer**.
`collect_type` registers `HashMap` (it's a collected `FunctionGenerationContext`
field) and recurses its fields: `data` → `Option(*(Bucket))` enum → `Some`
variant field `*(Bucket)` → **`Pointer` → STOP**. `collect_type` had no `Pointer`
case (neither does TS's `collectType`). So `Bucket` (and its value type `V`) is
NOT collected via the field path.

TS reaches `Bucket` **incidentally** via the container's generated `___dup`/
`___drop` bodies (`collectTypesFromExpr` walks the drop expressions, which iterate
buckets and reference `Bucket`). In a simple program (`HashMap(K, SimpleStruct)`)
yo-self collects `Bucket` the same way — confirmed: repros with value structs,
object value types, recursive `Box(Self)` value types, signature-only HashMaps,
and never-called methods ALL compile clean. But in the **self-compile**, the
dup/drop-based collection does not reach these specific map value types (their
dup/drop generation involves recursive members — `AstExpr`, `Box(Self)`
self-shells — and that path diverges from TS here). The pointer barrier then
leaves `Bucket`/`V` unregistered → panic when emitting `HashMap`'s typedef
(`Bucket* data`).

## Why the 564 markers are CASCADE, not the real tail

Both "get past the panic" diagnostics (void-fallback + the rejected inline fix)
emit `stage2.c` with **564** `Failed to transpile` markers. Classifying them:
435 are generic control-flow (`if`/`match`/`while`/begin) and the named ones are
async/effect codegen functions (`emit_deferred_async_block_struct_definitions`,
`_store_cond_branch_info`, `mark_as_closure_fn`) — i.e. the functions that USE the
12 broken (`void`-fallback'd) types. So 564 is the downstream cascade of the 12
uncollected types, NOT the genuine tail. A CLEAN fix collapses it.

## Rejected fix (regressed corpus)

Recursing into the pointee INLINE in `collect_type` (a global `is_pointer_type`
case) fixed the panic but **regressed 22 corpus fixtures** (`PASS 83 → SELF-FAIL
22`). Root: it perturbed the MAIN collection's function-discovery ORDER, and the
**lazy array-struct registration** (`Array_uint8_t_24` for `i32.to_string`'s
buffer, registered as a side effect of `get_type_string` during collection) is
order-sensitive — the array typedef stopped being emitted (`Array_uint8_t_24`
present in clean output, absent with the inline fix → "use of undeclared
identifier 'Array_uint8_t_24'"). Reverted.

## Fix (second pass — does not touch main collection order)

A SEPARATE pass `collect_pointer_pointees` run in `compile_module` AFTER
`collect_required_types` and BEFORE `generate_type_declarations`: it snapshots the
already-registered struct types and `collect_type`s the pointee behind each
pointer field (`?*(Bucket)` / `?*(T)`), looping to a fixpoint for transitive
container nesting. Because it runs as a distinct pass, the MAIN collection order
(and thus the order-sensitive array-struct registration) is untouched — no corpus
regression. A struct with a `T*` field structurally REQUIRES `T` registered to
emit its typedef, so this is the correct completeness rule; it's a DIVERGENCE from
`collectType` (no such pass), justified because TS reaches `T` via dup/drop walks
that yo-self's recursive-type dup/drop generation can't always complete in the
self-compile. `_collect_field_pointees` finds pointers directly or one level
inside an enum variant (covers the nullable-pointer `?*(T) = Option(*(T))` shape).

## Validation

- Corpus 83/83 (regression gate — fix is additive/guarded).
- `check ./std` 152/152.
- Full self-compile: panic gone, `stage2.c` emitted, real (un-inflated) marker
  count measured.
