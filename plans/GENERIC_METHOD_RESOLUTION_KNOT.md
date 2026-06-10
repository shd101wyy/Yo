# Generic-Method-Resolution Knot — Rework Plan

> **Scope.** The single root cause behind **132 / 133** failing Phase-3
> evaluator files (`check ./yo-self`): a method on a generic-type
> instantiation (`HashMap(String, X).new()`, etc.) resolves to `unit`. This
> doc scopes the dedicated rework after ~12 incremental attempts charted the
> dead ends. See `BOOTSTRAPPING_EVALUATOR.md` Phase 3 / Stage 1–4 for the
> full attempt log.

## CURRENT STATUS (latest first)

**Landed & committed (all regression-free unless noted):**

1. `66cc149e` — **Layer 1**: static-vs-instance method dispatch
   (`_try_find_receiver_method` uses the receiver VALUE; static calls look up
   the inner struct). std 151, tests 154 per-file, 0 regressions.
2. `68053176` — **type_to_string depth cap** (recursion guard for cyclic/deep
   types). Neutral.
3. `3b0c8957` + `17d20dd6` — **recursiveTypeRef port (A+B)**: SomeT-leaf
   recursion placeholder + `resolve_recursive_type_ref`. Neutral.
4. `b0878d36` — **Layer 2 foundation**: all-type-args routing (memoize+stamp
   every type-constructor instantiation) + cheap `type_to_string_key` synthesis
   key (fixes the O(n²) stringify blowup). **Termination wall solved** — std
   151, tests 154, regressors green. Top-level knot provably resolves (concrete
   stamped, cfid matches impl pattern).
5. `b07e9338` — **Gap A (enum cfid side-table) + Gap B (Self-plumbing)**: the
   generic static-method CASCADE now advances. `HashMap(String,X).new()` →
   `new` and `_alloc_with_capacity` both resolve (`ctx.self_type` is set from
   the static-dot receiver around the body eval, so `Self.method()` dispatches
   statically; cascades through nested calls). std **temporarily 150/151** —
   ONLY `std/encoding/html.yo` changes (its `_entity_map := HashMap(...).new()`
   moves from silently-accepted `unit` to a real CTFE that hits the next
   cascade gap). Regressors green.
6. `0aa5f5f2` — **sizeof port**: `get_size_of_type` / `get_alignment_of_type`
   now compute C-layout aggregate size/alignment for Struct/Tuple/Union/EnumT
   (were stubbed `.None`). Mutual recursion (per-field helpers ↔ public fns)
   broken with function-pointer slots (`g_size_of_type_fn` /
   `g_alignment_of_type_fn`), wired at module top level. std 150/151, neutral.

**Remaining — the REAL next gap is generic SUBSTITUTION, not sizeof.**
Instrumenting `sizeof.yo` proved that the sizeof port alone does NOT advance the
cascade: at `hash_map.yo:59` `sizeof(Bucket(K,V))` receives a `Struct` whose
`field_types` are unsubstituted `SomeT` (ids 1450/1451), not `String` — i.e.
during `_alloc_with_capacity`'s specialization, the type params `K→String,
V→String` were never substituted into the inner `Bucket(K,V)` construction (the
struct name is also empty). `get_size_of_type` correctly returns `.None` for a
`SomeT` field, so the `::` binding still fails. **NEXT: find why the specialized
method body builds `Bucket(K,V)` with abstract `SomeT` params instead of the
concrete instantiation — likely the Self-plumbing sets `ctx.self_type` but not
the type-PARAM environment, or `substitute()` isn't applied to constructor-call
args inside the specialized body.** Then likely more (malloc handling, etc.).
**Validation gate is per-file expected-change, NOT std==151** (html.yo and any
untyped `:= G(...).new()` legitimately change).

## Porting fidelity (TS → yo) — mostly 1-to-1, with documented divergences

The **functions** are faithful 1-to-1 ports (`evaluate_function_call`,
`evaluate_comptime_fn_call`, `resolve_recursive_type_ref`, the synthesizer, the
static/instance dispatch, the `ctx.self_type` mechanism = TS `context.SelfType`).
Some **data representations** deliberately diverge because yo-self's `TypeValue`
is a value-semantic enum (no object identity) and lower modules can't import
`EvalValue` (circular):

- `Struct.constructor_func_id` — added as a real field (faithful to TS
  `StructType.functionValue.funcId`).
- **Enum** `constructor_func_id` — a **side-table** (`value.yo g_enum_cfids`),
  not a field (EnumT field-add is ~65-site churn; behaviorally equivalent;
  `substitute` preserves the enum id so the key stays valid).
- **recursiveTypeRef** — a **side-table** (`comptime_fn.yo g_recursive_type_refs`),
  not a `SomeT` field (SomeT can't hold `EvalValue` arg-values — circular import).
- `type_to_string_key` (shallow synthesis key) — a yo-self-specific perf proxy
  for TS's O(1) `checkedTypePairs` object identity (yo-self has no identity).

These are behaviorally faithful; the divergences are forced by yo-self's value
semantics + module graph, and each is documented at its definition site.

## CORRECTION (BEGIN step 2, probe build `/tmp/yo-self-probe`): the knot is method resolution, NOT the gate/memoization

The Stage-3 SIGBUS framing was a red herring. Running the **committed
baseline** (no Stage-3 struct stamping) instrumented with `[GATE]`/`[CFC]`
probes showed:

- **`imm_vec` PASSES** (`check` rc=0) — the baseline does **not** crash.
  The SIGBUS was introduced only by the (reverted) Stage-3 `struct.yo`
  stamping. There is no active crash to fix.
- **The routing gate works for the vast majority** of type constructors:
  `Option` 96×, `ArrayList` 13×, every trait constructor — all
  `itht=T crc=T ret=TypeUni`. (A minority — `Vec` 60×, `ArrayList` 7× —
  show `itht=F crc=F ret=other`, i.e. a callee whose return resolved to a
  `SomeT`/non-Type; worth a faithful follow-up but NOT the knot.)
- **The cache is active** (`sc=T`, 215 HIT / 456 MISS) — memoization runs.

**The actual knot symptom** (`type_trait_methods.yo:130`, hit while checking
any file that imports it):

```
Incompatible types:
- Expected: <struct:struct_yo_id_3073>   // the LHS annotation HashMap(String, ArrayList(MethodEntry))
- Given   : unit                          // the RHS  HashMap(String, ArrayList(MethodEntry)).new()
```

`.new()` on a generic instantiation resolves to **`unit`**. The resolution
path (`env.yo:get_type_trait_methods_by_name_from_env`):

1. `type_id_or_empty(ty)` → the receiver Struct's `id` (a fresh `random_id`
   per instantiation, e.g. `3073`).
2. `get_type_trait_methods_by_name(id, "new")` → exact-string `HashMap.get` →
   **MISS** (the impl was registered under a different instantiation's id).
3. Fallback `_g_find_methods_from_generic_impls_fn` → `impl.yo`
   `find_methods_from_generic_impls` → for each registered generic impl,
   `try_match_generic_impl(resolved, entry)` = `synthesize_types(receiver
pattern `HashMap(K,V)`, concrete `HashMap(String,X)`)`. A match returns the
   method candidate. The fallback IS wired (`impl.yo:1236`).

So `.new()`→`unit` means the **fallback returned no candidate**. Three
possible causes (the `[GIMP]` probe build narrows it):

- **(c1) the HashMap generic impl was never registered** when checking this
  file (`n_keys`/`total_entries` for the lookup = 0 or excludes HashMap);
- **(c2) it is registered but `try_match_generic_impl` fails to synthesize**
  `HashMap(K,V)` against `HashMap(String, ArrayList(MethodEntry))`
  (`match=N`) — this is the funcId/synthesize gap the foundation targeted;
- **(c3) it matches but the candidate's method type/value comes back as
  `unit`** (`matched>0 results>0` yet still `unit` downstream).

## What is solid (committed foundation)

- **Memoization** (`663fca9f`): the live FuncVal-callee path delegates
  type-returning calls to `evaluate_comptime_fn_call` (+ `ctx.comptime_fn_caches`).
- **`constructor_func_id`** on `TypeValue.Struct` (`0d4e951f`) =
  TS `StructType.functionValue.funcId`; set at the comptime-call site,
  preserved through `substitute()`, compared in `synthesizer.yo`.
- **`result_is_comptime_only`** on `TypeValue.Func` (`755d54f9`) =
  TS `FunctionParameter.isCompileTimeOnly` on the return; gates delegation.
- **PROVEN** (Stage 3 probes): with the concrete stamped, the synthesizer
  **does** unify the impl pattern `HashMap(K,V)` against the concrete
  `HashMap(String,X)` (`same=T`). The matching mechanism works.

## The two coupled sub-problems

**P1 — the annotation/inline-path concrete is unstamped.** In a
type-annotation position (`(g : HashMap(String,X)) = …`) the callee resolves
to a _specialized struct-return_ Func whose `result_is_comptime_only` is
false, so it takes the non-memoized inline path → the concrete gets a fresh
id and no `constructor_func_id` → synthesize can't unify it. Stage 3 fixed
this by stamping at `struct.yo` from the enclosing known-type-constructor →
`same=T`. **But that re-introduced P2.**

**P2 — recursive same-constructor synthesis doesn't terminate.** Once
same-constructor field-recursion is enabled, `imm_vec`/`imm_threading`/
`priority_queue` SIGBUS. TS terminates via Type-OBJECT identity
(`checkedTypePairs` uses `===`); yo-self's guard keys on string ids
(`synthesis_type_id`), which only catches a cycle when the same id recurs.

## DIAGNOSED (BEGIN step 1, done): the SIGBUS is infinite inline-path instantiation

Re-ran the Stage-3 binary (`/tmp/yo-self-dbg4`: `constructor_func_id`
stamping active + `[GATE]`/`[SC]` probes) on `imm_vec`. Findings:

- **Only 94 `[SC]` lines, no explosion** → the crash is NOT same-constructor
  Struct field-recursion. The "recursive `Vec` node" assumption was WRONG
  (`Vec` is the flat `object(_ptr,_len,_cap)`).
- **The crash boundary is a flood of `[GATE] ArrayList itht=F crc=F`** — the
  same `ArrayList` instantiation taken through the **non-memoized inline
  path** over and over. So the SIGBUS is **infinite inline-path `ArrayList`
  re-instantiation**: an un-memoized `ArrayList(...)` call re-evaluates its
  body / specialization, which re-instantiates `ArrayList(...)`, each call a
  fresh un-cached evaluation → unbounded recursion → stack overflow. (The
  same=T synthesize match merely _triggers_ the path; the loop is in the
  FuncVal-call instantiation, not in synthesize.)

This **confirms mechanism 1** (memoize every instantiation) is the fix: if
the inline-path `ArrayList(X)` call hit the comptime cache instead of
re-evaluating, the re-instantiation would return the cached type and the loop
would break.

### KEY FINDING (BEGIN step 2 analysis): the TS routing gate + no-return-specialization

Tracing the TS dispatch (`helper.ts:1731`) settled what the gate _should_ be:

- **TS routes to `evaluateComptimeFunctionCall` purely on
  `functionType.return.isCompileTimeOnly`** — NOT on `isTypeHierarchyType`.
  yo-self's gate is `is_type_hierarchy_type(ret_type) || result_is_comptime_only`;
  the first disjunct is an extra yo-self widening.
- **Inside, `shouldCache = isTypeHierarchyType(returnType)` ALONE**
  (`comptime-fn.ts:91`) — yo-self diverges by OR-ing `result_is_comptime_only`.
- **CRUCIAL: TS never specializes the callee `functionType.return.type` to the
  concrete struct.** For `ArrayList`, declared `-> comptime(Type)`, the callee
  Func's `return.type` stays `Type` (TypeUni) and `return.isCompileTimeOnly`
  stays `true` _through the whole call_. The concrete `object(...)` struct is
  the call's _result VALUE_, written to the ExprInfo's value — never back into
  the callee's return _type_. So in TS `isTypeHierarchyType(returnType)` is
  TRUE here, `shouldCache=true`, and the in-progress recursion guard is active.

**The yo-self bug, restated.** At the gate the probe showed `itht=F crc=F` for
`ArrayList`. `itht=F` ⟹ yo-self's recorded callee Func `result` is the concrete
`object(...)` struct, NOT `TypeUni`. `crc=F` ⟹ its `result_is_comptime_only`
was also dropped. So yo-self is **specializing the callee Func's return type to
the concrete struct** (and losing `rico`) somewhere between evaluating the
`ArrayList` identifier and the call gate — exactly the thing TS does not do.
Fix direction: preserve the callee Func's declared `result=Type` +
`result_is_comptime_only=true` so the gate fires and the call is memoized
(making yo-self's id-keyed cycle guard behave like TS's). The `[GATE]`/`[CFC]`
probe build (this step) confirms whether `ret` is `Struct` (callee return
wrongly specialized) and whether the `[CFC]` cache MISSes.

### Earlier open question (superseded by the finding above)

**Stage 4a already tried routing `itht=F crc=F` calls through
`evaluate_comptime_fn_call` via the known-tc gate, and STILL SIGBUS'd.** So
routing alone didn't break the loop. Why? Two candidates to instrument next:

1. **The known-tc gate didn't fire for these `ArrayList` calls** — was
   `ArrayList`'s func*id marked known-tc \_before* these calls? (Order: the
   mark happens when a Type-returning `ArrayList` call is cached; if the
   looping calls precede any Type-returning one, they're unmarked.)
2. **It routed but the `(func_id, args)` cache missed** — the looping
   `ArrayList(X)` calls have args that `_ctfe_args_equal` treats as unequal
   (e.g. a `SomeT` arg with a fresh id each time, or a `type_contains_some_type`
   exact-match that never matches), so each "memoized" call is a cache MISS →
   re-evaluates → loops anyway. **This is the likely culprit** and the thing
   to verify: instrument `evaluate_comptime_fn_call` to log cache hit/miss +
   the arg signature for `ArrayList` calls under Stage 4a.

## Approach (after the diagnostic confirms the recursion)

The faithful goal: make yo-self's string-id cycle guard behave like TS's
object-identity guard. Candidate mechanisms (choose by what the diagnostic
shows):

1. **Memoize ALL type-constructor instantiations** (outer + nested), so every
   `Foo(i32)` is one stable-id `TypeValue`; then the existing id-keyed
   `_has_type_pair` guard catches cycles exactly as TS's `===` does. Requires
   routing the inline/annotation path AND nested-node calls through
   `evaluate_comptime_fn_call`, AND verifying the `(func_id, args)` cache
   actually DEDUPs them (Stage 4a routed but still SIGBUS → the dedup likely
   failed; the diagnostic must show why — cache-miss on arg comparison?).
2. **Guard the cycle on `constructor_func_id` pairs** when same-constructor
   (stable across instantiations), not raw ids — but must avoid false-merging
   distinct instantiations within one synthesis (e.g. `Pair(Vec(i32),
Vec(str))`); key on `(cfid, arg-signature)` to disambiguate.
3. **Bound recursion** — REJECTED: a `checked.len()` bound backfired
   (SIGSEGV incl. prelude; normal same-constructor synthesis visits many
   pairs and throwing deep crashes).

## Validation (mandatory each step)

- Build `/tmp/yo-self-bin`; **baseline-vs-fix per-file diff** harness
  (`$? $file` per file, `join`) over `./std`, `./tests`, `./yo-self`
  (eval-only). Aggregate counts have hidden 0-improved/regressed results
  repeatedly — always per-file.
- Regressor watch: `imm_vec`, `imm_threading`, `priority_queue` must NOT
  SIGBUS; `std` must stay 151/151.
- Target: `.new()` resolves (the `type_trait_methods.yo` error moves past
  `Given: unit`) AND a real batch of the 132 flips, with zero regressions.

## BEGIN — progress

- **Step 1 (DONE):** diagnosed the SIGBUS via `/tmp/yo-self-dbg4` → it is
  **infinite inline-path `ArrayList` re-instantiation**, not synthesize
  recursion (see "DIAGNOSED" above). Mechanism 1 (memoize every
  instantiation) confirmed as the fix direction.
- **Step 2 (NEXT):** re-apply Stage 4a's known-tc delegation routing +
  instrument `evaluate_comptime_fn_call` to log, for `ArrayList` calls,
  **cache HIT vs MISS** and the arg signature. Goal: confirm whether the
  loop persists because (a) the gate doesn't fire (func_id unmarked at that
  point) or (b) the `(func_id,args)` cache MISSES (likely: `_ctfe_args_equal`
  treats the args as unequal each call — a `SomeT`/`type_contains_some_type`
  exact-match never matching). The fix follows from which: (a) mark earlier /
  widen the gate; (b) fix the cache-key equality so identical instantiations
  dedup (the real mechanism-1 enabler).
- **Step 3:** with the cache deduping, re-confirm `.new()` resolves +
  recursion terminates, run the full per-file diff, and only then land it.

## RESOLVED DIAGNOSIS — the knot is LAYERED (two independent bugs)

Probe builds (`/tmp/yo-self-{probe,probe2,rm,fix,base}`) over the actual knot
file `type_trait_methods.yo:130` (`_type_trait_methods = HashMap(String,
ArrayList(MethodEntry)).new()`) settled it into **two stacked layers**:

### Layer 1 — static-vs-instance method dispatch (FIXED, `function.yo`)

`HashMap(K,V).new()` is a STATIC method call (receiver is a _type_).
`_try_find_receiver_method` took the receiver's compiled **type** (`ri.ty` =
`Type`/TypeUni — the type-of-a-type) and ran the INSTANCE lookup, which can
never match any struct's impl → `recv=<non-struct>`, no method, `unit`. TS
(`function.ts:289-321`) branches on `isStaticMethodCall =
isTypeValue(receiverValue)`: for a static call it uses
`innerType = receiverValue.value` (the concrete struct) with
`getTypeTraitMethodsByNameFromEnv` and prepends **no** receiver arg.

**Fix landed in `_try_find_receiver_method`:** read the receiver's VALUE; when
it's a `TypeVal`, unwrap to the inner struct and use the static lookup
(`get_type_trait_methods_by_name_from_env`), and add `is_static` to
`ReceiverMethodResult` so the caller skips prepending the receiver. Probe
confirmed it engages (`is_static=T`, receiver corrected TypeUni→Struct).

- **Validation: std 151/151; all 170 `./tests` files pass per-file; zero
  per-file regressions vs baseline.** (`check ./tests` in _directory_ mode
  exits 139 on BOTH baseline and fix — a pre-existing cumulative-state crash,
  NOT introduced here. Validate per-file, never directory-aggregate.)
- It flips **0** yo-self files on its own — Layer 2 still blocks — but it is a
  correct, faithful, regression-free prerequisite: without it the receiver is
  TypeUni and Layer 2 could never even be attempted.

## THE FAITHFUL FIX: port TS's `recursiveTypeRef` placeholder + resolution

Tracing how TS terminates recursive-type instantiation (the thing that crashes/
hangs yo-self) pinpointed a concrete, faithful gap — NOT a fundamental
limitation:

**TS mechanism.** When a type constructor recursively references itself during
CTFE, the recursive call hits the in-progress temp cache and returns
`createUnknownValue(return.type, { variableName, recursiveTypeRef:
{functionValue, argValues} })`. Because a `variableName` is passed AND the
return is `Type` level 0, `createUnknownValue` (`value.ts:585`) promotes it to a
**`SomeType`** tagged with `recursiveTypeRef` (`definitions.ts:221`). So:

- The recursive reference is a **`SomeType` LEAF**, not a back-edge → the
  `TypeValue` stays a **finite DAG**, never cyclic. `typeToString`,
  `synthesizeTypes`, `substitute` all terminate (they hit the leaf).
- When the type is later **used as a constructor**, `resolveRecursiveTypeRef`
  (`function.ts:133`) resolves the placeholder from the now-completed cache:
  (1) exact arg-match cache entry, (2) `context.SelfType`, (3) any resolved
  entry of the same function.

**yo-self gap (two parts).**

1. The temp-cache placeholder uses bare `create_unknown_val(return_type)`
   (`comptime_fn.yo:344`) → always `UnknownVal`, never a `SomeType`. (yo-self
   HAS `create_unknown_val_with_name` which promotes to `SomeT` for `Type`
   returns — TS's behavior — but the recursion-guard site doesn't use it.) So
   the recursive reference is a non-type `UnknownVal`, the type structure isn't
   a clean finite DAG, and traversal doesn't terminate (SIGBUS in
   `type_to_string`, then hang after the depth cap).
2. No `recursiveTypeRef` tag and no `resolveRecursiveTypeRef`.

**Representation decision.** `recursiveTypeRef = {functionValue, argValues}`
where `argValues : Value[]`. yo-self's `SomeT` lives in `definitions.yo`
(TypeValue) and CANNOT hold `EvalValue` arg-values — that's a circular import
(`value.yo` → `definitions.yo`). So store it in a **side-table** keyed by the
placeholder `SomeT`'s `id`: `someT_id → (func_id : String, arg_values :
ArrayList(EvalValue))`. Lazy-init the side-table (no module-level `.new()` —
that would hit the very knot we're fixing).

**Why not "just resolve into the field".** yo-self `TypeValue` is value-
semantic (no shared objects), so resolving the placeholder INTO the field would
COPY the type and re-create the infinite expansion. The placeholder must STAY a
leaf in the type structure (keeping types finite); resolution happens LAZILY
only when the type is used as a constructor — exactly TS's contract.

**Progress.** A (`3b0c8957`) and B (`17d20dd6`) are LANDED and neutral (std
151, regressors pass without routing). **C is NOT yet viable:** re-applying the
all-type-args routing on top of A+B STILL hangs `imm_vec`. `sample`'ing the hung
process (macOS `sample <pid> 4`) showed the hot path is **string/array
building** (`concat` 442, `to_string`/`from`, ArrayList `extend`/`with_capacity`)
at SHALLOW eval depth — synthesize repeatedly stringifying a large/growing type:
`synthesis_type_id` falls to `type_to_string` for non-struct types, and with
`checked` growing it's O(n²) string-building. So the recursiveTypeRef
placeholder isn't shrinking imm_vec's structure (its recursion likely doesn't
hit the temp-cache path, or the type is genuinely large). **Next candidate
(C-prereq):** make `synthesis_type_id` use a CHEAP bounded structural key (tag +
one level of child ids) for non-struct types instead of full `type_to_string`
(TS's `checkedTypePairs` is O(1) object identity; yo-self stringifies → the
blowup). C reverted; A+B kept.

**UPDATE — C LANDED (`b0878d36`); 2b isolated.** The cheap synthesis key
(`type_to_string_key`) fixed the blowup, so the all-type-args routing now
terminates: std 151/151, `./tests` 154/154, regressors pass — all
regression-free, committed as the Layer 2 foundation. The termination wall is
solved. Remaining: `HashMap(String,X).new()` still → unit. Isolated the
`try_match` throw (cross-module `g_dbg_synth_active` flag set only for the
HashMap-shaped entry, gating the synthesizer throw probes): the TOP level now
matches (concrete stamped, cfid == pattern), but synthesize recurses into
`data : ?*(Bucket(K,V))` and throws because the **nested** concrete is
unstamped — two cases:

1. `?*(T)` is an Option-like **enum**; `EnumT` has no `constructor_func_id`, so
   the enum synthesize case throws on raw id-inequality. A `variant_names`-based
   same_constructor guard ENGAGED but is too coarse — **regressed std 151→150**
   (`std/encoding/html.yo`, false enum unification in HashMap internals).
   Reverted. Needs precise `constructor_func_id` on `EnumT`.
2. After the enum, it throws on a nested **struct** (`Bucket`) whose concrete
   side has EMPTY `constructor_func_id` — unstamped despite routing.

**Common root:** comptime_fn stamps only the TOP-LEVEL returned struct; nested
instantiations built during body eval reach synthesize unstamped. **2b =
(a) make nested instantiations get stamped (investigate why Bucket(K,V)/
Bucket(String,X) built in HashMap's body isn't routed→stamped), and (b) add
`constructor_func_id` to `EnumT` (mirror Struct; substitute preserves enum id so
a side-table keyed by id is viable; `variant_names` is NOT — too coarse).**
Substantial multi-part sub-project; foundation stands regression-free.

**Steps.**

- **A:** make the temp-cache placeholder a `SomeT` leaf (use
  `create_unknown_val_with_name` with a name derived from func_id) + record
  `(someT_id → func_id, arg_values)` in the side-table. Validate neutral at
  HEAD (std/tests), and that it (with the all-type-args routing) stops the
  imm_vec hang.
- **B:** port `resolveRecursiveTypeRef` (3 strategies) and call it where the
  placeholder `SomeT` is used as a constructor / where its concrete type is
  required (method dispatch, codegen-facing sites).
- **C:** re-apply the Layer 2 all-type-args routing on top; the recursive-type
  instantiations now terminate (finite DAG), so it should be safe; validate
  per-file (std 151, regressors, then env_lookup `.new()` resolves).

### Recursion guard FIXED (`68053176`) + Layer 2 retry (still not viable)

Per "fix the recursion guard first, then retry layer 2":

- **Recursion guard fixed & committed (`68053176`):** crash-report analysis of
  the Layer 2 SIGBUS showed it was infinite recursion in **`type_to_string`**
  (frames bottoming out in `___chkstk_darwin`), reached via
  `synthesis_type_id`'s `type_to_string` fallback when the generic-impl
  synthesize descends into a recursive type's non-struct fields. `type_to_string`
  had no cycle/depth guard. Added a depth cap (`_tts(t, _d)`, cap 40).
  **Neutral at HEAD: std 151/151, regressors imm_vec/imm_threading/
  priority_queue all pass.**
- **Layer 2 retry (all-type-args routing) — STILL NOT VIABLE, reverted again.**
  With the type*to_string guard in place, re-applying the all-type-args
  routing no longer SIGBUSes — but `imm_vec` now **HANGS** (infinite loop, no
  stack growth; killed after 3+ min). So the guard only removed the
  stack-overflow \_site*; the underlying non-terminating recursion in the
  synthesize/memoization of recursive-type instantiations persists, just
  manifesting as a hang instead of a crash. Diagnostics ruled out the obvious
  suspects: comptime-fn recursion is finite (~710 calls), and `_synthesize_call`'s
  per-`checked` depth never exceeds ~1200 (the cross-entry re-entrancy uses
  fresh `checked` lists). The loop is a non-stack-growing cycle (likely
  try_match → synthesize → trait-constraint check → find_matching_generic_impl
  → try_match, each re-instantiating). **Conclusion: the all-type-args routing
  is too broad — it routes recursive-type instantiations onto the memoized path
  where they don't terminate. Layer 2 needs a narrower stamping approach that
  does NOT route recursive types through memoization (or a proper cross-entry
  cycle guard on the try_match/trait-check path).** Reverted; only the
  type_to_string guard landed.

### Layer 2 — generic-impl match of the instantiation struct (earlier attempt, reverted)

**Probe chain (5 builds) pinpointed the exact mechanism and the wall:**

1. With Layer 1, the static lookup reaches the concrete `HashMap(String,X)`
   struct, but a `[L2]` probe in `find_methods_from_generic_impls` showed it
   has **empty `constructor_func_id`** while all three `new`-defining impl
   patterns ARE stamped (`cfid=yo_id_2853/1950/1791`). So `same_constructor3`
   (synthesizer Struct case) is false → throw → no match → `unit`. **P1 = the
   concrete is unstamped.**
2. **Attempt:** route every FuncVal call whose arguments are ALL type values
   (`all_args_are_types` — a robust type-constructor signal independent of the
   mis-specialized return) through `evaluate_comptime_fn_call`, and widen
   `should_cache` likewise, so each instantiation is MEMOIZED (stable id) and
   STAMPED. Probe confirmed it WORKS at the top level: the concrete then
   carries `cfid=yo_id_2677`, matching the HashMap pattern's `cfid=yo_id_2677`
   → `same_constructor3` true.
3. **But two blockers remained, so it was reverted:**
   - **(2b) nested unstamped struct.** `[L2T]`/`[L2S]` probes: the top-level
     match now recurses into fields, and `HashMap`'s `data : ?*(Bucket(K,V))`
     field synthesizes `Bucket(K,V)` vs a nested `Bucket(String,X)` concrete
     that is STILL unstamped (`cfid` empty) → field-level throw → `.new()`
     still `unit`. The top-level routing doesn't reach nested type-constructor
     instantiations built during the body eval.
   - **(2c) SIGBUS regression.** The same all-type-args routing moves the
     recursive-type instantiations of `imm_vec`/`imm_threading` onto the
     memoized comptime path, where the temp-cache recursion guard fails to
     terminate them → `rc=138`. (std stayed 151/151, but the regressors crash.)

**Conclusion (confirmed empirically):** Layer 2 is genuinely coupled to P2
(recursion termination). Stamping the concrete (P1) is necessary AND achievable
via routing, but the SAME routing (a) misses nested generics and (b)
re-triggers the recursive-generic SIGBUS through the comptime path's
insufficient recursion guard. The clean fix requires repairing the
comptime-path recursion guard (temp-cache `_ctfe_args_equal` apparently fails
to catch the recursive re-instantiation) and/or recursively stamping nested
instantiations — the hard architectural work that ~8 prior attempts hit. Layer
1 stands committed; Layer 2 reverted to keep the regressors green. **Next: fix
the `evaluate_comptime_fn_call` recursion guard FIRST (so routing recursive
types is safe), THEN re-apply the all-type-args routing + add nested stamping.**

### Layer 2 (original framing) — generic-impl match of the instantiation struct

With Layer 1, the static lookup now correctly receives the concrete
`HashMap(String, ArrayList(MethodEntry))` struct, but
`get_type_trait_methods_by_name_from_env` → `find_methods_from_generic_impls`
→ `try_match_generic_impl` (`impl.yo`) still returns **0** candidates: the
`synthesize_types(receiver pattern `HashMap(K,V)`, concrete struct)` can't
identify the fresh-random-id instantiation as a `HashMap`. This is the
ORIGINAL funcId knot (P1/P2): the instantiation lacks the
`constructor_func_id`/name identity for synthesis to unify it with the impl
pattern. The committed foundation (`constructor_func_id` + synthesizer guard)
targets exactly this but is not yet effective on the generic-impl-match path,
and enabling same-constructor recursion there is what previously SIGBUS'd —
so Layer 2 is coupled to the recursion-termination work and must be done
under supervision (it can crash the whole corpus if unbounded).

**Next session:** land Layer 1 (verified safe), then attack Layer 2 by making
`try_match_generic_impl`'s synthesis recognize same-constructor
instantiations via `constructor_func_id` WITH a terminating cycle guard
(object-identity-equivalent), validating per-file each step against the
`imm_vec`/`imm_threading`/`priority_queue` SIGBUS regressors.

_(ENV: `bun` drops from PATH; `BUN=/nix/store/*-bun-1.3.3/bin/bun`. Build
loop ~5 min; classify by exit code, per-file diff, not aggregate.)_
