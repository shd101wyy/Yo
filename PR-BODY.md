# R7 — the parser drops `ref(...)`/`atomic(...)` (MOVED TO v0.2.80)

**Status: R7 moved to v0.2.80 by the coordinator at the 06:00 hard stop (2026-11-19); branch parked mid-package-3.** What remains for v0.2.80, one honest list:

1. Finish package 2's check-green loop: the full `check ./src` stood at **229/273 files passing** and was still converging (rounds logged `tmp/check21.log`..`tmp/check78.log`). The remaining families are the same mechanical E0901 shapes, currently in `src/evaluator/calls/function.yo` (MethodEntry/ArgEntry lists: `labels.get(`, `matching.get(`, `slots.get(` and friends → `get_cloned`), then whatever the next rounds surface; `check ./std` not yet run. Fix patterns are in the pushed commit history (`d3c3e0e1c`..`7ba828a8f`).
2. Package 3 (the drop) — fully scripted, NOT applied: `tmp/pkg3.py` (evaluator arms → E0009+repair naming `Rc(S)`/`Arc(S)`, LSP completion keywords, registry sentences en+zh, hint-text edits, the dead `header`-field check) and `tmp/pkg3b.py` (effect-records Copy: the derive-scope `in_derive_impl` exemption across flowability/derive/function_type/anonymous_function). Both scripts' anchors were verified against this tree; run, `yo fmt`, re-check.
3. Rebase onto develop `d8f0d89fa` (3e flip #1997 + emitter #1998 + E0604 skip-guard #2003): expect conflicts in `evaluator/calls/helper.yo` (`_eval_and_check_specialized_body`'s sb_skip guard — keep BOTH: the value-semantics conversion + the `> usize(0)` direction) and across the 156-file EvalValue retype sweep vs the package-2 rewrites (keep the flip's Rc spelling under the ownership fixes).
4. Build the stage-1 tree binary; run the tree-binary-only verification list: `rc`, `async_await`, `dyn`, `borrow_spelling`, `cell_handles`, `string`, `sync`/`refcell`, `parameter_modes` (incl. the new E0009 rows), `algebraic_effects` (the new derive(Copy,Clone)-on-effect-record row — needs the pkg3b checker half first).
5. Cli golden re-records (tree binary): `check-accessor-copy-names-get-cloned`, `public-safe-report` (both carry help texts pkg3 edits) + a verify pass over the 9 rewritten fixtures; `check-ref-struct-header-field` is DELETED with its diagnostic.
6. Gates: `check ./src` + `check ./std` clean, the rewritten test files green one-per-invocation, fmt with the TREE binary, `check-issue-refs.sh`, the cli-diff scorecard; then rewrite this body's Verification section with real numbers.

**Done and pushed** (branch `v0279/parser-drop`): packages 1, 4, 5, 6 (fixture half), 7; the tree's own ~50 multi-line `ref` declarations converted, with the whole-codegen/effects E0901 sweep that discovery forced — the honest number is 152 → 229 files passing across ~58 full-check rounds, because "~50 records" turned into a value-semantics conversion of every list consumer in `src/codegen/**` and `src/evaluator/effects/**`; impl.yo and await_analysis.yo green standalone; the impl-forcing cluster single-owner rework (`sync_in_flight_ctx_at`, `_mutate_impl_in_flight_at`, projectional accessors).

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

### Package 4 — the `is_reference_semantics`/`is_atomic_rc` reread (163 sites)

Post-drop the flags' only producer is `evaluate_cell_type`
(`src/evaluator/types/struct.yo`), reached through the reserved
`__yo_cell(V)`/`__yo_atomic_cell(V)` primitives inside std's `Rc`/`Arc`/
`RefCell` construction (`src/prelude.yo`). Every reader below was reread
against that input. Verdicts: **cell** = reads the cell-payload flag, fires
for `Rc`/`Arc`/`RefCell` payloads exactly as it did for `ref(...)` — no
change; **carry** = the flag rides a type node through a mechanical
copy/compare/hash — no change; **dead** = reachable only through a user
`ref(...)`/`atomic(...)` declaration, kept (harmless, and the reserved
primitives can still spell the shape in an unsafe file); **edit** = wording
or logic changed in this PR.

| File | Sites | Verdict |
| --- | --- | --- |
| evaluator/types/struct.yo | 23 | 1 edit (the dead `header`-field check, deleted), 1 dead (the `force_reference_semantics` argument of the plain struct/enum paths — only the `__yo_cell` paths feed it now), rest cell/carry |
| types/guards.yo | 22 | cell — `is_reference_struct_type` and friends are the predicate every E0911/E0919/E0910 rule consults; payloads of `Rc`/`Arc`/`RefCell` answer exactly as `ref(...)` did |
| types/utils.yo | 17 | cell — control-bound/origin walks over flagged payloads (the ctl-return rule's input) |
| evaluator/types/utils.yo | 10 | cell — `mark_generic_independent` and marker plumbing |
| types/type_key.yo | 8 | carry — the flag is part of a type's identity key |
| types/definitions.yo | 8 | carry — node constructors |
| evaluator/types/enum.yo | 8 | cell + 1 edit (the recursive-value-enum hint names `Box`, `ArrayList`, `Rc`) |
| codegen/types/generation.yo | 8 | cell — the counted-header C layout fires for `__yo_cell` payloads (`Rc`/`Arc`) |
| evaluator/trait_checking.yo | 6 | cell — Send/Sync/Runtime/Comptime marker derivation for flagged payloads + 1 edit (the impl-site message's reference-type list) |
| verifier/vc.yo | 4 | carry — sort nodes carry the flag |
| types/creators.yo | 4 | carry |
| evaluator/calls/helper.yo | 4 | cell — dispatch notes |
| codegen/utils/index.yo | 4 | dead-ish — the `ref(enum)` Index arms are unreachable from user code now; the reserved primitives can still spell them (kept) |
| codegen/exprs/comptime_value.yo | 4 | cell — embedding a comptime value of a flagged payload |
| doc/builder.yo | 3 | cell — `StructKind.Object`/`AtomicObject` for cell payloads (tests/type_reflection pins both kinds through `__yo_cell`) |
| types/compatibility.yo | 2 | carry — structural compare |
| evaluator/values/anonymous_module.yo | 2 | cell — begin-expr ordering for flagged payloads |
| evaluator/utils.yo | 2 + 2 | cell — `_lb_is_cell_type` (E0910/E0911 roots) + 2 edits (the move-only help texts' `ref(struct(...))` mention) |
| evaluator/module_loader.yo | 2 | cell — deserialization stamps the flag |
| evaluator/exprs/extern.yo, c_include.yo | 2 + 2 | cell — extern value marshalling |
| evaluator/exprs/assignment.yo | 2 | cell — assignment through flagged payloads |
| evaluator/calls/comptime_fn.yo | 2 | cell — comptime reflection over flagged payloads |
| codegen/functions/dyn.yo | 2 | cell — the box rules for reference/atomic payloads (`Arc(Dyn)` interim cells) |
| codegen/exprs/other_fn_call.yo | 2 | cell — call emission through handles |
| types/substitution.yo, types/intern.yo, evaluator/values/impl.yo, evaluator/exprs/initialization_assignment.yo, evaluator/calls/index_trait.yo, evaluator/calls/function.yo, evaluator/builtins/type_fns.yo, evaluator/builtins/sizeof.yo, codegen/exprs/property_access.yo, codegen/exprs/await.yo | 1 each | cell — substitution carries, interning keys, phase-A registration, init-assignment through payloads, Index dispatch notes, call-site rules, `Type.get_info` kinds (pinned by tests), `sizeof` of a counted layout, property access through handles, the E0911 await check |

Diagnostics text that named the deleted form (all edited here):
`diagnostics_registry.yo` E0901 (both languages), E0910, E0911, E0919;
`evaluator/utils.yo`'s two move-only helps; `trait_checking.yo`'s impl-site
message; `public_safe_report.yo`'s `ref(name) : T` example;
`evaluator/types/enum.yo`'s recursion hint. One check deleted outright:
struct.yo's reserved-`header`-field rejection (its input was exclusively a
user `ref(struct)`; the cli case that pinned it is removed with it).

One behavioral consequence recorded for the audit lane: `YO_AUDIT_RC_WRITE`'s
user-facing surface is empty post-drop — an `Rc`/`Arc` payload write is
E0919, a `RefCell` door write is behind the door, and `Rc.make_mut`'s result
is a value place, so no user-spelled write through a counted handle reaches
codegen (tests/cli-cases/audit-rc-write-census now pins the negatives).

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
