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

### Stage 1 REVIEW findings (2026-08-08) — a UAF every gate passed over

A code review of the Stage-1 branch found a **real use-after-free** that the
full battery (TS fast suite, 23-file battery, 155-program corpus, `check
./std`, stage-2/stage-3 fixpoint, Guard Malloc) had all reported green.
Recorded here because the failure mode is instructive: the gates measure
_behavior of programs the compiler emits_, and this bug only manifests for a
specific source shape none of the corpus programs happened to contain.

**Hole 1 (HIGH, live UAF): the compile-time-value early-exit outranked the
structural forms.** The walk short-circuited on "this expr has a concrete
`$.value`, so codegen inlines it and nothing inside runs". That reasoning is
right for a CTFE'd call and WRONG for a statement: an assignment stamps
`VUnit` (assignment.ts:762,772,1218) and a declaration carries its own value,
purely because that is their type. So the walk skipped whole statements and
never visited the mutating call on the right-hand side:

```rust
poke   :: (fn(w : AliasWrap, seed : i32) -> i32)({ w.b = box(i32(100) + seed); w.b.* });
honest :: (fn(w : AliasWrap, borrowed : Box(i32), seed : i32) -> i32)({
  t := poke(w, seed);          // skipped whole — the mutation is never seen
  borrowed.* + (t - t)
});
```

`honest` was reported read-only → Stage 1 elided the Stage-0 dup → the
borrowed projection read recycled memory, **returning 2 instead of 42**.
Fixed by moving the check below the structural dispatch (`=`, `:=`/`::`,
`match`, safe heads), where it only applies to genuinely folded calls.
Ported to yo-self in lockstep — the port had the identical ordering.

Regression test: `tests/rc.test.yo` "statement-hidden mutation keeps the
borrowed-projection dup", covering both the reassignment and declaration
forms. Verified RED before the fix (SIGABRT).

**Hole 2 (HIGH, latent): the memo cache was keyed by a REUSABLE id.**
`summaryByFuncId` is process-global, but `funcId`s come from `randomId()` —
a per-module-path COUNTER (`utils.ts`) that `clearAllModuleCounters()` resets
per test file and `resetModuleIdCounter()` resets on module drop/reload. Any
process compiling a module path twice can hand `fn_<mod>_id_N` to a different
function and inherit its verdict; a "read-only" verdict inherited by a
mutating callee elides the dup silently. `utils.ts` now exposes a module-id
generation (a plain number — an inbound import into that leaf would be a
cycle) and the cache drops its memo when it moves.

yo-self does NOT share this hazard: its `random_id` is a single monotonic
process-global with no reset, so ids are unique for the life of the process.
That invariant is now documented at the yo-self cache, with a note to add the
guard if the generator ever gains a reset.

**Hole 3 (MEDIUM): the unmark was fail-open.**
`removeBorrowedProjectionDupMark` cleared the deferred dup BEFORE confirming
it could flip the dup temp back to non-owning; on either early-return path
(no temp name / temp not in the current env) the dup was gone but the temp
stayed owning, and the caller's RAII collection — which deliberately runs
right after — would emit a scope-end `___drop` with no matching `___dup`.
`callerEnv` is re-bound several times between the arg loop and the unmark, so
a lookup miss is not hypothetical. Now all-or-nothing. The yo-self unmark has
no equivalent hazard: its dup temp is consumed at creation and balanced by an
explicit call-node drop, not a scope-end drop.

**Lesson for this class of work:** behavioral gates cannot find a
mis-classification whose trigger shape is absent from the corpus. For an
analysis that decides whether to REMOVE a safety operation, write adversarial
probes per decision rule (here: one per early-exit) and assert the verdict
directly, rather than relying on end-to-end suites.

### Hardening pass (2026-08-08) — two more holes, the leak closed, release

### points reconciled

Probing every "this callee is read-only" rule in the walk (rather than
relying on end-to-end suites) found a second class of hole and closed the
last known leak.

**Holes 3 and 4 (HIGH, live UAF): every RC-DECREMENT primitive was
whitelisted as safe.** `___drop`/`___dispose` sat in `SAFE_RECURSE_HEADS`
and `__yo_decr_rc`/`__yo_dyn_drop`/`__yo_sometype_drop` in
`PURE_BUILTIN_HEADS`, while `__yo_drop_array_element`/`_tuple_element` were
(correctly) excluded — an inconsistency nobody had noticed. The written
justification was "a decrement only frees storage nothing else references,
because a live borrow is backed by the container's own counted reference",
which is exactly the assumption Stage 0 exists to deny. A callee doing
`___drop(w.b)` or `__yo_decr_rc(w.b)` releases the container's reference
with NO assignment for the assignment rule to see, and was reported
read-only. Both are user-reachable (`___drop` is used in
tests/basic.test.yo). Decrements now live in their own set, tested BEFORE
the safe/pure lists so one can never be whitelisted by accident. Verified
red-before-green: with the rule disabled the `__yo_decr_rc` test SIGABRTs.

Compiler-GENERATED drops are provably not a hazard, on two independent
grounds: they never appear as AST children (they live in ExprInfo
side-channels this walk does not traverse), and `getVariablesNeedingDrop`
(env.ts) only selects variables with `isOwningTheRcValue` — a borrowed
parameter is non-owning by definition. Only explicit decrements can reach
borrowed storage.

**Rules probed and found SOUND:** cycle-guard optimism with the mutation
only on a mutual-recursion back edge; mutation inside an
immediately-invoked closure; mutation inside a `while` body; the
(post-fix) compile-time-value early-exit.

**The runtime-path leak is closed.** `_evaluate_funcval_runtime_call` — the
path most ordinary calls take — never wired `fv_s0_drops`, so every
may-mutate Stage-0 dup on that path leaked its `+1` from the day Stage 0
shipped. The drop is now attached to the call node, the same channel
helper.yo and the inline path use.

**Release points differ between the compilers, and that is now documented
rather than accidental.** yo-self releases the Stage-0 `+1` POST-CALL (its
dup temp is consumed at creation and balanced by an explicit call-node
drop — the design forced by its multi-exit cleanup machinery, see the
Stage 0 log). TS releases at SCOPE END (its dup temp stays owning and the
normal scope-end machinery drops it). Both are sound; only the timing
differs, and it is observable only through `rc`. Closing the leak made the
difference visible for the first time, because the leaking path had been
accidentally matching TS by never releasing at all.

The regression test now asserts AFTER the enclosing statement scope, where
both release points have passed and both compilers agree (`rc == 1`). That
is the property that actually matters — the `+1` is released exactly once —
and it catches a leak (`rc 2`) and a double release (crash) equally well.
Note the PREVIOUS version of this test asserted `rc == 2` immediately after
the call, i.e. it had encoded the runtime-path leak as expected behaviour.

Unifying the two release points (making TS also drop post-call) is
deliberately NOT done here: TS's call-node deferred drops are emitted
before the call in some emitters (`recur.ts`), so moving the release there
risks the exact use-after-free that had to be fixed in yo-self's recur.yo.
It is worth doing as its own change, with its own gate run.

### Stage-0 audit (2026-08-08) — two more holes, in the rules deciding WHAT

### gets protected

Stage 1's rules were probed exhaustively; Stage 0's never were. Applying the
same method to Stage 0 — the rules deciding which arguments get a `+1` at all
— found two defects. They matter more than Stage 1's, because Stage 1 can
only elide a dup that Stage 0 created: a shape Stage 0 declines to mark is
unprotected no matter what Stage 1 concludes.

**Hole A — the projection predicate required a 2-arg dot, so INDEX reads were
never protected.** `exprIsRcProjectionPlace` matched `w.b` and `a.b.c` but
rejected `h.a(0)`, whose AST is `(h.a)(0)` — a call whose FUNC is the dot.
An element read is a view into container storage exactly as a field read is.
Reproducer: a callee reassigning `h.a(0)` in a loop freed the borrowed box
and the caller read **101 instead of 42** — the same signature as the
original Stage-0 bug, reached through indexing. Both compilers had it.

Fixed by factoring the root walk into `placeRootIsRuntimeVariable` and
accepting two forms: a dot chain with an atom rhs (field), or any other call
whose FUNC's root is a runtime variable (index/method read). Widening is safe
by construction — the marker no-ops when the argument's temp already OWNS its
value, which is what an ordinary value-returning call produces, so only
genuine borrows into live storage pick up the `+1`, and Stage 1 elides it
again for read-only callees.

**Hole B (TS only) — the marker treated a runtime `UnknownValue` as an
inlined constant.** `setExprAsNeedsToCallDupForBorrowedProjection` skipped on
a bare `if (expr.$.value)`. But an `UnknownValue` IS a value object: per
AGENTS.md, `value == undefined` means runtime, whereas `UnknownValue` means
"type known, value not". Element reads carry exactly that, so even after
hole A was fixed the marker still skipped them. The yo-self twin already
guarded with `is_unknown_val` — **the port had diverged and yo-self was the
correct side**; this is TS catching up. Same class as the Stage-1
statement-skipping bug: "has a value" ≠ "is compile-time inlined".

**Rules probed and found SOUND:** nested projection chains (`h.inner.b`),
and a projection whose ROOT is the caller's own parameter rather than a local.

**The regression test WAS blocked; it is now checked in.** The only shape
that discriminates is a fixed-size `Array` field: its element reads are
inline, non-owning, and carry an `UnknownValue`. `ArrayList` reads go through
the Index trait and yield an OWNING temp, so they were already safe at `+0`
and a test built on them passes with or without the fix — worthless as a
regression guard. But `Array(Box(i32), N)(...)` emits invalid C in BOTH
compilers (pre-existing, verified with these changes stashed), so the test
cannot be checked in yet. Filed as
`issues/fixed/array-of-rc-constructor-emits-invalid-c.md` (fixed 2026-08-08; three defects, see that doc), which carried the
reproducer. That bug is now fixed and the test — "an INDEXED borrowed
argument is protected like a field projection" — is checked into
`tests/rc.test.yo`, passing under both compilers. The fixes here are
additionally verified by hand (101 → 42) and by the full gate battery.
