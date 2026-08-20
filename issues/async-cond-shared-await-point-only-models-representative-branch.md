# async cond/match shared await point only models its REPRESENTATIVE branch

**Status:** FIX IMPLEMENTED 2026-08-20 (branch
`fix/async-cond-heterogeneous-await-slots`, commit 41592a403) — all shapes
verified fixed at runtime, 181/181 `tests/async_await.test.yo` green (15 new
regression tests incl. heterogeneous MATCH arms, NESTED cond arms, and the
reverse named/anonymous mix), 74/74 effects, emitted C clean of the
incompatible-pointer class (native strict-clang: 0). Awaiting full-suite +
fixpoint validation before moving to `issues/fixed/`.

Two more members surfaced while validating (same root, now also fixed):
- a MATCH arm whose value IS the await recorded no branch info at all
  (`remaining.len() > 0` gate), so even uniform tail-await match arms lost
  their value;
- NESTED cond/match arms: the outer `_store_cond_branch_info` overwrote the
  nested arms' records, leaving their (globally unique) dispatch codes caseless
  — the switch's `default:` then skipped the await entirely. Dispatch points
  now UNION branch records, and anonymous cases carry a NULL-slot guard so
  dead/outer codes and never-stored paths skip cleanly.
Supersedes `issues/windows-arm64-emitted-c-state-machine-pointer-mismatch.md`
(the Windows-arm64 sighting was one symptom of this; the defect is in the
emitter and affects EVERY target).

## Root cause

A `cond`/`match` whose branches await shares **one await point** across all
awaiting branches (one suspension state suffices — only one branch runs). But
everything hung off that await point — the `await_future_N` slot's C type, the
registration/extraction access path, the result type, the future-variable-ness,
the target binding — is taken from a single **representative branch** (the
first one the analysis saw). Every other awaiting branch is emitted through the
representative's model:

- `src/evaluator/shared/suspension_analysis.yo` (~line 540): branch suspension
  points are merged by depth position; one representative per position survives.
- `src/codegen/exprs/async.yo:755`: the slot is declared with the
  representative's future type (or not at all, if the representative awaited a
  named variable).
- `src/codegen/async/state_code_gen.yo` (`generate_cond_branch_with_await`):
  every branch stores its own future into the one slot.
- `src/codegen/async/state_machine.yo` (`_emit_await_suspension`,
  `_emit_prev_await_result_extraction`): readiness check, cold-start,
  continuation registration, abort check and result extraction all go through
  the representative's field and type.

The retired TS compiler has the identical structure (attic
`state-code-gen.ts:2527,2542`) — this is inherited, not a porting regression.

## The eight defect shapes (all reproduced 2026-08-20, `--release`, macOS)

Reproducers: `issues/repros/async-cond-branch-await-shapes.yo` (shapes 1–6)
plus the shape 7/8 regression tests in `tests/async_await.test.yo`. "anon" = the branch awaits a call
expression; "var" = it awaits a named local Future.

| # | branches | today's behavior |
| - | -------- | ---------------- |
| 1 | anon+anon, same result type, both tail awaits | **wrong value** (cond result stays 0) + ill-typed C |
| 2 | anon+anon, `String` vs `unit` results | ill-typed C; registration/extraction read WRONG OFFSETS for the non-representative branch — deadlock or RC-on-garbage once that branch's future actually suspends |
| 3 | anon+anon, representative result is `unit`, other branch binds | extraction skipped entirely (`is_prev_unit`); the bound variable reads a zeroed field |
| 4 | anon+anon, single awaiting branch whose VALUE IS the await | **wrong value** (0) — `r := cond(flag => io.await(f, io), true => i32(7))`; the branch has no remaining exprs, so nothing ever assigns the registered target |
| 5 | var+var (branches await different named futures) | **C compile fails** (`no member named 'await_future_N'`) — declaration took the var path, stores took the anon path; and registration polls the representative's variable, i.e. the WRONG future for the other branch |
| 6 | var+anon, same future type | **C compile fails**, same missing-field class |
| 7 | SINGLE awaiting branch, `x := io.await(named_var, io)` | **C compile fails** — the `:=`-await branch store always writes the slot, but the declaration site skipped it (`future_variable_id`); a var-await that BINDS inside a cond has never compiled |
| 8 | SINGLE awaiting branch, standalone `io.await(named_var, io)`; the OTHER branch taken | compiles, but the not-taken branch's **lazy future is cold-started and awaited anyway**: the "was the await branch taken" guard is `sm->var_X != NULL`, and a bound variable is never NULL. Side effects the program chose not to run, run (measured: marker incremented). A never-completing future would deadlock the state machine |

Shape 4 needs no heterogeneity at all and silently miscompiles in the current
release on every platform. Shapes 1–3 are live in the compiler tree itself:
the windows cross-emit shows five `-Wincompatible-pointer-types` sites, one of
which (`_7930`/`_7950`) pairs a `__yo_t2*` result with a `uint8_t` result —
shape 2. It has not misfired only because those futures complete synchronously
and the misread offset lands on a calloc'd-NULL `continuation_fn`
(`__yo_incr_rc(NULL)` no-ops).

## Why Windows arm64 exposed it first

The store `sm->await_future_N = <other branch's future>` is
`-Wincompatible-pointer-types`. On the x64 release leg that is a suppressed
warning; on the arm64 leg it is a hard error. **Not an architecture difference
— a clang version skew**: `windows-latest` pre-installs LLVM 20.1.8 (so
`choco install llvm` no-ops), while `windows-11-arm` has no pre-installed LLVM
and choco installs 22.1.7, where the diagnostic is a default ERROR that `-w`
does not downgrade. The moment GitHub's x64 image ships LLVM 22+, every leg
fails. The v0.2.12 arm64 emit was NOT clean either — its log died at mimalloc
first, and the earlier "CLEAN" reading of that log was wrong: this class was
present in that C too (same emitter, same tree).

## Fix design (implemented)

One authority for "is this await point branch-uniform?": the suspension
analysis records every branch's await expr per merged position
(`cond_branch_suspension_exprs` on `SuspensionPoint`). Codegen attaches each
branch's own await exprs to its `CondBranch` record.

- **Uniform-anonymous points** (all awaiting branches anonymous, same future C
  type, same io-ness — the overwhelming majority): emission unchanged,
  byte-identical C. Shapes 7/8 prove var-await points are broken even when
  "uniform", so ANY named-future branch routes to the dispatch path.
- **Dispatch points** (heterogeneous types, mixed io-ness, or any named-future
  branch): the slot is declared `void*` (stores are implicit
  `T*`→`void*`, no casts); suspension registration and result extraction are
  emitted inside the existing `switch (sm->cond_branch_M)`, each case accessing
  the future through ITS OWN exact type (cast from the erased slot, or the
  branch's `sm->var_X`), extracting per the branch's own result type directly
  into the branch's own destination (bound var field, or the cond's registered
  target). No cross-type field access survives anywhere.
- Shape 4 (uniform case): an awaiting branch with EMPTY remaining exprs whose
  value is the await itself gets `<target> = sm->await_result_N;` in its
  dispatch case.

## Implementation map (2026-08-20)

| piece | where |
| --- | --- |
| per-branch suspension exprs recorded on the merged representative | `src/evaluator/shared/suspension_analysis.yo` (merge loop), `cond_branch_suspension_exprs` on `SuspensionPoint` |
| the ONE dispatch/uniform predicate | `cond_await_point_needs_dispatch` (`src/codegen/async/state_code_gen.yo`) — consulted by declaration, stores, suspension, extraction, continuation. Uniform = all awaiting branches ANONYMOUS + same future C name; any named-future branch or type mismatch → dispatch |
| per-branch future access (cast/var-field/io-ness/result type) | `cond_branch_future_access` + `resolve_future_var_field` (same file); `CondBranch.await_exprs` carries each branch's awaits in order (depth = `ap.index - cond_branch_source_index`) |
| erased `void*` slot declaration | `src/codegen/exprs/async.yo` (`emit_async_block_struct_definition`) |
| per-branch stores (named branches don't store) | `generate_cond_branch_with_await`, `generate_remaining_expr_future` |
| per-branch registration switch (replaces the NULL guard) | `_emit_await_suspension_dispatch` + `_emit_await_suspension_core` (`state_machine.yo`) |
| per-branch extraction switch | `_emit_prev_await_result_extraction_dispatch` (`state_machine.yo`) |
| shape-4 target handover (uniform path) | `_emit_cond_branch_continuation` — empty-remaining await-value branch emits `<target> = sm->await_result_N;` in its case |

Uniform-anonymous points emit byte-identical C to before (the suspension core
is the same text, parameterized).

## Known open corner (documented, loud if hit)

A dispatch-mode point where one branch's await is a `while` CONDITION (reads
`sm->await_result_N` to decide the next iteration) is not given a per-branch
`await_result_N` write; if the shapes ever combine that way the emitted C
fails to compile (loudly) rather than corrupting. No such shape exists in the
tree, std, or tests.
