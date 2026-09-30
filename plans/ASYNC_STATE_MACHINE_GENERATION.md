# Async state-machine generation: the 2026-09-28 audit and the improvement plan

**Status:** ACTIVE (since 2026-09-29). The audit is complete (#985).
Phases 0–3 are merged (#989, #991), and phase 5 (the single-pass lowering)
is landing; phases 6 and 7 are next. The owning `JoinHandle` of phase 2
waits for the seed (#996, `issues/join-handle-ownership-waits-for-the-seed.md`).
The per-phase progress log is §9. Written
2026-09-28 against develop `af62bdb28` (seed v0.2.45).

**Scope.** How the compiler turns an `io.async` body into a C state machine,
and the runtime protocol the generated code relies on: the future header,
waiting, completion, abort and cancellation. The per-platform I/O backends
are out of scope; they were audited separately in
`plans/reference/LINUX_ASYNC_IO_PERFORMANCE.md` and
`issues/windows-async-io-runtime-audit.md`.

**Goal set by the user:** audit the state-machine generation, document every
issue found, and lay out phase by phase how to make generation correct by
construction and fast.

---

## 1. Summary

The generator works for the shapes std uses and fails, often silently, just
outside them. It is not short of fixes: 109 async issues have been fixed,
and 54 commits in 40 days touched the five core files. Its **design** makes
each fix local to one shape.

- **The body is split only at its top-level statements.** An await nested in
  a `cond`/`match`/`while` gets an empty state. Separate "continuation"
  emitters then REGENERATE the rest of the enclosing construct inside the
  next state's `case`, driven by hand-maintained bookkeeping
  (`CondBranch.codes`/`part_codes`, chained branches, post-while
  expressions, `OuterWhileLoop`, `deferred_to_outer_while_loop`, active
  flags). That bookkeeping is a control-flow graph encoded by hand. Every
  new nesting combination needs a new emitter path, and a shape nobody
  wrote a path for falls through: sometimes to a C error, sometimes to
  **silently missing code**.
- **The ownership protocol has gaps.** They sit at the edges the common path
  never exercises: a second waiter, an awaiter of an already-running
  future, abort of a task someone awaits, abort of a task suspended in a
  nested future, and drop/retain of non-pointer RC values.
- **The generated code is 2–3.5× slower than it needs to be on the hot
  paths.** Every cold await pays a `calloc` that bypasses glibc's tcache.
  Every synchronously completing child costs a scheduler round trip (a
  kernel entry once any I/O is pending). Every completion costs a scheduler
  step per chain level.

The plan: harden and fix now (phases 0–3), then replace the
segment/continuation lowering with a single-pass resumable lowering over a
small IR (phases 4–6), which removes whole bug classes rather than
individual shapes.

## 2. How generation works today

```
evaluator                               codegen
─────────                               ───────
await_analysis.yo  ─ AwaitPoint[] ─┐    exprs/async.yo   generate_async_block → DeferredAsyncBlock
suspension_analysis.yo (walk, cond │      emit_async_block_struct_definition  (layout)
  merging, needs_own_cond_branch)  │      generate_async_block_constructor / _state_dispose
                                   └──▶ async/state_machine.yo
                                          compute_cross_boundary_variables  (segment-granular liveness)
                                          compute_overlapping_slots         (non-RC, same C type only)
                                          generate_async_block_resume_function
                                            split_into_state_segments  (shared/suspension_codegen.yo)
                                            hoist_non_splittable_awaits
                                            per segment: case N: prologue (extract prev result,
                                              _emit_cond_branch_continuation, _emit_nested_level_switch,
                                              _emit_outer_chained_branch_layers, _emit_while_continuation,
                                              _emit_outer_while_continuation, _emit_post_while_cond_branch …)
                                              generate_state_segment_code  (state_code_gen.yo)
                                              _emit_await_suspension[_dispatch]  → _emit_await_suspension_core
                                            _emit_last_segment_completion
                                        runtime_core.yo  queue, poll step, JoinHandle abort
```

About 14.6k lines across `state_machine.yo` (4.4k), `state_code_gen.yo` (4.0k),
`exprs/async.yo` (3.1k), `exprs/await.yo`, `shared/suspension_codegen.yo`,
`_fsm.yo`, `state_machine_naming.yo`, `async_completion.yo`, and the two
evaluator analyses. The machinery threads about 15 mutable SM fields through
`FunctionGenerationContext`, and every emitter saves and restores them by
hand (`p_in`, `p_smv`, `p_vr`, `p_pdd`, …).

**State numbering.** State `k` resumes after await point `k-1`. Each await
point has exactly one state, and the order of `AwaitPoint`s equals the state
order.

**Refcount protocol.**

- A constructor returns RC=1 (the owner).
- An awaiter that finds a pending non-io future increments it (the "event
  loop reference"), cold-starts it if its state is 0, and writes ITSELF into
  the future's single `continuation_fn`/`continuation_sm` slot.
- Completion sets `-1`, enqueues that one continuation, and releases one
  reference.
- `sm->await_future_N` owns its reference.
- Dispose drops the captures, the result if `state == -1`, and every
  cross-boundary local if `state == -2`.

**Where rules live.** Await-placement restrictions (E0904) are checked only
in codegen.

## 3. Findings

### 3.1 Architecture: why shape bugs keep coming

1. **Top-level-only splitting.** `split_body_at_suspension_points` cuts
   `begin` statements. A statement holding N awaits yields one real segment
   and N−1 empty ones. Everything inside the statement after its first
   await is reproduced by a continuation emitter keyed on the await index.
   Every rewrite is also top-level-only: `hoist_non_splittable_awaits`
   inspects only the last top-level expression of a segment, which is why
   `if(await …)` inside a match arm is rejected
   (`issues/fixed/if-await-in-a-match-arm-is-rejected-as-a-later-cond-branch.md`).
2. **Two independent numberings of the same thing.** The struct emitter
   numbers the extra `while_loop_N_active` and `cond_branch_N` fields by
   walking await points. The body emitter allocates them from
   `async_next_while_loop_index` and `cond_branch_case_seq` while
   generating. When the walks disagree, the C names a field that does not
   exist (`async-postwhile-multiple-await-ifs.md`: declares `cond_branch_0`
   and `_2` but writes `_1`), or a label is emitted twice
   (`async-nested-cond-await-duplicate-while-labels.md`, now minimized to an
   outer `while` holding an inner `while` with two awaits).
3. **Shape whitelists that fall through silently.**
   - `generate_while_body_with_await` handles `x := await`, a bare await,
     cond/match/if and a nested while. `v := cond(…await…)` is discarded
     without a diagnostic (`async-cond-value-with-await-arm-inside-while-yields-zero.md`).
   - The cond-branch emitter handles `x = await`, `x := await` and a bare
     await. `out = (await(f) + 10)` in a later arm is discarded
     (`await-inside-an-expression-in-a-later-cond-arm-is-dropped.md`).
   - `generate_remaining_expr_future` ends in
     `// Warning: unhandled await pattern in remaining expressions`, emitted
     as a C comment.
   - 37 `/* Error: … */` return strings remain under `src/codegen/`.
4. **Macro blindness.** The suspension walk follows `macro_expansion` only
   for the hard-coded `if` head. A user macro that awaits becomes a
   blocking await inside a task: a silent deadlock
   (`io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await.md`).
   This is what blocks `for_await`
   (`plans/backlog/FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`).
5. **Store sites that must remember a rule.** The borrowed-future `incr_rc`
   (the `Park.wait` fix) and the named-future "no slot" rule are enforced by
   convention at each store site. Two sites got one of them wrong:
   `async-second-cond-arm-await-of-a-field-future-frees-it.md` (a UAF) and
   `named-future-awaited-in-a-while-emits-missing-await-future-field.md`
   (a C error).
6. **Rules in codegen.** E0904 fires only in `yo compile`, so `yo check` and
   `yo lsp` are green on programs that do not compile
   (`await-placement-rules-only-enforced-in-codegen.md`).
7. **Vestigial generality.** The `SuspensionPoint`/`SuspensionSegment` "shared
   with algebraic effects" layer has one user left, since effects use
   evidence passing now.

### 3.2 Bugs found by this audit

All were reproduced on the seed and on a tree build of `af62bdb28`, with a
committed repro under `issues/repros/`.

| Issue | Class | Area |
|---|---|---|
| `async-second-cond-arm-await-of-a-field-future-frees-it.md` | UAF | store site skips borrowed-future `incr_rc` |
| `named-future-awaited-in-a-while-emits-missing-await-future-field.md` | C error | store site ignores `future_variable_id` |
| `await-inside-an-expression-in-a-later-cond-arm-is-dropped.md` | **silent wrong value** | cond-branch whitelist fall-through |
| `two-tasks-awaiting-one-pending-future-lose-the-first-waiter.md` | hang | single continuation slot |
| `awaiting-an-already-started-future-from-a-state-machine-leaks-it.md` | leak | event-loop ref taken for a non-cold future |
| `aborting-a-task-never-wakes-its-awaiter.md` | hang | abort paths never fire the continuation |
| `abort-does-not-cancel-a-nested-future-the-orphan-keeps-running.md` | wrong value / deadlock / leak | no structured cancellation |
| `abort-dispose-never-drops-string-option-and-value-struct-locals.md` | leak | `_rc_field_drop_line` has no inline fallback |
| `nested-io-async-string-capture-is-not-retained.md` | UAF | `_rc_field_retain_line` has no inline fallback |
| `statement-level-io-spawn-leaks-the-state-machine.md` | leak (152 B/spawn) | JoinHandle ref keyed on `variable_name` |
| `io-async-param-shadowing-an-outer-name-still-captures-it.md` | waste (32 of 152 B) | capture analysis ignores param shadowing |
| `impl-future-struct-field-emits-incompatible-pointer.md` | C error | `Impl(Future)` field: no upcast, check accepts |
| `if-await-in-a-match-arm-is-rejected-as-a-later-cond-branch.md` | false E0904 | top-level-only hoist |
| `await-placement-rules-only-enforced-in-codegen.md` | tooling | E0904 invisible to check/LSP |
| `a-non-send-closure-reading-a-global-marks-it-thread-reached.md` | false rejection, shown as an unrelated E0610 | evaluator D1 registry |
| `sanitize-address-is-silently-dropped-for-a-bare-output-name.md` | tooling | ASan probe runs `"$0"` through `PATH` |
| `three-deep-nested-while-never-resumes-the-middle-loop.md` | **silent wrong value** | `outer_while_loop` holds one level |
| `an-arm-with-two-sequential-awaits-runs-enclosing-code-in-the-wrong-state.md` | **silent wrong value** | continuation emitted before the chained await |
| `break-or-continue-after-an-await-in-an-arm-emits-raw-c-keywords.md` | **silent wrong value** / C error | break/continue info not installed |
| `hoisted-condition-await-plus-an-arm-or-body-await-is-lowered-as-plain-code.md` | garbage value / C errors | hoisted statement never re-split |
| `while-with-await-in-both-step-and-body-is-miscompiled.md` | C error / SIGSEGV | step-await layout assumes an await-free body |
| `primitive-match-arm-while-await-post-loop-code-runs-every-iteration.md` | **silent wrong value** | primitive and enum match paths drifted |
| `tail-primitive-match-with-three-arms-redefines-continuation-fn.md` | C error | unbraced `case` bodies with declarations |
| `reassigning-a-heap-local-from-an-await-leaks-the-old-value.md` | leak | extraction treats `=` like `:=` |
| `reassigned-heap-local-in-an-arm-after-a-loop-await-leaks.md` | leak | continuation loses the arm's deferred drops |
| `thread-local-async-registries-leak-at-thread-exit.md` | leak (one-time, per thread) | no thread-exit hook |
| `a-begin-block-step-in-a-three-argument-while-reads-an-undeclared-local.md` | C error (sync code, not async) | while step emission |

The shape sweep also widened three docs: the await-in-an-expression family
(`await-inside-an-expression-in-a-later-cond-arm-is-dropped.md`, now five
shapes including a top-level SIGSEGV), the `match` variant of
`async-cond-value-with-await-arm-inside-while-yields-zero.md`, and a
misleading E0904 hint (`await-placement-rules-only-enforced-in-codegen.md`).

**Count:** 27 new bug docs, and 7 of them are silent wrong values.

### 3.3 The open async issues, re-verified

All 25 open async-SM docs were re-run, and each carries a dated
"Re-verified 2026-09-28" section.

- **Still reproduce (9):**
  - `async-cond-value-with-await-arm-inside-while-yields-zero`
  - `async-cond-value-with-throwing-arm-after-await-undeclared-temp` (widened: no throw needed)
  - `async-effect-setter-emits-a-raw-non-ascii-identifier-as-a-c-member-name`
  - `async-nested-cond-await-duplicate-while-labels` (minimized)
  - `async-postwhile-multiple-await-ifs`
  - `impl-fn-param-captured-by-an-async-block-is-not-in-the-capture-struct` (moved to the sync-future path)
  - `io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await`
  - `unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0` (type confusion on `__yo_unwind_value`)
  - `unit-zst-residual-gaps` (the unit-local row)
- **Fixed but not closed (7):**
  - `a-ref-value-passed-to-an-async-future-is-never-released`
  - `closure-argument-inside-an-io-async-body-loses-the-future-result-type`
  - `sync-main-awaits-propagate-errors-through-a-null-exn` (by rejection)
  - `yo-self-async-await-argcount-overpermissive`
  - `yo-self-async-completion-drop-set-divergence`
  - `yo-self-async-emission-cluster`
  - capture-cluster finding 1
- **Changed (5):**
  - `an-ioasync-closure-calling-a-ctl…` (E0905 now; the swallow hides the real error)
  - `async-abort-dispose-double-drops-moved-enum-payload` (now a leak)
  - `yoself-accepts-await-in-cond-that-ts-rejects`
  - `ftt-stub-in-live-closure…`
  - capture-cluster
- **Latent (1):** `io-async-sync-path-returns-a-c-comment…`.
- **Not reproduced (3):**
  - `async-await-nested-if-lost-continuation`
  - `async-sm-fn-typed-local-across-suspension`
  - `async-tail-match-return-hangs-state-machine`
- **Not reproduced on Linux:** `pending-io-future-local-drop-uaf` (the macOS
  kqueue borrow is untested).

### 3.4 Generated-code quality and performance (measured)

Method: callgrind instruction counts per op (n=100k minus n=0), plus
interleaved wall-clock A/B runs. The box is a loaded 32-thread WSL2 machine,
so treat wall times as ±2× and instruction counts as exact. The programs
live in the audit scratch dir. Their shapes are reproducible from the
table.

| Path | instr/op | ns/op |
|---|---|---|
| plain sync fn call (baseline) | 44 | 3.6–4.0 |
| await of an already-completed future | 61 | 3.8 |
| cold `sync_fut_t` leaf (no-await body) | 648 | 55–57 |
| cold state machine that completes synchronously | 852 | 69–71 |
| the same, with I/O parked in the kernel | – | **312–384** |
| chain depth 4 / 8 | 4187 / 7220 | 338–349 / 694 |
| chain depth 4 with parked I/O | – | 1624–2020 |

What costs, in order:

1. **`__yo_rc_alloc` + `memset` fuse into `calloc`**, which bypasses glibc's
   tcache. Prototype fix: `cold_sm` 852 → 495 instructions (−42%), 70.8 →
   33.8 ns; depth 4 349 → 169 ns. The bundled mimalloc was no faster than
   glibc `calloc`. This probably affects every RC allocation followed by
   `memset`, not only futures.
2. **A cold child that completes synchronously always yields**
   (`__yo_async_spawn_task(self); return;` in `_emit_await_suspension_core`).
   With I/O pending, each yield is a kernel entry. Prototype (use the
   inline budget and `goto state_N`): 327–343 → 96–112 ns; depth 4 with
   pending I/O 1956 → 640 ns (3.1×).
3. **Completion always enqueues the parent**, so a depth-k chain takes k+1
   scheduler steps to finish. A one-slot same-step handoff (capped at 64,
   no C-stack growth) takes 8 steps to 2 at depth 4, 2.2× with parked I/O.
   `sync_fut_t` already resumes its continuation inline, so the two
   completion paths are inconsistent today.
4. **The inline budget resets per resume call**, so a loop over ready
   futures yields every 33rd iteration. Budget 1024: 16.5 → 8.8 ns with
   I/O pending.
5. **Layout.** A one-await machine is 152 B; 16 awaits is 272 B.
   - The 64 B header carries three per-TYPE function pointers
     (`cancel_pending_fn`, `__yo_resume_fn`, `__yo_set_effect_fn`, 24 B)
     that `header.type_id` already implies.
   - `Io` is stored twice: `__yo_param_0` (32 B, all-NULL, never read) and
     a shadowed capture (32 B).
   - There is one `await_future_N` pointer per await point, although at
     most one is live (128 of 272 B at 16 awaits).
   - RC locals are never slot-shared, and statement temps dropped at scope
     end become struct fields (and hold heap memory across awaits).
   - A one-await machine could be about 64 B.
6. **Code size.** About 98 C lines, 4.1 KB of C and 358 B of machine code
   per await. In `yo.c` itself: 143 resume functions, 49k lines, 2.65 MB
   (2.2%), plus 147 near-identical `set_effect` functions (153 KB).
   Outlining the cold paths gains only 7%. Most per-await bytes are the
   inlined child constructor.
7. **`set_effect` via strcmp.** It costs 72 instructions per cold start,
   and the future's concrete type is usually known at the call site. A
   direct store is possible.

The doc claim "~10–50 ns per poll" holds only for ready awaits. "~200 B per
state machine" is about right.

**Re-measured 2026-09-29, after phases 2 and 3** (callgrind instructions per op, same programs; the seed v0.2.45 before, the phase 2/3 branch after):

| Path | before | after |
|---|---|---|
| plain sync fn call | 44 | 44 |
| await of an already-completed future | 61 | 58 |
| cold `sync_fut_t` leaf | 648 | 325 (−50%) |
| cold state machine that completes synchronously | 852 | 361 (−58%) |
| the same, with I/O parked in the kernel | 732 | 325 (−56%) |
| one-await chain (`d1`) | 1662 | 688 (−59%) |
| chain depth 4 / 8 | 4187 / 7220 | 1669 / 3255 (−60% / −55%) |
| chain depth 4 with parked I/O | 4607 | 1669 (−64%) |
| `main`'s own cold await | 510 | 347 |
| spawn 100k one-await machines, then await each | 1718 | 1638 |
| spawn 100k no-await leaves, then await each | 691 | **1239** (+79%) |

The last row is the owning `JoinHandle`'s own allocation (`issues/an-owning-join-handle-costs-an-allocation-per-spawn.md`, phase 7).

Wall clock, same box, interleaved runs (median ns/op, before → after):

- cold leaf 70 → 25;
- cold state machine 83 → 28;
- the same with parked I/O 204 → 24;
- depth 4: 442 → 146;
- depth 4 with parked I/O: 1100 → 157;
- ready await with parked I/O: 10.6 → 3.9;
- leaf spawn: 134 → **211**.

### 3.5 Control-flow shape matrix

The shape sweep (await placement × control-flow construct × a suspending or
synchronously completing inner future × `-O0`/`-O2`, with expected values
from the same program written synchronously) is in §8.

- 11 of its findings are new bugs (the §3.2 rows from
  `three-deep-nested-while…` down).
- Every failing shape nests an await in a branch or loop that ALSO contains
  another suspension, or inside an expression.
- Every straight-line shape and single-level branch shape passed.

That is the §3.1 diagnosis, measured: the continuation emitters are where
the failures are.

---

## 4. Target design

Four properties, each removing a bug class from §3.

1. **One lowering path for every placement.** Before emission, every await
   is at statement position (`t := await(f)`) in the macro-expanded tree.
   This removes E0904, the whitelists and macro blindness.
2. **Emit the body once.** The resume function is the body's ordinary C,
   generated in one pass by the ordinary expression generator. Each
   suspension point becomes

   ```c
   sm->state = K;  <store future>;  <ready? goto resume_K>;  <cold start>;  <register waiter>;  return;
   resume_K: ;     <extract result into t>
   ```

   The resume point sits wherever the await is, inside any nesting, and
   the function opens with `switch (sm->state) { case K: goto resume_K; … }`.
   A `goto` into a nested block is legal C11, and the audit verified that
   codegen emits no GNU statement expressions, no `cleanup` attributes and
   no VLAs, which are the only constructs that forbid it. Dispatch is by
   `goto` rather than by `case` labels placed in the body because Yo's
   `match` lowers to C `switch`, which would capture them. Structured C
   `while`/`if`/`switch`, `break` and `continue` then survive suspension
   unchanged, so the continuation emitters, the active flags and every
   duplicate-label bug disappear.
3. **Liveness decides storage.** A value is a struct slot if and only if it
   is live across some suspension. "Use" includes its pending scope-end
   drop. Slots are assigned by interference and may share memory across
   types, RC included. Each state has a live-set table, which is what
   dispose on abort drops. "Drop every cross-boundary local on -2, hoping
   memory is NULL" goes away.
4. **One protocol helper per transition.** `complete`, `abort` and
   `cancel` are runtime functions over the common header. Each wakes ALL
   waiters (a waiter list), and `cancel` recurses into the future the task
   is suspended on. Generated code calls them and never re-implements
   them.

**The IR.** Emission runs over a small codegen-side tree (not a new AST: its
leaves reference existing `AstExpr` nodes, so ExprInfo stays valid). Nodes:

- `Stmt(expr)`
- `Bind(target, expr)`
- `Await(slot, future_expr, target)`
- `If(cond, then, else)`
- `Switch(match_expr, arms)`
- `Loop(cond?, body, step?)`
- `Break`, `Continue`
- `Return(expr?)`
- `Block(stmts, scope_drops)`

Normalization produces it from the macro-expanded body by hoisting each
await out of its enclosing expression. Operands evaluated before the await
in source order are spilled to temps first, which keeps evaluation order
exact. Laziness is kept explicit:

- a `cond` whose later condition awaits becomes nested `If`;
- `a && await(f)` becomes `If(a, t := await(f), t := false)`;
- a `while` condition await becomes
  `Loop(body: { c := await; If(!c, Break); … })`.

The same tree drives liveness and emission.

## 5. Phases

Every phase lands as one or more PRs off `develop` (stacked where they
depend on each other). **Local gates for a `src/` PR:**

- `yo check ./src`;
- `yo fmt --check` on changed `.yo` files;
- a stage-1 build (`yo build`);
- the affected test files with the stage-1 binary (`tests/async*`,
  `tests/async/`, plus the new regression tests), ASan on;
- `S1=<stage-1> bash scripts/bootstrap/gates_fast.sh`;
- for any change to emitted C, `bash scripts/bootstrap/fixpoint_only.sh`.

Docs-only PRs gate on `scripts/check-issue-refs.sh`. Every bug fix follows
`AGENTS.md`: a test that fails before and passes after, and the issue doc
moved to `fixed/` in the fixing commit.

### Phase 0: make failures loud, give the tests teeth

1. **Fix the ASan probe** (`sanitize-address-is-silently-dropped-for-a-bare-output-name.md`).
   Otherwise every memory-bug repro below "passes".
2. **No silent fall-through in the SM emitters.** Every branch that today
   emits nothing, a `// Warning: …` comment or a `/* Error: … */` string
   becomes a `codegen_user_error` (with an E-code, when the program is
   legal but unsupported) or a `codegen_fatal` (for an internal
   invariant). Sites:
   - `generate_remaining_expr_future`'s tail;
   - the `:=`/`=` arm of `generate_while_body_with_await`;
   - `generate_cond_branch_with_await`'s dispatcher;
   - the 37 `/* Error: */` returns in `exprs/async.yo` and friends.

   Exit: `await-inside-an-expression-in-a-later-cond-arm-is-dropped` and
   `async-cond-value-with-await-arm-inside-while-yields-zero` fail at
   compile time instead of running wrong.
3. **E0904 in the evaluator** (`await-placement-rules-only-enforced-in-codegen.md`).
   The placement predicates move next to `analyze_await_points`, so
   `check` and `lsp` report the same span as `compile`.
4. **Shape corpus.** `tests/async/sm_shapes.test.yo` covers the §8 matrix
   with expected values, sync and suspending inner futures, and loops run
   0, 1 and 1000 times. Shapes that do not compile yet are listed in a
   `known-unsupported` block that phase 5 empties. This is the
   differential oracle for phases 4–6.

### Phase 1: point fixes for the ownership and store bugs

Each fix ships with the issue's repro as a regression test.

1. `emit_await_future_store` owns both store rules (borrowed → `incr_rc`,
   named → no slot), and every store site calls it, including
   `generate_remaining_expr_future`'s two raw stores and the while-body
   binding branch. This fixes
   `async-second-cond-arm-await-of-a-field-future-frees-it` and
   `named-future-awaited-in-a-while-emits-missing-await-future-field`.
2. The event-loop reference is taken only on the cold start
   (`awaiting-an-already-started-future-from-a-state-machine-leaks-it`).
3. `_rc_field_retain_line` and `_rc_field_drop_line` fall back to
   `generate_dup_code_for_value` / `generate_drop_code_for_value`, plus a
   unit test over a type matrix that both emit or neither does. This fixes
   `abort-dispose-never-drops-…` and `nested-io-async-string-capture-…`.
4. A discarded spawn handle is dropped
   (`statement-level-io-spawn-leaks-the-state-machine`).
5. Capture analysis honours parameter shadowing
   (`io-async-param-shadowing-…`).
6. A D1 reach record only for `Send` closures
   (`a-non-send-closure-reading-a-global-marks-it-thread-reached`).
7. `Impl(Future)` fields: upcast at initialisation, or reject at check
   (`impl-future-struct-field-…`; the decision is recorded in the issue).
8. The recursive condition-await hoist inside arms
   (`if-await-in-a-match-arm-…`). Phase 4 subsumes this; do it only if
   phase 4 slips.
9. The still-reproducing shape issues (§3.3 and §3.2) that do not need the
   new lowering:
   - non-ASCII setter member names;
   - unit locals across an await;
   - the sync-future `Impl(Fn)` capture;
   - braced `case` bodies
     (`tail-primitive-match-with-three-arms-redefines-continuation-fn`);
   - the `=`-reassign old-value drop
     (`reassigning-a-heap-local-from-an-await-leaks-the-old-value`);
   - the thread-exit frees (`thread-local-async-registries-leak-at-thread-exit`);
   - the sync `while` step block
     (`a-begin-block-step-in-a-three-argument-while-reads-an-undeclared-local`).

   Everything in the control-flow family is left to phase 5 on purpose.
   That covers the `cond_branch_N` numbering, the duplicate labels, the
   3-deep loop, the two-await arm, `break`/`continue` in arms, a hoisted
   condition plus an arm await, step+body awaits, primitive-match drift and
   the arm-reassign leak. Each would be another special case in the
   continuation emitters that phase 5 deletes. Phase 0.2 makes the ones
   that are silent today loud where the fall-through is detectable, and
   the shape corpus pins them.

### Phase 2: the runtime protocol (waiters, abort, cancellation)

1. **A waiter list.** The header keeps one inline waiter, and extra waiters
   chain through pooled `__yo_continuation_t` nodes. Completion wakes all
   of them, in FIFO order
   (`two-tasks-awaiting-one-pending-future-lose-the-first-waiter`).
2. **`__yo_future_complete` / `__yo_future_abort` runtime helpers.**
   `emit_async_future_completion`, `emit_async_future_escape`, the
   resume's `-2` guard, `cancel_pending` and `__yo_join_handle_abort_raw`
   all call them. Abort wakes the waiters
   (`aborting-a-task-never-wakes-its-awaiter`).
3. **Structured cancellation.**
   - Every SM future gets a `cancel_pending_fn`. It cancels the future in
     its live `await_future_N` slot (or its named suspended-on future),
     recursively, then runs abort.
   - `Channel.recv`/`send`, `Mutex.lock` and `Park` deregister their
     waiter on cancel.

   This fixes `abort-does-not-cancel-a-nested-future-…` (all three repros).
4. **The unwind/abort path in the synchronous await**
   (`unwind-from-a-handler-installed-inside-io-async-exits-main-with-rc-0`):
   an aborted task's unwound value is read only by the frame whose handler
   produced it, and typed by that frame.

### Phase 3: cheap performance wins on today's emitter

These are independent of the rewrite, and phase 5 keeps them.

1. No malloc+memset→calloc fusion (§3.4.1): initialise fields explicitly
   in `__yo_new_*`, or keep the zeroing out of clang's reach. Measure the
   same change for all `__yo_rc_alloc` + `memset` sites.
2. A synchronously completing cold child continues inline while the budget
   lasts (§3.4.2).
3. Same-step handoff of the woken parent in `__yo_async_run_ready_tasks`
   (§3.4.3), and `sync_fut_t` completion made consistent with it.
4. A per-thread, per-scheduler-step inline budget instead of per resume
   call (§3.4.4).
5. `set_effect` as a direct typed store when the awaited future's concrete
   type is known, and one shared setter body per layout (§3.4.7).

Exit: the §3.4 table re-measured and recorded here. Targets: cold sync
child ≤ 25 ns, depth 4 ≤ 120 ns, the same with parked I/O ≤ 150 ns.

### Phase 4: normalisation and the IR (no emission change yet)

1. Build the IR (§4) from the macro-expanded `io.async` body, with the
   await-hoisting and laziness rules. It covers every `AstExpr` form that
   can contain an await, including user macro expansions and `if`.
2. Liveness over the IR: per suspension point, the live set with pending
   scope drops counted as uses.
3. **Shadow mode.** Compute both the IR's slot set and today's
   `compute_cross_boundary_variables` result for every async block in
   `./std`, `./src` and `tests/`, and report differences under
   `YO_DEBUG_ASYNC_IR=1`. A difference is either an old-path bug (file it)
   or an IR bug (fix it).

Exit: IR construction succeeds for every async block in the three trees,
and the shadow diff is empty or fully explained.

### Phase 5: the single-pass resumable emitter

**Implementation design (refined 2026-09-29, from reading the emitters).**
The seam already exists. Inside an SM, `generate_await`
(`src/codegen/exprs/await.yo`) emits nothing today and returns a
substitution. In the new mode it emits the whole suspension INLINE, at the
point where the ordinary expression generator reaches it, and returns the
extracted result as the expression's value:

```c
// await K (analysis index K-1)
sm->await_future_K = <future>;          // emit_await_future_store; a named future stores nothing
sm->state = K;
<ready?  budget: goto __yo_resume_K>    // the §3 fast paths
<cold start + effect injection>
__yo_future_add_waiter(<acc>, <resume>, sm);
return;
__yo_resume_K: ;
<aborted? escape>                       // the existing extraction prologue
<result temp> = <dup of acc->result>;  <release the slot>
```

The resume function is then:

```c
if (sm->state == -2) { <aborted-entry guard> }
switch (sm->state) { case 0: break; case K: goto __yo_resume_K; … default: return; }
<the body, generated ONCE by generate_begin in SM context>
<completion with the body's value>
```

The body is generated into a scratch emitter first, so the dispatch switch
lists exactly the labels that were emitted. That includes awaits the
analysis never saw, such as the ones inside user-macro expansions.

This is legal C11 because a `goto` may enter any block except a VLA scope,
and the audit verified that codegen emits none, nor statement expressions
or `cleanup` attributes. `match` stays a C `switch`, which is why the
dispatch is by `goto` and not by `case` labels in the body. What does NOT
survive the jump is a **C local** written before the suspension and read
after it. The design rules follow from that:

1. **Slotting.** Every Yo variable, pattern binding and minted temp of the
   body lives in the SM struct. That is the whole `captured_variables`
   list; phase 6 narrows it by liveness. Rendering already goes through
   `state_machine_variables` (`sm->var_…`), and minted temps through
   `_store_temp_var_to_state_machine_if_needed`. So what changes is the
   filter (`cross_boundary_ids` = everything), not the renderer.
2. **Helper locals.** An emitter that declares a C-only local, emits a nested
   user statement list, and uses the local afterwards must slot it. Known
   cases: a match scrutinee temp dropped after the arms, and a condition
   temp dropped after a `cond`. Written-after-resume locals (a begin block's
   value temp, a cond/match result temp, a result temp) are fine. Each case
   gets a corpus shape under ASan.
3. **Evaluation order.** An await nested inside a larger expression is
   hoisted by construction (its statements are emitted before the enclosing
   expression's text). That is exact when every operand evaluated before it
   is a literal or a local variable read. Otherwise the earlier operand must
   be spilled first, and until that exists it is a coded user error (the
   E0904 family, which then covers only this one shape). Laziness is free:
   an await in a later `cond` condition, or on the right of `&&`, is emitted
   inside the branch that evaluates it.
4. **One emission per await.** `generate_await` records the await's id and
   refuses a second emission (`codegen_fatal`). An emitter that generates an
   expression twice would duplicate a label.
5. **The analysis follows every macro expansion** (not only `if`), so a body
   whose awaits all come from a macro becomes a state machine
   (`io-await-inside-a-macro-expansion-…`).

With emission done this way, the IR of §4 is needed only for phase 6's
liveness, not for phase 5.

1. Emit from the IR as in §4, behind `YO_ASYNC_LOWERING=ir`. It reuses the
   existing expression generator, SM-variable naming
   (`state_machine_naming.yo`) and `emit_await_future_store`. Loops are C
   `while`, `match` is the ordinary C `switch`, and `break`/`continue`/
   `return` are the ordinary emitters plus the pending-drop rules.
2. **Differential.** The phase-0 shape corpus, `tests/async*`, `std`'s
   tests and the self-build, run under both lowerings with identical
   observable output. Then the stage-2/stage-3 fixpoint under the new
   lowering.
3. Flip the default. Delete the segment/continuation machinery: the
   `*_continuation` emitters, `_fsm.yo`, `hoist_non_splittable_awaits`,
   the placement predicates and E0904 (retired, since every placement is
   legal), `CondBranch`/`WhileLoopInfo`/`AsyncCondBranchInfo` and their
   context fields, `split_body_at_suspension_points`, and the
   `SuspensionPoint` base layer. Expect about 8–9k lines to go.

   Exit: every `known-unsupported` shape in the corpus passes, the
   macro-await repro and `for_await` work inside a task (unblocking
   `FOR_AWAIT_NEEDS_MACRO_AWARE_ASYNC_TRANSFORM.md`), and the §3.1 issue
   families are closed. That is, every §8 failing row, plus
   `async-nested-cond-await-duplicate-while-labels`,
   `async-postwhile-multiple-await-ifs`,
   `async-cond-value-with-throwing-arm-after-await-undeclared-temp`,
   `if-await-in-a-match-arm-…`, `io-await-inside-a-macro-expansion-…`,
   and `await-placement-rules-only-enforced-in-codegen` (E0904 retired).

### Phase 6: layout from liveness

1. Slot allocation by interference over per-state live sets, across types
   (RC included). There is one `await_future` slot, unioned, and
   `await_result` is unioned too.
2. A per-state live-set table drives abort dispose (and cancellation). This
   is the structural fix for the abort double-drop and leak family.
3. The header shrinks:
   - the per-type function pointers move behind `header.type_id` (a
     vtable);
   - `result` moves after the fixed fields;
   - `Io` is zero-sized in SM fields.

   Target: one-await machine ≤ 72 B, 16 awaits ≤ 96 B.
4. Statement temps are dropped at their last use when that precedes a
   suspension, so they do not pin heap memory across the await.

### Phase 7: allocation per await

After phase 3, malloc/free is about half of a cold await. Options,
measured before choosing:

- a per-type free list of state machines;
- embedding an immediately awaited child's machine in the parent's slot
  (Rust-style: the child's lifetime is exactly the await), falling back to
  the heap when the future escapes;
  designed in `plans/backlog/ASYNC_AWAIT_SITE_FUSION.md` for the
  single-await wrappers that make up half of std's `io.async` blocks
  (measured: ~180 ns a round trip of std's `TcpStream` ping-pong);
- **the spawn handle without a box.** `JoinHandle(T)` is a `ref` struct
  around the future pointer: one extra allocation per spawn
  (`issues/an-owning-join-handle-costs-an-allocation-per-spawn.md`, +79% on
  the leaf-spawn benchmark). The future is already counted, so the handle can
  be that counted reference itself.

### Docs and instructions, per phase

- Phase 0/1: `.github/instructions/c-codegen.instructions.md` (store-rule
  owner, no silent fall-through, per-state drops); the
  `docs/{en-US,zh-CN}/ASYNC_AWAIT.md` performance numbers (§3.4).
- Phase 2: the ASYNC_AWAIT "Multi-Await", "Aborted Futures" and
  cancellation semantics.
- Phase 5: rewrite the "State Machine Transformation" and "Where `await`
  may appear" sections (every placement legal), and the
  `testing.instructions.md` note that `yo check` now sees async rules.
- Phase 6: "State Machine Memory".

## 6. Risks

- **Evaluation order during hoisting.** Spilling earlier operands must
  match the evaluator's order exactly. The shape corpus includes
  side-effecting operands (`f() + await(g)`, `a.b(await(c))`) with
  observable order.
- **Drops across jumps.** A `goto resume_K` into a scope skips C
  initialisers. Liveness must treat every value whose drop or read follows
  the suspension as live. The old path's
  `_store_temp_var_to_state_machine_if_needed` rule is the precedent. ASan
  on the corpus is the gate.
- **Compile time.** The IR plus liveness must not regress `yo check ./src`
  or `yo build`. The phase-4 exit measures both.
- **Bootstrap.** The new lowering compiles the compiler (143 resume
  functions in `yo.c`), so the fixpoint gate is mandatory before the flip.
  Keep the old path until the flip PR is green on every CI arm.

## 7. Metrics to track

- Open async-SM issues: 24 at the audit, plus the 27 it filed (§3.2).
- Silent-wrong-value shapes in the corpus: must reach 0 in phase 0.
- The §3.4 table.
- `sizeof` of the 1-, 4- and 16-await machines.
- Resume-function bytes in `yo.c`.
- Lines in the SM generator.

## 8. Appendix: control-flow shape matrix results

The sweep used a tree build of `af62bdb28`, cross-checked on the v0.2.45
seed. Each shape was run with a suspending and a synchronously completing
inner future, at `-O0` and `-O2`, and under ASan. The repros are committed
as `issues/repros/async-shape-*.yo`, with expected vs actual on line 1.

### Failing

| Repro | Shape | Result |
|---|---|---|
| b1a, b1c, b1d | await inside `+`, a call argument, or an arm tail value, in an if/cond arm | wrong value (statement dropped) |
| b1b | `acc = (acc + await)` in a while body | SIGSEGV |
| b1e | await in the awaited future's argument, top level | SIGSEGV (not rejected) |
| b2 | 3-deep while, await innermost | wrong value |
| b3a, b3b | arm with two sequential awaits, nested if or loop | wrong value |
| b4a, b4c | `break` after an await in an if or enum-match arm | wrong value |
| b4b | `continue` after an await in an arm | C error |
| b5a | `r := match(await, …, 1 => await, …)` | uninitialized read |
| b5b, b5c, b5d | condition/scrutinee await plus an arm/body await | C errors |
| b6a, b6b | await in the while step and the body | C error / SIGSEGV |
| b7 | primitive match arm with a while-await, then trailing code | wrong value |
| b8 | tail primitive match, 3+ arms, one awaiting | C error |
| b9 | `v := match(… await arm …)` inside a while | yields 0 |
| l1, l2 | `s = await` reassigning a heap local; reassignment in an arm after a loop await | leaks |
| d1 | begin block as a value containing awaits | misleading E0904 hint |

### Passed

- **Straight-line and branches:** await as a statement, `x := await`,
  `x = await` (int), await as the tail value; `if` without else, if/else, a
  3-arm cond with the middle arm awaiting (as a statement and as a value),
  a cond as the tail value, `r := match(n, … => await)`; enum match payload
  bindings used after an await (value and statement); a nested cond inside
  a match arm after an await; two and three sequential awaiting `if`s
  (including the same local name in both arms); nested ifs 2 deep with an
  await per arm, and 3 deep with an await only innermost; a top-level `if`
  with 2 awaits; `if(await_bool)` and `match(await)` with no arm await;
  early `return` after an await, including inside a nested cond. An
  arm-local read after the cond is correctly rejected (E0401).
- **Loops:** await in the body; as the condition (no body await); in the
  3-arg step (no body await); 2-deep nesting; 3 levels mixing `if` and
  `while`; `break`/`continue` before and after an await at loop level; a
  separate `if(…, {break;})` after an arm await; `continue` with a step;
  early `return` from a loop, from a 2-deep loop, and from a loop in an
  arm; `while` inside an if/else/middle-cond/enum-match arm; if/elif chains
  and enum matches inside loops; counters and locals mutated across awaits
  and read after the loop; 0, 1000 and 1,000,000 iterations (no growth, no
  hang); two loops in sequence, then an await after them.
- **Heap values:** String and ArrayList locals across awaits in loops,
  arms, nested loops, and with `break`/`continue`/`return`; an
  `Option(String)` payload used after an await. Values were correct and
  ASan clean.
- **Effects:** an IoExn throw from the awaited future inside a loop, an arm
  or a cond value unwinds as expected.
- **Ownership** (the lifecycle sweep):
  - RC locals across 1–3 awaits; abort at a sleep, a nested SM, a woken
    Park and a yield (`ref` counts exact);
  - a local moved before an await, then aborted (no double drop);
  - a cold future dropped unawaited (captures released);
  - a completed RC result awaited twice;
  - a future passed as a parameter or captured;
  - `join_all`, `race_first`/`any_first` (`ref` counts), `timeout` won and
    lost;
  - recursive self-await 1M deep at `-O0` and 5M at `-O2`;
  - 1M sequential awaits (flat 4 MB RSS);
  - 100k spawned tasks with `join_all` (all disposed).

## 9. Progress log

- 2026-09-28: audit landed (#985).
- 2026-09-29: phase 0/1 batch in progress on `async-sm-p0p1`:
  - the ASan probe fix;
  - store sites via `emit_await_future_store`, including named futures in
    loops;
  - the running-task reference taken only on cold start;
  - the retain/drop inline fallbacks;
  - `=`-reassign release;
  - braced primitive-match cases;
  - no silent fall-through in the cond-branch and while-body emitters.
  - the D1 thread-reach fix: a non-Send closure no longer marks the globals it
    reads as thread-reached; reads are recorded per fn and promoted only from
    Send roots;
  - the cond/match value in a while body routed through the await-carrying
    emitters, which removes the `std/fs/dir.yo` workaround;
  - the abort dispose skips pattern-binding slots, which borrow the scrutinee.
    The String drop fallback exposed this; a `ref` payload binding was already
    a use-after-free.
  - Tests: `tests/async/sm_ownership.test.yo` (10). CLI goldens:
    `sanitize-address-bare-output-name` and the two E0904 cases.
- 2026-09-29: phase 2/3 batch on `async-sm-p2` (stacked on p0p1):
  - `__YO_FUTURE_PREFIX` is shared by every future, including the raw I/O one;
  - the waiter list;
  - `__yo_future_abort` with structured cancellation through
    `cancel_pending_fn(fut, prev_state)`;
  - the park cancel hook, with `Mutex`/`Channel` skipping dead waiters;
  - an owning `JoinHandle` (detach on drop);
  - the `__yo_rc_alloc` calloc-fusion barrier;
  - inline continue after a synchronous completion (budget 1024);
  - the same-step handoff.
  - Tests: `tests/async/sm_protocol.test.yo`.
- 2026-09-29: phase 0/1 merged (#989).
- 2026-09-29: phase 2 item 4 (unwind identity) joins the phase 2/3 PR:
  - an `unwind` carries its handler literal's id (`__yo_unwind_target`);
  - a frame catches exactly the handlers written in its own body, and the
    catch in an `io.async` block resolves its future;
  - the task-abort registry transports the target and value between tasks;
  - a statement-level spawn's handle is materialized, so it is dropped.
  - All six phase-2 issues are closed, with tests.
- 2026-09-29: phases 2 and 3 merged (#991). The unwind value check inside an
  `io.async` body merged separately (#994: a re-raised flow violation is
  re-flagged, so it survives nested trials).
- 2026-09-29: phase 5 on `async-sm-p5`. The single-pass emitter sits behind
  `YO_ASYNC_LOWERING=inline`, and the shape corpus is
  `tests/async/sm_shapes_{1..4}.test.yo` (129 cases).
  - First differential, one case per batch: inline 126/129, old lowering
    78/129 (20 E0904, 22 wrong results, 9 C compile failures).
  - Found and fixed on the way (rule 1, "everything lives in the task"):
    - await results were C locals, lost when a second await in the same
      expression suspended first;
    - pattern bindings were C locals shadowing their slots, now resolved by
      declaration site;
    - result fields are keyed per await expression, since the analysis
      merges branch awaits into one point;
    - a sync bug: a begin-block `while` step dropped its declarations
      (`issues/fixed/a-begin-block-step-in-a-three-argument-while-reads-an-undeclared-local.md`).
- 2026-09-29: phase 5 flipped on `async-sm-p5-flip`. The single-pass
  lowering is the only lowering, and the segment/continuation machinery is
  deleted (about 7.9k lines: the `*_continuation` emitters,
  `suspension_codegen.yo`, `CondBranch`/`WhileLoopInfo`/`AsyncCondBranchInfo`
  and their context fields, the placement predicates). E0904 now covers only
  the `inout` rule.
  - Found and fixed after the flip:
    - a materializer that compares a temp name with the raw code redeclared
      a self-named atom whose rendering is its slot (`T known = sm->var_known;`,
      the stage-2 `_compiler_identity`): `is_self_named_atom`, now tested at
      every such site;
    - a pattern binding of a scrutinee known at compile time is bound
      compile-time-only, and the analysis skipped it, so it had no slot;
      now a compile-time-only variable is skipped only when its read folds.
  - Closed with the issue reproducers as tests (`tests/async_await.test.yo`
    and `tests/async/channel.test.yo`): every §8 failing row, plus
    `async-nested-cond-await-duplicate-while-labels`,
    `async-postwhile-multiple-await-ifs`,
    `async-cond-value-with-throwing-arm-after-await-undeclared-temp`,
    `if-await-in-a-match-arm-is-rejected-as-a-later-cond-branch`,
    `io-await-inside-a-macro-expansion-is-emitted-as-a-blocking-await` and
    `await-placement-rules-only-enforced-in-codegen`.
  - **Seed-gated.** `src/` and `std/` are compiled by the seed, so they keep
    the old safe spellings (await bound before a scrutinee or compound
    condition, statement-form `cond` after an await, no await in a macro)
    until `SEED_VERSION` carries this lowering. For the same reason
    `std/async/stream.yo`'s `for_await` waits for that bump. The
    cheatsheets say so. Lesson (from #996): build stage 1 with
    `yo build --std-path ./std`, as CI does, or the seed never compiles the
    tree's std and a seed-incompatible std change passes every local gate.
- 2026-09-29: the rest of phase 1, on `async-sm-p1rest` (stacked on phase 5):
  - item 5: the capture tracker takes the innermost binding, so an
    `io.async` parameter shadowing an outer name does not capture it;
  - item 7: `Impl(Future(T, E))` struct fields are supported (option 2 of
    the design question): the value is upcast to the future interface at the
    constructor, in a value-struct literal and at an assignment;
  - item 9:
    - non-ASCII effect-setter paths are sanitized;
    - the no-await block's `Impl(Fn)` capture reads `closure_context`;
    - the unit local has no slot (the single-pass lowering).
  - Also: a hollow `io.async` body reports the error its trial swallowed
    instead of E0905, and the async emitters' `/* Error: … */` markers are
    `codegen_fatal`.
  - §3.3's "fixed but not closed" issues are closed with a pinning test, or
    retired where their subject is gone.
