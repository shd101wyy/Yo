# Scope: structural-gate tests (5 of the 18 ./tests fails)

All 5 fail identically — `comptime_expect_error(...)` expects a compile error,
but yo-self evaluates the construct successfully (the rejection gate doesn't
fire). **⚠️ CORRECTION (2026-06):** the original claim that "all are standalone
type/impl-level checks — NOT behind the def-time-body-eval wall" is WRONG.
A gate is tractable now ONLY if its rejectable construct fires at MODULE level
(a definition's param/return/field TYPE position, or a module-level begin
block). Any gate whose construct sits in a FUNCTION BODY is wall-blocked,
because yo-self's `check` does not evaluate fn bodies. Notably
`extern_unsafe_wrap` (unwrapped extern call inside a fn body) IS wall-blocked —
see its entry below. The remaining tractable (module-level) gates are
`safe_code_structural_gates` (its cases are definitions/begin-blocks, not
bodies), `sync/mutex` (`Mutex(NonSendObj)`), and `thread_safety`
(`Iso(Arc(T))` nesting ban) — all evaluated at module scope.

Two independent sub-clusters.

## Cluster A — raw-pointer-in-safe-code (LOW risk, cleanest)

Tests: `safe_code_structural_gates`, `extern_unsafe_wrap`.
Repro: `takes_ptr :: (fn(p : *(i32)) -> i32)(...)`, `(fn(s : *(char)) -> usize)(strlen(s))`
— a raw pointer type `*(T)` (or `&(x)` address-of) named in a file WITHOUT
`pragma(Pragma.AllowUnsafe);`. "Phase C structural gates" (plans/MEMORY_SAFETY.md).

**TS gates (both use `isImplicitlyUnsafeCapableFile`):**

- `calls/pointer.ts:75-86` — evaluating a `*(T)` TYPE throws
  `Raw pointer types ('*(...)') are not available in safe code` when
  `!context.unsafeContext && !isImplicitlyUnsafeCapableFile(modulePath)`.
- `exprs/_expr.ts:1237-1248` — the `&+`/`&-`/`&/` (and `&(x)` address-of) gate,
  same condition.

**yo-self status:** `is_implicitly_unsafe_capable_file` IS ported
(`evaluator/memory_safety.yo:97`) and `ctx.unsafe_context` exists, but the gates
are NOT wired: `calls/pointer.yo`'s `evaluate_raw_pointer_call` has no pragma
check (only `builtins/unsafe.yo` checks it, for `unsafe(...)`).

**Fix:** add the gate to `evaluate_raw_pointer_call` (pointer.yo) — mirror
pointer.ts:75-86 — and the address-of/`&+`/`&-` gate to the matching yo-self
site (port of \_expr.ts:1237). Both are ~6-line guards using already-ported
helpers.

**Why low-risk:** the gate fires ONLY in non-`pragma` files. std/ and yo-self/
declare `pragma(Pragma.AllowUnsafe);` (and use `*(T)` pervasively), so they're
unaffected; only safe user files (the test fixtures) start rejecting. Validate
per-file anyway (a stray non-pragma std file using `*(T)` would surface).

## Cluster B — Send / negative-impl (MEDIUM risk)

Tests: `negative_impl`, `thread_safety`, `sync/mutex`.
Repros:

- conflict: `impl(ConflictType, Send()); impl(ConflictType, !(Send))` → must reject.
- standalone negative (must still WORK): `impl(MySendStruct, !(Send()))` overrides
  auto-derive so the type no longer counts as Send.
- `Mutex(NonSendObj)` where `Mutex(T)` has `where(T <: Send)` → must reject.

**TS mechanism:** `values/impl.ts:270-300` — a `negativeImplRegistry`
(`Set<"typeId:traitTypeId">`) + `negativeGenericImplRegistry`. `impl(T, !(Trait))`
registers a negative entry; Send/Acyclic derivation and the
positive+negative conflict check consult it; `Mutex(T)`'s `where(T <: Send)`
fails because `type_implements_send(NonSend)` returns false (negative or
non-derived).

**yo-self status:** `values/impl.yo` has NO negative-impl registry (grep: none).
So `impl(T, !(Send))` is inert → no conflict detection, no auto-derive override.

**Fix:** port the negative-impl registry + registration (impl.ts:270-300) into
`impl.yo`; wire the conflict check (positive+negative for same type/trait →
throw) at impl registration; make `type_implements_send`/`type_implements_acyclic`
(trait_checking.yo) consult the negative registry; verify `Mutex`'s
`where(T <: Send)` is actually enforced at instantiation (apply_where_clause
constraints + type_implements_send). Broader: touches impl registration + Send
derivation + where-clause enforcement, and the standalone-negative positive
cases must keep working.

## ⚠️ COMMON ROOT (discovered 2026-06): `comptime_expect_error` is DISABLED

ALL 5 gate tests (and the flowability tests `ref_flowability`/`slice_flowability`)
wrap the expected rejection in `comptime_expect_error(...)`. But yo-self's
`evaluate_comptime_expect_error` (builtins/comptime_expect_error.yo) has its
inner exception handler REMOVED (header comment lines 9-14: disabled because the
TS codegen building yo-self-bin "cannot pass given bindings via exn_x — the
unwind handler cannot access outer function parameters"). It evaluates the arg
with the NON-RAW `evaluate_expression` (which catches+prints+swallows any error)
and then ALWAYS throws "Expected compile error, but the expression was evaluated
successfully". So it can NEVER detect an error → every `comptime_expect_error`
case fails regardless of whether the underlying gate fires.

**This is the gating prerequisite for the whole cluster.** No gate test can flip
green until `comptime_expect_error` actually CATCHES the arg's error. Fix:
evaluate the arg via `evaluate_expression_raw` (which DOES take an `exn`) wrapped
in a LOCAL unwinding `Exception` — the pattern `try_populate_expr_info_table`
(main.yo) uses successfully (`Exception(throw : ((_e) -> unwind(...)))`), which
compiles fine, sidestepping the codegen limitation that disabled the original
handler. If the raw eval throws → caught → error occurred → return unit; else →
throw "evaluated successfully". This is the documented trial-eval-swallow fix
(memory `yo-self-test-trial-eval-swallow`).

## Progress (2026-06)

- [x] **Eval-time pragma registration** (pragma.ts:113-116) — committed
      (d1ac577d). yo-self had NO `register_file_pragma` callers (only the
      SkipPrelude pre-scan), so `AllowUnsafe` was never registered and
      `is_implicitly_unsafe_capable_file` was globally false. Added `evaluate_pragma`
  - the `pragma(...)` dispatch in `_expr.yo`.
- [x] **Phase-C raw-pointer-type gate** (pointer.ts:75-86) — committed. `*(T)`
      in safe code now rejected; prelude (pragma'd) exempt. std 151→151, tests
      164→164, 0 regressions. Does NOT flip a test yet (blocked by the
      comptime_expect_error common root above).
- [x] **Fixed `comptime_expect_error`** (the common root) — committed 2bc49fe5
      (local unwinding exn + `evaluate_expression_raw`, clones the arg). It now
      DETECTS errors. tests 164→165 (`ref_return` flipped), std/yo-self 0 regressions.
      Detection is no longer the blocker; each remaining test now just needs its
      underlying gate to FIRE.
- [x] **safe_code_structural_gates — DONE** (commit 8cd68d48). Ported the
      Phase-C address-of `&(x)` gate (ptr_fns.yo `evaluate_address_call`,
      ptr-fns.ts:45-61): `&(expr)` in safe code → reject. This was the LAST
      missing gate — its other cases (raw-ptr types d1ac577d, unsafe/asm/extern/
      c_include already ported, Send-pragma e0d7fda9) fired already. The two
      `&+` and `*(U)(p)`-cast cases both open with `p := &(x)`, so address-of
      fires first (matching TS eval order). tests 167→168, 0 regressions.
      **Faithfulness follow-up:** the standalone `&+`/`&-`/`&/` pointer-arith
      gate (\_expr.ts:1237) + the inner `__yo_ptr_add/_sub/_diff` builtin gate
      are NOT ported — yo-self `_expr.yo` has no `&+` dispatch branch (routes
      through the prelude `&+` impl), so it needs a new dispatch branch. Dead in
      safe code now that `&(x)` is gated, but worth porting for parity.
- [ ] **Extern-call-requires-unsafe gate** (extern_unsafe_wrap — a SEPARATE gate
      from the raw-ptr-type one; calling an `extern "c"` fn without `unsafe(...)`).
      ⚠️ **CORRECTION (2026-06): this test is BEHIND THE DEF-EVAL WALL, not a cheap
      win.** Its negative case `bad_unwrapped :: (fn(s : *(char)) -> usize)(strlen(s))`
      puts the unwrapped extern call in a FUNCTION BODY. yo-self's `check` does NOT
      evaluate fn bodies (verified: the def reports "evaluated successfully" — the
      body `strlen(s)` is never reached), so the gate could be ported faithfully and
      still never fire here. Additionally, the faithful port requires `is_extern` on
      the `Func` TypeValue variant (TS `FunctionType.isExtern`) — yo-self's Func
      carries no such field (extern.yo:178 / c_include.yo:174 explicitly skip it as
      "codegen-only"). So this needs (a) the Func-variant `is_extern` field AND (b)
      def-time body eval. Reclassified: WALL-BLOCKED. The earlier "NOT behind the
      wall" claim at the top of this doc is wrong for any gate in a fn body.
- [x] **thread_safety — DONE** (commit 516ecf61). Ported the Phase-H
      `Iso(Arc(T))` ban (iso.yo `evaluate_iso_type_call`: child is_atomic_object +
      has `*` deref field → reject) and `Arc(Iso(T))` ban (struct.yo
      `evaluate_struct_type`: atomic-rc struct whose `*` field is_iso_type →
      reject). Both predicates were already ported; only the call-site checks were
      missing. thread_safety's earlier `impl(ConflictType, Send())` case already
      fired via the Send-pragma gate from e0d7fda9. tests 166→167, 0 regressions.
- [x] **Cluster B negative_impl — DONE** (commit e0d7fda9). Ported the 3-gate
      cluster into impl.yo: negative-impl registry (g_negative_impl_registry +
      has_negative_impl/register_negative_impl), negative detection + marker-only
      check (reject !(trait-with-methods); register marker negatives), and the
      Send-requires-pragma gate (impl(..., Send()/Acyclic()) without
      pragma(Pragma.AllowUnsafe) → reject). tests 165→166, std 151/151, yo-self
      337/338, 0 regressions. Still TODO in this family: `thread_safety`,
      `sync/mutex` (the Mutex(T) `where(T <: Send)` enforcement path).
- [ ] **Cluster B (cont.)** — bigger than "a conflict gate" (investigated 2026-06).
      `negative_impl.test.yo` (NO pragma) needs a MULTI-GATE cluster, because its
      `comptime_expect_error` cases each error via a DIFFERENT gate:
  - **negative-impl detection** (impl.ts:827-866): recognize `impl(T, !(Trait))`,
    register it, and do NOT error on standalone marker negatives
    (`impl(MySendStruct, !(Send()))` must succeed). yo-self currently silently
    accepts `!(Send())` as a no-op (verified) — close, but no registry.
  - **marker-only check** (impl.ts:3000-3015): `!(Trait-with-methods)` → reject.
    Handles the `!(Clone)` and `!(MyHandler)` cases.
  - **the conflict case** `impl(X, Send()); impl(X, !(Send))` errors in TS via the
    **Send-requires-pragma gate** — `impl(..., Send())` manually requires
    `pragma(Pragma.AllowUnsafe)` + a `// SAFETY:` comment (verified by running TS
    on a bare `impl(X, Send())` → "Manual 'impl(..., Send())' requires
    pragma..."). yo-self lacks this gate entirely. (The positive↔negative
    conflict gate at impl.ts:2827 `hasNegativeImpl` only catches negative-THEN-
    positive; the test is positive-then-negative, so the Send-pragma gate is
    what fires.)
  - `Type.impls(..., Send) == false` asserts are `comptime_assert` → vacuous
    (lenient) → don't strictly require the negative registry to be consulted.
    `thread_safety` + `sync/mutex` are the same Send family (conflict +
    `Mutex(T)`'s `where(T <: Send)`). Net: negative_impl ≈ 3 faithful gate ports
    (negative detection + marker-only + Send-requires-pragma). A focused
    feature-sized effort, not a one-liner.

## sync/mutex — precise blocker (investigated 2026-06)

`Bad :: Mutex(NonSendObj)` must reject because `Mutex :: (fn(comptime(T) :
Type, where(T <: Send)) -> comptime(Type))` and `NonSendObj :: object(...)` is
not Send. This fires at MODULE level (not behind the def-eval wall) — tractable
in principle — but it is NOT a simple "call the existing function" wiring:

- The validation fns ARE ported: `validate_concrete_type_constraints` +
  `apply_where_clause_constraints` (function.yo:1229-1495), and
  `type_implements_send` / `type_implements_trait_bool` (trait_checking.yo:685).
- BUT `apply_where_clause_constraints` operates on constraint **AST exprs**
  (it re-evaluates `lhs_expr`/`trait_expr`), and the `Func` TypeValue variant
  stores only **evaluated** `where_types : ArrayList(TypeValue)` — the original
  `where(T <: Send)` exprs are collected locally in
  `evaluate_function_type` (function.yo:2583-2604, into `where_clause_exprs`)
  and DISCARDED after `prepare_where_clause_variables` runs. The general call
  path (helper.yo:1425) also discards `where_types` (`_ := wt;`).
- **The constraint is NOT lost, though** — `prepare_where_clause_variables`
  encodes it as the `comptime(T)` param's `SomeT.required_trait_types = [Send]`
  (function.yo:3396-3410 reads these back into `where_types`). So the faithful,
  representation-matching fix is: **at the comptime-fn binding step** (where a
  concrete type arg binds to a `comptime(T)` SomeT param — `calls/comptime_fn.yo`
  / `builtins/comptime_fn.yo:295`), check the bound concrete type against that
  param's `required_trait_types` via `type_implements_trait_bool`, throwing the
  ported error (function.yo:1381 "does not implement required trait").
- **Risk (why deferred): Send-derivation completeness.** This adds a reject on
  the HOT comptime-type-constructor call path. If any type that SHOULD be Send
  is not derived as Send by `type_implements_send` (auto-derive gaps), valid
  std/tests code using `Mutex(T)`/`Arc(T)`/etc. starts wrongly rejecting →
  broad regressions. MUST validate per-file across std(151)/tests/yo-self and
  revert on ANY regression. Scope before implementing: audit
  `type_implements_send` auto-derive against the std types passed to Mutex/Arc.

### Send-derivation AUDIT — conclusion (2026-06)

Audited before attempting the fix. **Send-derivation is NOT the blocker; the
where-clause subject→bound plumbing is.** Findings:

1. **`where(... Send)` is pervasive** — `*(T)`/`Array`/`Slice`/`Arc` Send impls
   (prelude:5500-7631) and especially `std/imm/map.yo` puts
   `where(K <: (Eq, Hash, Send), V <: Send)` on _dozens_ of functions. So
   enforcement touches a wide surface, not just Mutex.
2. **But the realistic regression surface during `check` is SMALL.** yo-self's
   `check` does not evaluate fn bodies, so the where-clause only ever fires at
   MODULE-LEVEL concrete type-constructor instantiations. A sweep of std found
   essentially NONE at module level (all `Arc(...)`/`Mutex(...)`/imm-map calls
   live inside fn bodies; `Type.impls(X, Send)` ground-truth asserts in
   `tests/basic.test.yo:263-285` are inside `test{}`/`comptime_assert` →
   not-evaluated/vacuous). So Send auto-derive completeness is unlikely to bite
   during `check`.
3. **The real blocker is representation.** `evaluate_comptime_fn_call`
   (calls/comptime_fn.yo:310) collects a FLAT `all_arg_vals` and never
   cross-references constraints. The Func type's `where_types` is a flat trait
   list with **no subject** (definitions.yo:81). The subject→bound info DOES
   exist on the type-var's `SomeT.required_trait_types` (set by
   `prepare_where_clause_variables`, function.yo:399-405), but
   `evaluate_comptime_fn_call` doesn't map each comptime type-param's SomeT to
   its bound arg value. Faithful enforcement therefore needs the param↔SomeT↔arg
   linkage threaded through the comptime-call path (and ideally the general call
   path too) — a **feature-sized integration**, not a surgical gate add.

**Verdict:** safe on risk (Send-derivation adequate, small check-time surface),
but the work is plumbing the constraint-subject linkage into
`evaluate_comptime_fn_call` (call each comptime type-param's
`SomeT.required_trait_types` through `type_implements_trait_bool` against the
bound arg, throwing function.yo:1381's "does not implement required trait").
Deferred pending that dedicated integration — NOT blocked by Send derivation.

### Implementation ATTEMPT + REVERT (2026-06)

Tried the side-table approach: a func*id-keyed `g_where_clause_exprs_registry`
(function_value.yo) populated in `evaluate_function_type` (keyed by the `fn(...)`
type-expr id) and re-keyed to the FuncVal id in
`try_to_implement_function_by_function_type` (function_type.yo) via
`copy_where_clause_exprs` — exactly mirroring the existing
`register_func_param_defaults`/`copy_func_param_defaults` infrastructure (this
re-key was NECESSARY: the FuncVal id the call site sees is `random_id()`'s bare
`yo_id_N`, NOT anonymous_function.yo's `fn*<id>`— verified via trace). Then in`evaluate_comptime_fn_call`, `get_where_clause_exprs(func_id)`+`apply_where_clause_constraints(exprs, callee_env, ctx, exn)`.

**Result: REVERTED.** The side-table wiring worked (the registry hit at call
time), but **blindly re-applying `apply_where_clause_constraints` at every
comptime-fn call breaks pervasively**: it fired on prelude where-clauses (e.g.
`where(K <: (Eq, Hash, Send))`) and the RHS mis-resolved — error
`Type <struct:...> does not implement required trait (id : comptime_string)`
and `Expected trait type for right-hand side of where clause constraint`. Root:
`apply_where_clause_constraints` / `parse_where_clause_constraints` were built
for DEFINITION-time eval (type-vars are SomeTs); re-running them at call-time in
`callee_env` (type-vars bound to concrete values) changes the LHS/RHS evaluation
semantics. ALL positive where-bearing tests (arc, imm_list, imm_map, basic,
thread_safety, channel) regressed to errors.

**TS does NOT apply it blindly.** `applyWhereClauseConstraints` is called at
GUARDED points in `helper.ts`: line 1374-1404 only when _all_ where-clause LHS
types are forall params already bound in `calleeEnv`, and re-applied at
1494-1507 after arg processing. The faithful fix is to port those GUARDED call
sites into yo-self's general call path (`helper.yo`, which currently discards
`where_types` at :1425) with TS's exact conditions — a substantial, careful
change to the hot path, NOT the side-table + blind re-eval I tried. The
side-table is the right storage mechanism; the missing piece is replicating
TS's _when-to-apply_ guards. Deferred as a dedicated effort.

### Implementation ATTEMPT #2 — faithful call-site placement (2026-06)

Re-did it faithfully per the above: placed the re-application at the comptime
type-constructor call site in `calls/function.yo` (inside the
`is_type_hierarchy_type || callee_result_is_comptime || all_args_are_types`
routing block, just before `evaluate_comptime_fn_call`), using `fresh_env`
(which DOES have all params bound — forall at :1236, regular at :1281+, so
`T → NonSendObj` is bound there), AND setting **`ctx.is_evaluating_function_type
= true`** around the call — the exact context flag TS sets at helper.ts:1399/1503
and the one attempt #1 omitted. Side-table re-keyed to the FuncVal id as before.

**Result: REVERTED — same failure.** The flag had ZERO effect on the error:
`Type <struct:struct_yo_id_34> does not implement required trait
(id : comptime_string)` still fired pervasively (struct_34 is early-prelude; ALL
of arc/basic/imm_list/imm_map/thread_safety/channel regressed). Diagnosis: the
error is thrown at function.yo:1382 AFTER `is_trait_type(tv)` returned TRUE
(else it throws at :1355) — so `tv` IS a trait, but `type_to_string(tv)` prints
`(id : comptime_string)`. I.e. re-evaluating the constraint RHS expr via
`evaluate_expression_raw` at the bound call-time env produces a WRONG trait
TypeValue for many functions. **The blocker is not placement and not the
context flag — it is that `apply_where_clause_constraints` /
`validate_concrete_type_constraints` mis-resolve the constraint RHS when
re-evaluated at call time.** That is a porting bug in those routines'
call-time evaluation semantics, needing dedicated tracing (which fn, which
constraint, why `tv` prints `(id : comptime_string)`).

**Better next path (avoids RHS re-eval entirely):** don't re-evaluate the where
EXPRS at all. The constraint bounds are ALREADY evaluated and stored on the
type-var's `SomeT.required_trait_types` (function.yo:399-405; read back into
`Func.where_types` at function.yo:3396 by iterating `forall_params`). So at the
comptime call site, iterate the callee `Func`'s forall/type params; for each
whose type is a `SomeT` with `required_trait_types`, look up the bound concrete
value in `fresh_env` by the param label and call
`type_implements_trait_bool(concrete, trait)` directly — no expr re-eval, no
RHS mis-resolution.

**…but that assumption is FALSE (verified statically 2026-06).** A
`comptime(T) : Type` param (Mutex uses `comptime`, NOT `forall`) is added to the
ENV as a fresh `SomeT` (`t_some_t(info.name, frame_level)`, function.yo:2543-2570)
and tracked in `pre_added_indices` — it is NOT pushed into `forall_params`.
`prepare_where_clause_variables` then attaches `Send` to THAT env SomeT's
`required_trait_types`, which is a DEFINITION-TIME env binding, gone by call
time. And `Func.where_types` is collected by iterating `forall_params`
(function.yo:3396), so for a `comptime(T)` param it is likely EMPTY. Net: for
comptime type-constructors, the subject→bound linkage is persisted NOWHERE on
the Func — neither in `where_types` (empty) nor recoverable from
`forall_params`. So BOTH paths (re-eval exprs; read forall SomeT bounds) are
blocked.

### Targeted DIAGNOSTIC (2026-06) — root cause isolated

Re-applied attempt #2's wiring but put `validate_concrete_type_constraints` in
**trace-and-continue** mode (eprintln the `(rhs, tv, concrete, impl)` tuple,
suppress all throws) so ONE `check ./tests/sync/mutex.test.yo` captured every
constraint check. Findings (decisive):

1. **The `(id : comptime_string)` was a RED HERRING — purely cosmetic.** BOTH
   `Send` and `Comptime` marker traits `type_to_string` as `(id : comptime_string)`
   (marker-trait rendering, no name). The traits resolve CORRECTLY; there is NO
   RHS mis-resolution. (Attempt #2's diagnosis was wrong on the mechanism.)
2. **The Mutex case WORKS:** trace shows
   `rhs=Send tv=(id : comptime_string) concrete=<struct_yo_id_2012=NonSendObj> impl=false`
   — enforcement would correctly REJECT `Mutex(NonSendObj)`. The plumbing
   (side-table + call-site application + `type_implements_trait_bool`) is sound.
3. **The REAL regression source: `where(T <: Comptime)`.** 67 such constraints
   in std (`ComptimeAdd`, `ComptimeIndex`, the comptime operator/index traits,
   prelude:258-350+). Trace: `rhs=Comptime` yields `impl=true` for primitives
   (i32, usize, f64, comptime_int, comptime_string, Expr, bool, …) but
   `impl=false` for user structs (`struct_yo_id_34`, `_37`). So call-time
   enforcement of these pervasive constraints REJECTS struct args, aborting
   before the Send check matters → arc/basic/imm_list/… regressed.

So enforcement is NOT blocked by plumbing or Send-derivation. It is blocked by
ONE of: (a) yo-self's `type_implements_trait_bool(<struct>, Comptime)` returns
false where TS's `typeImplementsTrait` returns true (a Comptime auto-derive
parity gap — `_all_fields_implement_comptime`, utils.yo:143), OR (b) yo-self's
comptime-type-ctor call routing (`all_args_are_types` etc., function.yo:1446)
fires where-enforcement on calls TS would NOT re-check (over-broad scope vs TS's
single general-path application at helper.ts:1494). Distinguishing (a) vs (b)
needs a TS-side trace of whether `ComptimeIndex`/`ComptimeAdd` re-apply
`where(T <: Comptime)` for these same structs and what `typeImplementsTrait`
returns there. NEXT STEP if resumed: instrument the TS `validateConcreteType
Constraints` (function.ts:1500-1599) on the same fixture and compare the
`(rhs, concrete, implemented)` tuples to the yo-self trace above.

### TS-SIDE TRACE (2026-06) — SETTLED: it's (b), and there is NO TS bug

Instrumented TS `validateConcreteTypeConstraints` (function.ts:1572) with the
same tuple trace and ran `./yo-cli check ./tests/sync/mutex.test.yo` (./yo-cli
runs `bun run src/yo-cli.ts` — TS source directly, no build). Comparison to the
yo-self trace:

- `Send` vs `NonSendObj`: TS `impl=false` — MATCHES yo-self. Send works in both.
- `Comptime` vs primitives (comptime_int/usize/i32/…/Range/Expr): TS `impl=true`,
  same counts as yo-self. MATCHES.
- **`Comptime` vs USER STRUCTS: TS NEVER checks them.** Every TS `Comptime` line
  is against a primitive/Range/Expr; there is NO `Comptime concrete=<struct>`
  line. yo-self has 2-3 EXTRA `Comptime concrete=<struct_yo_id_34/_37> impl=false`
  checks that TS does not perform → that's the over-rejection.
- TS trait names render correctly (`Comptime`, `Send`, `ComptimeNegate`); the
  yo-self `(id : comptime_string)` is purely a `type_to_string` cosmetic gap.

**Conclusion: case (b). NO TypeScript-side bug** — TS is correct & self-consistent
(only checks `Comptime` against types that satisfy it; the LHS for the struct
cases evidently stays a generic `SomeT` in TS so `validateConcreteTypeConstraints`
is never reached, taking the SomeT branch of `parseWhereClauseConstraints`
instead). yo-self's divergence: at the comptime-type-ctor call site the
constrained type-param RESOLVES TO A CONCRETE STRUCT where TS keeps it a `SomeT`,
so yo-self enters the concrete-validate path and rejects. The enforcement scope
is otherwise identical (primitive counts match) — only these 2-3 struct cases
diverge.

### OVER-CONCRETIZATION TRACE (2026-06) — TRUE ROOT FOUND, revises (b)→(a)

Re-instrumented with the constraint string + LHS resolution + path tags. Result
(`check ./tests/sync/mutex.test.yo`, traces stderr):

- The over-rejection is `constraint="Idx <: Comptime" concrete=<struct:struct_yo_id_34>
impl=false` and `<struct_yo_id_37> impl=false` — `Idx` is `ComptimeIndex`'s
  index-type param.
- TS's trace for the SAME `Comptime` constraint checks `Range(usize) impl=true`
  and `RangeInclusive(usize) impl=true`. **`struct_34`/`_37` ARE
  yo-self's `Range(usize)`/`RangeInclusive(usize)` instantiations** (used as the
  `Idx` of `ComptimeIndex` for slice indexing). So this is NOT case (b)
  (over-broad scope) — TS performs the identical check. It is **case (a): yo-self
  derives `Range`/`RangeInclusive` instantiations as NON-Comptime where TS derives
  them Comptime.**
- Two corroborating symptoms of the same root: yo-self renders these structs with
  EMPTY NAMES (`<struct:struct_yo_id_34>`) vs TS's `Range(usize)`; and zero
  `WHERE-LHS` hits (the validate came via `apply_single_trait_constraint`'s
  atom-lookup path, function.yo:1411, finding `Idx` bound to the concrete
  range-struct).

**TRUE ROOT (a real yo-self correctness bug, currently latent):** trait markers
(`Comptime`/`Send`/`Acyclic`/`Runtime`) are auto-derived at struct DEFINITION time
(`auto_derive_traits_for_struct_type`, called from `evaluate_struct_type`) with the
generic `SomeT` field types, and are NOT re-derived when a generic struct is
INSTANTIATED with concrete args via a comptime type-constructor (`Range(usize)`).
At definition `Range`'s fields are `SomeT(T)` (unconstrained → not Comptime), so
`Comptime` is never registered; after `T→usize` the marker is never re-derived.
TS derives `Comptime` for the concrete instantiation. The empty struct name is the
same gap (the instantiation isn't fully stamped with name + re-derived markers).

**Fix scope (newly precise, but a new sub-feature):** when a comptime
type-constructor produces a struct instantiation (the `constructor_func_id` /
`type_arguments` stamping path in `evaluate_comptime_fn_call` / the synthesizer),
re-run `auto_derive_traits_for_struct_type` against the now-CONCRETE field types
(and set the proper name). Then re-apply the where-enforcement plumbing (attempts
#1/#2, confirmed correct for the Send case). Risk: touches the hot comptime-fn
instantiation/stamping path; validate per-file. This is a yo-self bug fix, NOT a
TS fix (no TS bug) and NOT a where-plumbing issue (plumbing works). The Send
rejection of `Mutex(NonSendObj)` is already confirmed correct.

### TRAIT-RE-DERIVATION TRACE (2026-06) — BEDROCK ROOT: trait values are NAMELESS

Instrumented `auto_derive_traits_for_struct_type` (AUTODERIVE),
`type_implements_comptime_builtin` (CTB-STRUCT), and `type_implements_trait`
step 4 (REG-CHK), all with the where-enforcement plumbing live. For
`struct_yo_id_34` (= `Range(comptime_int)`, the `Idx` of `ComptimeIndex`):

- `AUTODERIVE id=struct_yo_id_34 comptime=true` — Comptime auto-derive DOES run.
- `CTB-STRUCT id=struct_yo_id_34 is_ref=false` — value struct;
  `type_implements_comptime_builtin` returns `.None` (correctly falls through, no
  early return). So Comptime IS registered (auto-derive gates on `!is_ref`, and
  it's a value struct).
- **`REG-CHK` did NOT fire for struct_34** — and it's guarded by
  `trait_name == "Comptime"`. So `_trait_type_name(trait_type)` returns EMPTY,
  and step-4's `if(!type_id.is_empty() && !trait_name.is_empty())` guard
  (trait_checking.yo:359) is false → **the registry lookup is SKIPPED entirely**
  → returns false, despite Comptime being registered for struct_34.

**Bedrock root:** yo-self creates ALL trait values with an EMPTY name
(`trait_name_str := String.from("")`, types/trait.yo:1097) — the name from the
`Comptime :: trait(...)` binding is never stamped onto the `TraitT`. Same for
structs (all render `<struct:id>`). So `_trait_type_name` is always empty, and
the name-keyed auto-derive registry (`g_type_trait_registry`, keyed
`(type_id, trait_NAME)`, trait_checking.yo:69) is a DEAD PATH at lookup. It's
latent because primitives/objects resolve via the builtin fast-paths (steps 1-2)
and `Type.impls` is vacuous; only value-struct auto-derived markers (Range's
Comptime) need the registry — and that only surfaces once where-enforcement is
wired.

**This is also a yo-self↔TS architectural DIVERGENCE.** TS `typeImplementsTrait`
step 4 (trait-checking.ts:395-430) does NOT use a name-keyed registry — it
iterates `targetType.trait.fields` (the derived traits carried ON the struct)
and matches by `areTypesCompatible` (id/structural), never by name. The yo-self
name-keyed `g_type_trait_registry` is a deliberate, documented simplification
("folded from trait_registry.yo", trait_checking.yo:58-67) whose lookup premise
("TS compares traits by name", :150) is inaccurate AND broken (names empty).

**Fix options (a design decision — foundational, NOT gate-sized):**

1. **Stamp type names from `::` bindings** (most faithful: TS effectively names
   types). Broad blast radius — rendering (`<struct:id>`→`Range`), comparisons.
2. **Resolve marker-trait names by id in step 4**: auto-derive only registers a
   FIXED marker set (Send/Comptime/Acyclic/Runtime/Rc/Dispose); map `trait_type`
   → canonical name by comparing its id against the env marker traits (the way
   steps 1-2 already match Comptime/Runtime). Surgical; makes the existing
   name-keyed registry correct for markers without broad name-stamping.
3. **Port TS's `struct.trait.fields` + type-compat approach** (largest;
   structs/enums would carry their derived traits as trait-value fields).

Recommended next: option 2 (smallest, contained) — then re-apply the where
plumbing and validate per-file. The whole chain is now resolved end-to-end;
this is the single remaining link.

### IMPLEMENTATION (2026-06) — two fixes landed; one derivation layer remains

- **Option 2 — DONE** (commit 0519e25b): `_resolve_registered_trait_name` maps a
  nameless marker trait → its registry name by matching id against env Send/
  Comptime/Acyclic/Runtime/Rc; step-4 registry lookup now works for value
  structs. std 151, tests 168, yo-self 337/338, 0 regressions.
- **Send/Acyclic builtin fast-paths — DONE** (commit b4080e8b):
  `type_implements_send_builtin` / `type_implements_acyclic_builtin` recognize
  primitive/comptime-data leaves as Send/Acyclic (yo-self primitives have no id
  for the registry and TS carries this on every type's `.trait`). Wired as steps
  2a/2b. std 151, tests 168, yo-self 337/338, 0 regressions.

With BOTH fixes + the where-plumbing re-applied, **`sync/mutex` rejects
`Mutex(NonSendObj)` correctly (exit 0) and `sync/channel` passes** (the Send
builtin fixed `Channel(bool)`). But **`imm_map` regresses**: `where(T <: Send)`
on `struct_yo_id_2967` (in `std/imm/string`) returns false. Diagnosis (SEND-
FIELD-FAIL trace fired ZERO times): `_all_fields_implement_send` was never called
with a failing field for struct_2967 → its `auto_derive` never ran with concrete
fields → **its Send marker was never registered**. This is the
generic-instantiation **trait-re-derivation gap** (same bedrock item): a struct
instantiation created via a path (comptime-fn stamping comptime_fn.yo:733 /
substitution) that does NOT re-run `auto_derive_traits_for_struct_type` against
the now-concrete fields. (Range happened to work because its body eval had
concrete fields; this instantiation didn't.)

**The plumbing is held back** (can't ship the imm_map regression). The remaining
fix = re-run `auto_derive_traits_for_struct_type` (with concrete field types) at
the generic-instantiation/stamping site so markers register under the
instantiation's id. Then re-apply the plumbing (validated: only imm_map blocks)
and validate per-file. Net once landed: tests 168→169 (sync/mutex), no
regressions.

### THREE DERIVATION FIXES LANDED + PLUMBING VERDICT (2026-06)

Three foundational trait-checking fixes committed (all validated clean in
isolation: std 151/151, tests 168, yo-self 337/338, 0 regressions):

1. **option 2** (0519e25b) — `_resolve_registered_trait_name` resolves nameless
   marker traits by id; registry lookup works for value structs.
2. **Send/Acyclic builtins** (b4080e8b) — primitive/comptime-data leaves recognized.
3. **on-demand re-derivation** (dfba72d8) — `type_implements_trait` step 4b
   recomputes auto-derived markers from a type's CONCRETE fields when the
   registry misses (handles generic instantiations + EnumT + `*(T)`), self-
   recursing via `recur`, guarded against cycles.

**Plumbing verdict — REVERTED (massive regression).** With all 3 fixes + the
where-plumbing re-applied, `sync/mutex` rejects `Mutex(NonSendObj)` ✓ and
`sync/channel`/`imm_map` pass — BUT a full per-file run showed **~150 yo-self/
files + 2 std (encoding/html\*) + tests/derive_clone_complex REGRESS**. Enabling
`where(...)` enforcement across yo-self's pervasively-generic code (every
ArrayList/HashMap/Option/imm-list use carries `where(T <: Send)` etc.) surfaces
a huge derivation surface the 3 fixes don't fully cover, AND the step-4b
on-demand cycle guard returns FALSE on a recursive in-progress type (e.g.
`ListNode(_next : Option(Self))`) where auto_derive's `send_derivation_in_progress`
returns TRUE optimistically — so legitimately-Send recursive types get rejected.

**Conclusion: where-clause enforcement is NOT landable for sync/mutex without
comprehensive Send/Comptime derivation parity** (the audit's pervasive-where(Send)
risk, fully materialized — ~150-file regression surface). The 3 derivation fixes
are kept (genuine correctness improvements + prerequisites). Remaining for
sync/mutex: (a) make the step-4b cycle guard OPTIMISTIC (return true for the
in-progress type, mirroring `send_derivation_in_progress`); (b) close the rest of
the derivation surface that 150 yo-self files exercise; then re-apply plumbing
and validate. This is a dedicated comprehensive-derivation effort, not a small
add. Plumbing reverted; tree green at tests 168.

**True fix scope:** persist the subject→bound constraint structure on the Func
TypeValue / a func*id side-table at definition time (the where-EXPRS side-table
from attempt #1 IS such storage and works), THEN fix the call-time \_application*
so it resolves the RHS trait correctly (the attempt-#2 bug: re-evaluating the
RHS expr in the bound call env yields a wrong trait `tv` that prints
`(id : comptime_string)`). Fixing that resolution is the real remaining work —
it needs tracing which fn/constraint produces the bad `tv` and why
`evaluate_expression_raw` of the RHS atom (e.g. `Send`) returns a mis-typed
trait at call time. Feature-sized + needs debugging; deferred. Tree stays green
at tests=168.

## Recommended order

1. **Cluster A first** — 2 tests, ~2 small contained gate ports, low risk,
   helpers already exist. Clean win toward matching TS on ./tests.
2. **Cluster B next** — 3 tests, the negative-impl registry port + Send
   consultation + where-clause check. Medium risk; validate the standalone
   negative-impl positive cases don't regress.

Both are independent of the def-time-body-eval wall (the flowability/contracts
blocker), so progress here doesn't depend on that multi-layer feature.

## Reference points

- TS: `calls/pointer.ts:75-86`, `exprs/_expr.ts:1237-1248`,
  `values/impl.ts:270-300`, `memory-safety.ts:86` (`isImplicitlyUnsafeCapableFile`).
- yo-self: `evaluator/memory_safety.yo:97` (gate helper ported),
  `calls/pointer.yo` (`evaluate_raw_pointer_call` — needs the gate),
  `values/impl.yo` (needs the negative-impl registry),
  `evaluator/trait_checking.yo` (`type_implements_send`/`_acyclic`).
- Tests: `tests/{safe_code_structural_gates,extern_unsafe_wrap,negative_impl,thread_safety,sync/mutex}.test.yo`.
