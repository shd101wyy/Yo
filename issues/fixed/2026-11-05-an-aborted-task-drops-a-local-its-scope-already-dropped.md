# An aborted task drops a local's slot that holds no value

**Severity:** S2 — a spurious `drop` in safe code: aborting a task drops a named local's task slot that was never stored, or whose scope already dropped it. For a `Drop` struct of plain fields the user's `drop` runs on all-zero fields (a file-descriptor wrapper would close fd 0); a pointer-shaped value (`String`, `Rc`, `Box`) is a no-op on zeroes, which is why it went unseen.

**Status:** FIXED 2026-11-05 on `fix/aborted-task-match-binding-drop`. Found while fixing
`issues/fixed/2026-11-05-an-aborted-task-leaks-a-value-moved-into-a-match-binding-across-an-await.md`:
once a consuming match's binding slot was dropped by the abort, aborting before the arm ran
dropped the binding's never-stored slot.

## Reproducer

```yo
{ println } :: import("std/fmt");
{ yield } :: import("std/async");
(mut(g_disposed) : i32) = i32(0);
V :: struct(n : i32);
impl(
  V,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_disposed = (g_disposed + i32(1));
    })
  )
);
_task :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io); // abort here: `v` was never stored
    k := {
      v := V(n : i32(5));
      io.await(yield(io), io);
      v.n
    };
    io.await(yield(io), io); // or here: `v`'s scope dropped it
    k
  })
);
```

Spawned and aborted at the first await, develop 58ec8be03 counts one drop (expected 0); aborted
at the last await, two (expected 1).

## Root cause

A task slot (`sm->var_…`) has no liveness of its own: the abort dispose drops every
cross-boundary local's slot, and relies on an empty slot being all zeroes (the struct is
`memset` at allocation, and a scope-end drop or a move out zeroes the slot). A move flag
(`__yo_mv_…`, every named local has one) only emptied a moved-out slot before the drop. Zeroes
are an empty value for a pointer-shaped type, not for a `Drop` struct of plain fields.

## Fix

The move flag now means "the slot holds no value of its own", for every named local:

- it starts set (`<struct>_init_move_flags`, called at both allocation sites);
- every store clears it (the existing stores, and now a pattern binding's);
- a scope-end drop of the slot sets it again (`generate_drop_of_operand`, `src/codegen/exprs/rc_fns.yo`);
- the abort dispose, a fused site's release and an early completion's pending drops run a
  flagged slot's drop only while the flag is clear (`_unless_moved_out`, `src/codegen/exprs/async.yo`;
  `src/codegen/exprs/atom.yo`).

A temporary's slot has no flag and keeps the zero convention, so a temporary of a plain `Drop`
struct still gets the spurious drop: filed as
`issues/2026-11-05-an-aborted-task-drops-a-temporary-s-slot-before-it-is-stored.md`.

## Test

`tests/async/sm_ownership.test.yo`: "an aborted task drops a plain Drop local only while its
slot holds it" (before the local, while it lives, after its scope) and the binding shapes of
"an aborted task drops a plain Drop payload its match binding holds once, wherever it stops".
