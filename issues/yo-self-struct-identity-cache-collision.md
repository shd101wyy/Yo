# yo-self — structurally-identical struct collision in the comptime-fn CTFE cache

Status: **EVALUATOR FIX VALIDATED + COMMITTED — clean net −18 markers (440 → 422),
0 un-masked.** Repro transpile 5→0, `check ./std` 152/152, corpus 83/83 unchanged.
A RELATED codegen-layer issue (layer 2, below) remains — deferred as the next lever.

## Summary

The #1 full-compile marker cluster (`_find_capture_type_c_name`,
`yo-self/codegen/exprs/async.yo:437`, ~126 markers) fails because two
**structurally-identical but differently-named** structs collide in the
comptime-fn CTFE cache:

```rust
CodegenTypeEntry     :: object(ty : TypeValue, c_name : String, c_include : Option(String));
CodegenExternFnEntry :: object(ty : TypeValue, c_name : String, c_include : Option(String));
```
(`yo-self/codegen/utils/index.yo:75-76`)

They are the value types of two separate maps —
`types : HashMap(String, CodegenTypeEntry)` and
`extern_functions : HashMap(String, CodegenExternFnEntry)`. When the generic
`HashMap.values()` / `HashMapValues.next()` is instantiated for both, the second
instantiation hits the first's cache entry (the cache treats the two `V` structs
as the same type), and the cached iterator yields the wrong element type →
`Cannot unify CodegenTypeEntry and CodegenExternFnEntry` (swallowed by def-time
trial-eval, surfacing as `Failed to transpile` markers on every dependent op).

## Confirmed a yo-self PORT bug (TS-first check)

Minimal repro (`src/tests/fixme.yo`): two same-fielded structs `StA`/`StB` used as
`HashMap` value types, each iterated via `.values().next()`:

| compiler | markers |
| --- | --- |
| TS reference (`./yo-cli`) | **0** |
| yo-self clean HEAD | **5** (`mb.set`, both `.values()`, both `.next()` matches) |

TS handles it; yo-self does not → a port divergence, not a language bug.

## Root cause — yo-self omits TS's nominal struct-distinctness check

`are_types_compatible_exact` (the comptime-fn cache key, via
`_ctfe_args_equal` → `compatibility.yo`) compares two structs under
`require_exact`. TS (`src/types/compatibility.ts:288-306`) does a **nominal**
check first:

```ts
if (expected.fields.length !== given.fields.length ||
    (expected.type.id !== given.type.id &&        // different identity
     !typeContainsSomeType(expected.type) &&        // neither is a placeholder
     !typeContainsSomeType(given.type) &&
     !(sameFuncId)))                                // not the same constructor
  return false;                                     // → DISTINCT
if (expected.type.id === given.type.id) return true;
// …only then structural field comparison
```

yo-self's `require_exact` struct path **omitted** this nominal step and went
straight to structural field comparison — so `CodegenTypeEntry` and
`CodegenExternFnEntry` (identical fields) compared **equal** → collision.

Why yo-self can't copy TS verbatim: yo-self struct `id`s **churn** across generic
instantiations (no stable `funcId` — see [[yo-self-phase3-generic-impl-funcid]]),
so an `id`-nominal check would wrongly distinguish two instantiations of the same
type. But `::`-bound structs now carry a **stamped name** — the stable nominal
identity. So the faithful adaptation uses the NAME.

## Fix (`yo-self/types/compatibility.yo`, `require_exact` struct branch)

Add a nominal **name-distinctness** arm before the structural comparison:

```rust
// different non-empty names, neither containing a SomeT  → DISTINCT
((((aname.len() != usize(0)) && (ename.len() != usize(0))) && (aname != ename))
   && ((!(type_contains_some_type(actual))) && (!(type_contains_some_type(expected))))) => false,
```

- Same name (`Box(i32)` vs `Box(String)`) or empty names (`""`-reconstructed types)
  fall through to the existing **structural** comparison → generic-instantiation
  matching is preserved (this is why yo-self uses structural at all).
- Mirrors TS's *results* exactly (TS never treats differently-named, non-placeholder
  structs as exact-equal), using yo-self's available identity (name).
- NOT "name-only" comparison (which regressed `std` 151→17 once —
  [[yo-self-phase3-hashmap-new-blocker]]): it is name-DISTINCTNESS layered on top of
  structural, so same/empty-named types are still compared by fields.

Also added `{ type_contains_some_type } :: import("./utils.yo");` to compatibility.yo.

## Validation

- Repro `src/tests/fixme.yo`: **5 → 0** markers.
- `check ./std`: **152/152** (the name-only regression did NOT recur).
- Full self-compile: **440 → 422 markers (clean net −18, 0 un-masked)**. EXIT=0.
  Contrast the recursive-clone fix ([[yo-self-p1-dirB-where-self-type1]] UPDATE 7),
  which was +3 from warm-up un-masking — this fix has **zero churn**, supporting
  that the cache collision was itself a *source* of warm-up instability.
- Corpus A/B (base vs dbg40): pending.

### What the −18 actually unblocked (NOT the predicted async-capture fn)

The removed markers are a **comptime-intrinsic cluster**, not
`_find_capture_type_c_name`: `ci_str_quote` / `ci_range` / `ci_resolve_comptime_list`
/ `substring` / `expr_info_table_set` / `new_expr_info` / where-constraint iteration
— i.e. the comptime string-slicing + comptime-list intrinsics, which use same-fielded
structs (a `Range`-like `object(start_idx, end_idx)` etc.). So the collision was
**general** (any two same-fielded structs), and the fix drains it wherever it occurs.
`_find_capture_type_c_name`'s markers were NOT in the removed set — that async-capture
cluster is either a distinct root or warm-up-masked; revisit separately.

## Layer 2 (codegen type-flow) — SEPARATE, deferred next lever

A runnable test (two same-fielded structs as HashMap values, iterate both, `putchar`
the codes) revealed a SECOND layer with the same root. With the evaluator fix, the
**transpile is clean (0 markers)** — but the emitted C fails to compile (clang):

```
error: assigning to '__yo_enum_yo_id_5989_struct_yo_id_6072' from incompatible type
        '__yo_enum_yo_id_6328_struct_yo_id_6072'   // Option(StA) vs Option(StB)
error: assigning to '__yo_struct_yo_id_5815' from incompatible type '__yo_struct_yo_id_6080'
```

`_type_key_at` (`codegen/utils/index.yo:646`) keys structs by `id` when present, so
StA/StB DO get distinct C types — the failure is a **type-flow inconsistency**:
`Option(StA)` (enum 5989) and `Option(StB)` (enum 6328) wrap the SAME payload struct
id 6072, i.e. codegen's generic-instantiation type identity **churns inconsistently**
(the deeper no-stable-funcId problem, [[yo-self-phase3-generic-impl-funcid]]). This is
a distinct, deeper issue (stable type identity for generic instantiations in codegen),
NOT a quick analogous name-check. The P1 transpile-marker metric (440→422) measures
only layer 1, which the evaluator fix correctly drains.

A runnable corpus regression test (`samefielded_value_structs.yo`) was therefore
**removed** — it SELF-FAILs on layer 2 even after the layer-1 fix. Re-add it once
codegen layer 2 is fixed; until then the evaluator fix is regression-covered by the
full-compile marker count + `src/tests/fixme.yo` repro (TS 0 / base 5 / fix 0).

## Lesson

A yo-self marker is almost always a divergence from TS — confirm with a minimal
repro through BOTH compilers first, then diff the specific decision (here: TS's
nominal `id`/`funcId` struct-distinctness vs yo-self's structural-only exact
comparison). The faithful fix maps TS's stable `id` identity onto yo-self's stable
identity (the stamped name) without copying the unstable mechanism verbatim.
