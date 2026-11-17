# A closure that moves a by-value capture on one branch leaks it when the other branch runs

**Severity:** S1 — an unbounded leak in accepted safe code: each call of such a closure that takes the branch which does not move the capture leaks the capture's heap buffer.

**Status:** FIXED (see "Resolution" below). Found 2026-11-17 by the deref-owner lane (VERDICTS-63 Generation A): `tests/internal/diagnostics_registry_examples.test.yo` failed on a LeakSanitizer report (317 bytes in 8 allocations), all allocated by `String.clone` in `set_closure_writes_captures` (`src/evaluator/utils.yo`), whose closure moved its `fid` capture into the map when `writes` held and only borrowed it otherwise. The reproducer below leaks on a develop `916b279c1` binary as well. The deref-owner lane worked around it by building one closure per branch in that function; the codegen bug is fixed here.

## Reproducer

`issues/repros/2026-11-17-a-closure-moving-a-by-value-capture-on-one-branch-leaks-it-on-the-other.yo`, built with
`--std-path ./std --optimize 1 --sanitize address --allocator system`:

```yo
{ String } :: import("std/string");
{ HashMap } :: import("std/collections/hash_map");
{ RefCell } :: import("std/sync/refcell");
(g_tbl : RefCell(HashMap(String, bool))) = RefCell(HashMap(String, bool)).new(HashMap(String, bool).new());
note :: (fn(func_id : &String, writes : bool) -> unit)({
  fid := func_id.clone();
  g_tbl.with_mut({ fid, writes }(m) => {
    if(writes, {
      m.insert(fid, true);
    }, {
      m.remove(&fid);
    });
    ()
  });
});
main :: (fn() -> unit)({
  k := String.from("a-func-id-long-enough-to-be-on-the-heap");
  note(&k, false);
  note(&k, true);
  note(&k, false);
});
export(main);
```

```
==…==ERROR: LeakSanitizer: detected memory leaks
Direct leak of 39 byte(s) in 1 object(s) allocated from:
Direct leak of 39 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 78 byte(s) leaked in 2 allocation(s).
```

Two leaks, one per `writes = false` call. A closure that never moves `fid` (`{ fid }(m) => { m.remove(&fid); () }`) does not leak, and the `writes = true` call does not either.

## Root cause

The closure's C body moves `closure_context->fid` into `insert` on one branch and only lends it to `remove` on the
other. A closure that never moves `fid` has its capture dropped with the record, so the record's drop skips a
capture the body moves on SOME path, and the non-moving branch drops nothing either. A capture moved on some paths
needs a drop on the others (a drop flag, or a drop at the end of each non-moving branch), as a conditionally moved
local gets.

## Workaround

Build one closure per branch, so each closure moves its capture on every path or never moves it
(`set_closure_writes_captures`, `src/evaluator/utils.yo`).

## Resolution

The evaluator already handled the shape. A value moved in some arms of a `cond`/`match` and kept in others gets
`___drop(name)` at the end of each arm that keeps it (`_drop_in_arms_that_keep`, `src/evaluator/utils.yo`), and a
skippable `&&`/`||` operand that moves a value gets the drop on the path that skips it
(`drop_moves_of_skippable_operand`). The capture frame of an `FnOnce(...)` closure is one of the frames the join walks,
so the drop was built for `fid` too. Codegen then threw it away. In a closure body it skips every drop whose target
names a capture (`is_deferred_drop_for_closure_capture`, `src/codegen/utils/index.yo`), because a capture normally
belongs to the closure record. The only drops it keeps are those tagged `mark_fnonce_capture_drop`: the drops an
`FnOnce` body schedules for its own capture frame at scope end and on an early exit (`src/evaluator/exprs/begin.yo`).
The arm-end drop and the skipped-operand drop were never tagged, so they vanished. And because a capture moved on any
path counts as moved at the join, the body's scope-end drop does not cover it either.

The fix tags both drops as the body's own capture drop when the value is a by-value entry of the current `FnOnce`
body's capture list (`is_own_fnonce_capture`). Codegen then emits them in the arm that keeps the capture, exactly as it
emits a conditionally moved local's drop. No runtime flag is needed, because the arms are structured. Inside an
`io.async` state machine that owns its capture list (`sm_owns_fnonce_captures`), the tag still defers to the
dispose. That dispose drops the capture slot through its move flag, so the keeping arm is covered there without
an arm drop.

Coverage:

- `Fn(...)` and `FnMut(...)` bodies cannot move a by-value capture (E0913), so the shape exists only under `FnOnce`.
  The test pins that their record drops a capture the arms only lend exactly once.
- The early-exit paths (`return` before the move, `return` after a move in one arm) were already handled by the
  consumed-capture early-return drops. They are pinned by the new test as well.

Regression test: `tests/closure_capture_conditional_move.test.yo`, a dispose counter on a `Drop` type, so it holds
without the leak verdict. It covers `if`/else, an `if` with no else, a three-arm `cond`, `match` arms, a nested
branch, both early-return shapes, a skipped short-circuit operand, the reproducer's `RefCell.with_mut` shape,
`Fn`/`FnMut`, and an `io.async` capture-list body with and without an await. Every case asserts exactly one dispose per
call: a leak reads 0, and a double drop on the moving path reads 2. On the develop binary, 7 of the 10 sync cases and
the `io.async` case read 0. With the fix, all 11 tests pass, and the reproducer is clean under
`--sanitize address --allocator system`.
