# A `&mut` argument to a callee that neither writes nor lends it is a read

**Severity:** S1 — `f(&mut xs)` beside a live `&` loan of `xs` is accepted when the callee's body neither writes the parameter nor makes a `&mut` reference value of it, and always when the callee has no body to read (a `Dyn(Fn)` value, a function pointer); the second form is a heap-use-after-free today.

Filed 2026-11-12 by VERDICTS-57 §3.4 (the general rule, G, is v0.2.78). v0.2.77 ships the narrow rule
(`issues/fixed/2026-11-11-a-mut-argument-is-an-exclusive-access-only-when-the-callees-body-writes-it.md`): making a
`&mut` reference value of a place is a write, and a callee's `lends_mut` summary bit makes its `&mut` argument a
write. What that leaves:

1. **Body-dependent exclusivity.** Whether `f(&mut xs)` conflicts with a live `&` loan still depends on `f`'s body:
   a callee that writes the parameter or lends it `&mut` is a write, one that only reads it (`peek` in
   `issues/repros/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read.yo`, beside
   `grow`) is a read. No program is unsound through a summarized callee today (a callee that neither writes nor
   lends cannot invalidate the loan), but the contract lives in the body: an edit inside `peek` silently changes
   what its callers may do, which `plans/backlog/REFERENCES_AND_ORIGINS.md` §6 rejects. The positive row
   `tests/origins/unsound/v57-mut-self-nonwriting-live-loan-pos.yo` pins today's verdict and flips at G.
2. **Unresolved callees.** `d3_check_pending_unresolved_callee` judges only the borrowed-value (E0908) entries, so a
   `&mut` argument to a `Dyn(Fn)` value, an `Impl(Fn)` parameter, a function pointer or a `Dyn(Trait)` method is
   never a write against a live loan
   (`issues/repros/2026-11-12-a-mut-argument-to-a-callee-that-neither-writes-nor-lends-it-is-a-read-unresolved.yo`:
   the callee clears the list `r` points into; the audit's
   `issues/repros/2026-11-11-a-mut-argument-is-an-exclusive-access-only-when-the-callees-body-writes-it-fn-value.yo`
   and `…-dyn-trait.yo` are the function-value and `Dyn(Trait)` forms). Pre-existing: the v0.2.76 seed accepts it
   too. A by-value `&mut`
   lend to such a callee is judged since the v0.2.77 fix (it needs no body).

**Item 2 is fixed** by `fix/c2-access-modes` (audit §9 cluster 2): `d3_check_pending_unresolved_callee`
(`src/evaluator/exprs/assignment.yo`) judges the local-borrow entries with the unknown mask (`all`), so every `&mut`
argument to a callee with no body is a two-phase write against the live loans (E0911). Rows
`tests/origins/unsound/c2-mut-arg-unresolved-dyn-fn.yo`, `-fn-value.yo`, `-dyn-trait.yo` (E0911) and
`c2-mut-arg-unresolved-dyn-fn-pos.yo` (accept). The same branch makes every `&mut` argument and receiver an exclusive
access against a live closure's capture borrow whatever the callee is (the declared mode). Item 1 (a summarized callee
that neither writes nor lends, against a local `&` loan) is what remains open here.

## Expected (G)

Every `&mut` argument and receiver is an exclusive access of its place at the call's activation point (two-phase,
P9), whatever the callee is: E0911 against a live loan of an overlapping place. The mutation mask feeds only D3
and the runtime asserts; `lends_mut` is deleted.

## Plan (VERDICTS-57 §3.4)

1. Census in print mode over src, std and tests (the `_g_audit_inout_borrow` pattern): every `&mut` argument of a
   non-writing, non-lending callee under a live `&` loan. std has 432 `self : &mut Self` slots, src about 1,400
   `&mut` slot lines.
2. Sweep the hits (most are `&mut self` methods that should take `&Self`).
3. Flip: the local-borrow judge activates every `&mut` argument as a write; the unresolved-callee path too.
