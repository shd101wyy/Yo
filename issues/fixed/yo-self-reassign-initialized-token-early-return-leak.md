# yo-self: reassignment moves `initialized_at_token` forward → earlier early-returns skip owned-local drops (the Environment leak)

Status: FIXED (pending final gates) — 2026-07-16
Where: `yo-self/evaluator/exprs/assignment.yo` (reassignment Variable rebuild)
Filter tripped: `yo-self/codegen/exprs/return.yo` `_keep_pending_drop` forward-reference guard
Regression test: `tests/codegen-bootstrap/reassign_early_return_drop.yo`
Repro (standalone): scratchpad `ctor_ret_leak4.yo` — TS `tracked=0`, yo-self pre-fix `tracked=100`

## Symptom / impact

After the container-dispose fix (`issues/fixed/yo-self-container-dispose-not-wired.md`),
`s2 compile yo-self/parser.yo` still held **1.99M live Variables vs s1's 360K**.
Live histogram + per-type RC site tracing (see Method) showed:

- Variable: allocs identical (2.68M both), incrs identical (16.0M vs 16.1M), but
  **decrs 18.24M (s1) vs 16.40M (s2)** — a 1.84M missing-DECR deficit, all of it
  in the container-dispose loop (`ArrayList(Variable).___dispose`: 3.29M vs 1.35M
  element-decrs). The Variables are _pinned by their owners_, not orphaned.
- Frame: live 10.2K (s1) vs 35.3K (s2). Environment: live 57.1K vs 75.4K — and
  in s2 **~119K Environments died only as cyclic garbage** (alloc+incr−decr =
  194.5K vs live 75.4K) versus ~1.5K in s1. The env RC imbalance is also a large
  chunk of the GC-thrash perf gap (the collector must reclaim what RC should have
  freed).
- Environment per-function RC diff (executions are deterministic, so any
  per-function count delta is an EMISSION difference): the extra env incrs
  concentrate under `_synthesize_types_impl` (attributed one frame up to its
  callers `_synthesize_call` +97K and `synthesize_types` +21.5K — note
  `__builtin_return_address(0)` inside the inlined `__yo_incr_rc` names the
  _caller of the function containing the incr_).

## Root cause

`_synthesize_types_impl` (yo-self/evaluator/types/synthesizer.yo:1113) does:

```rust
(ee : Environment) = expected_env;      // owning local, +1 dup
(ge : Environment) = given_env;         // owning local, +1 dup
if(_has_type_pair(checked, exp_id, giv_id), {
  return(SynthesizeResult(expected_env : ee, given_env : ge));   // EARLY RETURN
});
...
ee = res.expected_env;                  // REASSIGNED in later arms
ge = res.given_env;
```

- TS emits, at the early return: dup-temps for the ctor args, then
  `___drop(ge); ___drop(ee)` — balanced.
- yo-self emitted `incr(ee); incr(ge); new(ee, ge)` and dropped ONLY the String
  locals — ee/ge's own +1 never released. Each anti-circularity hit leaked +1 on
  BOTH envs. The over-counted envs look externally referenced to the Bacon-Rajan
  collector (rc > internal refs), so they and their whole Frame→Variable chains
  are pinned forever.

Why the drops were skipped: the reassignment path in
`evaluator/exprs/assignment.yo` rebuilt the Variable with
`initialized_at_token = <reassignment site>`. TS does the same
(assignment.ts:619-633) **but TS's envs are persistent** — an expression BEFORE
the reassignment holds a snapshot with the ORIGINAL token. yo-self shares one
mutable Variable (END-of-scope env), so after evaluation the token points at the
reassignment site, which is AFTER the early return; codegen's
`_keep_pending_drop` forward-reference guard
(`_variable_initialized_after_cleanup_point`, return.yo) then judges the local
"not yet declared here" at every earlier return and suppresses its drop. The
same function's tail return (after the reassignment) kept the drops — matching
the observed emission exactly.

Minimal trigger (all three needed): owning local + used in an early-`return`'s
value + **reassigned later in the function**. Without the reassignment the drop
is emitted (repro v1–v3 were clean; v4 with reassignment leaked).

## The fix

On reassignment, PRESERVE the first initialization token (the C decl site —
what the emission-order filter actually needs, and what TS's snapshot semantics
effectively deliver):

```rust
initialized_at_token : if(
  is_mutating_defined_variable,
  updated_variable.initialized_at_token,
  Option(Token).Some(ast_expr_token(lhs_resolved))
),
```

## Method (reusable)

1. Live-object histogram by `dispose_fn` via dladdr (scratchpad/patch_hist.py).
2. **Per-type RC site tracing** (scratchpad/patch_rcsite.py): patch
   `__yo_incr_rc`/`__yo_decr_rc` to count events for one dispose_fn, keyed by
   `__builtin_return_address(0)`, plus per-symbol aggregation. Run s1 and s2 on
   the same input; since evaluation is deterministic, any per-function count
   difference is a codegen emission difference. Caveat: attribution is shifted
   ONE FRAME UP (return_address inside the inlined incr = caller of the
   containing function); clang -O2 inlining can also shift attribution between
   tight caller/callee pairs — compare families, and verify against the actual
   emitted C.
3. Extract the suspect function's emitted C from both stage1.c (TS emit) and
   stage2.c (yo-self emit); diff the RC ops per source construct.
4. Reduce to a differential repro; iterate ingredients until the leak appears
   (the reassignment turned out to be the key).

## Gates (all run 2026-07-16, fixed s1 = --release/-O2)

- Repro `ctor_ret_leak4.yo`: yo-self tracked 100 → 0 ✓
- `tests/codegen-bootstrap/reassign_early_return_drop.yo`: TS PASS + yo-self PASS ✓
- Corpus `scripts/diff-test.sh tests/codegen-bootstrap`: PASS 126 / DIFF 2 → both
  DIFFs verified PRE-EXISTING (pre-fix and post-fix yo-self binaries byte-identical
  behavior on both): `ptr_deref_copy_rc_struct` (known ctor-arg RC-count print
  divergence) and `constructor_result_drop` (TS-side rc=139 was a FLAKY crash under
  parallel-6 contention — 8/8 clean solo reruns at -O0 and -O2) ✓
- `check ./std`: 153/153 ✓
- `check ./yo-self`: NOT a usable gate on this box right now — the run stalls
  ~50 min inside `yo-self/tests/expr_traversal.test.yo` and jetsams (rc=137).
  PRE-EXISTING: the pre-fix binary stalls identically at the same file (verified
  by racing both). Machine-state/pathological-file issue, independent of this fix.
- Self-emit: s1 emits stage2.c (36.7MB), `clang -O2` → **0 errors** ✓

## Proxy result (s2 = self-compiled from the fixed emit, compile yo-self/parser.yo)

| metric             | s1      | s2 pre-fix          | s2 post-fix |
| ------------------ | ------- | ------------------- | ----------- |
| Variable live      | 359,896 | 1,988,484           | **424,975** |
| Environment live   | 57,087  | 75,364              | **60,692**  |
| Frame live         | 10,196  | 35,283              | **11,529**  |
| total live tracked | 898,657 | 2,426,712           | **776,152** |
| peak RSS           | 477 MB  | 1,656 MB            | **808 MB**  |
| wall               | ~2 s    | minutes (GC-thrash) | **4.9 s**   |

Drop-parity with s1 effectively reached; the cyclic-garbage source that forced
the Bacon-Rajan collector to run constantly is gone (s2 pre-fix had ~119K
Environments dying only via cycle collection; the unmatched +1s pinned the rest).
This is the same mechanism as the 26G/48-min main.yo self-emit GC-thrash — the
fixpoint should be re-attempted.
