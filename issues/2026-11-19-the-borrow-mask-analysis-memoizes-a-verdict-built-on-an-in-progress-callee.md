# The borrow-mask analysis memoizes a verdict built on an in-progress callee

**Severity:** S3 — a memo that should be skipped is kept; no user-visible failure is known, but a borrow-mask verdict computed inside a recursion cycle can be cached from a conservative intermediate

**Status:** OPEN (found 2026-11-19 by the R7 lane's copy-then-write audit; not an R7 regression — develop `939fe7160` has the same code)

## Where

`src/evaluator/effects/mutation_summary.yo`, `_MsP.analyze`:

```yo ignore
local_touched := ArrayList(String).new();
(mut(ctx) : _MspCtx) = _MspCtx(
  ...
  touched : local_touched.clone(),
  ...
);
// ... the fixpoint and the walk call `_MsP.analyze(…, &mut ctx.touched)` for
// callees, and `_ms_touched_add(touched, …)` records an in-progress callee
// into `ctx.touched` ...
filtered := ArrayList(String).new();
while(li < local_touched.len(), { ... });   // reads the EMPTY original list
if(mask_all || (filtered.len() == usize(0)), {
  // memoize
});
```

`ctx.touched` is a clone of `local_touched`, so every callee the walk marks as
"touched while in progress" lands in `ctx.touched`, and the memo guard reads
`local_touched`, which nothing writes. `filtered` is therefore always empty:
the verdict is always memoized, and the caller's own `touched` list is never
told about the in-progress callees either. The comment at the top of the
function ("the caller must not memoize a verdict built on it") is defeated.

The sibling analysis `_MsW` (same file, ~line 290) passes `&mut local_touched`
directly and reads it back correctly; only `_MsP` routes it through the
context struct.

## Fix (not applied in the R7 PR)

Read `ctx.touched` instead of `local_touched` after the walk (and drop the
unused local). It needs a regression test with a mutually recursive pair whose
first-visited member's mask depends on the second's, checking the second
call's verdict is recomputed rather than served from the memo; and a look at
the test-suite deltas, because fewer memos can change verdicts in cycles.
