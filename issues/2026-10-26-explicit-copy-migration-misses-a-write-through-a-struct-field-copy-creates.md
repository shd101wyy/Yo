# The explicit-copy migration inserts a `.clone()` where the copy CREATES the share a walk writes through

**Severity:** S2

## What happened

Running `yo fix --migrate explicit-copy` on `src/evaluator/effects/mutation_summary.yo`
(base a27cd5f01, B4-3d) inserted `.clone()` at the `_MspCtx` construction in
`_mutation_summary_for`:

```yo ignore
local_touched := ArrayList(String).new();
ctx := _MspCtx(
  ...
  touched : local_touched.clone(),   // inserted
```

The analysis's fixpoint walk pushes every callee `fid` it consults into
`ctx.touched`, and the function then READS `local_touched` after the walk to
build `filtered` (the dependency list that decides whether the verdict may be
memoized, and what to register in the caller's `touched`). The copy created the
share: with `.clone()`, everything the walk pushed landed in the clone,
`local_touched` stayed empty, `filtered` was always empty, and verdicts computed
from in-progress (provisional) callee masks were memoized as final.

The observable damage was found by the B4 behaviour corpus (base vs head
stage-1 binaries compiling `src/main.yo`): the head binary emitted 14 fewer
`__yo_borrow_assert_unborrowed` entry asserts (`function_param_mutation_mask`
verdicts flipped to "does not mutate" for `_call_lends`, pattern.yo's
`_useful`, `_extend_cloned`, the `_MsP.collect` walk and others) — scattered
across files the sweep never touched, because the unsound memoization poisoned
later queries. All 23 copy-sensitive test files stayed byte-identical; only
`src/main.yo` differed.

## Why the tool misses it

B4-0a fixed three written-after misses (loop-carried, pattern-binding,
already-shared buffers: `issues/fixed/2026-10-24-*`). This shape is different:
the source (`local_touched`) is a FRESH local that is never written again
directly — the write goes through the struct field the copy itself hands out
(`ctx.touched`, written by `_MsP.collect(body, &ctx)` under `&ctx`), and the
read-back goes through the original name after the walk. The flow is
"local → (copy into) struct field → callee writes the field through a `&`
parameter → local read afterwards". `record_copy_flow_decl` records captures
and pattern bindings, not a field of a struct literal built from the local
consumed as a whole.

## The fix for this campaign

The insertion was reverted by hand (the site is deferred in B4-3d with the
reason "the copy creates the share the walk writes through"). A tool fix should
record, for a struct-literal field whose value is a local, a flow from the
local to the field, and treat a write to `x.f` reachable through any later use
of the struct as a write to the local when the local is read after.

## Reproducer

`issues/repros/2026-10-26-explicit-copy-migration-misses-a-write-through-a-struct-field-copy-creates.yo`
(the dry run proposes the insertion at the `touched : local_touched` field
store; after `yo fix` applies it, the program's `filtered` list stays empty).

A regression test belongs with the tool fix (a `fix-migrate-explicit-copy-*`
cli-case whose golden shows the site LISTED, not inserted).
