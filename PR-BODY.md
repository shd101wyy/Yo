# R7 — the parser drops `ref(...)`/`atomic(...)` (WORK IN PROGRESS)

**Status: INCOMPLETE — do not merge.** This branch is the parser-drop lane's
work-in-progress handover. Package 2 (the tree's own remaining `ref`
declarations — a scope discovered at diagnosis to be ~50 declarations, not the
7 the task's single-line grep finds) is roughly two-thirds converted; the
checker-fix loop has not converged yet, and packages 3–7 (the actual parser
drop, the flag reread, tests, cli fixtures, docs) have not started. The
commits are per subsystem so the remainder can be reviewed incrementally.

## Summary

What this PR will be when complete (ledger row R7,
`plans/handover/VBD_V0279_RETIREMENTS_AND_CLAIM.md`):

- Every `ref(...)` / `atomic(...)` declaration is E0009 with structured repair
  naming the `Rc(S)` / `Arc(S)` spelling; the `BK_REF`/`BK_ATOMIC` evaluator
  arms (`src/evaluator/exprs/_expr.yo:817-964`) are deleted.
- The LSP keyword list (`src/lsp/completion.yo:125,141`), the VS Code grammar
  (`vscode-extension/syntaxes/yo.tmLanguage.json:145`) and `syntaxes/yo.vim:56`
  drop `ref`/`atomic`.
- The 163 `is_reference_semantics`/`is_atomic_rc` reader sites are reread as
  cell-payload flags (the only remaining producer after the drop is
  `evaluate_cell_type`, `src/evaluator/types/struct.yo:588`).
- The tests #1788 kept and the 13 cli fixtures are rewritten; the effect
  records' `Copy` lands as the ctl return rule in the checker (std's own
  derives are Generation B, v0.2.80 — confirmed with the coordinator).
- Docs: DESIGN's "mut gates four writes" exemption, "Replacing a `ref`
  declaration", the deleted-mode-words note, ERROR_DIAGNOSTICS' two ref-handle
  sentences — both languages.

### Package 1 (diagnosis) — complete

- `ref`/`atomic` are NOT lexer keywords: they are call-shape intercepts at the
  evaluator's dispatch (`ast_expr_is_fn_call_of(expr, BK_REF/BK_ATOMIC, ...)`).
  There are no lexer/token/parser arms to delete; the "parser drop" is the
  evaluator dispatch arms plus the E0009 replacement.
- The E0009 machinery to extend: `ast_expr_is_old_mode_spelling`,
  `old_mode_spelling_message`, `deleted_mode_spelling_error`
  (`src/expr.yo:1051-1087`); the registry entry `E_DELETED_SPELLING`
  (`src/diagnostics_registry.yo:267`, both languages) needs the ref/atomic
  sentence; repairs via `format_error_message_with_repair[_at]`
  (`src/error.yo:363`).
- Effect records' Copy: `derive(Exception, Copy, Clone)` fails on the v0.2.78
  seed with "A function's result type cannot be control-bound" (measured;
  unconditional rejection at `src/evaluator/calls/function_type.yo:1296` and
  `src/evaluator/values/anonymous_function.yo:2554`). The coordinator confirmed
  the split: the ctl return rule lands in this PR's checker + tests; std's
  derives and the `type_lacks_copy_for_flip` exemption deletion are v0.2.80
  Generation B.
- Test surface (package 5): the #1788 "Kept" list PLUS the deferred leftovers
  now on develop: `dyn.test.yo:1347` `_DrsObj`, `error_source_chain.test.yo:68`
  `_Child`, `borrow_spelling.test.yo:58` `Node`, `http/http.test.yo:1005/1583`
  `_KaStats`/`_PipeReader`. `check-strict-borrow-loop-calls-a-read-only-method`
  no longer exists. The negative E0009 rows go in
  `tests/parameter_modes.test.yo` (where the mode-word E0009 rows live).
- cli fixtures (package 6): 9 fixtures still write the forms
  (audit-rc-write-census, borrowed-for-through-a-cell-across-an-await-is-e0911,
  check-ref-struct-header-field, fix-migrate-unsized-views,
  inout-for-store-fresh-into-self-panics, the two local-borrow and two
  mut-match e0911 cases); 2 goldens carry ref-mentioning help text
  (check-accessor-copy-names-get-cloned, public-safe-report); 1 opts comment
  (ctl-handler-in-a-ref-struct-field-is-rejected). Of #1788's six
  inout-*-panics cases only inout-for-store-fresh-into-self-panics still uses
  `ref(`.

### Package 2 (the tree's own declarations) — in progress

**Scope discovery:** the task's grep `ref\(struct|ref\(enum|atomic\(ref` is
single-line and finds 7 declarations; the multi-line spelling
`X :: ref(\n  struct(...)` adds ~45 more (52 total, minus `AstExpr` — 3d's —
and `EvalValue` — 3e's). The coordinator confirmed all ~50 are R7's. The seed
(v0.2.78) accepts both spellings, so per-package `yo.cmd check ./src` gates
stay valid while the tree still spells the old form in the unconverted files.

Converted (committed on this branch):

- codegen registries and walk records (14 types): plain structs;
  `_MatchLabels` threads `&mut`; `_LiveVar` derives Copy and the walk's
  handle-writes become read-modify-insert through `&mut _LiveWalk` helpers.
- error/pattern/build/lsp/substitution records (13 types): plain structs with
  per-field/manual Clones; the LSP's didChange re-inserts a fresh `DocState`.
- evaluator analysis records and caches (~19 types): plain structs;
  `is_owning_the_same_rc_value_as` becomes `Option(Rc(Self))` (the
  self-referential indirection a value struct needs); the two in-place
  `ArgEntry` writes (legacy-str rewrite, comptime-self receiver patch) go
  through `ArrayList.with`, `evaluate_comptime_fn_call` takes
  `&mut ArgValues`; `LocalBorrowInfo`'s registry writes (transitive freeze,
  shorten-holder) go through `g_local_borrows.with_mut` + in-place `with`;
  `MethodEntry` gets an in-place registry updater
  (`update_type_trait_method_entry`) for the phase-A/provisional refreshes;
  `_MspCtx`/`_GrCtx` thread `&mut`; `Substitution` threads `&mut` through its
  writers.
- `VcSort` is `Rc(VcSortNode)`, the `VcTerm` shape (recursive payloads over
  the Rc; constructors `Rc.new(VcSortNode.X(...))`, patterns `Rc(.X(...))`).

Remaining in package 2:

1. **The impl-forcing cluster** (`ImplInFlight`/`ImplPendingField`,
   `src/evaluator/values/impl.yo` ~5053-5170, 5579-5800, 6098-6450,
   `src/evaluator/context.yo:3649+`): the record is pushed into
   `g_impls_in_flight` as a deep copy today-sharing-a-cell, and both the field
   loop (through its local) and the env-lookup forcing hook (through the
   stack) write it. Design decided, not yet implemented: the stack becomes the
   single owner — the forcing hook takes the entry OUT at its index
   (`xs.remove(i)`), runs the force on the owned value, and inserts it back at
   the same index BEFORE any `truncate_forcing_depths` (the stack is whole at
   the truncate); the Case-2/Case-3 field loops stop writing their locals
   after `push_impl_in_flight` and go through the stack top. Must land as one
   unit (loop and hook together) or the hook reads stale state.
2. **The checker-fix loop**: `yo.cmd check ./src --std-path ./std` until
   green. Round 3 (`tmp/check3.log`, killed at handover after its families
   were fixed) surfaced only `types/substitution.yo` copy sites (`s.*` out of
   `&mut Substitution` — all now `_subst_clone(s)`, committed); the next
   round gets past substitution's importers and will name the following
   families (expect: the Substitution/ArgValues `&mut` cascades' remaining
   call sites, `YoError` copy sites — fix pattern `err.clone()` — and
   whatever the impl cluster and the `VcSort` Eq derive surface). A cold
   check takes ~20-40 min on this Windows box (the Mac Mini timings do not
   transfer); budget accordingly, or use `--watch`/`--watch-once` once a
   resident checker is up. Fix pattern per family: copy sites get
   `.clone()`/`Rc.clone`, handle-write sites get `ArrayList.with`/`with_mut`
   in place, `&`-writes get `&mut` threaded.
3. A copy-then-write audit pass (the hazard: `map.get(k).Some(v) => v.field =
   x` silently writes a dying copy inside src/, which is exempt from the
   decision-47 local-mut rule — `is_global_mut_rule_exempt`,
   `src/evaluator/memory_safety.yo:273`). The audit script is
   `tmp/audit_copy_write.py` (gitignored); its 20 findings were each triaged:
   fixed in this branch where real, or verified take-modify-put/local-push
   patterns that stay correct.

## Verification

- Not yet green. `yo.cmd check ./src --std-path ./std` is the per-package
  gate; the last complete run (against a mid-conversion tree) is
  `tmp/check2.log`; a fresh run (`tmp/check3.log`) was still executing at
  handover. All 31 touched files parse and pass `yo.cmd fmt` (run per file —
  fmt doubles as the parse gate between full checks on this slow box).
- 7 commits on `v0279/parser-drop`, pushed: per-subsystem as instructed, so
  the rebase after 3d/3e merges stays mechanical. All rounds' known error
  families are fixed at handover (rounds 1-3 logs: `tmp/check1.log`..
  `tmp/check3.log`).

## LLM attribution

- Model: GLM-5.3 (ZCode CLI, parser-drop lane agent, coordinated by the v0.2.79
  main session)

## Deferred

- Packages 3-7 of the original brief (the drop itself, the 163-site reread
  table, tests, cli fixtures, docs) — blocked on package 2's completion.
- The effect records' std derives + `type_lacks_copy_for_flip` exemption
  deletion — v0.2.80 Generation B (coordinator-confirmed; the v0.2.78 seed
  rejects them evaluating std).
