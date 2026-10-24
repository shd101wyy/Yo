# A borrowed `for` over a `mut(G)` global is not E0916

**Severity:** S2 — `for(&mut G, x => …)` over a `mut(G)` module-level binding compiles although lending such a binding to a call is E0916, so the loop holds a borrow of storage any function can replace by name.

**Status:** FIXED 2026-10-23 (`feat/b7a-read-walk`). **Found:** 2026-10-23, while gating B7a: the read walk `for(&G, …)` stopped raising the E0916 that `tests/global_lend.test.yo` expects, and the in-place walk never raised it.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array_list");
(mut(G) : ArrayList(i64)) = ArrayList(i64).new();
main :: (fn() -> unit)({
  for(&mut G, x => {
    x = i64(0);
  });
});
export(main);
```

Develop `7898d4da0` and the v0.2.68 seed accept it (`yo check` exits 0). A body that calls anything is E0911 (decision 18 rule 3: "a module-level place, which has no run-time borrow flag"), but a call-free body is not, and nothing else is reported.

## Root cause

Decision 47 makes every lend of a `mut(G)` binding to a call E0916 (`_judge_global_lend`, `src/evaluator/calls/function.yo`). The borrowed `for` does not lend `G` to a call: it takes a local borrow `c := &mut G` in the prelude macro's own code and lends `c` to the cursor methods (`walk_start`, `walk_elem`, `walk_next`). A local borrow of a module-level place is legal, and rule 3's per-call check (`local_borrow_note_call`, `src/evaluator/utils.yo`) skips the cursor calls: their tokens are in the prelude's module, outside the caller's live range of the macro-site borrow. Only calls written in the loop body are checked.

Before B7a the read form `for(&G, …)` expanded to the value form, `G.into_iter()`, which IS a lend of `G` to a call, so it was E0916. Once B7a gave it the local-borrow lowering, it lost the error as well.

## Fix

`evaluate_borrow_check` (`src/evaluator/exprs/runtime.yo`), which every borrowed `for` passes through, resolves the root of the loop's local borrow. When that root is a `mut(G)` module-level binding, it raises E0916 at the `for` (`_reject_borrowed_for_over_mut_global`), with the same help as a call lend: walk a local copy, and write it back after an in-place walk. The registry text for E0916 names the borrowed `for` as a lend.

## Test

`tests/global_lend.test.yo`, "lending a mut global, or a place under it, to a call is E0916": the read walk and the in-place walk over `_gl_mlist`, each with a call-free body, are E0916. The in-place case fails before the fix.
