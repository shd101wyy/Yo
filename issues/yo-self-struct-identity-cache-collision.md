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

| compiler                  | markers                                                    |
| ------------------------- | ---------------------------------------------------------- |
| TS reference (`./yo-cli`) | **0**                                                      |
| yo-self clean HEAD        | **5** (`mb.set`, both `.values()`, both `.next()` matches) |

TS handles it; yo-self does not → a port divergence, not a language bug.

## Root cause — yo-self omits TS's nominal struct-distinctness check

`are_types_compatible_exact` (the comptime-fn cache key, via
`_ctfe_args_equal` → `compatibility.yo`) compares two structs under
`require_exact`. TS (`src/types/compatibility.ts:288-306`) does a **nominal**
check first:

```ts
if (
  expected.fields.length !== given.fields.length ||
  (expected.type.id !== given.type.id && // different identity
    !typeContainsSomeType(expected.type) && // neither is a placeholder
    !typeContainsSomeType(given.type) &&
    !sameFuncId)
)
  // not the same constructor
  return false; // → DISTINCT
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
- Mirrors TS's _results_ exactly (TS never treats differently-named, non-placeholder
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
  that the cache collision was itself a _source_ of warm-up instability.
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

**ROOT-CAUSED (probe-confirmed, see task #30):** generic type instantiations are never
interned to a stable id. `HashMapValues` is an anonymous `struct(...)` (hash*map.yo:631)
returned by a comptime fn. An instrumented `comptime_fn.yo` probe showed the constructor
appears under **7 different func_ids** (funcId churn across specialization contexts) AND
the comptime-fn cache **misses every time within each func_id** (HIT=0); `yo_id_5968`
missed 3× → struct ids 5981/6001/6199 = the exact conflicting C ids. So each instantiation
re-runs `handle_struct_def` → fresh `struct*${random_id}` → codegen emits distinct
incompatible C types → clang fails. The clang conflicts span **both** within-func_id
(5981/6001/6199) and across func_ids (`Option` enums 5989 vs 6206), so the 7 func_ids
must collapse to ONE stable id.

**CONFIRMED pre-existing and general** (NOT caused by the layer-1 fix): the _base_ binary
(no compat fix) fails the _single-struct_ repro identically (5 clang errors, 0 transpile
markers). `HashMap.values()/.next()` returning any struct value is simply broken in
yo-self codegen; the corpus never exercises it and `check ./std` is evaluator-only.

The fix is the deep **funcId-stability refactor** (give generic fns/type-constructors
their definition funcId, à la TS `functionValue.funcId`, so the cache interns
instantiations) — [[yo-self-phase3-generic-impl-funcid]], attempted + reverted once
("may need a Struct funcId field"). Core type-identity machinery, broad regression risk,
multi-session — NOT a quick fix, and NOT resolvable by a within-func_id sub-fix. The P1
transpile-marker metric (440→422) measures only layer 1, which the evaluator fix drains.

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

## Layer 2 — UPDATE 2026-06-29: faithful codegen-key fix landed (core) + multi-layer map

**Confirmed yo-self-ONLY (TS has no bug).** TS `src/evaluator/calls/comptime-fn.ts` MEMOIZES
comptime type-constructor calls in `functionValue.calledComptimeFunctionCaches` keyed by
`(funcId, argValues)` → `Bucket(i32,N)` returns the SAME interned struct (stable `id`)
everywhere; it also stamps `typeName="Bucket(i32,N)"` + `functionValue`. yo-self's cache
(`g_comptime_fn_caches`) misses on the args comparison → fresh `struct_${random_id}` each time.

**Probe finding (decisive):** for `HashMap(i32,N)`, the two `Bucket` struct ids (3819/4094)
BOTH carry the SAME `constructor_func_id=yo_id_3766` + `type_arguments=[i32,N]`. So the random
`id` churns but `(constructor_func_id, type_arguments)` is STABLE — yo-self DOES stamp it at
instantiation (comptime_fn.yo:841-851), the faithful analogue of TS's `(funcId, argValues)`.

**Fix landed (faithful, the issue-endorsed mapping — NOT the unstable cache mechanism):**
`_type_key_at` (codegen/utils/index.yo) now keys a generic-instantiation struct (non-empty
`constructor_func_id` + `type_arguments`) by `gs_${cfid}_${recur(type_args)}` instead of the
churning `id`. **Regression-free: corpus 88/88 DIFF 0 SELF-FAIL 0.** Eliminates the FATAL
`Bucket`-value-struct assignment errors — `HashMap(i32,Self)` cycle went from a hard C-compile
error to COMPILING.

**Confirmed multi-layered (matches the original "multi-session" assessment).** Full
`HashMap`-of-RECURSIVE-ref-struct support additionally needs, each a SEPARATE mechanism:

1. **cfid consistency:** the SAME struct (id 4090 = `HashMap(i32,N)`) reaches codegen sometimes
   with `cfid=3802` (→ stable `gs_` key) and sometimes `cfid=""` (→ falls back to churning
   `id` key) → re-fragments into two C types. substitute/clone/shell-resolution all PRESERVE
   cfid (verified), so the `cfid=""` comes from an evaluation-order / early-collection path
   (unpinned). This is the next layer to land for the codegen-key fix to fully bite.
2. **Recursive self-shell id stability:** `N` (recursive through `HashMap(i32,Self)`) fragments
   via the struct self-shell (4090 vs 4088) — a different mechanism from generic-instantiation
   identity (related to the recursive-enum/struct self-shell work).
3. **Separate pre-existing codegen bug:** `use of undeclared identifier _file____tmp__temp_2154`
   in HashMap `set`/`_resize` — unrelated to type identity; blocks the non-cyclic set/get path.

So the codegen-key fix is the faithful CORE (regression-free); layers 1–3 remain for the full
`HashMap`-of-ref-struct use case. `tests/codegen-bootstrap/hashmap_self_cycle.yo` stays held
(TS-validated; saved at `/tmp/hashmap_self_cycle_hold.yo`) until layers 1–2 land.

## Layer 2 — UPDATE 2 (2026-06-29): full use-case map — 3 DISTINCT deep bugs, only 1 is task #30

Exhaustive investigation of `HashMap`-of-recursive-ref-struct (the use case that surfaced
task #30). It is blocked by THREE independent deep bugs; only the first is task #30:

1. **Type-identity (task #30 proper).** The cfid-key fix (committed 69eabca07) collapses the
   cfid-STAMPED subset, but the churn is pervasive: generic ENUM instantiations (`Option(...)`)
   churn ids too (the EnumT key uses the id), and the SAME struct reaches codegen with `cfid`
   sometimes empty. The complete fix is the TS-faithful MEMOIZATION root — make
   `g_comptime_fn_caches` HIT for recursive generic instantiations so ONE struct object (stable
   id) is returned everywhere (TS's `calledComptimeFunctionCaches`). The cache misses because a
   recursive type arg is the self-shell / SomeT-template on first instantiation and resolved
   later (`_ctfe_args_equal` → unequal). ATTEMPTED: adding `resolve_struct_shell` to
   `are_types_compatible_exact` (mirroring the enum-shell handling) — did NOT fix the case
   (reverted); the actual mismatch is the SomeT-template, not a shell.
2. **Substitution template-leak (NOT task #30).** `Bucket(K, V)` with unsubstituted SomeT args
   (`gs_..._1832_1833`) reaches codegen as a concrete C struct — i.e. a `HashMap(i32,N)` copy
   whose `data : ?*(Bucket(K,V))` field never had `K→i32, V→N` substituted. A
   nested-generic-instantiation substitution gap.
3. **RC-dup undeclared-temp (NOT task #30).** `HashMap.get` returning `Some(bucket.value)` (an
   RC field of a value-struct local) emits `__yo_incr_rc(_file____tmp__temp_NNNN)` referencing
   a dup-result temp that is never declared — a deferred-dup materialization gap for a
   field-access dup source in a match-arm-return context.

Each is core-compiler deep work (substitution / comptime memoization / RC-dup codegen);
together MULTI-SESSION, matching the original assessment. **Task #30 does NOT block P1** — no
corpus test uses HashMap-of-ref-struct (the held `hashmap_self_cycle.yo` is TS-validated),
corpus is 88/88, `check ./std` 152/152, yo-self builds. The cfid-key core fix is the landed,
regression-free, faithful first layer.

## Layer 2 — UPDATE 3 (2026-06-29): the 3 use-case bugs fixed — HashMap-of-ref-struct WORKS

`HashMap`-of-ref-struct now compiles, runs, AND collects cycles in yo-self (corpus 89/89,
`tests/codegen-bootstrap/hashmap_self_cycle.yo` re-added + passing differentially; `HashMap(i32,N).get`
→ "got 42"; `HashMap(i32,Self)` cycle → "fully reclaimed"). The three use-case bugs:

1. **Type identity (task #30):** the cfid-key (`_type_key_at`, commit 69eabca07) collapses the
   cfid-stamped generic-instantiation structs. A residual remains: some struct copies reach codegen
   with `constructor_func_id` empty (an unpinned eval-order/recursive-self-shell path), keyed by the
   churning raw id, so a layout-identical `HashMap(i32,N)` copy gets two C structs → a clang
   `-Wincompatible-pointer-types` WARNING. It is **benign** (the structs are layout-identical; the
   pointer is used identically and the cycle GC traverses correctly — the program runs + collects).
   Full elimination = the deep memoization root (make the comptime-fn cache HIT for recursive args so
   ONE struct object exists) — risky, cosmetic, separate.
2. **Substitution template-leak:** resolved/benign in practice — `HashMap(i32,N).get` now compiles
   cleanly ("got 42"); no template-leak error.
3. **RC-dup undeclared-temp (bug 3): FIXED** (commits db2b47d4d + 74a7611bd). Two parts:
   (A) inline value-struct `___dup` in `generate_dup_code_for_value` (value structs had no dup → a
   copy didn't dup its RC fields); (B) materialize the phantom dup-source temp for field-access
   ref-handle dups in `emit_deferred_dup_or_code` (`incr_rc(<undeclared temp>)` → `T tmp = x.f;
incr_rc(tmp)`, TS's materialize-then-dup, guarded against redefinition where the temp is
   pre-declared). This was an RC-layer port gap, not task #30.

Net: the use case is FUNCTIONALLY complete (compiles + runs + cycles collect, matching TS); the only
residual is the benign bug-1 cosmetic warning. Validated regression-free: corpus 89/89, TS check ./std
152/152.

## UPDATE 4 (2026-06-29): bug-1 cosmetic warning ELIMINATED

The residual clang `-Wincompatible-pointer-types` warning is now fixed. Root cause: the same
generic-instantiation struct (e.g. `HashMap(i32,N)`) reached `_type_key_at` as TWO different
TypeValues — one stamped with `constructor_func_id` + `type_arguments` (producing the stable
`gs_<cfid>_<args>` key), and one unstamped copy (cfid="", tas.len=0) falling back to the churning
raw `id` key. Both had the same struct `id` but different cfid states.

**Fix** (`yo-self/codegen/utils/index.yo`, `_type_key_at` Struct branch):

1. **Struct-shell resolution** — `resolve_struct_shell(t)` mirrors the existing enum-shell
   resolution in the EnumT branch: an empty-field self-shell resolves to the final struct, so
   the shell and final share one C type key.

2. **Side-table dedup** — `g_struct_cfid_keys: ArrayList(StructCfidKeyEntry)` maps struct*id →
   cfid-based key. When a cfid-present struct generates its `gs*<cfid>\_<args>`key, it records`(struct_id, key)`. When a cfid-empty copy reaches the same branch, it searches the
side-table and reuses the same key. Linear scan (ArrayList, not HashMap) — cheap because the
side-table is only hit during type collection, not per-expr lowering, and avoids the
HashMap resize/rehash that caused an abort inside the recursive `\_type_key_at` hot path.

This is faithful to TS's principle ("one type → one C name") — TS achieves it via comptime-fn
memoization producing one struct object; yo-self achieves it via struct-id-keyed key dedup at
the codegen level.

**Validated:** corpus 89/89 (0 DIFF, 0 SELF-FAIL), TS `check ./std` 152/152, hashmap cycle test
compiles with ZERO incompatible-pointer-type warnings and runs correctly ("hashmap cycle fully
reclaimed").
