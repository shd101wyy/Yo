# yo-self P1 — executing-mode transpile-error tail (candidates)

## 2026-06-25 (cont.) — ✅ branch-merge `case<base` fix: 422 → 416 (−6), clean

**Committed.** The largest REAL cluster in the 422 [TTERR] map (the 9 "Frame level N has
different number of values" throws — `merge_and_check_envs`, `yo-self/evaluator/utils.yo`)
is now drained net −6.

**Root:** the per-frame **value-count check** (utils.yo:762-813) threw whenever a case env
was SHORTER than the base at a non-innermost frame (`case_vars_len < base_vars_len`, the
`true =>` arm at :800). But that is NOT an inconsistency: (1) the base frame GROWS during
this very `cj` loop via temp-adoption (:783 pushes adopted temps into the base frame), so a
LATER case env is compared against the grown base and spuriously looks short; (2) a trivial
arm (`.None => .None`) records no copy of an enclosing binding its siblings carry (the
yo-self per-arm recorded-env divergence from TS). The downstream **names check** (:815-841,
reads a missing case var as base at :827) and **per-column consume/init merge** (:847+, at
:866) were ALREADY made `case<base`-tolerant; the value-count check just never matched them.

**Fix:** the `case_vars_len < base_vars_len` branch now defers to those downstream checks
(`true => ()`) instead of throwing — symmetric with the `case>base` all-temps branch above.
A genuine inconsistency (a missing NON-temp binding, or a consume/init split) is still caught
by the names check + the per-column merge, so soundness is preserved (cf.
[[yo-self-branch-merge-trivial-arm]] SOUNDNESS note). Validated: full self-compile 422→416
EXIT=0, `check ./std` 152/152, A/B corpus 83/83 CHANGED=0. The −6 (vs 9 targeted throws) is
the documented un-masking: draining a guard-throw early in a fn body surfaces the next throw
unless the whole body is clean.

## 2026-06-25 — markers 440→422 (struct-identity fix); [TTERR] map of the remaining 422

**Committed:** `9a160f286` nominal struct-distinctness in `are_types_compatible_exact`
(same-fielded-struct comptime-fn cache collision) → **440→422, clean −18, 0 un-masked**.
std 152/152, corpus 83/83. See `issues/yo-self-struct-identity-cache-collision.md`.

**[TTERR] swallowed-throw map of the 422** (instrumented `_trial_eval_fn_body` swallow
handler with `println(\`[TTERR] ${_err.to_string()}\`)`, full self-compile EXIT=0):
only **43 distinct swallowed throws** produce all 422 markers (~10 cascaded marker-lines
per root throw; 309 of the 422 are enclosing `if(`). Clustered + cross-referenced vs the
actual stage2 markers:

| swallows | category | location | → markers? |
| --- | --- | --- | --- |
| **19** | `Type mismatch member "value"` Got `Type(1)` | hash_map.yo:82 / hash_set.yo:74 (`with_capacity` `Self(…)`) | **0 — WARM-UP-MASKED noise** (confirmed: 0 stage2 markers) |
| **9** | `Frame level N … different number of values for different cases` | suspension_analysis.yo:479(3)/:134(2), trait_checking.yo:1143/:1391, function.yo:1698, await.yo:125 | **YES — largest real cluster** (branch-merge) |
| 7 | `Incompatible types` | flowability:674, import:214, va_start:88, gensym:116, comptime_assert:81, and_or:77 | scattered (≈6 distinct) |
| 3 | `Type mismatch member "args"/"field_types"` | definitions.yo:362 (recursive `TypeValue.clone`), parser.yo:982/:1392 | recursive-clone + array_list args |
| 2 | `Expected bool` | formatter.yo:174, utils.yo:934 | |
| 2 | `Cannot unify` | function.yo, await.yo | |
| 1 | `Argument count mismatch` | parser.yo:1205 | |

**KEY: the dominant [TTERR] cluster (19 `"value"`) is masked NOISE (0 markers)** — exactly
the doc-wide overcount warning. The real next target = **branch-merge "Frame level" (9
swallows)**: `merge_and_check_envs` too strict vs per-arm frame divergence
([[yo-self-branch-merge-trivial-arm]], partial fix already landed for target.yo/naming_checker).
Codegen layer-2 (funcId churn) is the deeper, deferred refactor (task #30) — not these.

## 2026-06-24 (cont. 2) — TS↔yo-self divergence comparison: real divergences found, +0 on dominant markers

A 6-pair parallel TS↔yo-self comparison (adversarially verified) of the def-time-eval /
type-check modules found CONCRETE VERIFIED porting divergences — confirming the hypothesis
that divergences cause the bugs. But the ones found are EDGE-CASE divergences: implementing
two was **+0 markers** in the full self-compile (std 152/152, corpus 83/83), because the
DOMINANT markers come from a deeper recursive-type behavioral gap, not these line-diffs.

**Verified divergences (real porting bugs; worth fixing for faithfulness, NOT the dominant root):**
1. `types/compatibility.yo:331-335` — compares TUPLE element LABELS; TS (compatibility.ts:262-263)
   explicitly does NOT ("Tuple is structural, not nominal"). Removing the check → +0. REVERTED.
2. `evaluator/exprs/property_access.yo` (533, 1280/1301/1312/1317, 1403/1412/1417) — field/deref
   access on an unknown receiver calls `create_unknown_val(ft)`, but TS `createUnknownValue` wraps
   a `Type(0)` (type-level) field in a SomeType (yo-self's own SomeT branch ~1075 already does it).
   4 struct-field sites via a helper → +0. REVERTED. (Targets type-level assoc fields.)
3. `evaluator/calls/type.yo:272` — construction validation drops the expected-type context to
   `convert_comptime_type_to_runtime_type` (comptime_str field expecting `*(u8)` → `str`). NOT TESTED.
4. `evaluator/calls/helper.yo:1465` — specialized FuncVal carries `cloned_body` (unevaluated) vs
   TS `specializedBody` (evaluated). DELIBERATE yo-self comment → risky/uncertain. NOT TESTED.
5. `evaluator/exprs/match.yo` — doesn't refresh `evaluatedBody.$.env` after pop_frame before
   consume_case_body_temp_var (TS does). Medium. NOT TESTED.
6. `evaluator/calls/function_type.yo:600-614` — empty placeholder FuncVal to the body-eval ctx vs
   TS's real functionValue (known; tied to the inert recur work).

**KEY RESULT:** the comparison METHOD is sound — it's how the 3 LANDED fixes were found
(return()-unit ← begin.ts:1122, match-expected_type ← match.ts:471, where-clause ← impl.ts:2425;
each a divergence on the SPECIFIC failing construct). But the remaining dominant markers are NOT a
localized line-divergence — they are a DEEP behavioral gap in recursive-type def-time handling
(`(*(T))(ptr)`→Type(1) in HashMap/HashSet `with_capacity`; clone→TypeVal; box-deref-field→unit on
recursive structs; the self-shell). SIX fix attempts (recur×2, _apply_ref_amp, cfid, tuple,
property_access-Type0) were +0 in the full compile — the markers are warm-up/context-dependent and
resist instrumentation-guessing AND edge-case-divergence-fixing. The dominant root is the
recursive-type behavioral work (multi-session). [[yo-self-recursive-enum-self-shell]]

## 2026-06-24 (cont.) — ⚡ FAST LOOP + remaining frontier precisely scoped (multi-session)

**FAST ITERATION LOOP (the process win).** Full `main.yo` self-compile is ~45-50 min and
was the bottleneck. Def-time throws are PER-MODULE + deterministic → validate a fix by
standalone-compiling ONLY the target module:
`YO_MAIN_STACK_MB=4096 yo-self-bin compile yo-self/<path>/M.yo --emit-c --skip-c-compiler -o /tmp/mod`
(other_fn_call.yo = 2m20s/53 markers; async.yo = 3m44s/108 markers). Per-fix cycle ~55m→~20m;
an INERT fix is caught at ~13m. CAVEAT: standalone OVERCOUNTS warm-up-masked errors
(hash_map/hash_set `with_capacity` `Self(…*(Bucket(K,V))…)` → "value: Type(1)" — ~0 markers
in the full compile; filter them). Full self-compile = periodic checkpoint only.

**Precise async.yo error map (19 def-time throws, instrumented standalone compile)** — after
filtering warm-up-masked hash_map/hash_set noise, the REAL remaining clusters are all
recursive-type / structural-identity / branch-merge (NO quick convergent wins left):
1. **`box.*.field` → unit** (env.yo:925 `boxed.*.name`; await_analysis.yo:248 `owner_box.*.id`;
   suspension_analysis.yo:227 `owner_var.id`). `Variable` is a recursive struct
   (`is_owning_the_same_rc_value_as : Option(Box(Variable))`). **EMPIRICAL: a minimal repro
   (`RecS :: object(name, other : Option(Box(RecS)))` + `b.*.name`, called from main)
   compiles to 0 markers** — so it is NOT a generic recursive-struct-deref gap; it is
   CONTEXT-DEPENDENT (forms only with Variable's full definition / env.yo's type-definition
   order — a shell that only materializes in the real compile context). Resists isolation.
2. **Structurally-identical struct collision** — "Cannot unify CodegenTypeEntry and
   CodegenExternFnEntry" (both `object(ty, c_name, c_include)`, index.yo:75-76).
   `_find_capture_type_c_name` (async.yo:437, the full-compile #1 ≈126-marker fn) iterates
   `context.base.types.values()` (HashMap V=CodegenTypeEntry); the generic `.values()/.next()`
   instantiation collides with the CodegenExternFnEntry one in the comptime-fn/struct-identity
   cache ([[yo-self-phase3-hashmap-new-blocker]] "name-only struct comparison is unsound").
   Fix direction: cache key must distinguish same-fielded structs by NAME.
3. **Branch-merge "Case env is missing outer frames"** (trait_checking.yo:1143/1391,
   suspension_analysis.yo:134) — [[yo-self-branch-merge-trivial-arm]], merge_and_check_envs
   too strict; workflow did not confidently solve.

**Conclusion:** convergent quick wins (527→445) EXHAUSTED. The remaining bulk = recursive-type
self-shell (enum + struct) + structural-struct identity + branch-merge — context-dependent,
resists isolation (#1 repro proves it), a focused MULTI-SESSION refactor. Best executed fresh
with the fast loop (module-by-module), NOT mid-session. The enum-shell elimination (approach D)
gave +0 markers, so a struct-shell fix may be orthogonal too — validate on the real compile
context before investing.

## 2026-06-24 — diagnostic-driven drain: 527 → 522 → 485 → … (instrumentation + parallel root-cause workflow)

**Marker progression (committed):** 527 →(where-clause, b45ee91e7)→ 522
→(return() unit, a0a45270e)→ 485 →(match.yo expected_type, 7ab2e6183)→ **445**.
All three validated: check ./std 152/152, differential corpus 83/83 (DIFF 0),
self-compile EXIT=0 at each step.

**Cycle 3 (recur-at-def-time) — TWO fixes tried, BOTH inert (+0), REVERTED.**
`recur(...)` genuinely fails at def-time body eval (confirmed: `_value_contains_unknown`'s
`if(recur(f), …)` is a marker; `__recur_fn` is bound only at call time, function.yo:2548,
and `_build_def_time_body_env` drops the caller's capture). Tried: (a) bind `__recur_fn`
to `func_val` in the def-time body env — inert (recur is NOT resolved via env lookup at
def-time); (b) pass the real `func_val` (not the empty `flow_fv` placeholder) to
`create_function_body_evaluation_context` so `evaluate_recur`'s
`is_validating_function_definition` short-circuit reads it from `func_body_ctx.func_value`
(faithful to TS function-type.ts:491-494) — ALSO inert. Root: the recur short-circuit
(recur.yo:164) calls `try_to_call_function_with_arguments(func_val, …, skipSpecialization,
skipCtfeExecution)` which STILL fails at def-time — the blocker is the def-time call
machinery, not the func value. Both safe (std 152/152, corpus 83/83) but 0-marker, so
reverted (no speculative code). NOTE: the `flow_fv` empty-placeholder IS a real divergence
from TS (TS passes the real functionValue) — worth fixing TOGETHER with the recur
short-circuit when that's tackled.

**Top remaining targets (445-base, by marker count; yo_id shifts per build — match by
expr):** #1 ~126 = a `type_key(entry.ty) == target_key` reverse-lookup scan whose throw
is "Cannot unify incompatible STRUCT types" (synthetic token → codegen/utils/index.yo:1),
i.e. a recursive-enum/struct-unification failure inside `_type_key_at`'s `resolve_enum_shell`
+ EnumT/Struct id handling — the documented self-shell family, NOT recur (the workflow
mis-diagnosed it as recur; the error category disproves that). #2 ~83 = an `_unwrap_unsafe`-
shaped body (`.FnCall(_,_,args,_,_) => … args.len() …`) — a recursive-enum DESTRUCTURE
whose bound field resolves to a TypeVal/unit. These two = 47% of the tail and both reduce
to the recursive-enum field-type / self-shell cluster (the hardest unsolved area). Smaller
solid wins from the workflow (verifier-adopt, faithful, low-risk): `_apply_ref_amp`
(other_fn_call.yo) nested-cond `c.len() - usize(1)` → extract to a typed binding (mirrors
line 98); `generate_type_declarations` (types/generation.yo) add explicit `()` to the
queue.push if-blocks.

**Method that worked (reusable):**
1. Instrument the def-time-eval swallow `_trial_eval_fn_body` (function_type.yo) with
   a capture-free handler `((_err) -> { _tt_eprint(\`[TTERR] ${_err.to_string()}\n\`); unwind(()) })`
   (`_err.to_string()` embeds file:row via format_error_message; `_tt_eprint` = a
   non-aborting libc fwrite, mirror panic_dyn). The handler CANNOT reference module
   variables — only its local `_err` + module fns. Build `--optimize 1`, run the
   self-compile capturing `2>stderr`, then cluster `[TTERR]` blocks by (error, file:row).
   REVERT the instrumentation before committing fixes.
2. Cluster the actual stage2.c markers by enclosing C function
   (`awk '/^static .*yo_id_[0-9]+\(/{...}'`) — this is the GROUND TRUTH for which
   functions block the fixpoint (vs the [TTERR] map, which OVERCOUNTS warm-up-masked
   std specializations like hash_map/hash_set with_capacity `(*(T))(ptr)→Type(1)`).
3. Fan out a parallel root-cause Workflow (one Explore agent per distinct throw site →
   adversarial-verify each proposed fix vs the TS reference + regression risk → group by
   shared_root_key). The verify stage correctly REJECTED several wrong root-causes
   (trait-default `!=` band-aid [known std 152→104 regression], flowability Box,
   await String/str, env.yo `boxed.*.name`, future-trait label-type).

**The two dominant CONVERGENT compiler roots (both TS-faithful porting bugs):**
- ✅ **`return()` (zero-arg call) not treated as unit** (begin.yo, FIXED a0a45270e, −37).
  Routed to the `return(val)` branch → `args.get(0)`=None → `make_err_expr()` → poisons
  return-type inference ("got fn(T:Type)->Type"). TS begin.ts:1122-1124 treats
  atom-OR-zero-arg-call as unit. This was the dominant async/await/state-machine cluster.
- ⏳ **match arm bodies don't get `expected_type` propagated** (match.yo, IN VALIDATION).
  TS match.ts:471 sets `expectedType: resultType ?? context.expectedType` per arm so a
  bare `.None`/`.Variant` (shorthand enum) infers its type from earlier arms. yo-self
  tracked `result_type_pm`/`result_type_em` but never threaded it. Fix = set
  ctx.expected_type at all 4 arm-body eval sites (260/530/1357/1912). Targets the
  "Failed to infer enum variant type" cluster (while_loop, panic, typeid, open,
  utils/index) — the principled root vs the per-site `Option(T).None` band-aids.

**Remaining clusters (from the 46-agent workflow, ranked):**
- "Case env is missing outer frames" — branch-merge, 7 sites (return.yo, function.yo:1698,
  await.yo:125, trait_checking.yo:1143/1391, suspension_analysis.yo:134, var_fns.yo:156).
  Documented [[yo-self-branch-merge-trivial-arm]]; merge_and_check_envs too strict. The
  workflow did NOT confidently solve these — needs the documented relaxation.
- "Type mismatch for type member ... got Type(1)" in yo-self files (NOT std): definitions.yo:362
  (`types.clone()` recursive-enum), suspension_analysis.yo:227, await_analysis.yo:248,
  comptime_index_fns.yo:235 — recursive-enum field / clone-resolves-to-TypeVal family.
- numeric-type-constructor dispatch (comptime_index_fns.yo:235 → fix in function.yo ~2230):
  ensure TypeVal-context numeric converter sets ExprInfo to the target type.
- evaluator/builtins "Incompatible types" (alignof.yo:103 — fill `.None` arm with
  `create_unknown_val(t_usize())` mirroring sizeof.yo; and_or, va_start, gensym, …).
- parser.yo array_list macro (982/1205/1392) — MACRO_DISPATCH-gated, DEFER.
- String-vs-str residue (function.yo:1, await.yo:1) — slice/overloading-redesign tail.

## 2026-06-23 (✅ FIX LANDED) — where-clause check in `try_match_generic_impl` (blanket-scoped): 527 → 522

Implemented the TS-faithful where-clause check (impl.ts:2425-2432) in yo-self's
`try_match_generic_impl` (`evaluator/values/impl.yo`). For a BLANKET impl
(`impl(forall(I), where(I <: Iterator), I, …)` — receiver pattern is a bare type
variable), a concrete type bound to a where-constrained forall param must implement
the constraint trait via `g_type_implements_trait_fn`, else the impl does NOT match.

**Mechanism delivered:**
- `GenericImplEntry` gained two parallel arrays `where_constraint_some_types` /
  `where_constraint_traits` (mirrors TS `GenericImpl.whereConstraints`).
- `_collect_impl_where_constraints` parses the `where(...)` clause at BOTH positions
  (before the receiver `forall(I), where(…), I, …` and after it
  `forall(T), Channel(T), where(…), …`); splits a tuple RHS `(Send, Acyclic)` into
  per-trait constraints (a tuple-as-type throws).
- The check resolves the bound type via `_resolve_one_forall_binding` (same path as
  the bindings loop, with the name fallback) — a plain env lookup leaves it abstract
  and silently skips the check.

**Blanket-scoping (the key safety adaptation):** the check runs ONLY for blanket
impls (`is_some_type(entry.receiver_type_pattern)`). Specific-pattern impls
(`ArrayList(T)`, `HashMap(K,V)`) already constrain via their pattern; enforcing THEIR
where-clauses here wrongly excludes them when the trait-implements predicate is
incomplete — e.g. the load-order false-negative on `String <: Hash` broke
`HashMap(String, _).new()` (self-compile EXIT=1) under the unscoped check. TS enforces
all where-clauses because its predicate is complete; scoping to blankets is the safe
yo-self adaptation and still catches the Iterator-blanket shadowing (the actual bug).

**Validated:** repro 0 markers (ArrayList + HashMap `into_iter().next()` both resolve);
`check ./std` 152/152; differential corpus 83/83 (DIFF 0); full self-compile EXIT=0
with **522 markers (was 527, −5)** and the `HashMap.new → unit` hard error gone.

The 5-marker drain confirms the into_iter blanket-shadowing was a small facet of the
527 (not the ~40-marker async cluster originally hypothesized). The remaining 522 have
OTHER roots — re-measure the throw→function map (`scratchpad/diag.sh`) on this base and
drain the next-biggest cluster.

## 2026-06-23 (DEFINITIVE ROOT) — yo-self `try_match_generic_impl` SKIPS where-clauses (a yo-self bug, NOT a TS bug)

Traced `coll.into_iter().next()` → unit all the way down (smoking-gun trace below).
THE ROOT: yo-self's `try_match_generic_impl` (evaluator/values/impl.yo:324-331) is a
documented **Phase-3.5 simplification that SKIPS where-clause constraints**
(verbatim: "Where-clause constraints skipped (no `g_type_implements_trait_fn` check
yet …)"). TS's `tryMatchGenericImpl` (src/evaluator/values/impl.ts:2337-2342) CHECKS
all `impl.whereConstraints`. So the std blanket
`impl(forall(I), where(I <: Iterator), I, into_iter : fn(self)->Self)` (prelude.yo:7939)
matches EVERY type in yo-self (the `I <: Iterator` gate is ignored) but only real
iterators in TS.

**Smoking-gun trace** (instrumented `_try_find_receiver_method`): for `xs : ArrayList`,
`into_iter` has **2 hits** — hit#0 = the blanket (`-> Self`, returns the receiver
type) and hit#1 = ArrayList's own (`-> ArrayListIter`). `_select_matching_overload`
(function.yo:462) trial-calls in order and picks the first arg-compatible one = hit#0
(blanket), since the trial's Step-8b `validate_where_constraints_for_call` is scoped to
MARKER traits (Send/Sync), not `Iterator`. So `it : ArrayList`, then `it.next()` finds
no `next` on ArrayList (hits=0) → degenerates to `unit` → "match got unit". This
mis-resolves iterator methods on EVERY collection — the ~40-marker async/iterator
cluster (yo-self's build/fetch/version code iterates heavily, so it blocks the fixpoint).

**It is a yo-self bug, not a TS bug** (TS self-compiles to 0 real markers; TS's
where-check excludes the blanket for ArrayList).

**FIX (TS-faithful):** port TS impl.ts:2337-2342 into yo-self's `try_match_generic_impl`
— for each `where` constraint, if the concrete type does NOT implement the constraint
trait, return `matched=false` (skip the impl). Use the `g_type_implements_trait_fn`
hook (comment says it exists "beyond returning true if function pointer is set"). The
earlier into_iter-return / get_all_some_types framings were SURFACE symptoms of this.
**CAVEAT:** the trait-implements predicate must be complete — an incomplete
`<: Iterator` check would wrongly exclude the blanket for REAL iterators (ArrayListIter
etc.), breaking iterator chains (the same risk the Send/mutex where-validation work
documented: unscoped enforcement regressed std→145). Validate with corpus + std +
self-compile. The earlier-tested fixes (get_all_some_types type_args; +0) were reverted.

## 2026-06-23 (earlier framing) — 🎯 ROOT ISOLATED: `coll.into_iter().next()` → unit at def-time

Definitive throw→function map (instrumented `_trial_eval_fn_body`: `[TTERR]` error
from the capture-free handler + `[TTLOC]` `module_path:row` from the caller, paired
in log order; script `scratchpad/diag.sh`). 527 markers = **93 distinct functions**,
each failing once. The single biggest cluster is **async/await** (~40 of 93:
`codegen/async/{state_machine,state_code_gen}.yo`, `codegen/exprs/{async,await}.yo`,
`evaluator/async/await_analysis.yo`, `evaluator/shared/suspension_analysis.yo`) — and
yo-self's OWN source uses async heavily (`version_cache`/`fetch`/`build_runner`/
`install_command`), so these **block the fixpoint**, they are not peripheral.

**Isolated root (minimal repro, ~10 s):** `coll.into_iter().next()` returns **`unit`**
during def-time body eval, for ANY collection (HashMap AND ArrayList), so
`match(it.next(), .Some => …, .None => …)` throws "Expected enum … got unit" and
downstream `e.value.field` throws "member value mismatch". Narrowing:
- `match(xs.get(usize(0)), .Some/.None)` (`.get()` → `Option(T)`) — **works**.
- `it := xs.into_iter(); n := it.next()` (no match) — **works** (binding `unit` is silent).
- `match(it.next(), …)` — **throws got-unit**.

So `.get()` (returns `Option(T)`) binds `T` fine, but the iterator chain does not:
`into_iter()` returns the user generic struct `ArrayListIter(T)`/`HashMapIter(K,V)`
(std; `next : fn(ref(self)) -> Option(T)`, a CONCRETE Option — no associated type),
and at def-time the iterator's element type is NOT bound to the concrete element, so
`it.next()` degenerates to `unit`. Likely a **generic-method-return-type substitution
gap for user generic structs at def-time** (Option works because it is special-cased;
`ArrayListIter(T)` is not). This is MASKED everywhere — the trial wrapper swallows it
and `check` never surfaces swallowed body-eval throws (std 152/152 despite this) — and
only becomes markers in the self-compile where codegen needs the ExprInfo.

**PINNED:** annotating `(it : ArrayListIter(EP)) = xs.into_iter()` makes the match
WORK. So the gap is precisely in binding `into_iter()`'s declared return
`ArrayListIter(T)` to `ArrayListIter(EP)` at the call site during def-time eval — the
user generic struct return type isn't being re-instantiated with the bound `T`
(Option works because it's special-cased).

**Fix attempt 1 (get_all_some_types type_arguments) — TESTED, +0 on repro, REVERTED.**
Hypothesis: `_collect_some_types_into`'s `.Struct` arm walks `field_types` but NOT
`type_arguments`, so `get_all_some_types(ArrayListIter(T))` misses `T`, and
`_resolve_some_types_deep` returns the type unchanged. Added a `type_arguments` walk
(test-safe; faithful to TS, which finds these via `StructType.fields`). Rebuilt +
ran the repro (`main` iterating ArrayList + HashMap so it codegens): **still 4 markers**
(cascading from `match(it.next(), …)`). Then instrumented `_resolve_some_types_deep`
itself with an `[RSD-IN]`/`[RSD-OUT]` print gated on `"Iter"`: **it NEVER fired** for
the repro. So `into_iter`'s return-type resolution does NOT go through
`_resolve_some_types_deep` (nor `_evaluate_funcval_runtime_call` — the `[RT]` print
there also never fired). The return type is degenerate BEFORE those resolution points.
Reverted (unvalidated, +0 on repro). The `.Struct` type_arguments gap may still be a
real latent bug worth a separate validated fix, but it is NOT this one.

**Narrowed for next session:** method calls route through
`try_to_call_function_with_arguments` (function.yo:3271, from the
`_try_find_receiver_method` site at 3205). For `xs.into_iter()` the result type is
computed somewhere in THAT path that bypasses both `_resolve_some_types_deep` and
`_evaluate_funcval_runtime_call`. NEXT: instrument inside
`try_to_call_function_with_arguments` (and its sub-dispatch) to see where
`ArrayListIter(T)`'s return type is produced and why `T` is left unbound (vs `.get()`'s
`Option(T)`, which resolves). The `.get()` vs `into_iter` discriminator + the
explicit-annotation-fixes-it fact (the value channel binds it, the inference channel
does not) both still hold.

**Code region traced (where the fix goes):** the runtime-call return-type
resolution is `_evaluate_funcval_runtime_call` (calls/function.yo:966) — it (a) binds
forall SomeTs in the return type by NAME from the call's forall bindings
(`fa_bound_names`, lines 998-1028), then (b) `evaluate_function_return_type_again`
(types/function.yo:3894 → `_resolve_some_types_deep(return_type, callee_env)`) resolves
REMAINING SomeTs from the callee env. `into_iter`'s `T` is the IMPL's param (bound via
`Self=ArrayList(EP)`), NOT its own forall, so it depends on step (b). For `.get()`
(`-> Option(T)`) step (b) resolves `T`→`EP`; for `into_iter` (`-> ArrayListIter(T)`)
it does not. The divergence to pin next: either (i) `ArrayListIter(T)`'s `T` is NOT a
resolvable SomeT in the declared return (baked in at `into_iter`'s signature eval, so
`_resolve_some_types_deep` skips it), or (ii) `into_iter` takes the OTHER call path
(helper.yo, not this inline FuncVal arm) which resolves differently. Diagnostic: print
`resolved_ret` / `get_all_some_types(ret_type)` for `into_iter` vs `get` at
function.yo:1040. Compare to TS `evaluateFunctionReturnTypeAgain` (helper.ts:1282) —
TS produces 0 markers, so it resolves this; mirror it. Fixing this one gap should
drain a large fraction of the 93 (all manual-iteration call sites). Minimal repro in
`src/tests/fixme.yo`; re-measure by re-adding the `[TTERR]`/`[TTLOC]` instrumentation
per `scratchpad/diag.sh`.
Repro lives in `src/tests/fixme.yo`. Validate with `yo-self-bin compile … --emit-c`
and the `[TTERR]`/`[TTLOC]` instrumentation (currently uncommitted in
`calls/function_type.yo` — revert before committing real fixes).

## 2026-06-23 (LATE) — ⚠️ SHELL THEORY DISPROVEN; real root = def-time body-eval TYPING

**The recursive-enum self-shell is NOT the P1 bottleneck.** Implemented "approach D"
(`plans/RECURSIVE_ENUM_SHELL_REFACTOR.md`) — eliminate the shell entirely via
in-place enum finalization (the `Self` placeholder shares the variant accumulator
arrays, populated in place; clone RC-shares all four arrays; substitute gets an
`visited_enum_ids` cycle guard). It is fully validated green (fast repro 0 markers,
corpus 83/83, `check ./std` 152/152, self-compile COMPLETES) — and the marker count
is **527 → 527 (+0)**. A throw-point diff of the two `stage2.c`s (committed shell base
vs. approach D) is **295/296 byte-identical**. So the shell accounted for only the
~37 markers already captured by `3996b5982`; the other ~490 are shell-orthogonal.
Approach D was REVERTED (zero benefit + RC-share/cycle-guard risk). **This
invalidates the premise of `RECURSIVE_ENUM_SHELL_REFACTOR.md` and the 8+ prior
use-site attempts below — stop chasing the shell.**

**The real root (from the 527 marker source expressions, NOT the throw messages):**
527 markers collapse to ~93 throws / **296 throw-points** (first marker of each run);
**246/296 (83%) are plain `if(...)` statements** like `if(s == e.type_id, …)`,
`if(d == usize(0), …)` — statements that cannot fail on their own. So the def-time
body-eval trial wrapper (`_trial_eval_fn_body`, calls/function_type.yo) is evaluating
~93 of yo-self's OWN function bodies with **mistyped parameters/locals** — `e.type_id`,
`.len()`, `==` then throw "got unit"/"incompatible types"/"member mismatch" because the
binding's type is wrong, not because the construct is wrong. NEXT: instrumented
`_trial_eval_fn_body` to print `module_path:row :: error` per swallowed throw →
self-compile → throw→function map (run `diag.sh`), to find WHY def-time eval mistypes
these params (likely a small number of high-leverage bugs in def-time param/local type
setup; fixing the root should drain many markers — the convergent P1 fix the shell was
not).

## 2026-06-23 — post-redesign tail RE-MEASURED: codegen SIGABRT FIXED, real tail = 564 markers / 102 throws (recursive-type family)

After the overloading redesign (commits dd44dae0a..5742e7b66) landed, the full
self-compile no longer COMPLETES — it **SIGABRTs in codegen** (not OOM): a
`panic` in `_lookup_named_c_type` (codegen/utils/index.yo) on **12 uncollected
types** — HashMap `Bucket(K,V)` entries + their recursive value types
(`CapturedVariable`, `WhileLoopInfo`, `EffectCallPoint`, `CondBranch`,
`ClosureParamSlot`, `EvidenceParameter`, …), all `Option(HashMap/ArrayList)`
fields of `FunctionGenerationContext`. **FIXED** via a new
`collect_pointer_pointees` pass (collection.yo + codegen_c.yo wiring; validated
corpus 83/83, panic gone). Self-compile-only (only a compiler uses that context
at runtime; TS compiles main.yo cleanly in ~1 min). Details +
rejected-inline-attempt: `issues/yo-self-p1-uncollected-pointee.md`.

**NOT a redesign regression — the panic + tail are PRE-EXISTING.** A pre-redesign
build (`cead3db9f`, the commit just before the overloading redesign) SIGABRTs
**identically** (`no C type name found for <struct:struct_yo_id_NNNNN>`). So the
uncollected-pointee panic was introduced earlier (most plausibly `98b95a9dd`, the
default-arg codegen fix, which emits more code reaching these container types),
NOT by the redesign. The doc's earlier "30 markers, run_compile-only" baseline
predates that — at that point run_compile broke early AND fewer codegen functions
were emitted, so the self-shell tail was masked.

**With the panic gone, the genuine (previously-masked) tail is 564 `Failed to
transpile` markers across ~214 codegen functions**, revealed progressively as
codegen unblocked more functions (run_compile early-break → 30 visible →
default-arg fix → uncollected-pointee panic → collect_pointer_pointees fix → 564
revealed). Instrumenting the
def-time body-eval swallow (`_trial_eval_fn_body`, function_type.yo) shows the
564 markers come from only **102 distinct def-time eval throws** (each failing
fn → its whole tail loses ExprInfo → many markers). Throw-category breakdown:

| count | category | nature |
|---|---|---|
| 21 | `Expected enum...got unit` (match scrutinee) | recv resolved to unit |
| 20 | `Type mismatch for type member "value"` | Bucket/recursive value field |
| 17 | `Return type...got fn(T : Type) -> Type` | **clone-resolves-to-TypeVal** (documented self-shell) |
| 14 | `Incompatible types` | generic mismatch (downstream) |
| 5 | `Failed to infer enum variant type` | |
| 5 | `<enum:..._self_shell> and unit` | **explicit recursive-enum self-shell** |
| 4 | `Case env is missing outer frames` | branch-merge (documented) |
| ~6 | member mismatches `id`/`args`/`param_types`/`field_types` | recursive value fields |
| 2 | `Cannot unify "String" and "str"` | redesign-adjacent residue |
| 2 | `Expected bool for "and"` | comptime `and` |
| misc | argcount, begin-tail, struct-name unify | |

### 2026-06-23 (cont.) — shell-receiver-resolve fix: 564 → 527 (partial)

Fast repro built (`src/tests/fixme.yo`: a recursive enum `RecT` with
`Tuple(types : ArrayList(Self))` + a `clone` over a match arm — reproduces the
failure in ~10s). Instrumenting `_try_find_receiver_method` (a `[CLONE_DBG]`
print of receiver-type / is_static / hits) pinned the mechanism EXACTLY:
`ArrayList(Self).clone()` resolves fine (hits=1) and clones its elements via
`element.clone()`, whose receiver is the bare **top-level `__self_shell`** enum —
`hits=0` (the empty shell has no methods) → the call degenerates to `Type(1)` →
"Type mismatch for type member" at the enclosing construction.

FIX (`function.yo` `_try_find_receiver_method`): `receiver_type :=
resolve_enum_shell(receiver_info.ty)` — resolve a top-level shell receiver to its
finalized enum before method lookup (no-op for non-shell receivers; unlike the
prior no-op attempt #8 which resolved the OUTER `ArrayList(shell)` receiver, here
the element receiver IS a top-level shell). Validated: **corpus 83/83**, full
self-compile **564 → 527** markers, 0 regression. It is CORRECT + safe but only
one facet — most failures don't fail on the element clone; they hit other
shell-propagation paths (member-`value` mismatch from a different path, etc.).
Confirms the doc's "whack-a-mole does NOT converge" — the real fix is the
systematic shell-free recursive-enum representation (a multi-session refactor;
value-type enums can't mutate `Self` in place like TS's shared object).

### 2026-06-23 (cont. 2) — type-args resolve: faithful repro FIXED, self-compile UNCHANGED (use-site does not converge — confirmed)

Follow-on attempt: `resolve_enum_shell_in_args` (resolve shells in the receiver's
direct type-arguments, so `ArrayList(shell).clone()` binds its element forall
`T=final` for `with_capacity`'s `*(T)`). A FAITHFUL repro (`RecT` with a MANUAL
`clone` over `ArrayList(Self)`, mirroring `TypeValue.clone`) went to **0 markers**
with it; corpus 83/83. BUT the full self-compile stayed **527 → 527** — ZERO
additional benefit over the committed `resolve_enum_shell(receiver)`. REVERTED
(no measured gain; "no speculative code").

**This empirically settles the direction.** The committed shell-receiver-resolve
captured the clone-on-top-level-shell-receiver facet (~7 throws / 37 markers);
the type-args refinement fixes the same pattern in the repro but adds nothing in
the real self-compile (already covered). The remaining 527 are OTHER shell facets
(the diag throws were dominated by member-`value` mismatch ×20 + enum-got-unit
×21 — NOT clone-on-shell). Three distinct use-site shell-resolves this session
(deep field-patch at register_enum_final; top-level receiver-resolve [committed,
+37]; type-arg receiver-resolve [+0]) confirm the P1 doc's verdict: **per-input
shell-resolution does NOT converge.** The remaining tail requires the SYSTEMATIC
shell-free recursive-enum representation — a multi-session refactor converting
`Self` from a value-copied empty shell to a shared/handle reference (like TS's
mutable object). It can't be done piecemeal without leaving the compiler broken
mid-change; it needs a dedicated design + multi-session execution.

The DOMINANT cluster (clone→TypeVal, member-`value`, `_self_shell`-and-unit,
member-`field_types`/`args`/`id`) is the **recursive-enum-SELF-SHELL family** —
the documented-hardest unsolved P1 issue (8+ ruled-out fix attempts below). The
enum-got-unit / member-value / incompatible-types categories are most likely
DOWNSTREAM of the same root (a recursive-type method resolving to unit/typefn
breaks the enclosing match/construction/unification). So the fixpoint is now
gated primarily on cracking recursive-type method resolution in executing-mode
eval — a deep, focused effort. Smaller tractable categories: String/str (2),
case-env frames (4), `and` (2), argcount (1).

**Validation artifacts (this session, uncommitted — fix in working tree):**
collect_pointer_pointees in `yo-self/codegen/types/collection.yo` +
`codegen_c.yo`. Corpus 83/83, std unaffected (path is a no-op for fully-collected
types). Re-measure command: `yo-self-bin compile yo-self/main.yo --emit-c
--skip-c-compiler` then `grep 'Failed to transpile' stage2.c | grep -v 'const
uint8_t' | grep -v '\.ptr' | wc -l`.

## 2026-06-22 (cont. 2) — ✅ ROOT FOUND + FIXED: codegen method-dispatch first-hit (NOT registration)

The 8-cycle "registration throws" diagnosis (below, now SUPERSEDED) was WRONG. A
definitive 3-way probe — a panic distinguishing THREW / NO-EXPRINFO / HAS-EXPRINFO,
placed at the body eval in impl.yo's method-exprs loop, guarded to
`method_name=="starts_with" && current_trait_ty.is_some() && receiver_name=="String"`
— printed **HAS ExprInfo**. So StrPattern's `starts_with` body eval SUCCEEDS and
registration COMPLETES (`register_type_trait_method`, impl.yo:2108). Therefore
`get_receiver_methods_by_name` returns hits=2, and the evaluator's
`_select_matching_overload` (b4788d38e) DOES pick the `str` overload and records it
via `record_method_callee_value`. (The earlier "hits=1 / 1 individual registration"
readings were instrumentation artifacts — empirically false: the fix below works
*because* eval recorded the StrPattern value.)

**The real bug is in CODEGEN.** `other_fn_call.yo`'s concrete method-call dispatch
re-resolved the method by NAME via `get_type_trait_methods_by_name(tid, mname)` and
took the FIRST FuncVal entry (the `while ... mc_name.is_none()` loop stops at hit[0]).
The inherent `starts_with(prefix:String)` registers before (std/string.yo:842 < 1567)
the StrPattern `starts_with(prefix:str)`, so codegen emitted a call to the INHERENT
(`yo_id_4572(self, prefix:String, position)`) while passing the `__yo_str` literal →
C error "passing '__yo_str' to parameter of incompatible type 'String'". The
evaluator-resolved value (`lookup_method_callee_value`) was only a FALLBACK, used
when the registry MISSED — so the priority was inverted.

TS never re-resolves by name: codegen reads the resolved FunctionValue straight from
the call's callee ExprInfo (`expr.func.$.value`, other-fn-call.ts:453). yo-self's
dot-callee has no ExprInfo (comment other_fn_call.yo:898), so the method-callee
side-table IS its faithful equivalent.

**THE FIX** (other_fn_call.yo): prefer the evaluator-resolved method
(`lookup_method_callee_value(ast_expr_id(expr))`) FIRST; fall back to the registry
first-hit only when no value was recorded. This also subsumes the prior generic-impl
fallback (the registry misses the concrete id for generic-impl methods). VALIDATED:
the repro `s.starts_with("-")` now emits `yo_id_4909(self, prefix:__yo_str, position)`
(the StrPattern overload) and compiles+runs clean (was a hard C type error). Corpus
regression-gate: IN PROGRESS (clean so far) — to be confirmed 83/83 + `check ./std`.

Lesson: when a method resolves correctly in the EVALUATOR but C-fails on arg types,
suspect codegen RE-RESOLUTION, not the evaluator. The decisive moves were (1)
inspecting the emitted C — *which* C function does `main` call? — and (2) the 3-way
HAS/NO/THREW probe; both beat the 8-cycle panic binary-search that chased a phantom
registration throw. (The `_substitute_self_in_method_ty` step in impl.yo is real and
fine; it does not throw for this case.)

### SUPERSEDED (kept for the lesson) — the disproven 8-cycle "registration throws" chain

The earlier reading claimed: hits=1; StrPattern never registered individually;
the impl.yo method-exprs loop throws in the expected-type computation
(`_trait_field_type_by_label` → `_substitute_self_in_method_ty` → `substitute`),
aborting `impl(String, StrPattern(...))`. The 3-way probe DISPROVED this (HAS
ExprInfo → registration completes). Cause of the mis-diagnosis: panic binary-search
landed between two probe points and was read as "throws in 2000-2018", but the body
eval at ~2019 actually succeeds; the real divergence was downstream in codegen.

## 2026-06-22 — GENUINE TAIL MEASURED + `starts_with` overload-resolution FIXED

Rebuilt stage-1 from HEAD at `--optimize 1` and ran the REAL full self-compile
(`yo-self-bin compile yo-self/main.yo --emit-c --skip-c-compiler`, peak **4.58 GB**,
matches the P2 commit series). The genuine tail is **30 markers, ALL in ONE
function**: `run_compile` (`yo-self/main.yo:877`, the `compile` CLI driver). The
function header + initial `:=` bindings transpile; the break starts exactly at the
arg-parsing `while` loop (every subsequent statement loses ExprInfo because the
def-time body eval threw and unwound there). So **30 markers = 1 failing function**,
not 30 bugs. (TS reference: 0 real markers — its 2 "Failed to transpile" / 1 "dyn()
requires object type" hits are yo-self's OWN source string literals, filter with
`grep -v 'const uint8_t' | grep -v '\.ptr'`.)

The `while` throws at **`a.starts_with("-")`**. Root (DBG'd via the swallow):
**"Cannot unify incompatible types: String and str"**. `starts_with` is OVERLOADED —
inherent `impl(String)` `starts_with(prefix : Self=String)` (string.yo:842) + the
`StrPattern` trait `starts_with(prefix : str)` (string.yo:1560). A comptime_string
LITERAL coerces to `str`, which only the `str` overload accepts; but yo-self's
`_try_find_receiver_method` (function.yo:234) took `hits.get(0)` (the inherent
`String` one) and the call-site unify THREW instead of falling over to the `str`
overload. (`s.starts_with(p)` with a String VARIABLE worked because hits[0] matched.)

**FIX (committed-ready, corpus 83/83, repro 0 markers, TS check OK):** mirror TS
overload resolution (function.ts:330 keeps ALL candidates as `functions`; :1691
filters to type-matching). Added `all_hits : ArrayList(MethodEntry)` to
`ReceiverMethodResult`; the call-site (`.None` arm at function.yo:~3101) now calls a
new `_select_matching_overload` that trial-calls each candidate (via the existing
`_trial_call_overload_candidate` — swallowing, fresh-id-cloned, side-effect-free) and
picks the FIRST that type-checks, falling back to hits[0]. Single-hit (the common
case) skips trials → no behavior change. New helper `_build_receiver_call_args`
builds the trial arg list (receiver prepend + `&(...)` ptr-conv).

### `run_compile` codegen gaps (the eval now succeeds):

1. **Default-arg codegen (omitted optionals not emitted) — ✅ FIXED (commit
   98b95a9dd), method-call path.** `a.starts_with("-")` omits `(position : usize)
   ?= 0`; the eval bound the default VALUE but never pushed it to
   `runtime_arg_exprs_in_order` → C `too few arguments`. Fix (faithful, mirrors
   helper.ts:328-344): added `FuncParam.default_value_expr` + a func-id side-table
   (`g_func_param_default_exprs`), and in `try_to_call`'s Step 7 omitted branch
   clone+evaluate+push the default expr to `rt_args`. Corpus 83/83. **Remaining:
   the inline-FuncVal arm (function.yo ~2424) for DIRECT calls** (`add(i32(3))`
   still C-fails "too few arguments") — same pattern, push the default expr after
   the supplied-args loop; the side-table is already there.
2. **str-vs-String = trait-impl overload NOT COLLECTED (diagnostic-confirmed root).**
   After fix #1, `a.starts_with("-")` emits all 3 args but C-fails `passing
   '__yo_str' to parameter of incompatible type '…' (String)`: codegen emits the
   INHERENT `starts_with(self : String, prefix : String, position)` (`yo_id_4572` —
   body matches `prefix._bytes`) with the str literal. DIAGNOSTIC (panic-instrumented
   `_try_find_receiver_method`): for `a.starts_with`, **`get_receiver_methods_by_name`
   returns hits=1 — only the inherent**; the `StrPattern` trait `starts_with(prefix
   : str)` (std/string.yo:1567 `impl(String, StrPattern(...))`) is NOT collected. So
   `_select_matching_overload` (fix b4788d38e) is a no-op here (1 hit) and the
   inherent is used; the comptime_string `"-"` then matches the inherent's `String`
   prefix LENIENTLY (no "Cannot unify" throw — confirmed: `prefix`'s resolved_pt is
   CONCRETE, not a SomeT, and 0 eval markers), so the eval records the inherent and
   codegen emits the String-param fn with a str arg. ROOT: `impl(Type, Trait(...))`
   registers its methods as a trait-VALUE (via `register_trait_value_fn`), NOT as
   individual `register_type_trait_method(Type_id, …)` entries (only the
   method-exprs loop at impl.yo:1982/2108 does that, for direct `label : fn` fields).
   `get_receiver_methods_by_name_from_env` (env.yo:2378) only does the registry
   lookup, NOT the TS `.trait.fields` walk over the type's impl'd-trait values (the
   comment at env.yo:2434 acknowledges this divergence). FIX (faithful, mirrors TS
   getReceiverMethodsByNameFromEnv): make `get_receiver_methods_by_name_from_env`
   ALSO collect methods from the receiver type's impl'd-trait values, OR register
   trait-impl methods individually under the receiver id at impl time. THEN
   `_select_matching_overload` must PREFER the exact match (`StrPattern` `str` over
   the inherent `String`, since the inherent leniently matches str too — likely an
   are_types_compatible(String, str) leniency to also tighten). Regression-prone
   (adding candidates changes dispatch); validate vs expr/target/`check ./std` +
   corpus. NOTE: my earlier "Self floats as SomeT" hypothesis was DISPROVEN by the
   diagnostic — `prefix` is concrete; the issue is collection, not Self-resolution.
   Surfaced only by the fixpoint (corpus has no str-literal overloaded-method call
   omitting a default).
3. **`dyn(<template string>)` codegen** — `exn.throw(dyn(\`compile: missing input
   file…\`))` (run_compile's first stmt) emits `/* Error: dyn() requires an object
   type (use box() for value types) */` (a broken `Type x = ;` decl). TS compiles it
   (its only such hit is the source string literal). The recorded arg type for the
   `dyn(\`…\`)` arg is a value-type String in yo-self vs an object/Box type in TS.
   2 instances in the self-compiled C (run_compile + one other fn).

Beyond these, the statements AFTER the `while` (std_path / io.await / compile_module /
the template `dyn()`s) were never reached by the eval (it threw at the while), so they
may surface their OWN gaps once the while compiles. The fixpoint needs ALL of
run_compile's tail drained, then `stage2.c` → stage2 binary → stage3 (≡ check).

## Status: OPEN — the P1 drain (lead, now that P0/corpus is deterministic)

Per-module `// Failed to transpile` markers, each a real executing-mode
evaluator/codegen gap. As of 2026-06-21 (after the Index-trait, cond/panic,
open-import, and P0 double-free fixes), the small/medium modules are near-clean:

Per-module status as of 2026-06-21 AFTER Candidates 1–3 + the frame-depth fix +
the specialization-Self fix + the receiver-arg-type fix:

| module | swallowed errors | note |
|---|---|---|
| `error/token/utils/lexer/expr/target/naming_checker` | **0** | ✅ all clear (Candidates 1–3 + frame-depth relaxation) |
| `value.yo` | 6→2 swallowed | `Self`-not-found ×4 (378914804) + `field_labels` (8910182ad) RESOLVED. DBG_SW2 re-survey shows 2 remain: (a) `field_types` ×1 — `types.clone()` (the SECOND arg of the SAME `.Tuple(labels, types) => TypeValue.Tuple(labels.clone(), types.clone())` at definitions.yo:392, masked behind field_labels before) where `types : ArrayList(Self)` has the RECURSIVE-ENUM element `TypeValue` (vs `labels`'s concrete `String`) → still Type(1); receiver-arg-type fix did NOT clear it = recursive-enum-element intersection (deeper). CONFIRMED ROOT (DBG_EL instrumentation): the clone receiver's element IS a recursive-enum SELF-SHELL — `types.clone()` has `types : ArrayList(<enum:..._self_shell>)` (e.g. `enum_yo_id_5981__self_shell`). The empty-variant shell as the element makes `with_capacity`'s `(*(T))(_ptr)`/`sizeof(T)` degenerate to Type(1) (shell has no layout). FOUR fix attempts, ALL ruled out (build-validated, reverted, zero regression each): (1) try_to_call self_type from self arg → REGRESSED expr/target/parser; (2) substitute `Self` SomeT in receiver type → no-op (it's a SHELL, not a SomeT); (3) `resolve_enum_shell` the receiver Struct's type_arguments in create_specialized → no-op (T bound separately, upstream); (4) `resolve_enum_shell` the `forall_val` in try_to_call's explicit-forall loop → no-op (with_capacity's T is bound via a DIFFERENT path — the receiver-type-arg→forall derivation in the DISPATCH, NOT the explicit-forall loop). FIVE fix attempts now ruled out (build-validated, reverted, zero regression each):
(1) try_to_call self_type ← self arg → REGRESSED expr/target/parser; (2) substitute
`Self` SomeT in receiver → no-op (it's a SHELL not a SomeT); (3) resolve_enum_shell
the receiver Struct type_arguments in create_specialized → no-op; (4)
resolve_enum_shell `forall_val` in try_to_call's explicit-forall loop → no-op;
(5) resolve_enum_shell `recv_type_args` at the static-dot derivation
(function.yo:2477) → no-op (`types.clone()` is an INSTANCE call, so
_static_dot_receiver_self_type returns None → recv_type_args empty). DEFINITIVE
CONCLUSION: `_funcval_bind_foralls` (function.yo:733) binds foralls by NAME-MATCH
(`ptn == fa_name`) + recv_type_args fallback — NEITHER fires for instance `clone`'s
impl forall `T` (param type is `ArrayList(T)`, not literally `T`), so the shell-`T`
comes from yet another path (captures `cap_vals`, or structural self-arg
unification). The recursive-enum SELF-SHELL propagates through MANY
specialization-input paths; whack-a-mole at each input does NOT converge (SIX
tried — the 6th: resolve_enum_shell the pointee in the `.Pointer` cast branch
(function.yo:2103) was ALSO a no-op, PROVING `*(T)` with `T=shell` does not even
reach the `.Pointer` cast — the shell breaks the `*(T)` TYPE-APPLICATION evaluation
UPSTREAM, yielding Type(1) before any cast). DEFINITIVE: stop guessing fix sites
(6 failed). KEY: `resolve_enum_shell` DOES resolve these shells correctly —
`register_enum_final(shell_id, …)` (enum.yo:706) registers the final under the
SHELL id (`${enum_id}__self_shell`), which is exactly what resolve_enum_shell looks
up, so the 4 resolve_enum_shell attempts (#3–#6) being no-ops means the
field_types-failing `types.clone()`'s `T` is NOT at any path I resolved. The "shell
in clone→with_capacity" mechanism was ASSUMED from DBG_EL (which showed shells in
SOME clone receivers) but NEVER CONFIRMED for the actual failing `types.clone()`
call — its `T` may come from a different path, or types.clone() may fail for a
DIFFERENT reason entirely. INSTRUMENTED (DBG_CONSTR at the construction check, type.yo:275): `types.clone()`
evaluates to `valkind=TypeVal` (a TYPE value, typed Type(1)) — i.e. `clone` itself
resolves to a TYPE-returning result on this receiver, NOT a runtime clone. SAME
root for parser.yo's `args`: `__v_args.clone()` also → `valkind=TypeVal`. So the
issue is in CLONE METHOD RESOLUTION on a receiver whose type carries the recursive
self-shell (the method likely isn't found on the shell-element receiver, so
`types.clone` resolves to a type and `(type)()` yields a type). 7th fix attempt
(resolve_enum_shell_deep — a NEW recursive shell-resolver — applied to the
destructured field TYPE at both match.yo destructure sites) was ALSO a no-op:
resolving the field TYPE doesn't change that `clone` resolves to a TypeVal. SEVEN
build-validated fix sites now ruled out; the resolve-shell approach CONSISTENTLY
no-ops, so the bug is NOT "shell reaches type-application" — it is in how the CLONE
METHOD CALL is resolved/evaluated when the receiver type contains the shell. The
next effort must trace the `types.clone()` method-call resolution itself (property
access → method lookup → why it yields a TypeVal instead of a runtime call) — a
deep focused effort in method dispatch + recursive-enum-shell, the hardest
subsystem. Systemic (value.yo field_types + parser.yo args), warm-up-masked.
8TH ATTEMPT (no-op, reverted): resolve_enum_shell the receiver type in
`_try_find_receiver_method` (function.yo:199, runtime method dispatch). No-op
because for `types.clone()` `receiver_info.ty` is `ArrayList(shell-element)` (a
Struct — top-level resolve_enum_shell doesn't touch the nested element), and the
inner `<enum shell>.clone()` routes through a DIFFERENT clone-resolution path
(property_access processes it per DBG_PA, yet the call still yields a TypeVal).
8 distinct interception points all miss → the shell propagates through clone
resolution PERVASIVELY. The fix needs EITHER (a) systematic shell elimination at
the recursive-enum representation / `register_enum_final` time so no `__self_shell`
survives into method resolution (preferred — kills the whole class), OR (b) finer
instrumentation to pin which clone-resolution path (property_access vs
_try_find_receiver_method) evaluates the failing `types.clone` func and returns a
type. Confirmed beyond 8 single-build attempts — a focused multi-step effort.
9TH ATTEMPT (no-op, reverted): resolve_enum_shell at the CENTRAL method-registry
chokepoint `type_id_or_empty` (type_trait_methods.yo:58 — used by every
method/assoc-type lookup) — still no-op. CRITICAL PATTERN: resolve_enum_shell has
now no-op'd across FIVE distinct resolve attempts (#3,4,5,6,9). This strongly
implies resolve_enum_shell CANNOT resolve THIS shell at these points — most likely
the shell's final is NOT in `g_enum_finals` when/where these run (a
registration-TIMING issue: the value.yo def-time-eval reaches the inner element
clone before `register_enum_final` has registered EvalValue's final, OR under a
different g_enum_finals state), NOT a wrong-site issue. THE DEFINITIVE NEXT STEP is
to INSTRUMENT resolve_enum_shell itself (print whether it finds the final for the
failing shell id during value.yo compile): if it does NOT find it → fix is
registration timing/ordering (ensure the final is registered before any clone of a
shell-typed value); if it DOES find it → the failing clone routes through a path
that never calls these resolve sites (trace it). Either way this is a deep,
focused, multi-step effort in the recursive-enum-shell subsystem — NOT a single
targeted resolve insertion (9 ruled out). Warm-up-masked; systemic (field_types + args).

DEFINITIVE DIAGNOSTIC (build #21, DBG_RESOLVE inside type_id_or_empty): for the
SAME shell id (e.g. `enum_yo_id_5981__self_shell`), resolve_enum_shell returns BOTH
`…5981__self_shell|vars=0` (final NOT registered — TIMING) on ~2 calls AND
`…5981|vars=39` (resolved) on ~9 calls. So TWO facts are now PROVEN:
  (1) TIMING — some clone-resolutions run BEFORE `register_enum_final`, so resolve
      is a genuine no-op there (vars=0).
  (2) PATH — the chokepoint fix used the RESOLVED id (vars=39) yet field_types
      STILL failed → `clone` for these enums is NOT in the `type_id_or_empty`
      method registry at all; it is resolved via a DIFFERENT path (the generic
      Clone-impl resolver / derived-clone), which the shell breaks.
So the failing `types.clone()`/`__v_args.clone()` resolve via the generic-impl /
derived-clone path on a shell-typed RUNTIME (NoVal) receiver — NOT
`_try_find_receiver_method` (8th attempt, no-op) and NOT
`find_methods_from_generic_impls` (takes a TypeVal, our receiver is NoVal). The
TRUE next step: find the clone-resolution path for a RUNTIME enum value receiver
(derive(Clone)/generic Clone impl dispatch in the method-CALL path,
evaluator/calls/*), resolve the shell receiver THERE, AND fix the registration
TIMING so the final exists before any clone of a shell-typed value. A deep,
multi-faceted effort (shell + clone-via-generic-impl/derived + registration timing)
— the hardest subsystem, confirmed beyond 9 build-validated targeted attempts. That is a focused
effort on the recursive-enum-shell subsystem (the hardest part of the port, per
[[yo-self-recursive-enum-self-shell]] + [[yo-self-phase3-hashmap-new-blocker]]).
Warm-up-masked (not a real fixpoint blocker). (b) `and` ×1 — `name.starts_with("Box(")` at guards.yo:561 → non-bool. ISOLATED (repro ladder, this session): NOT default-arg (both `starts_with("a")` and `starts_with("a", usize(0))` fail) and NOT the `&&` (starts_with ALONE fails; `len()==` alone works). ROOT: a COMPTIME_STRING LITERAL arg to a `Self`-TYPED param — `name.starts_with(p)` with a String VARIABLE `p` WORKS, but `name.starts_with("a")` (literal) FAILS. `starts_with(self : Self, prefix : Self, …)`: the comptime-arg→param coercion (helper.yo:482) is GUARDED `!is_some_type(resolved_pt)`, and `prefix`'s `Self` is NOT resolved to the concrete receiver (String) because `ctx.self_type` is not the receiver during `try_to_call`'s arg-binding (the create_specialized Self fix runs LATER). FIX ATTEMPT (FAILED + REVERTED, this session): setting `ctx.self_type` from the `self` param's arg_type inside `try_to_call`'s param loop (so a later `prefix : Self` resolves) did NOT fix starts_with AND regressed expr 0→1, target 0→1, parser 4→5. Two reasons learned: (1) `resolved_pt` for `prefix` is an ALREADY-EVALUATED SomeT, not the `Self` identifier, so setting `ctx.self_type` does NOT make `evaluate_function_parameter_type_again` resolve it; (2) the self param's `arg_type` is NOT a clean receiver type (e.g. `*(Self)` for `ref(self) : Self` methods), so overwriting `ctx.self_type` with it corrupts Self resolution elsewhere. So the real fix must RESOLVE the SomeT `Self` in `resolved_pt` directly (in the coercion at helper.yo:482, guarded: only when the SomeT is `Self` and resolves to a concrete non-SomeT) — the regression-prone coercion area (touching it unguarded once regressed std 151→17, see [[yo-self-template-string-to-string-cluster]]); a careful, validated focused effort. Gates that catch regressions here: the small-module marker counts (expr/target were 0) + `check ./std` (sensitive to this coercion class). 2ND `and` ATTEMPT (no-op, reverted): resolve a BOUND SomeT via `get_value_of_some_type_from_env(callee_env_r, resolved_pt)` before the coercion guard — no-op because `Self` is NOT bound in callee_env_r during starts_with's arg-binding (the receiver type isn't threaded there). UNIFIED ROOT (both value.yo residuals): `field_types` AND `and` both stem from the RECEIVER TYPE not reaching instance-method arg-binding / method-resolution. Threading it is the central method-dispatch change that (a) regressed expr/target/parser when done via ctx.self_type from the self arg (ref-self `*(Self)` corruption) and (b) no-op'd via env-resolution (Self not in env). So the value.yo tail needs ONE careful central fix: correctly thread the (deref'd, non-pointer) receiver type into instance-method arg-binding + method-resolution + as `Self` for coercion — validated incrementally against expr/target/std (all sensitive). A focused effort; 12 build-validated targeted attempts (10 field_types + 2 and) ruled out the peripheral approaches. 3RD `and` ATTEMPT (no-op, reverted): resolve a bare `SomeT("Self")` resolved_pt via the bound `self` var in callee_env_r before the coercion — no-op, so `prefix`'s resolved_pt is NOT a bare SomeT literally named "Self" (likely a fresh-id SomeT whose name isn't "Self", OR `self` isn't bound at that point, OR the failing path isn't this check_if_function_parameter_matches_argument). DEFINITIVE NEXT STEP for `and`: instrument `resolved_pt` (type_to_string + the SomeT name/id) for the prefix param of starts_with when compiling value.yo — determine the ACTUAL type before designing the resolution. INSTRUMENTATION OBSTACLE (build #24): `helper.yo` CANNOT `import("std/fmt")` for `eprintln` — it creates a circular import (helper.yo → std/fmt → … → calls/function.yo → helper.yo), build fails rc=1. So instrument via a NON-eprintln mechanism: a module-level `(g_dbg : ArrayList(String))` global written in helper.yo and printed by a caller that CAN import std/fmt, OR add the diagnostic in a callee/caller of check_if_function_parameter_matches_argument that already imports fmt, OR temporarily print from `function_type.yo` (which can import fmt) by threading the value out. 13 build-validated attempts total (10 field_types + 3 and); all peripheral guesses ruled out — both value.yo residuals need finer instrumentation of the exact type/path THEN a regression-prone central fix (a focused multi-session effort, not single-build attempts). The 6 visible MARKERS are all `if(...)`-as-value COLLATERAL = separate OPEN issue `yo-codegen-block-rhs-drops-statements`. |
| `parser.yo` | 4 markers | `array_list(...)` macro-expansion ×3 (gated MACRO_DISPATCH) + arg-count |

IMPORTANT — STACK, not memory: standalone-compiling a big module SIGSEGVs (rc=139,
peak mem only ~2.8 GB — NOT OOM) at the default 1 GiB main-thread stack due to
deep compile-time recursion. Run with `YO_MAIN_STACK_MB=4096` (as
scripts/diff-test.sh already does) and it compiles. So `value.yo`'s earlier
"no .c" was stack exhaustion, not a transpile bug; with 4096 MB it emits C with 6
errors.

The visible `// Failed to transpile` markers (all `if(...)`-shaped) are COLLATERAL
— a minimal `if(b, …)` compiles fine. Instrumenting the def-time swallow
(`_trial_eval_fn_body`) under the big stack surfaced the REAL per-function throws
(the remaining MEASURABLE P1 tail, 2026-06-21):

| module | real swallowed errors (count) |
|---|---|
| `value.yo` | `Variable "Self" not found` ×4 (dominant); `Type mismatch for type member "field_labels"` ×1; `Expected bool type for "and" argument` ×1 |
| `parser.yo` | `Type mismatch for type member "args"` ×2; `Argument count mismatch: expected 0, got 1` ×1 |

These are NEW families (distinct from Candidates 1–3): (a) `Self` unbound in some
def-time body-eval context (likely an impl/trait-method body or a nested
closure/construction referencing `Self`); (b) struct/enum CONSTRUCTION type-member
mismatch (`field_labels`/`args` — a `Struct(...)`/`EnumT(...)` built with a
wrong-typed field at def-time eval); (c) `and`/arg-count argument-shape errors.
The `Self`-unbound family (4×, dominant) is the highest-leverage next target —
fixing it should also clear the collateral `if`-markers in those functions.
ROOT (traced, no rebuild): the identifier evaluator DOES resolve `Self` via
`ctx.self_type` (identifer_and_operator.yo:107, `if identifier=="Self" &&
self_type.is_some()`); so a `Self not found` means `ctx.self_type` is **None**
during the DEF-TIME body eval of some type/impl method that references `Self`
(as a param type or constructor). `create_function_body_evaluation_context`
(function_type.yo) only COPIES the parent ctx's `self_type`, so the parent ctx
at that def-time-eval site lacks it. Most type methods work (self_type is set),
so the 4 failures are specific — likely derived methods, or methods
def-time-evaluated outside their impl's self_type scope. NEXT: instrument the
identifer_and_operator.yo:166 throw to print `token.module_path:token.row` (so
the swallow names the failing method) → set `ctx.self_type` for that def-time
path. EvalValue is itself a recursive enum (`ArrayList(Self)`/`Box(Self)`
fields), so its derived/`==` methods are prime suspects.

The other big modules (`function.yo`, `helper.yo`, `codegen_c.yo` TIMEOUT >240 s;
`match.yo` SIGABRTs) are slow/heavy standalone even with the big stack — their
tail + the unified self-host fixpoint remain gated on P2 (memory / compile-time)
or a 32 GB+ box.

## `Self`-not-found in specialized method bodies — ✅ RESOLVED

The dominant `value.yo` family (`Variable "Self" not found.` ×4) was traced via
the printing-swallow instrumentation (DBG_SW handler in `_trial_eval_fn_body` +
DBG_LOC at the def-time call site) to four GENERIC method bodies evaluated during
SPECIALIZATION:
- `std/collections/hash_map.yo:287` (`set` → `Self._find_bucket(self, key, hash)`)
- `std/collections/hash_map.yo:335` (`get` → `Self._find_bucket(...)`)
- `std/collections/hash_set.yo:272` (`add` → `Self._find_slot(self, element, hash)`)
- `std/collections/hash_set.yo:306` (`remove`/`contains` → `Self._find_slot(...)`)

These surface when compiling `value.yo` because an outer function's def-time body
eval calls `map.set(...)`/`set.add(...)` with concrete K/V, triggering
specialization of the generic method. The specialized body is evaluated by
`create_specialized_function_inline` (`evaluator/calls/helper.yo:1338`,
`evaluate_begin_expression(cloned_body, callee_env, ctx, …)`), which did NOT set
`ctx.self_type` — so `Self` (and `Self.static_method`) hit
`identifer_and_operator.yo:166` "Variable Self not found." and the def-time
swallow ate it → no ExprInfo → "Failed to transpile".

ROOT vs TS: TS evaluates the specialized body with `{ ...context }`
(`helper.ts:2434`), and the method-dispatch caller has already set
`context.SelfType` (carried from the method's `functionType.SelfType`, a field on
TS `FunctionType`). yo-self's `Func` TypeValue has NO `SelfType` field and the
dispatch doesn't thread `self_type` to this point, so the specialized body lost
it. FIX (faithful-in-effect, commit 378914804): reconstruct `ctx.self_type` from
the bound `self` parameter's type (the concrete receiver) just before the
specialized body eval, scoped (saved + restored in the context-restore block, so
nested specializations each see their own receiver). NOT a `self`-named-param
heuristic at `create_function_body_evaluation_context` — that path (the def-time
eval) is NOT where generic methods are evaluated; specialization is. Validated:
value.yo Self-not-found 4→0 (all-DBG_SW 6→2), parser/expr/target/naming_checker
unchanged, check ./std 152/152.

A fully-faithful alternative (add a `self_type` field to the `Func` enum, stamp
it from `ctx.self_type` at `evaluate_function_type`, read at every body-eval
site) would also cover STATIC methods (no `self` param) that reference `Self` —
none are among the current tail, so deferred. Tracked here if such a case
surfaces.

## Remaining value.yo (2) + parser.yo (3) — characterized, ORDER/CONTEXT-dependent

After the Self fix, the remaining swallowed errors are:
- `value.yo`: `Type mismatch for type member "field_labels"` ×1 (definitions.yo:392,
  `.Tuple(labels, types) => TypeValue.Tuple(labels.clone(), types.clone())` —
  `labels.clone()` evaluated to `Type(1)`); `Expected bool type for "and"` ×1
  (guards.yo:561, `… && name.starts_with("Box(")` — the method call evaluated to
  non-bool).
- `parser.yo`: `Type mismatch for type member "args"` ×2 (parser.yo:996,1410,
  `array_list(arg, arg_copy)` / `array_list(str_atom)` → `Type(1)`);
  `Argument count mismatch: expected 0, got 1` ×1 (parser.yo:1219,
  `array_list(rhs_expr)`).

TWO root families:

1. **`array_list(...)` (parser ×3) = MACRO EXPANSION at def-time eval.**
   `array_list` is a MACRO (`std/collections/array_list.yo:827`,
   `fn(...(quote(elems))) -> unquote(Expr)`). At def-time body eval the call is
   NOT expanded → evaluated as a plain variadic fn → `Type(1)` (from
   `unquote(Expr)`) or "expected 0, got 1" (the `...(quote(elems))` declares 0
   normal params). Tied to the gated MACRO_DISPATCH subsystem (corruption history,
   see [[yo-self-macro-dispatch-corruption-fixed]] / [[yo-self-macro-expansion-port]]).
   Deferred — deep + gated.

2. **`labels.clone()` (value `field_labels` ×1) = pointer cast `(*(T))(_ptr)`
   yields `Type(1)` during NESTED `clone` specialization. ✅ RESOLVED (commit
   8910182ad).** FIX: in `create_specialized_function_inline` set `ctx.self_type`
   from the actual RECEIVER ARGUMENT's type (`arg_values.args[0].arg_type`) when the
   first param is `self`, instead of the `self` param's DECLARED type — which during
   def-time signature eval can be a freshly-minted SHELL struct id for the same
   generic (the dual-struct-instantiation root). The argument carries the real,
   complete receiver struct, so `Self`→that struct and the nested
   `Self.with_capacity`/`(*(T))(_ptr)` specialization succeeds. Validated: repro
   `xs.clone()` 1→0, value.yo field_labels cleared (remaining value.yo markers are
   if-as-value collateral, `yo-codegen-block-rhs-drops-statements`), std 152/152,
   corpus PASS 83/83. The `and`/`name.starts_with()` sibling (a self-first method)
   is likely cleared by the same fix — re-verify with DBG_SW if pursuing.
   Investigation history (kept for the methodology):
   - Reliable minimal repro: a fn `m_clone(xs : ArrayList(String)) -> xs.clone()`
     that is **CALLED from `main`** (so its body is EMITTED) fails to transpile.
     The earlier "clean in isolation" repros were a RED HERRING — with a trivial
     `main` the fn is dead code (never emitted), so no marker even though the
     def-time eval threw. Emit it (call it) and it fails. So this is NOT
     order/context-dependent; it is consistent once the body is emitted.
   - The swallowed throw (via the instrumented binary): `Type mismatch for type
     member "_ptr": Expected <enum…(Option(*(T)))> Got Type(1)` at
     `std/collections/array_list.yo:124` — `_ptr : .Some((*(T))(_ptr))` inside
     `with_capacity`. `xs.clone()` calls `Self.with_capacity(...)`; when
     `with_capacity` is specialized INSIDE clone's specialization (nested), the
     pointer cast `(*(T))(_ptr)` evaluates to `Type(1)` instead of a `*(T)` value.
   - Cast dispatch: `evaluator/calls/function.yo:2103` (`.Pointer(_) =>` →
     `try_to_convert_to_pointer_type`). NEXT STEP: instrument there to print
     `func_type` (is the `.Pointer` branch even taken? is `T` bound to String, or
     is `*(T)` a `*(SomeT)`/Type?) for the `(*(T))(_ptr)` call when compiling
     repro8; the cast likely falls through to the `_ =>` numeric branch or
     `try_to_convert_to_pointer_type` returns a type because `T` is unbound in the
     nested specialization. Likely fix: bind the callee type's forall (`T`) in the
     nested `with_capacity` specialization, OR resolve `*(T)` against the bound
     element type before the cast.
   - CONFIRMED PRE-EXISTING: repro8 fails IDENTICALLY (2 markers) under the
     pre-Self-fix baseline binary — the 378914804 Self fix introduced NO
     regression here.
   - CAPSTONE (warm-up): adding a DIRECT `with_capacity` call
     (`m_wc(n) -> ArrayList(String).with_capacity(n)`) BEFORE `m_clone`, both
     CALLED from main, makes BOTH pass (0 markers). So it is a NESTED-SPECIALIZATION
     bug: when `with_capacity` is first specialized via the NESTED path (inside
     `clone`'s specialization), the impl forall `T` is NOT bound → `sizeof(T)` /
     the `(*(T))(_ptr)` cast degenerate to `Type(1)`. When `with_capacity` is first
     specialized DIRECTLY, `T` binds, it caches a GOOD entry, and the later nested
     call reuses it. IMPLICATION: this error is LARGELY MASKED in the full
     self-compile (where `with_capacity`/`clone` get warmed by direct calls
     throughout std), so it is substantially a STANDALONE-per-module-survey
     ARTIFACT — the per-module `--emit-c` survey OVERCOUNTS errors that warm-up
     hides in the real fixpoint build. Real fix (deep, deferred): bind the
     callee's impl forall (`T`) from the receiver/Self type in the NESTED
     specialization path (create_specialized_function_inline / the call dispatch),
     not only on the direct path. Lower priority than first thought (likely not a
     real fixpoint blocker).
   - DEFINITIVE ROOT (DBG_FA instrumentation printing `arg_values.forall_args`
     VALUES in create_specialized_function_inline, failing m_clone-only vs passing
     m_wc-direct-first): the forall-binding hypothesis is DISPROVEN — `with_capacity`
     specializes with `names=[T] forall_args=[String]` in BOTH cases, so `T` IS
     bound to `String`. The real differentiator is STRUCT IDENTITY:
       FAIL: with_capacity specialized for `self=struct_3934`(String) + `struct_3984`(u8); NO struct_4028.
       PASS: same + with_capacity for `self=struct_4028`(String)  ← the extra one.
     `ArrayList(String)` exists as TWO distinct struct ids (3934 vs 4028). `m_clone`'s
     `xs.clone()` (receiver = one instance) has clone's body call `Self.with_capacity`
     where `Self` resolves to the OTHER `ArrayList(String)` instance (struct_3934, a
     def-time-minted shell); that instance's `with_capacity` body throws (the
     `(*(T))(_ptr)`→Type(1) construction mismatch) so clone's body eval fails →
     `xs.clone()` gets no ExprInfo → "Failed to transpile". The passing m_wc case
     first specializes `with_capacity` for struct_4028 directly, and warm-up reuses
     it. So this is the DUAL-STRUCT-INSTANTIATION / CTFE-struct-identity class (the
     same family as the HashMap.new cache collision — see
     [[yo-self-phase3-hashmap-new-blocker]] — and the "two struct instantiations of
     one generic type" def-time-minting issues), NOT forall-binding and NOT
     cache-key-completeness alone. Real fix is deep struct-identity unification
     (make the def-time signature eval and the call-site agree on ONE struct id for
     `ArrayList(String)`, OR resolve `Self` in clone's body to clone's ACTUAL
     receiver struct, not a freshly-minted shell). Known-hardest area; high
     regression risk; a focused effort, not a session-end fix. (Diagnostic note:
     `type_to_string` renders a struct as `<struct:id>` WITHOUT type args; print
     `arg_values.forall_args` values, and compare struct IDS across pass/fail.)
   The `name.starts_with()` (`and` ×1) error is a sibling — same "method call in an
   emitted body during specialization mis-resolves" class; re-confirm its exact
   throw the same way. LOWER-VALUE than the Self family (2 errors, 1 module);
   does NOT gate the fixpoint (P2 does). Session fixme.yo repro ladder: repro2→3
   (isolate method-call) → repro5/6 (FALSE clean = dead-code-elim) → repro7 (enum
   fn alone, trivial main → false clean) → **repro8 (fns CALLED from main → both
   bodies fail; the reliable repro)**.

## Candidate 1 — derived multi-field `Clone` — ✅ RESOLVED (4-layer fix)

Root-caused as FOUR stacked yo-self-only codegen bugs (not the suspected
generate_other_function_call constructor-callee gap below). All fixed; see
`yo-self-derive-clone-typename-quote.md` for the overview, plus
`yo-self-anon-fn-ref-param-deref.md` and `yo-self-method-inline-ref-amp.md`:
(1) `Type.to_comptime_string` stored an unquoted StrLit → corrupted constructor
head (Token->oke, T->empty); (2) `ref(self)` field reads not dereferenced
(anon-fn binding dropped is_ref); (3) derived enum clone re-materialized its
`ref(self)` match subject into a colliding local `self`; (4) a primitive field's
inlined `__yo_return_self` receiver was not address-of'd. Regression tests
`derive_clone_enum_string.yo` (non-primitive) + `derive_clone_multifield.yo`
(primitive) in the corpus.

### Original (now-disproven) hypothesis + repro

```rust
open(import("std/string"));
K :: enum(A, B);
derive(K, Clone, Eq(K));
T :: struct(kind : K, value : String, row : usize, col : usize, ch : usize, mp : String, inp : String);
derive(T, Clone);
mk :: (fn() -> T)(T(kind : K.A, value : String.from("v"), row : usize(1), col : usize(2), ch : usize(3), mp : String.from("m"), inp : String.from("i")));
main :: (fn() -> unit)({ a := mk(); b := a.clone(); () });
export(main);
```

yo-self emits, in T's derived clone body:
```c
return // Failed to transpile (((self.kind).clone)(), ((self.value).clone)(), …);
```
i.e. a struct construction whose **callee renders empty** (positional
`(field.clone(), …)`, no `T` head). An EXPLICIT labeled `T(kind : …, …)` (as in
`mk`) transpiles fine — only the derive-generated positional/`Self(...)` form
fails. This is the real `expr.yo:fn_..._6604` (Token's derived clone, rendered
`oke(...)`) and affects every `derive(Clone)` multi-field struct used in return
position (Token, AST nodes, …).

Likely root: yo-self's `generate_other_function_call` value-struct-constructor
branch doesn't recognize the derive-synthesized constructor callee (an empty/
gensym atom or a `Self` form) the way it recognizes a named/labeled `T(...)`.
Compare how the evaluator annotates the derived-clone construction's ExprInfo
(`value` = StructVal shell + `runtime_arg_exprs_in_order`) vs an explicit
labeled construction, and route the synthesized form through the same
runtime-construction emitter.

## Candidate 2 — ✅ RESOLVED (evaluator side): recursive-enum self-shell in nested match

`expr.yo` `is_function_boundary_arrow` is FIXED (expr.yo transpile errors 1→0).
Root: it does `match(func_box.*, …)` two levels into `AstExpr` (`func : Box(Self)`).
The enum self-shell patch (types/enum.yo) replaces only ONE level of self-nesting;
the second-level `Box(Self)` deref surfaced the raw empty-variant shell, and the
match evaluator never called `resolve_enum_shell` → "variant Atom not found in
<enum:..._self_shell>" → swallowed at def-time → no ExprInfo → "Failed to
transpile". Found by instrumenting `_trial_eval_fn_body`'s swallow to print
`err.to_string()`. Fix: `resolve_enum_shell(matched_type)` in match.yo (mirrors
synthesizer.yo / property_access.yo). check ./std 152/152, corpus PASS 82.

SIBLING (codegen) — ✅ ALSO FIXED: the same self-shell leaked into C type
emission (a recursive enum's `Box(Self)` field emitted an empty C enum, "use of
empty enum"). Fixed by resolving shells in codegen's `_type_key_at` + `collect_type`
(codegen-local). Regression test `recursive_enum_nested_match.yo` in the corpus.
See `issues/fixed/yo-self-codegen-recursive-enum-self-shell.md`. This unblocks the
AstExpr (`Box(Self)`) recursive-enum codegen for the fixpoint.

## Arm-frame-depth check — ✅ FIXED (target.yo 2→0)

`merge_and_check_envs` (evaluator/utils.yo) threw "Frame level is different for
different cases" for a `cond`/`match` that MIXES a `begin`-block arm (pushes its
own binding frame) with a simple-expr arm — non-uniform total depth. yo-self
evaluates each arm under a per-arm `push_frame` (a divergence from TS, where arm
envs sit at the outer level), so the ported strict total-depth equality was
wrong here. Fix: require each arm env to CONTAIN the outer frames
(0..max_frame_level — the only frames the post-check ownership loop scans), not
match total depth; the per-frame variable-count check remains the soundness
guard. target.yo 2→0, std 152/152, corpus PASS 83.

## Candidate 3 — ✅ RESOLVED (trivial nested-match arm drops an enclosing binding)

FIXED in merge_and_check_envs (evaluator/utils.yo): treat a case var MISSING from
an arm's recorded frame as the BASE var (it retains its pre-match state) rather
than `make_err_variable`, at BOTH the variable-names check and the per-column
consume/init merge. A trivial arm (`.None => .None`) records no copy of an
enclosing destructure binding (`self_al`) that the base + destructuring sibling
arms carry; since that binding was init'd BEFORE the match, an arm that doesn't
re-bind it simply retains the base state. This keeps genuine partial-consume/init
detection intact (a consuming arm keeps the var in its frame with consumed_token).
naming_checker.yo 1→0 (std/string/string.yo's `index_of` — and all
`.index_of`/`.contains`/`.find`), check ./std 152/152, no regression. Details
below for history.

### Original diagnosis (kept for history)

`std/string/string.yo:516` `index_of` (surfaced via naming_checker.yo): the
function body is `cond(simple => .Some(i), true => begin(… match … begin(…
while(… return(.Some(char_index)) …), return(.None)) …))` — embedded `return`s
deep inside a `begin` that is itself a `cond`/`match` arm in RETURN position.
After the arm-frame-depth fix above, index_of's def-time eval now throws (still
swallowed → no ExprInfo) **"Frame level 4/5 has different variable names for
different cases"** (evaluator/utils.yo:812). Confirmed via the printing-swallow
instrumentation. ROOT: `merge_and_check_envs` has THREE strictness checks
(depth=702, value-count=768, variable-names=812) that all require arms to share
an IDENTICAL frame/variable layout at every level 0..max_frame_level. A
`begin`-block arm's `:=` bindings (e.g. `char_index`/`byte_index`) land in a
scanned frame that a simple sibling arm (`.None => .None`) does not have — so the
names/counts diverge. PRECISE ROOT (instrumented the names-check, DBG_NAMES dump):
```
frame=4/max=4 kk=0 base.len=1 case.len=0 base[kk]=self_al   case[kk]=__err__
frame=5/max=5 kk=0 base.len=1 case.len=0 base[kk]=search_al case[kk]=__err__
```
i.e. it is NOT the begin-arm adding locals — it is the TRIVIAL arm DROPPING an
outer binding. In the nested `match(self._bytes, .None => .None, .Some(self_al)
=> match(substr._bytes, .None => .None, .Some(sub_al) => begin(…)))`, the inner
match's env (base) has the OUTER destructure binding `self_al`/`search_al` at
frame 4/5, but the trivial `.None => .None` arm's recorded env has that frame
EMPTY (case.len=0). So the names check compares `self_al` vs missing and throws.
In TS every arm env retains the outer bindings (arms sit at the outer level), so
this never arises — it is a yo-self recorded-env divergence: a trivial match arm
records a shallower/emptier env than its siblings, losing an in-scope outer
binding. (Disabling the names check alone does NOT clear index_of — the layout
inconsistency also affects the count check / per-column merge.)

ATTEMPTED (reverted): giving the names-check the same `frame_i !=
max_frame_level` innermost-frame exemption the value-count check already has
(at the innermost frame, arms legitimately bind different locals). This is a
correct consistency improvement BUT insufficient — index_of stays at 1, because
`self_al`/`search_al` is NOT an arm-local here: it is an ENCLOSING-destructure
binding that happens to sit at the inner match's innermost frame (the inner
match is nested inside the outer `.Some(self_al)` arm). So the per-column merge
(utils.yo:826+) still processes it as a shared var and the missing-in-`.None`-arm
inconsistency resurfaces. The innermost exemption can't cleanly cover it.

FIX (deep, soundness-sensitive — fresh task): the right fix is (a) — make a
TRIVIAL arm's recorded env carry the same enclosing-frame bindings (`self_al`)
that its sibling arms and the base retain (match.yo arm-env recording / per-arm
frame management). That makes ALL the merge checks (depth/count/names/per-column)
see a consistent layout at once, matching TS (where arm envs sit at the outer
level with enclosing bindings intact). Relaxing the individual checks is
whack-a-mole (each fix exposes the next) and risks the consume/init merge
soundness. Affects ALL `.index_of`/`.contains`/`.find` users — high value.
Related: the now-compiling `target.yo` and OPEN
`issues/yo-codegen-block-rhs-drops-statements.md`.

## Method

`compile <m>.yo --emit-c --skip-c-compiler` + `grep -c "Failed to transpile"`;
minimal repro in `src/tests/fixme.yo`; if the node has no ExprInfo, instrument
the def-time trial-eval swallow (`_trial_eval_fn_body`,
`evaluator/calls/function_type.yo`) to print the swallowed throw; root-cause →
fix evaluator or emitter → re-measure → corpus-validate (now deterministic) →
commit. The corpus differential is reliable again post-P0.

## UPDATE (2026-06-26): the 141 control-flow cluster ROOT = generic-collection-method `Self._alloc_with_capacity` → `T = Type(1)` (the task #28 knot)

Re-measured the post-recur-fix 141 tail. The dominant cluster is **45 control-flow
markers (16 `if`, 16 `match`, 10 `while`, 3 `cond`)**. The `if`/`match` half traced
to ONE root via [TTERR] swallow-instrumentation + binary search.

**The swallowed throw** (def-time body eval, [TTERR]):
```
Error: Type mismatch for type member "value":
Expected: <struct:struct_yo_id_5827>   (= String)
Got:   Type(1)                          (= TypeUni(1), an unsubstituted type param)
  at std/collections/hash_set.yo:88:15  ->  Self(... data : .Some(data_ptr) ...)
```
`Type(1)` is `TypeValue.TypeUni(1)` — the kind/placeholder for an **unsubstituted
forall `T`**. The match/if marker is on the WHOLE construct (not the inner call)
because the throw leaves it NOINFO (no ExprInfo) -> codegen falls to the marker.

**Minimal repro (8 lines, NO object, NO match, NO cross-module — much simpler than
the html.yo HashMap case in `issues/fixed/self-dispatch-loses-type-args.md`):**
```rust
open(import("std/string"));
{ HashSet } :: import("std/collections/hash_set");
emit :: (fn(h : HashSet(String), name : String) -> unit)({ _a := h.add(name.clone()); (); });
main :: (fn() -> unit)({ /* ... construct + */ emit(hs, `x`); (); });
```
**Fails (1 marker).** But `s := HashSet(String).new(); _a := s.add(name.clone());`
in the same fn **WORKS (0 markers).** The `.new()`-masking is the key tell.

**Mechanism (confirmed by binary-search over repro variants):**
- `add` (mutating) calls `Self._resize(self,...)` -> `Self._alloc_with_capacity(cap)`.
  `_alloc_with_capacity : (fn(capacity : usize) -> Result(Self, ...))` has **NO `self`
  and NO `T`-typed param** — its `T` lives ONLY in the body (`*(T)`, `sizeof(T)`,
  `Self(...)`). So `T` cannot be synthesised from any call argument; it must be
  recovered from the enclosing `Self` context.
- `contains` (non-mutating) **works** on the same receiver — it never constructs
  `Self`, so `Type(1)` is never checked. Only `Self`-constructing methods surface it.
- **`.new()` masks the bug**: `HashSet(String).new()` specialises
  `_alloc_with_capacity` with `T = String` FIRST (explicit type arg in the call),
  cached. The param/match-bound receiver path has no prior `.new()`, so
  `_alloc_with_capacity` is first specialised via the nested `Self.` chain where
  `T` is NOT threaded -> `Type(1)`. So the receiver KIND (runtime param, match
  binding, object field) is IRRELEVANT — all fail identically; the discriminator
  is purely "was `_alloc_with_capacity` already specialised with concrete `T`".

**This is the same knot as `issues/fixed/self-dispatch-loses-type-args.md` /
`plans/GENERIC_METHOD_RESOLUTION_KNOT.md` (task #28, the dominant lever).** `check
./yo-self` passes 227/227 because `check` does NOT eval fn bodies; the **codegen
self-compile** def-time-body-eval path still hits it.

**FIX ATTEMPT (reverted — did NOT fire):** added a "Step 7b" fallback to
`try_to_call_function_with_arguments` (helper.yo) that, for any forall still
`UnknownVal`/`SomeT` after synthesis, binds it positionally from the static-call
RECEIVER's `type_arguments` (read via a local `_dot_receiver_concrete_type` mirror
of function.yo's `_static_dot_receiver_self_type`). Built clean (no syntax/type
errors), but the repro STILL threw `Type(1)` -> **the fallback never fired.** This
**independently confirms the prior session's finding** (which tried the same via
`ctx.self_type` and also never fired): no-arg `Self`-dispatched specialisations do
**NOT** flow through `try_to_call`'s forall path (Steps 6–8). The failing
specialisation happens elsewhere — almost certainly **def-time SIGNATURE eval where
the declared `Self` is a freshly-MINTED shell** with `T = SomeT`/`Type(1)` (see the
existing comment at `helper.yo:~1342` in `create_specialized_function_inline`,
which prefers the receiver ARG type over the declared `self` precisely "during
def-time signature eval the declared `Self` can be a ... shell ... whose nested
specializations (`Self.with_capacity` -> `(*(T))(_ptr)`) fail"), OR via the
`substitute()` method-resolution path. **NEXT: instrument
`create_specialized_function_inline` / the method-resolution substitute path (NOT
try_to_call) to find where `_alloc_with_capacity` is specialised with `T=Type(1)`,
and thread `T` from the enclosing method's concrete `Self` there.** The 8-line
repro above is the fast loop.

### FOLLOW-UP (2026-06-26, same day): the forall-binding hypothesis is DISPROVEN — `T` is already `String`; the degeneration is in the `Self(...)` construction eval

Spent ~7 instrumented builds chasing the above "thread T from Self" fix in
`create_specialized_function_inline`. **It is the WRONG site.** Hard runtime
evidence (probes at `create_specialized`, guarded to the `params[0]=="capacity"`
method = `_alloc_with_capacity`, on the 8-line repro):

- `[CSPEC-RAN] forall>0 struct` — `_alloc` DOES reach `create_specialized` (cache
  miss), `forall_names` is non-empty (contains `T`), and `ctx.self_type` IS a Struct.
- `[STSELF] self_type=<struct_5827> targ0=String` — at the failing
  `Self(...)` construction (type.yo:275), `ctx.self_type` = the concrete
  `HashSet(String)` AND its `type_arguments[0]` = `String`. So the band-aid
  `type_arguments` IS populated (contradicts the earlier guess that HashSet, like
  html.yo's HashMap, leaves it empty).
- `[CF0] name=T val=String` — **`T` is already bound to `String`** in `callee_env`
  at the `create_specialized` body-eval site. NOT `Type(1)`, NOT a `SomeT`, NOT
  `TypeUni`, NOT `UnknownVal`. So a forall-from-`Self` rebind is a NO-OP — there is
  nothing to fix there (`cf_unresolved` is correctly `false`). Two fix variants
  (rebind on `UnknownVal`/`SomeT`; widened to `TypeUni`; widened to any non-concrete)
  ALL left the marker at 1, because `T` is genuinely `String` going in.
- `[CF0] name=Self val=novar` — there is no `Self` *variable* in `callee_env`;
  `Self` resolves via `ctx.self_type` (correct, `HashSet(String)`).

**Conclusion:** with `T = String` and `Self = HashSet(String)` both correct at the
start of `_alloc`'s body eval, the body STILL produces `Type(1)`. The `Type(1)`
(`TypeUni(1)`) is the result type of the **`Self(...)` struct construction** itself
(the arg to `.Ok(Self(...))`; member "value" = `Result.Ok`'s field, expected
`Self`=struct_5827, got `Type(1)`) — i.e. evaluating `Self(ctrl:…, data:.Some(*(T)(…)), …)`
during **def-time body eval (`is_executing=false`)** degenerates the struct
construction to a type-value (`TypeUni`) instead of a value of type `HashSet(String)`.
This is the SAME class as the Direction-B keystone
([[yo-self-p1-dirB-where-self-type1]]) "`F(arg)` type-constructor application
degenerates to a type-value", but here the inputs are fully concrete (no recursive
self-shell) — so it is a cleaner instance: **a runtime struct construction `Self(…)`
evaluated at def-time yields the type instead of a value.**

**REAL NEXT STEP (correct site at last):** instrument the evaluation of a
`Self(...)` / struct-constructor FnCall in def-time body-eval mode (the
property-access / type-call path — `evaluator/calls/type.yo`
`try_to_call_type_with_arguments`, or wherever `Self(fieldargs)` with
`is_executing=false` is dispatched) and find why it returns `TypeUni(1)` rather
than a struct value (likely a `is_executing`/comptime gate that treats a
type-valued callee's call as a type-application). The forall machinery
(`create_specialized`, `type_arguments`, `_funcval_bind_foralls`) is NOT involved —
do not touch it. Fast loop: the same 8-line `fn(h : HashSet(String), name){ _a :=
h.add(name.clone()); () }` repro, [TTERR] on the swallow + an `is_executing` /
result-tag probe at the struct-construction dispatch.

#### Read-only dispatch trace (2026-06-26 — next-step HYPOTHESIS, not yet runtime-confirmed)

Traced where `Self(...)` is evaluated (no build). `evaluate_function_call`'s
TypeVal-callee dispatch (`function.yo:1691+`) has two relevant arms:
- **`.Struct(...)` arm (`function.yo:1873`)** → `try_to_call_type_with_arguments`
  + sets `out_s.ty = func_type` (the struct type). If `Self(...)` reached THIS arm
  its result type would be `HashSet(String)` — NOT `Type(1)`.
- **`.SomeT(... kind_fn ...)` arm (`function.yo:1749`)** → builds a *TypeApplication*
  (a TYPE) → exactly the `Type(1)`/`TypeUni` degenerate.

So the failing inner `Self(...)` callee is resolving to a **`SomeT`** (routing to the
SomeT/HKT arm), NOT to the concrete `.Struct` — even though `[STSELF]` showed
`ctx.self_type` concrete `HashSet(String)` at the OUTER `.Ok(...)` check. The `Self`
identifier resolves at `identifer_and_operator.yo:106-117`: it reads `ctx.self_type`
and, when that is a `SomeT`, calls `get_value_of_some_type_from_env`; if the env
binding is ALSO a `SomeT` it returns the `SomeT` unchanged → `TypeVal(SomeT)` callee
→ SomeT arm → `Type(1)`.

**Hypothesis to confirm with one build:** at the moment the INNER `Self(...)`
constructor's callee is resolved (inside `_alloc`'s body, before the `.Ok` wrap),
`ctx.self_type` is a `SomeT` (the impl's `Self` placeholder), not the concrete
`HashSet(String)` — it only becomes concrete by the time of the outer `.Ok` check.
Probe: print `ctx.self_type`'s tag (SomeT vs Struct) at `identifer_and_operator.yo:107`
guarded to `identifier=="Self"` AND module-path containing `hash_set`. If SomeT →
the fix is to make `Self` resolve to the concrete receiver there (or ensure
`ctx.self_type` is concrete throughout `_alloc`'s body, not just at the outer check).
If it is already a Struct there → the degeneration is inside
`try_to_call_type_with_arguments`'s per-field eval of `.Some(*(T)(..))` and the trace
above is wrong. Either way this is the FIRST build of the next active session — the
forall machinery is confirmed out of scope.

#### REFUTED (2026-06-26, +1 build): `Self(...)` DOES reach the Struct arm — degeneration is in the per-field eval

Ran the probe (function.yo `.SomeT`/HKT arm vs `.Struct` arm, guarded to
`tok.module_path.contains("hash_set")`, printing `ast_expr_to_string(func_expr)`).
Result on the 8-line repro: **`[STRUCTARM] Self` ×2, and ZERO `[SOMETARM-HKT]`.**
So the SomeT-resolution hypothesis above is WRONG — `Self` resolves to the concrete
`.Struct` and `Self(...)` enters the **Struct construction arm** (function.yo:1881)
correctly. The `[STRUCTARM] Self` print is at the TOP of the arm; the throw fires
AFTER it, inside `try_to_call_type_with_arguments` (the arm's body, function.yo:1917).

So the `Type(1)` is produced by the **per-field evaluation of one of `Self(...)`'s
field args**, NOT by callee dispatch. The throw's member `"value"` = a nested
`Option.Some` construction (the `ctrl :.Some(ctrl_ptr)` / `data :.Some(data_ptr)`
fields, `?*(u8)` / `?*(T)`), so the degenerating sub-expression is the `.Some(<ptr>)`
payload — most likely **`data_ptr := *(T)(data_void_ptr)`** (the `*(T)(...)` pointer
cast) evaluating to `TypeUni(1)` at def-time instead of a `*(T)` value. (`*(T)` is a
pointer-type expression; called with an arg `(data_void_ptr)` it should be a runtime
cast → a `*(String)` VALUE, but at `is_executing=false` it appears to yield the TYPE.)

**CORRECT NEXT PROBE (next active build):** inside `try_to_call_type_with_arguments`
(type.yo) just before the `are_types_compatible` throw (type.yo:275), the failing arg
is already evaluated — print `ast_expr_to_string(actual_arg_expr)` (guarded to
`member_element.label=="value"` + hash_set module) to confirm it is the `*(T)(...)`
cast (or `.Some(...)`). Then instrument the eval of a `*(T)(arg)` FnCall (pointer-type
callee with a value arg) in `is_executing=false` mode and find why it returns the type
rather than a cast value. Forall machinery AND callee dispatch are both now confirmed
OUT of scope.

#### TRUE ROOT (2026-06-26, +1 build — corrects the `*(T)`-cast guess): the struct FIELD TYPES retain unsubstituted `T`

Probe at the `try_to_call_type_with_arguments` field-check throw (type.yo, printing
`member_element.label` + `arg_type` + `ast_expr_to_string(actual_arg_expr)`, guarded to
`member=="value"`) gave TWO mismatches on the 8-line repro:
```
[ARGEXPR] member=value got=*(String) expr=data_ptr
[ARGEXPR] member=value got=Type(1)  expr=Self(ctrl :.Some(ctrl_ptr), data :.Some(data_ptr), capacity : capacity, size : usize(0))
```
- Line 1: the inner `.Some(data_ptr)` (the `data : ?*(T)` field). **`data_ptr` is correctly
  `*(String)`** — so the `*(T)(data_void_ptr)` cast is FINE (my prior "the cast yields
  Type(1)" guess is WRONG). The mismatch is that the Option's `value` field EXPECTS
  `*(T)` with **`T` still unsubstituted** (a SomeT/`Type(1)`), while the value is the
  concrete `*(String)` → `are_types_compatible(*(String), *(unsubstituted-T))` = false.
- Line 2: that throw drops the whole `Self(...)` construction to `Type(1)`, which is then
  the arg to the outer `.Ok(Self(...))` (Result.Ok's `value` field) → the marker.

**So the root is a SUBSTITUTION gap, not a cast.** The struct type used to construct
`Self(...)` has field types `data : ?*(T)` / `ctrl : ?*(u8)` where **`T` was NOT
substituted to `String`**, even though the struct's `type_arguments=[String]` (confirmed
earlier: `targ0=String`). i.e. `ctx.self_type` for `_alloc` reached via the add-chain
(`h.add` → `Self._resize` → `Self._alloc`) is a `HashSet(String)` whose `type_arguments`
are populated but whose **`field_types` still reference the impl forall `T`**. Via
`HashSet(String).new()` the same construction WORKS — so that path's `Self` carries
field types already substituted to `String`. There are effectively two `HashSet(String)`
representations: the `.new()` one (fields substituted) and the add-chain/Self-dispatch
one (fields = `?*(T)`).

**CORRECT FIX DIRECTION (core eval — for a deliberate session, NOT autonomous grind):**
substitute the struct's `type_arguments` into its `field_types` for the receiver
`Self` on the Self-dispatch path — either (a) at the Struct-construction arm
(`function.yo:1892`, substitute `forall→type_arguments` into the `get_struct_fields`
result before `try_to_call_type_with_arguments`), or (b) make the add-chain `Self`
(`ctx.self_type`) carry substituted field types at the point it is set
(`create_specialized` self_type / the method-dispatch that resolves `Self` from the
receiver). The `type_arguments` band-aid is populated but never pushed INTO the field
types on this path — that is the gap. (Needs the struct's forall param NAMES to build
the substitution; check whether the struct value or registry carries them.) This is
the recursive-type / self-shell substitution layer
([[yo-self-recursive-enum-self-shell]] / Direction-B), now pinned to the exact
field-type-substitution gap.

#### ✅ FIXED (2026-06-26, commit 21c45878b): 141 → 78 markers (−63)

Implemented option (a): at the Struct-construction arm (`function.yo:1892`), after
building `fields` from `get_struct_fields(struct_id)` (the registry TEMPLATE, with
`?*(T)`), override each field's `ty` with the struct VALUE's substituted
`field_types` (matched by label), then pass the merged `fields_subst` to
`try_to_call_type_with_arguments`. This is the faithful port of TS function.ts:1020
(`typeFields: value.value.fields` — TS sources construction fields from the value,
which is substituted; yo-self had diverged to the registry template). yo-self splits
field METADATA (defaults, registry) from field TYPES (the `TypeValue.Struct` value),
so the merge keeps registry metadata + value types. Moved the registry field into a
mutable local and overrode only `.ty` (no `clone()` of the metadata — `Option(EvalValue)`
has no `.clone`).

**Validation (all green):**
- minimal repro (HashSet.add on param + match-bound receiver): 1 → **0** markers
- full stage-2 self-compile: 141 → **78** markers (−63, ~45% of the tail), EXIT=0
- `check ./std`: 153 modules OK, no errors
- `check ./yo-self`: all **166 source modules** OK, no errors (stopped before the
  known-heavy `tests/` files, which `check` clean per README and are validated via sweeps)
- runtime: a HashSet `add`+`contains` program compiled by the fixed binary produced
  correct output (`has_apple=true`, `has_banana=true`, `has_cherry=false`) — confirms
  the emitted C is correct, not merely marker-free.

The remaining 78 markers are other clusters (re-measure + re-cluster the new
stage2.c). One incidental gap surfaced while building the runtime test: calling a
method INLINE inside a template-string interpolation (`${hs.contains(x)}`) emits a
marker (routes through `import("std/fmt/to_string").to_string()` un-transpiled);
binding to a local first transpiles. Likely part of the template-string/to_string
cluster — a candidate next target.

#### 78-tail re-cluster (2026-06-26, read-only — no dominant cluster left)

By leading construct: 8 `if`, 7 `while`, 6 `match`, 4 `usize`, 3 `cond`, 3
`expr_info_table_set`, then a long singleton tail. Unlike the 141-tail (where the
Type(1) construction dominated ~63), **the 78 are DIFFUSE — a long tail of distinct
small roots, no single dominant lever.** Visible candidate sub-clusters (each ~1–3
markers, distinct roots — NOT the now-fixed construction):
- **Derived-clone big-enum matches**: `match(self, .Unit => TypeValue.Unit, .BoolT
  => …)` (TypeValue clone) and `match(self, .Atom(__v_id,…) => .Atom(…clone…),
  .FnCall(…) => …)` (AstExpr clone) — the derived `clone` over a many-variant enum.
- **template-string inline method call** (`${hs.contains(x)}`) — see above.
- **comptime_assert** (`if(!(is_bool_val(arg_val)), begin(exn.throw(…"Expected bool
  value for \"comptime_assert\"")))`).
- **async sync-await result** (`if(!(is_result_unit), begin(result_var := …))`),
  template-string-import (`if(self.has_template_string, …BK_IMPORT…)`), variadic
  param reg (`if(label != "...", …g_func_variadic_params.set…)`).
- a few `while` arg-iteration loops (`while(i < args.len(), …evaluate_expression…)`).

So further P1 draining is now per-root and smaller-yield (no more −63 wins). NOTE:
the per-C-fn clustering (`awk '/^static/{fn=$0}…'` + `grep -oE yo_id_NNNNN`) is
UNRELIABLE here — a `static <ret-struct-id> <fn-id>(…)` line carries 2+ yo_ids, so
counts are inflated; cluster by marker EXPRESSION instead. (Per-function via the
fn name = last identifier before `(` on the `static` line DOES work: top fns are
comptime_assert handler ~9, a gensym-like Expr-atom builtin ~8, an implicit-vars
walker ~6, the comptime-`and` fold ~5, an async-result codegen emitter ~5.)

#### 78-tail [TTERR] throw-map (2026-06-26) + the Incompatible-types root

Built a [TTERR]-instrumented binary from the FIXED source and ran the full
self-compile capturing the swallowed def-time throws. Categories:
- **7 `Incompatible types: Previous X / Current unit`** (the biggest) — at
  **cond.yo:543** (the `cond` arm-type unification; `if`/`match` route here).
  Sites: comptime_assert.yo:81 `.None => {}`, gensym.yo:116 `_ => {}`, and_or.yo:77,
  import.yo:214 `}, {`, the `if`-macro default `?= quote(())` (prelude:7602),
  flowability.yo:674 (`Previous: ResumeType`). Pattern = a STATEMENT-position
  `match`/`cond`/`if` where one arm is a value-producing block and another is an
  empty `{}` / `()` (unit).
- 3 `Frame level N — different number of values` + 1 `… different variable names`
  (branch-merge family, [[yo-self-branch-merge-trivial-arm]]).
- 2 `Type mismatch for type member "args"` + 1 `"field_types"` — **NOT the enum
  arm; it is `array_list(...)` / `.clone()` on an `ArrayList` evaluating to
  `Type(1)`** where `ArrayList(T)` is expected. Sites: parser.yo:982/1392
  `array_list(arg, arg_copy)` / `array_list(str_atom)` (the `args` field of an
  `AstExpr.FnCall` construction, `Got Type(1)`); definitions.yo:362
  `.Tuple(labels.clone(), types.clone())` (`types.clone()` → `Type(1)`, the
  `field_types` member). So a SEPARATE Type(1) degeneration — the `array_list`
  builtin's (and `ArrayList.clone`'s) RESULT type degenerates to `TypeUni` at
  def-time. Distinct from the struct-field-type fix; needs its own diagnosis of
  the `array_list` builtin / ArrayList-clone result-type computation.
  **Read-only refinement (2026-06-26): `array_list` is a VARIADIC MACRO**
  (`array_list.yo:827`, `fn(...(quote(elems))) -> unquote(Expr)`) expanding to
  `{ tmp := ArrayList(typeof(first)).new(); tmp.push(first); unquote_splicing(rest_pushes); tmp }`.
  So the expansion's TYPE should be `ArrayList(typeof(first))` but is computed as
  `Type(1)` at def-time — a MACRO-EXPANSION type-computation gap (the
  expanded-block value type, involving `typeof(first)` + the `ArrayList(...)`
  application + `unquote_splicing`), NOT a plain builtin. Likely related to how the
  macro path records the expansion's `.ty` (cf. the recur macro_expansion side-table
  [[yo-self-recur-codegen-macro-expansion]], but here it's the EVAL-time type not
  codegen). Diagnose by instrumenting the macro-unquote path's `exp_info.ty` for an
  `array_list` call.

#### Status checkpoint (2026-06-26): all 78-tail clusters are distinct non-trivial investigations

After the dominant Type(1) struct-field fix (141→78), the remaining tail has NO
dominant lever — every cluster (arm-type unification upstream-typing; `array_list`
macro-expansion typing; branch-merge Frame-level; comptime-`and` bool) is a
separate, soundness- or type-system-sensitive multi-build diagnosis with its
next step documented above. None is a quick extension of a prior fix. Highest
marker-count target = the arm-type/Incompatible-types cluster (~22 markers across
comptime_assert/gensym/and_or) but it is the most delicate (must not relax the
TS-faithful cond.yo:543 check — fix the upstream arm-typing).
- 2 `Expected bool type for "and" argument` (the comptime-`and` builtin, and_or.yo).
- 2 `Cannot unify incompatible types`, 1 `Argument count mismatch`.

**KEY (the Incompatible-types fix is NOT "relax the check"):** TS `cond.ts:417-422`
has the BYTE-IDENTICAL unification + throw — so cond.yo:543 is a faithful port.
TS compiles yo-self fine, so in TS these arms unify (both `unit`, or the
value-arm is divergent/skipped). The divergence is therefore **UPSTREAM in yo-self's
ARM-TYPE COMPUTATION** — it computes a value/struct type for an arm that TS types as
`unit` (likely the value-arm-vs-empty-`{}` block, or an effect `exn.throw(...)` call
not flagged divergent by `has_any_control_flow` so its arm-type unifies against the
unit sibling). **NEXT (fresh instrumented diagnosis): print `body_einfo.ty` +
`has_any_control_flow(body_cf2)` per arm at cond.yo:526-553 for one of these sites
(e.g. comptime_assert) — find why an arm that should be `unit` is typed as a struct.
Do NOT relax the cond.yo:543 check (it matches TS).** This is the branch-merge /
arm-type family — soundness-sensitive; verify against TS before any change.

#### array_list cluster — investigation update (2026-06-26): variadic-macro typing, NOT the unquote path

Drove the `array_list`→`Type(1)` cluster (3 markers). 8-line repro: `Box(items :
array_list(a, b))` where `Box :: struct(items : ArrayList(i32))` → 1 marker on the
`Box(...)` (the `items` field sees `array_list`'s type as `Type(1)`).

**Isolated (variant test, all in one file):** `ArrayList(i32).new()` ✓, and
`ArrayList(typeof(a)).new()` ✓ both transpile — **only the `array_list` MACRO
fails**. So it's NOT ArrayList construction or `typeof`; it's the variadic macro's
expansion typing.

**Ruled out the obvious path:** instrumented the macro-unquote handler
(function.yo:2937, where `exp_info.ty` is recorded as the macro call's type) —
the probe produced **ZERO output** for the repro, i.e. `array_list` never reaches
that `if(macro_return_is_unquote(func_id_fv), .ExprVal => …)` block. So the macro
call's type is NOT being set from its expansion. **Hypothesis: `is_macro_fn(func_id_fv)`
and/or `macro_return_is_unquote(func_id_fv)` is FALSE at the call site for the
variadic `array_list`** — a registration/re-keying gap. The registry is keyed by
the fn-type-expr id at definition (function.yo:3699-3702) and RE-KEYED under the
FuncVal `func_id` by `try_to_implement_function_by_function_type`
(`copy_macro_registration`); if the variadic macro's re-key misses (or `func_id_fv`
≠ the registered id), the macro is treated as a plain comptime fn and its result
(an `Expr` value) is typed as the raw comptime/`Type(1)` instead of its expansion.
**NEXT: probe `is_macro_fn` + `macro_return_is_unquote(func_id_fv)` for the
`array_list` call** (and compare the registered id vs `func_id_fv`); fix the
variadic re-keying / `is_return_unquote` detection.

**INSTRUMENTATION CAVEAT (cost me ~3 builds):** adding a probe inside
`evaluate_function_call` (deeply nested) trips the TS compiler's OWN branch-merge
check (`Frame level N has different number of values`) — even as a module-level
helper, even with an early-`return` guard — because the `if(cond, {…:=…})`
value-arm-vs-unit pattern is exactly what that check rejects. Use an UNCONDITIONAL
print helper (no `if`/`cond` introducing bindings in one arm; build the message +
`fwrite` with no guard, grep the flood), or instrument the shallower registration
site (function.yo:3699). (This trip is itself a live demo of the Incompatible-types
/ Frame-level cluster root.)

##### ✅ FIXED (2026-06-26, commit pending): 47 → 43 markers (−4) — variadic-macro dispatch was unimplemented

The macro registration/re-keying was a RED HERRING (it works — `array_list` =
AST id 52590 → re-keyed correctly to FuncVal `yo_id_3970`, `is_macro_fn` true).
The actual root, pinned with gated `[CVTAG]`/`[DISP]` probes on the IMPORTED repro
(the earlier repro omitted `{ array_list }` from the import, masking the real path):
the `.FuncVal` dispatch arm (function.yo:2326) **rejected `array_list` BEFORE macro
dispatch** at the regular arg-count check (`n_a > n_p`) — the variadic
`...(quote(elems))` contributes `n_p=0`, so `array_list(a, b)` threw "Argument count
mismatch: expected 0, got 2" (swallowed at def-time → `Type(1)` → marker). This also
explains why the prior session's probe at the macro-unquote handler "never fired":
the throw short-circuits ~90 lines before it. Even past the count check, the variadic
`elems` was **never bound** into the comptime callee env (function.yo binds only the
`n_p` regular params), so the macro body's `elems.car()/cdr()/len()` had no binding.

yo-self had NO variadic-macro support in the type-checker dispatch (`variadic_args`
was always empty; `is_param_quoted` excludes the variadic). The fix implements it,
mirroring TS `helper.ts:969` + `1620-1709`, all GATED on quoted-variadic so
non-variadic calls are byte-identical (regression confined to `array_list`):
1. Skip the arg-count check when `get_func_variadic_param(func_id_fv).is_some()`.
2. Detect a quoted variadic via its recorded type = `ComptimeList(Expr)`
   (`is_expr_list_type`).
3. In the arg loop, route trailing args (index ≥ `n_p`) of a quoted variadic as
   raw-AST `ExprVal`s (so the CTFE unknown-arg gate sees compile-time-known values,
   not runtime unknowns).
4. After the regular-param loop, bind the variadic name (`elems`) to a
   `ComptimeListVal` of those `Expr`s in `fresh_env`, so the macro body runs and
   expands.

Validated (all green): repro `array_list(a,b)` markers 2→**0**; full self-compile
**47 → 43** (−4, EXIT=0); `check ./std` 152/152; differential corpus
`tests/codegen-bootstrap` **83 PASS / 0 DIFF / 0 SELF-FAIL** (the heap-corruption
gate for the macro-path change — clean). Method: the decisive move was fixing the
repro's import to match the real `parser.yo` user (`{ ArrayList, array_list }`),
which un-masked the true dispatch path; `[CVTAG]` then showed the FuncVal arrived
with the right id but never reached the macro check.

#### arm-type / Incompatible-types cluster — ROOT PINNED (2026-06-26): empty `{}` (`_()`) arm vs unit

Drove the highest-yield cluster (7 "Incompatible types" throws, ~22 markers via
comptime_assert/gensym/and_or). Minimal repro + [TTERR]:
```
test_c :: (fn(o : Option(i32)) -> unit)({
  match(o, .Some(x) => { _y := x; }, .None => {});  ();
});
```
→ `[TTERR] Incompatible types: Previous: unit, Current: <struct:struct_yo_id_NNNN>`
at the match. Variant matrix (fixed binary):
- `.Some => (), .None => {}` → FAILS  | `.Some => {x;}, .None => {}` → FAILS |
  `.Some => {_y := x;}, .None => {}` → FAILS
- `.Some => {}, .None => {}` → OK     | `.Some => {_y:=mk(x);}, .None => {_w:=mk(0);}` → OK

**Root:** `{}` (empty braces) parses to **`_()`** (the `_` anon-struct, BK_ANON_STRUCT),
which `evaluate_anonymous_struct_value` types as a FRESH empty struct (struct_NNNN) —
NOT unit. `()` types as unit. So `.None => {}` (empty struct) vs a `unit` sibling arm
fails yo-self's match-arm type unification, because **compatibility.yo:278**
(`.Unit => match(expected, .Unit => true, _ => false)`) makes `Unit` compatible ONLY
with `Unit`. (`{}` vs `{}` works — empty-struct vs empty-struct unifies; both-bind works
— both blocks are unit.) yo-self's OWN source uses `.None => {}` / `_ => {}` extensively
expecting it to be unit-compatible.

**Confirmed NOT a parser or anon-struct-eval divergence:** the TS parser
(parser.ts:704-719) ALSO rewrites empty `{}` → `_()`, and TS's
`evaluate_anonymous_struct` (anonymous-struct.ts:48) ALSO `createStructType`s it. So TS
*creates* the same empty struct, yet `areTypesCompatible(unit, empty_struct)` is
effectively TRUE in TS (it compiles yo-self's `.None => {}` arms). **OPEN: the exact TS
acceptance path is unpinned** — compatibility.ts has NO explicit unit↔empty-struct rule
(grepped), so it is likely `convertComptimeTypeToRuntimeType` widening (cond.ts:395-410 /
the retry yo-self also has at cond.yo:533) normalizing one side, OR comptime arm-selection
skipping the cross-arm unification, OR an empty-struct tag from `createStructType`.

**FIX (focused next step — SOUNDNESS-SENSITIVE, verify TS first):** make
`are_types_compatible` treat a 0-field struct as compatible with `unit` (BOTH
directions — given=Unit/expected=empty-struct AND given=empty-struct/expected=Unit, at
compatibility.yo:278 + the Struct arm). Narrow + semantically sound (empty struct is
zero-size like unit), and matches TS's observed acceptance. But CONFIRM the faithful TS
mechanism first (trace `convertComptimeTypeToRuntimeType(empty_struct)` / add a TS test
for `match(.Some=>(), .None=>{})`) so yo-self mirrors TS rather than over-permitting.
Gate-validate (std 153, self-compile drop, corpus, no regression). Repro: test_c above.

##### ✅ FIXED (2026-06-26, commit f33a7ab5f): 78 → 47 markers (−31)

Confirmed the faithful mechanism first: `./yo-cli compile` (TS) accepts
`match(.Some(x) => (), .None => {})` (EXIT=0, no error) — so TS treats unit-vs-empty-
struct as compatible. Mirrored it: in `_compat_impl` (compatibility.yo), BEFORE the
tag-mismatch guard, added a symmetric rule — a 0-field struct is compatible with
`unit` — gated to `!require_exact` (exact cache-key comparisons stay strict, since
the tags differ). Sound: empty struct and unit are both zero-size.

Validation (all green): repro markers → 0 (unit-vs-`{}` arms drain; struct-value +
both-`{}` controls unaffected); full self-compile **78 → 47** (−31, EXIT=0, markers
fell not rose → codegen healthy); `check ./std` 153 OK no errors; `check ./yo-self`
166 source modules OK no errors (stopped before the heavy `tests/`). The −31 (vs the
~22 estimate) is because the rule also drained empty-`{}` sites beyond the
comptime_assert/gensym/and_or trio. Both the Incompatible-types AND most of the
Frame-level branch-merge throws were this same empty-`{}` pattern.
