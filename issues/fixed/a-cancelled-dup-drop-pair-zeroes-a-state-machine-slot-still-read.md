# A cancelled dup/drop pair zeroes a state-machine slot the local still reads

**Status:** FIXED. Found 2026-10-01 by a peer session: a compiler built BY the
v0.2.47 seed segfaults (rc=139) in `yo unsafe-report`, `yo public-safe-report`
and `yo update --latest`. The seed-bump battery on develop showed it first:
run 36764200992 (6316dcd7b), "Self-hosted test subcommand (yo-self tier-1
gates)", three CLI goldens at rc=139.

## Symptom

```rust
Box2 :: ref(struct(xs : ArrayList(i32), n : usize));
make :: (fn(io : Io) -> Impl(Future(Box2, Io)))(
  io.async((io : Io) => {
    xs := ArrayList(i32).new();
    io.await(sleep(u64(1)), io);
    xs.push(i32(7));
    return(Box2(xs : xs, n : xs.len()));   // SIGSEGV: xs.len() reads NULL
  })
);
```

A later statement crashes the same way (`b := Box2(xs : xs); n := xs.len();`),
and so does a read after the next await. A local that is not live across an
await is a C local rather than a slot, and is unaffected.

In the compiler itself, the crash is `generate_unsafe_report`'s final
`UnsafeReport(privileged_files : privileged_files, …, totals :
UnsafeTotals(privileged : privileged_files.len(), …))`:

```c
__yo_t_...* __yo_moved0 = sm->var_privileged_files_...;
memset(&(sm->var_privileged_files_...), 0, sizeof(...));  // moved out: the slot no longer owns it
...
size_t n = __yo_fs_..._len(sm->var_privileged_files_...);  // NULL → EXC_BAD_ACCESS at 0x10
```

## Root cause (measured)

The dup/drop pair optimizer (`_optimize_dup_drop_pairs`,
`src/evaluator/exprs/begin.yo`) cancels a local's single store-dup against its
scope-end drop, and marks the local consumed at the store. The local is still
readable afterwards: in C it keeps the pointer, and the field owns the one
count (the pitfall "a move of a named local into a struct field is NOT a
consumption" in `AGENTS.md`).

#1018 added `_sm_consuming_read` (`src/codegen/exprs/atom.yo`). A read that
the evaluator records as the variable's consumption takes the slot into a C
temp and zeroes the slot, so that the abort dispose, which releases every
non-null slot, never releases a count the slot gave away. That is right for a
real move (an `own` argument): the evaluator rejects any later read. For a
cancelled pair it turns the fake move into a real one, and every later read of
the local sees NULL.

## Why every gate missed it

The release battery's S1 was compiled by v0.2.46, before #1018's lowering. The
bootstrap fixpoint compares emitted C, and never runs a stage-2 subcommand. The
language suite has no async body that reads a local after storing it into a
field. Released binaries are unaffected, because v0.2.46 built them.

## Fix

The optimizer does not run on a block that awaits (`_contains_io_await_for_opt`,
the same syntactic test `analyze_await_points` uses: it follows macro
expansions and does not enter a nested `io.async` body). Only a local live
across an await becomes a state-machine slot, and such a local's block
contains the await. There, the store keeps its dup, the slot keeps its own
count, and both the scope-end drop and the abort dispose release it once.
This mirrors the isolating-frame rule beside it: both need every count to
equal its live handles.

A compiler built by an unfixed seed still carries the bug in its own machine
code. So the compiler's source avoids the shape at each site the seed
miscompiles, reading the length before the store (see the sites listed in the
PR), until `SEED_VERSION` carries this fix.

Tests: `tests/async/sm_ownership.test.yo`, "a local stored in a field stays
readable across the next await", and "aborting a task after it stored a local
in a field releases the local once". Both crash with exit code 11 before the
fix.
