# A local read after it moves inside a task reads an emptied slot

**Severity:** S1. A task that binds a local to a new name and then reads the original name dereferences NULL. v0.2.47's own `yo update --latest` segfaults (rc=139) on it.

**Status: FIXED (2026-10-01).** This is a regression of #1002's consuming read (`issues/fixed/an-aborted-task-releases-a-local-it-moved-before-its-await.md`), shipped in #1018 and v0.2.47. It is the third of the three CLI cases that went rc=139 once `SEED_VERSION` became v0.2.47. The other two are `issues/fixed/a-move-out-of-a-task-slot-empties-it-before-the-consuming-call-runs.md`.

#1072 (`issues/fixed/a-cancelled-dup-drop-pair-zeroes-a-state-machine-slot-still-read.md`) fixed the container-store shape in the evaluator: in an awaiting block, a local's move into a field is no longer cancelled. It worked around this alias shape by respelling `run_install` to read through `current`. The alias elision still marks `(cur : T) = t` as `t`'s consumption, so a user program with the shape kept crashing. This fix is the compiler side.

## Symptom

`_bump_ranges_to_latest`'s caller in `src/install_command.yo`:

```rust
(current : Manifest) = manifest;
if(options.latest, {
  bumped := e.io.await(_bump_ranges_to_latest(manifest, …), e);
  current = bumped;
});
```

Minimal form:

```rust
io.async((e : Io) => {
  t := Thing(n : i32(1));
  e.await(yield(e), e);
  (cur : Thing) = t;
  if(bump, { b := e.await(_bumped(t, e), e); cur = b; });
  cur.n
})
```

The inner task read `t.n` through NULL.

**Superseded in part (2026-10-05).** "The language still lets `t` read that
value" below no longer holds for a user move: a read after a `sink`/`own` move
is E0901, because under `plans/VALUES_BY_DEFAULT.md` §0 a move consumes the
name, and the new owner may already have released the value
(`issues/fixed/a-reference-value-read-after-a-sink-move-reads-freed-memory.md`).
The move flag still matters for the moves the dup/drop pair optimizer makes
(`(cur : T) = t` with `t` read afterwards, which the evaluator marks only
after the block), and for the abort dispose.

## Cause

The evaluator records `(cur : Thing) = t` as `t`'s consumption, and the value moves to `cur` without a dup. The language still lets `t` read that value while its new owner holds it. Sync code keeps `t`'s C local as it is, and the old value is released at scope end.

`_sm_consuming_read` (`src/codegen/exprs/atom.yo`) zeroed `t`'s task slot at the move. That kept the zero invariant (a slot is non-zero exactly while it owns its value) for the abort dispose, but every later read of `t` in the task then read an empty slot.

## Fix

A named local's task slot has a move flag, `uint8_t __yo_mv_<field>`, emitted beside it by `emit_async_block_struct_definition` (`src/codegen/exprs/async.yo`), with lookup through `sm_move_flag_of` (`src/codegen/async/state_machine_naming.yo`).
- A move out of the slot sets the flag where the consuming line runs, and leaves the value readable.
- The abort dispose empties a flagged slot before its drops, so the new owner alone releases the value.
- Every store into the slot clears the flag: the binding (`init_assignment.yo`), a destructuring bind, and a reassignment (`assignment.yo`). A loop that re-binds the name therefore owns each iteration's value again.
- A temporary's slot, which is read once, is still emptied at the move.
- Named RC locals no longer share slots (`state_machine.yo`'s overlap pass), because a shared slot's next member would inherit the flag.

Tests in `tests/async/sm_ownership.test.yo`:
- "a local moved to another name inside a task is still readable" (both branches, each value disposed once);
- "an aborted task releases a value moved to another name once";
- "an aborted task releases a local re-bound after its previous value moved" (the store-side clear).

The first test fails (exit code 256) under a stage 1 built before this fix and passes after it.
