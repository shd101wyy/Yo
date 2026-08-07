# RC dup/drop: enforce the policy/mechanism split

**Status: BACKLOG (decided 2026-08-06).** Not scheduled — deliberately
deferred until PR 76 (`feat/bootstrap-codegen`) merges, because every
migration below touches the dup/drop seam that PR stabilized and each
one needs its own fixpoint + differential validation. Candidate
follow-on campaign alongside the borrowed-arg Stage 0 work
(`issues/borrowed-arg-invalidated-by-aliased-container-mutation.md`).

## The question this answers

Some dup/drop calls are generated during evaluation, some only during
codegen — is that a bug? Should everything move to the evaluator?

**No, and no — but with one rule.** The architecture is a
policy/mechanism split, and it is correct; what needs enforcement is
that **codegen never makes a policy decision**:

- **Policy (evaluator):** does this value need a +1/−1? Deferred
  `___dup` marks on copies, `deferredDropExpressions` built as real
  type-checked Expr trees (`src/evaluator/exprs/begin.ts`,
  `src/evaluator/calls/helper.ts`), consumption tracking
  (`setExprAsConsumed`), and the dup/drop pair-cancellation optimizer.
  These need types, trait resolution (which `___drop` specialization),
  and ownership state — all evaluator-only knowledge.
- **Mechanism (codegen):** how is the op spelled and where does it
  land? `generateDropCodeForValue` / `generateDupCodeForValue`
  (`src/codegen/exprs/drop-dup.ts`) pick `__yo_decr_rc` vs
  `fn_..._drop` and do the recursive `.data[i]` / `._N` descent into
  arrays/tuples; `generateDeferredDropExpressions` /
  `generateDeferredDupExpressions` (same file) EMIT the
  evaluator-planned exprs at flush points (scope end, early returns,
  after statements — see `ff1bffa58` for why placement is subtle).

## Why full evaluator-only generation is impossible

1. **Codegen-synthesized temporaries** (deref copies, sret temps,
   match materialization, async state-machine slots) do not exist at
   evaluation time — there is nothing to attach a policy mark to.
2. The recursive element/field drop code depends on **C lvalue
   shapes** (`(x).data[i]`, `(x)._0`) the evaluator never sees.
3. The evaluator **cannot splice drop calls into the AST** — they
   would be re-evaluated/CTFE'd (see the comment on
   `generateDeferredDropExpressions` in `begin.ts`); "deferred Expr
   attached to `$`" is already the closest-to-evaluator representation
   that works.
4. **Placement is a backend concern:** the same planned drop lands
   differently in a straight-line body, an async FSM state, and an
   unwind path.

## Inventory: codegen sites that currently make policy decisions

These are the migration candidates (or sites needing an explicit
justification comment). Each produces correct C today — this is debt,
not a bug list.

| #   | Site                                                                                                                                                                 | What it decides                                                     | Disposition                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `yo-self/codegen/exprs/init_assignment.yo` deref-RHS dup-at-copy ("when no deferred dup was marked")                                                                 | Whether an `x := ptr.*` copy of an RC struct needs a dup            | **Migrate.** TS plants this as an evaluator mark (`deferredDupExpressions`); yo-self patched it in codegen during the round-6 double-free hunt (see `tests/codegen-bootstrap/ptr_deref_copy_rc_struct.yo`). Port the TS mark instead.                                                 |
| 2   | `src/codegen/exprs/other-fn-call.ts:1740, :1844, :2878` unwind/abort-path argument drops (+ `memset` to zero SM fields)                                              | Which in-flight call arguments need dropping when a call is unwound | **Justify, probably keep.** The unwind path is codegen-materialized control flow; the evaluator has no node for it. But the "which args" predicate (`variableName && typeContainsRcType`) is policy — consider having the evaluator annotate the call with the owned-arg set instead. |
| 3   | `src/codegen/exprs/drop-dup.ts:333-368` emit-time filters: skip closure-capture drops, skip undeclared temps (`declaredCVarNames`), skip short-circuit-handled drops | Whether a planned drop is suppressed                                | **Keep but audit.** These encode placement facts codegen owns, but each suppression is a place a planned drop silently vanishes — exactly the hollow-drop failure shape. Each filter needs a regression test that would catch over-suppression.                                       |
| 4   | `src/codegen/exprs/rc-fns.ts` (bodies of generated `___drop`/`___dup`/dispose functions)                                                                             | Recursive element drops inside the drop functions themselves        | **Mechanism — fine as is.** Generating the drop function's own body is spelling, not policy.                                                                                                                                                                                          |

## Evidence the seam is where bugs live

Every recent RC bug was a policy error in the evaluator or a placement
error in codegen — never confusion within a side:

- `ff1bffa58` — statement-body drops flushed before the declaration
  (placement).
- `2037bb4a2` — bare tail-expression fn bodies missing scope-end drops
  (placement).
- Round-6 stage-2 double-free — yo-self missing the deref-copy dup
  mark (policy hole, patched in codegen = row 1 above).
- `issues/fixed/own-param-discard-leak.md` (2026-08-06) — own params
  recorded as captures, drop filter skipped them (policy).
- `ac85f6cfc` — pair-cancellation soundness (policy).

## Guards to keep regardless

- `rc()` balance tests (`tests/rc.test.yo`, `tests/ref_field_borrow.test.yo`).
- Per-function dup/drop count diff of yo-self emits between compiler
  versions (fewer dups after an optimizer change = new cancellation =
  potential UAF).
- CI LeakSanitizer on the leak-prone test files.

## Why not now (2026-08-06)

PR 76 is merge-ready with a green 14-job matrix; rows 1–2 above touch
the same code paths its final fixes stabilized. Row 1 alone requires a
stage-2/stage-3 fixpoint revalidation and a corpus differential.
Sequencing this after the merge keeps the PR reviewable and gives each
migration its own bisectable commit.
