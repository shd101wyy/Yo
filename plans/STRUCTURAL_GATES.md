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
