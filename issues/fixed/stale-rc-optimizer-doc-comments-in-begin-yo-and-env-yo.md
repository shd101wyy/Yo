# Stale RC-optimizer comments: `begin.yo`'s "all stubbed" block names live passes as no-ops and invites porting one without the inout rule; `env.yo` names a deleted optimizer as live

**Status:** FIXED 2026-09-23
**Severity:** papercut (documentation), with a safety-adjacent edge: the
stale block explicitly invites a future port of the one optimizer whose
TypeScript ancestor had a use-after-free, without mentioning the
`inout`-borrow-root rule that port must carry.
**Found:** 2026-09-23, auditing `plans/archive/INOUT_LOCAL_BINDINGS_AUDIT.md`
against the tree.

## Site 1 — `src/evaluator/exprs/begin.yo:2302-2313`

```
// -------------------------------------------------------------------------
// Ownership / RC optimizations — all stubbed (type_contains_rc_type = false)
// -------------------------------------------------------------------------
//
// The following passes are no-ops in Phase 2aa:
//   - Loop traversal borrow-chain optimisation
//   - dup/drop pair elimination (OPTIMIZE_DUP_AND_DROP_PAIRS)
//   - Deferred drop expression generation
//   - Own-parameter drop for nested returns inside function bodies
//
// These will be ported in Phase 3 once the RC type system is complete.
```

False on its face today: `_optimize_dup_drop_pairs` (`begin.yo:1020`) and
`_schedule_scope_end_drops` (`begin.yo:1398`) are live, safety-load-bearing
passes (the dup/drop pair optimizer's eligibility gate at `begin.yo:1166` is
where the inout-borrow-root skip lives — audit §8 B2′). The block is a
Phase-2aa porting note that survived every milestone it described.

The dangerous line is the last one. "Will be ported in Phase 3" invites
porting `optimizeLoopTraversalBorrowChain` from the TypeScript record — and
the TS version had a use-after-free when the loop mutated the structure
(`issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md`). Its stub was
deleted from this tree by #788 (`3d6df8def`, 2026-09-19, "docs: drop stale
TypeScript-bootstrap references"), which left this prose block behind. Anyone
re-adding the pass must apply the B2′ rule — a variable that is the
`borrow_root` of a live `inout` binding is used through the end of that
binding's scope and must never have its dup turned into a move — and nothing
at this comment says so.

## Site 2 — `src/env.yo:122-127` (`VariableRare.is_inout_borrow_root` doc)

```
/// Set on the ROOT variable of any `inout` local binding, never cleared:
/// a read through the binding is not a syntactic use of the root, so the
/// last-use optimizers (`_optimize_dup_drop_pairs`, the loop-traversal
/// borrow chain) must not turn the root's dup into a MOVE while a binding
/// may still write through it. §8 B2′ / §9 H6.
```

"... the loop-traversal borrow chain" names an optimizer that no longer
exists under any name (`grep -rn traversal src/evaluator/` finds only this
class of stale prose; #788 deleted the stub). The rule it states is correct
and live for `_optimize_dup_drop_pairs`; the second named optimizer is a
ghost.

## Fix

- Rewrite the `begin.yo` block to describe what exists (the two live passes,
  their ordering, and the B2′ skip), and drop — or correctly caveat — the
  "will be ported in Phase 3" line: if the loop-traversal pass is ever
  ported, it MUST treat `variable_is_inout_borrow_root` roots as live
  (B2′) and carry the TS-era mutation/escape guard.
- Drop the dead optimizer's name from the `env.yo` doc (or mark it "(if ever
  ported)").

## Verification

Doc-only change; `yo check ./src` plus `yo fmt --check` on the two files.
`grep -n "Loop traversal\|loop-traversal" src/` afterwards should return only
intentional references.

## Fix (2026-09-23)

`begin.yo`'s Phase-2aa block rewritten to name the two LIVE passes
(`_optimize_dup_drop_pairs` with the B2′ borrow-root exclusion;
`_schedule_scope_end_drops`), state that the loop-traversal pass was never
ported (stub deleted in #788), and spell the two rules any future port must
carry (treat `variable_is_inout_borrow_root` roots as live; the TS-era
mutation/escape guard). `env.yo`'s `is_inout_borrow_root` doc marks the
loop-traversal optimizer as never-ported.

## Verification

Comment-only edits to compiler source; the tree builds (full `src/main.yo`
emit + link) and the inout/rc gating files pass through the rebuilt binary
(`rc.test.yo` 51/51 exercises both named passes' behavior). `yo fmt --check`
clean; no `optimizeLoopTraversalBorrowChain`/"all stubbed" prose remains at
those sites.
