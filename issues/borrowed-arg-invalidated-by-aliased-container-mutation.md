# Borrowed argument invalidated by aliased container mutation (design gap, OPEN)

**Found 2026-08-06** while auditing `docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`
for soundness. This is a **calling-convention design gap**, not a localized codegen bug —
filed for a design decision, not silently patched.

## The hole

Function parameters borrow (+0). A field projection passed as an argument therefore hands
the callee a pointer the CALLER's structure owns. If that field is reassigned while the
borrow is live, the old value is dropped; whether the borrow dangles depends on where the
old-value drop lands:

- **Straight-line code is safe by accident of drop placement**: field reassignment saves
  the old value into a temp and defers its drop to scope end, so a borrowed alias stays
  valid through the function body (verified in emitted C: `poke` drops the saved old
  `w->b` at function end, after all uses).
- **Loops are NOT safe**: the old-value drop cannot be deferred across iterations, so it
  is emitted inside the loop.

Deterministic reproducer (macOS, `--release`, no sanitizer):

```rust
Wrap :: ref(struct(b : Box(i32)));

poke_loop :: (fn(w : Wrap, borrowed : Box(i32)) -> unit)({
  (i : i32) = 0;
  while(runtime(i < 2), {
    w.b = box(100 + i);          // iteration 1 drops the old box → borrowed dangles
    i = (i + 1);
  });
  println(`borrowed: ${borrowed.*}`);   // UAF read
});

main :: (fn() -> unit)({
  w := Wrap(b : box(42));
  poke_loop(w, w.b);             // borrowed aliases w.b, +0
});
```

Prints `borrowed: 101` — the freed 42-box's slot was recycled by `box(101)`, and the
borrowed parameter silently reads a _different, newer allocation_. Under a hostile heap
layout this is an arbitrary use-after-free. It contradicts the design doc's "zero risk of
memory safety bugs" claim.

Same-scope variant of the same class: a `match` binding borrows the scrutinee's payload
while the arm reassigns the scrutinee. Probed safe today (drop deferral again), but the
safety is placement luck, not a rule.

## Why this is a design decision

The reference languages solve it structurally:

- **Swift**: arguments are passed +0 but _exclusivity enforcement_ (compile-time where
  provable, runtime `Fatal access conflict` otherwise) forbids overlapping
  mutable/immutable access to the same storage.
- **Lobster**: global ownership/borrow inference decides per call site whether a borrow is
  safe; unsafe ones get a +1.

Options for Yo, roughly in increasing cost:

1. **Dup projection arguments** (+1/-1 around the call) whenever the callee (or anything it
   calls) _may_ mutate — conservatively: whenever the argument is a projection of a
   mutable structure and the callee takes any mutable handle on that structure (same root
   passed twice, as in the reproducer). The double-pass shape `f(w, w.b)` is syntactically
   detectable at the call site.
2. Dup ALL RC-typed projection arguments (+1/-1 per call) — simple, sound, measurable RC
   traffic cost; Phase-1.5-style cancellation can claw back the unconditional cases.
3. Exclusivity checking (Swift's model) — reject `f(w, w.b)` when `f` can mutate `w`
   through the first parameter; needs a mutation summary per function.
4. Full borrow inference (Lobster's model) — largest change, best codegen.

## DECISION (2026-08-06): Lobster's direction, staged

Swift's exclusivity is rejected: its general case is **dynamic** (per-storage access
markers + a runtime trap), which needs new runtime metadata and codegen instrumentation
and aborts at runtime — off-brand for a compile-time-RC language. Lobster's
"infer-what's-safe, insert RC ops where inference fails" matches the design doc's own
philosophy (safe by default, cancel what is provably redundant), and Yo is a
whole-program compiler with per-call-site specialization, so callee summaries are
computable where Lobster needs them.

Staged plan (each stage sound on its own):

- **Stage 0**: dup RC-typed **projection** arguments to borrowing parameters (plain
  locals stay +0 — the caller's binding keeps them alive for the call). Implement in
  `evaluateArgs` (`src/evaluator/calls/helper.ts`) via the existing
  `setExprAsNeedsToCallDup` + statement-temp drop machinery. The new dups must be exempt
  from dup/drop pair cancellation unless the callee is proven non-invalidating
  (precedent: the collector's `io.async` skip).
- **Stage 1**: per-specialization mutation summaries ("may mutate RC container storage
  reachable from params or globals?"), computed bottom-up — natural home:
  `src/evaluator/effects/`. Read-only callees (the vast majority) get the +0 borrow back.
- **Stage 2** (optional): escape summaries + call-site refinements (same-root-twice).

Benchmarks that decide whether Stage 1 must land together with Stage 0: stage-1
self-compile wall time (~6 min baseline) and the fast suite (~5.5 min baseline).

### Stage 0 implementation notes (surveyed 2026-08-07, pre-branch)

- **Site:** `src/evaluator/calls/helper.ts` `evaluateArgs` — the
  `parameter.isOwningTheRcValue && !parameter.isCompileTimeOnly` block
  (~line 411) handles own-params (move-or-dup + consume). Stage 0 adds the
  BORROWING-branch sibling: when the parameter is NOT owning and the argument
  is an RC-typed **projection** (place chain rooted at a runtime variable —
  reuse the "place" predicate from the match-place dup elision,
  plans/PERF_BORROW_ELISION.md §1, NOT a plain local atom), insert
  `setExprAsNeedsToCallDup(evaluatedArgExpr, context)` plus the
  statement-temp drop (the same post-call arg-temp drop machinery codegen
  already flushes) — and do NOT consume.
- **Cancellation exemption:** the dup/drop pair optimizer
  (`searchRecursively` / `optimizeDupDropPairs` in
  `src/evaluator/exprs/begin.ts`) must skip these dups (a cancelled pair is a
  move — it would reopen the hole). Precedent: the `io.async` capture skip.
  Add a marker on the dup expr (or its ExprInfo) rather than a positional
  heuristic.
- **yo-self twin:** `yo-self/evaluator/calls/helper.yo` arg loop (the Step-5b
  region patched for `is_parameter` in f017aaf23) + its
  `_optimize_dup_drop_pairs` in `evaluator/exprs/begin.yo`. Gate with the
  emit-diff discipline (per-function dup/drop counts before/after — fewer
  dups than intended = new cancellation = potential UAF).
- **Test:** the fixme reproducer becomes assertable once Stage 0 defines the
  semantics — check in a test asserting the borrowed projection still reads
  the PRE-mutation value after the callee mutates the container through the
  aliased root (plus an rc() balance check around the call).
- **Benchmarks to run before/after:** stage-1 self-compile wall time and the
  fast suite; if the added dup traffic is material, Stage 1 (mutation
  summaries in `src/evaluator/effects/`) lands in the same arc.

### Stage 0 landing log (2026-08-07, feat/rc-aliasing-stage0)

Core landed in both compilers (TS expr.ts
`setExprAsNeedsToCallDupForBorrowedProjection` + helper.ts borrow branch;
yo-self utils.yo twin + helper.yo Step 4c). Reproducer flipped from
`borrowed: 101` (recycled allocation) to `borrowed: 42`; emit shows the
+1/-1 pair on normal and early-return paths; Guard Malloc clean.

**Codegen invariant the new dups exposed** — several arg-rendering sites
emitted a deferred dup WITHOUT first declaring the argument's eval temp the
dup names (`___dup(<temp>)` → undeclared C identifier, raw projection read
lost). Pre-Stage-0 this was latent: deferred dups only reached those sites
on shapes that always materialized. Sites fixed (each: materialize the arg
temp, then dup):

1. `and-or.ts` / `and_or.yo` — the short-circuit conditional-temp collector
   missed dup-result temps (they live in the ExprInfo side-channel, not the
   syntactic tree): block-level drop for an if-scoped, conditionally-run
   dup. Surfaced by `a && f(w.b)` (tests/regex, cli/arg_parser).
2. `recur.ts` / `recur.yo` — the recur arg path replaced argCode with the
   dup result without ever materializing the source temp. Surfaced by
   `recur(K, V, h._left, key)` (std/imm/sorted_map, tests/imm_threading).
   The recur.yo twin also gained the whole dup/drop arg handling (was a
   documented Phase-4 gap).
3. `other-fn-call.ts` — the closure/state-machine capture exclusions
   skipped the temp declaration while the dup still emitted. Surfaced by
   `self._buf` in an async loop (tests/sys/bufio). A dup targeting the
   arg's own temp now forces the declaration.

Suite progress under Stage 0: bailed at 974 → 1080 → 1376 files, one new
site per round; the fourth full run passed 2671/0.

### yo-self arm status (2026-08-07, evening)

- Twins landed: dup marker (utils.yo — SYNTHESIZED, no nested eval; see
  issues/yo-self-dup-eval-inside-macro-generated-body-corrupts-module-eval.md),
  Step 4c in BOTH call paths (helper.yo + function.yo's inline FuncVal
  loop, gated `!checking_phase` + `!callee_is_extern` via the Func meta),
  shared predicate `arg_is_rc_projection_place` (utils.yo), and_or.yo
  collector + branch-drop undeclared gate, recur.yo full dup/drop arg
  handling, drop_dup.yo declare-assign for synthesized dup results.
- Green: tok_i minimal (derive+impl), fixme repro (`borrowed: 42`),
  tests/rc.test.yo 22/22 under the self-hosted binary (/tmp/s1_rc0h);
  battery 0 failures / corpus 155 / std 153; stage-2 self-emit rc=0
  hollow=0 AND clang-clean; stage-3 emits.
- **OPEN BLOCKER — FIXPOINT_BROKEN (P=rc2): stage-3 diverges with
  RECYCLED-STRING garbage** (`switch (().tag)`, `(Some).data`,
  `enum_yo_id_3343` where variable_name strings belong) — the STAGE-2
  BINARY has a String UAF, i.e. the stage-1 (TS-emitted) C over-drops a
  variable_name String somewhere. First divergence: rc2_stage2.c line
  ~28694, fn `yo_id_817405` (an `args.len()==1 && tok.value == "import"`
  helper — Option-String projection dup shape). Global emit-diff:
  s1_ue.c (pre-S0) 12,260 dups / 298,042 drops → s1_rc0h.c 15,761 /
  319,583 (+3.5k dups, +21.5k drops — plausibly consistent with
  early-return duplication, so counts alone don't convict).
- **Fast deterministic repro for the UAF:**
  `DYLD_INSERT_LIBRARIES=/usr/lib/libgmalloc.dylib /tmp/rc2_s2 compile
<scratchpad>/tok_e.yo --release --emit-c --skip-c-compiler -o /tmp/x`
  → rc=139 in seconds (tok_e = the tiny ref-struct+derive file).
- **Crash chain (lldb):** `yo_id_4627` (Option(String) clone, faults
  reading the freed object at x21+0x40) ← called from `yo_id_729516`
  (recursive, signature `(value_code : String, value_type : TypeValue*,
context)` = codegen/exprs/drop_dup.yo `generate_dup_code_for_value`,
  def at rc2_stage2.c:13039) ← yo_id_740424 ← yo_id_816465 ←
  yo_id_817065 ← yo_id_736607 ← yo_id_736875 ← yo_id_737129 ←
  yo_id_817295 ← yo_id_818391 ← main. So the FREED object is state read
  by codegen's dup-for-value walk (a TypeValue's field/variant Strings,
  or an ExprInfo-held object) — over-dropped earlier in the stage-2
  binary's run. The import-helper (`yo_id_817405`) emission delta was
  checked pre-vs-post Stage 0 and is BALANCED — the divergence garbage
  there is a downstream symptom, not the site.
- Emission-diff note: pre-Stage-0 `/tmp/ue_stage2.c` vs Stage-0
  `/tmp/rc2_stage2.c` — same-function diffs are the tool (function
  bodies differ only by the Stage-0 pairs; ids shift by file).
- **RESOLVED (same day): FIXPOINT HOLDS.** Two-part fix after
  malloc_history named the exact sites:
  1. The scope-end reliance was structurally unsound in yo-self — an
     unconsumed owning temp's drop gets emitted by the multi-exit cleanup
     machinery (match-arm exits + escape paths + scope end) on
     NON-exclusive paths. Redesign: the marker CONSUMES the synthesized
     dup temp and returns an explicit `___drop(<dup temp>)`, threaded
     through the previously-dormant TS-mirror channel
     `CheckParamResult.s0_drop` → `FuncCallResult.deferred_drop_expressions`
     → the call node's ExprInfo (4 consumer sites in function.yo; the 3
     `try_to_call_type_with_arguments` sites are construction results with
     no drop field and stay unwired) → codegen's post-call flush.
  2. recur.yo's node-drop flush ran BEFORE the call emission (TS-mirrored
     position, previously vacuous) — with Stage-0 drops now on recur
     nodes, it freed the argument the recursion was about to consume
     (gmalloc-traced: clone at +5276, freed at +5320, consumed at +5340
     in dup-for-value). The flush moved to AFTER the result-temp emission.
- Final validation: tok_i + repro + rc.test.yo 22/22 under the
  self-hosted binary; battery 0 failures / corpus 155 / std 153;
  stage-2 emit + clang clean; **stage-2 ≡ stage-3 (FIXPOINT_HOLDS)**;
  Guard Malloc clean on the repros and a self-hosted compile probe.
- Known accepted gaps (leak-direction, never corruption): unit-result
  `recur` calls do not flush their Stage-0 drops (no post-call emission
  point); macro-generated bodies' emissions carry the dups per each
  compiler's own evaluator decisions.

Sequencing: lands AFTER the 2026-08-06 CI-gating change (leak fix + branch-dup
classification) is green in CI, as its own change.

## Interim

- The loop-traversal optimizer's mutation guard
  (`issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md`) closes the same class
  _inside_ the traversal optimization, where the compiler itself was removing the
  protective RC ops.
- The design doc's Trade-offs section now names this hole instead of claiming zero risk
  (`docs/en-US/COMPILE_TIME_RC_WITH_OWNERSHIP_ANALYSIS.md`, both languages).

## Reproducer status

`src/tests/fixme.yo` variants, 2026-08-06 session; not yet a checked-in failing test
(there is nothing to assert until the semantics decision is made — the current behavior is
UB that happens to print recycled memory).

### Stage 1 landing log (2026-08-08, feat/rc-stage1-mutation-summaries)

**Stage 1 (per-callee mutation summaries) landed in both compilers — the
+23% Stage-0 cost is fully clawed back.** `check ./std` under the
self-hosted binary, min user of 3: pre-Stage-0 45.3 s → Stage 0 55.24 s
→ **Stage 1 45.14 s**. The aliasing hole is closed at zero measured
runtime cost.

- **TS**: `src/evaluator/effects/mutation-summary.ts` — a may-mutate walk
  over EVALUATED bodies (callees resolved via `func.$.value`), memoized by
  funcId with least-fixpoint cycle optimism (verdicts that depended on an
  in-progress walk are not memoized unless they found a real mutation).
  May-mutate sources: RC-typed place assignments; externs that are
  runtime/allocator family (`__yo_`-prefixed), libc free/realloc, or take
  callbacks (raw C byte ops cannot decrement RC counts — memcmp/printf are
  read-only); io builtins; ctl functions; unresolved callees. Match-arm
  patterns are skipped (no guards in Yo); primitive builtin heads
  (`__yo_op_*`, ptr math, `rc`, `__yo_panic`) are whitelisted. Gates:
  mark-time skip for non-generic callees + post-specialization unmark for
  generics (`removeBorrowedProjectionDupMark` reverses the marker exactly).
- **yo-self**: `yo-self/evaluator/effects/mutation_summary.yo` (the
  mutually recursive summary/walk pair lives in an impl-block namespace —
  module bindings are define-before-use). Elision gates in all THREE
  arg-marking paths: helper.yo `try_to_call_function_with_arguments`
  (marked args threaded via `CheckParamResult.s0_marked_arg`), function.yo
  inline body-executed path, and — found by instrumentation —
  `_evaluate_funcval_runtime_call`, the path most ordinary calls take,
  which early-returns BEFORE the inline path's drop wiring. Its Stage-1
  decision runs after the Gap-6 specialization (a generic callee's raw
  body is unevaluated; only the minted spec's body is walkable).
- **Pre-existing Stage-0 gap sharpened**: `_evaluate_funcval_runtime_call`
  never wired `fv_s0_drops` — Stage-0 dups on that path leaked their
  balancing drop since landing (invisible to the rc-balance asserts
  because the callee's own reassignment consumes a ref). After Stage 1,
  read-only callees elide the dup entirely (no leak); MAY-MUTATE callees
  on that path still leak the +1 — the drop-release-point semantics
  (TS releases at scope end; yo-self's explicit-drop channel releases
  post-call) need their own decision before wiring it. Tracked as the
  remaining leak-direction gap.

Validation: fixme repro green under both compilers (rc 2 inside read-only
callees on the non-generic, generic, and runtime-call paths; the aliased
mutation keeps its +1); tests/rc.test.yo 23/23 both compilers (new
"read-only callee elides the Stage-0 borrowed-projection dup" test); TS
fast suite 2673/0; battery 0 failures hollow=0; corpus 155 PASS / 0 DIFF;
`check ./std` 153/153; **FIXPOINT HOLDS** (stage-2 ≡ stage-3, hollow=0);
Guard Malloc clean.
