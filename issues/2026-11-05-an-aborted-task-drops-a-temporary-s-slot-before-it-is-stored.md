# An aborted task drops a temporary's slot before the temporary is stored

**Severity:** S2 — a spurious `drop` in safe code: aborting a task before it stores a temporary that lives across an await drops the temporary's all-zero task slot. For a `Drop` struct of plain fields the user's `drop` runs on zeroes; a pointer-shaped value is a no-op on zeroes.

Found 2026-11-05 while fixing
`issues/fixed/2026-11-05-an-aborted-task-drops-a-local-its-scope-already-dropped.md`, which gives
every named local's slot a liveness flag. A temporary's slot (`sm->var_<temp id>`, or a slot shared
by temporaries with disjoint live ranges, `sm->slot_N`) has no flag: the abort dispose drops it
whenever it is non-zero in the zero sense only.

## Reproducer

`issues/repros/2026-11-05-aborted-task-drops-unstored-temporary-slot.yo`
(`yo compile <it> -o r && ./r` prints `aborted before the temp: 1`; expected 0):

```yo ignore
_task :: (fn(io : Io) -> Impl(Future(i32, Io)))(
  io.async((io : Io) => {
    io.await(yield(io), io); // aborted here
    take2(V(n : i32(3)), io.await(_leaf(io), io)) // `V(...)` is a temporary held across the await
  })
);
```

## Root cause

The dispose's zero convention (`generate_async_block_state_dispose_function`,
`src/codegen/exprs/async.yo`): a temporary's slot is zeroed by the struct `memset` at allocation and
by every drop or move of it, and the dispose drops it unconditionally. Zeroes are not an empty
value for every type.

## Direction

Give a temporary's slot the same "holds no value of its own" flag the named locals' slots carry
(set at allocation and by a drop or move, cleared by the store into the slot), and drop a flagged
slot only while the flag is clear. A shared slot (`compute_overlapping_slots`) needs one flag for
the slot, cleared by each member's store.
