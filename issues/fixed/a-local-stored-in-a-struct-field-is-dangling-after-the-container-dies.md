# A local stored into a struct field is dangling once the container dies

**Status:** FIXED 2026-09-11. Found 2026-09-11 while writing the Dispose-counter gate for
the spawn-capture leak fix
(`issues/fixed/spawn-closure-captures-never-dropped-leak.md`). **Pre-existing**
— reproduces identically under the v0.2.30 seed and under a `develop` tree
build, with no compiler change of mine in the picture.

## Symptom

```rust
sink := S.new();                       // S :: atomic(ref(struct(...)))
{
  holder := H(tag : i32(7), sink : sink);
  _t := holder.tag;
};                                     // holder dies here
sink.count();                          // SIGSEGV — sink was freed with holder
```

`rc=139`, faulting inside the `sink.count()` load. `sink` is a live local in
the enclosing scope and is never consumed by anything the reader can see.

## Reproducer

`issues/repros/local-stored-in-a-struct-field-is-dangling-after-the-container-dies.yo`
(no threads, no async, no `Dispose` impl needed).

```
$ yo compile issues/repros/local-stored-in-a-struct-field-is-dangling-after-the-container-dies.yo \
    --std-path ./std --optimize 2 -o /tmp/repro && /tmp/repro
rc=139
```

## What the emitted C shows

```c
__yo_t0* sink = yo_id_7890();                          // rc = 1
{ // begin block
  __yo_t2* holder = __yo_new___yo_t2(7, sink);         // NO __yo_incr_rc on sink
  ...
  __yo_decr_rc_atomic((void*)(holder));                // -> 0 -> dispose -> free
} // end begin block
yo_id_7894(sink);                                      // USE AFTER FREE
```

and the container's generated dispose does release the field, correctly:

```c
static inline void yo_id_7904(__yo_t2* self) {
  __yo_t0* __yo_disp_f1 = self->sink; // Destructuring sink
  __yo_decr_rc_atomic((void*)(__yo_disp_f1));
}
```

So the store into the field took NO reference while the container's death
gives one back. `sink` has no scope-end drop of its own either, so the total
count balances — it is the LIFETIME that is wrong: main's reference was
silently transferred to a container that dies first.

This is the dup/drop pair optimizer's cancellation
(`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`; the mechanism is
described in `AGENTS.md` — "a named local passed to a struct literal gets a
deferred `___dup` (copy semantics), and the move you see in the emitted C is
manufactured by the dup/drop pair optimizer cancelling that dup against the
scope-end drop"). Cancelling is sound only when the container lives at least
as long as the local. Here the container is in an INNER scope, so the dup that
was cancelled belonged to a shorter lifetime than the drop it was cancelled
against.

## Why it was not noticed

**The GC masks it for a plain `ref`.** With `S :: ref(struct(...))` the same
program prints the right answer and exits 0 — not because the accounting is
right, but because a plain ref holding a ref is CYCLE-CAPABLE, so it is
GC-TRACKED and `__yo_decr_rc` routes to `__yo_decr_rc_tracked`, which buffers a
possible root instead of freeing immediately. An `atomic(ref(...))` is an Iso
type, never tracked, so `__yo_decr_rc_atomic` frees on the spot and the fault
is immediate.

Measured, same program, only the type constructor changed:

| container / field type | result |
| --- | --- |
| `atomic(ref(struct(...)))` | `rc=139`, SIGSEGV in the later read |
| `ref(struct(...))` | prints the right value, `rc=0` (GC deferral) |
| `atomic(...)`, container in the SAME scope | prints the right value, `rc=0` |
| `atomic(...)` + a `Dispose` impl | `rc=139` — `Dispose` is not the trigger |

So the non-atomic half of the language has the same wrong accounting and is
only saved by a collector that has to run eventually.

## Severity

A use-after-free on a shape a reader writes without thinking: build a handle,
put it in a struct inside a block, keep using the handle afterwards. It is
silent at compile time and, on the `ref` path, silent at run time too.

## Fix direction

`_optimize_dup_drop_pairs` must not cancel a dup emitted for a store into a
container whose scope is INNER relative to the local's own scope — the pair it
matches has to be same-scope. Per `AGENTS.md`'s warning about this family, the
change needs the dup/drop emit-diff gate (per-function dup/drop counts before
and after): a mispaired drop in the other direction is a double-free rather
than a leak. An over-cancellation canary belongs beside it — the same-scope
case above must keep its cancellation, or every struct store costs a
dup/drop pair again.

Tests: the reproducer as a `tests/` case in both spellings (`atomic(ref(...))`
and `ref(...)`), with a Dispose counter as the oracle rather than a leak
checker, plus the same-scope canary.

## Fix

`_optimize_dup_drop_pairs` (`src/evaluator/exprs/begin.yo`) gains one gate: a
dup whose own `ExprInfo.env` is DEEPER than the candidate's frame
(`ei.env.frames.len() > v.frame_level + 1`) cannot cancel that candidate's
scope-end drop. The pair then survives — the local keeps its dup and its drop,
the nested container releases what it took, and the totals balance.

**Measured by the dup's env depth rather than by restructuring the collector.**
The first attempt made `_search_dup_calls` treat a nested `begin` as a unit and
mark everything inside it. That also took ALIAS bindings (`env := env_in`) off
the CONSUMED path the early-return drop machinery uses, and the A/B emit-diff —
the same `src/main.yo` through the old and new compilers — showed **165 fewer
`__yo_decr_rc` calls**, i.e. `env` never dropped at all on some paths. The
depth gate's diff is `__yo_incr_rc` **+5** and `__yo_decr_rc` **+39**, both up:
one restored dup and one restored drop per exit path, which is exactly what
refusing a cancellation should cost.

Cond/match arms and `while` bodies are deliberately NOT caught. Measured, with
the `atomic(ref(...))` spelling that frees immediately: a container in a cond
arm, in both arms of a cond, in both arms of a match, and in a `while` body all
behave correctly today — the branch-aware collection path and the `while`
early-return in `_search_dup_calls` already keep them — and an arm body's frame
is not deeper than the frame being optimized.

Tests in `tests/rc.test.yo`, all over a module-level Dispose counter so both
directions are caught (an early free AND an unmatched dup that never disposes):

- a container one block deep, and two blocks deep — **red before the fix**;
- the SAME-scope container, which must keep its cancellation (the
  over-cancellation canary: two disposes means the gate went too wide, none
  means a dup is unmatched);
- a cond arm and a `while` body, which must also keep theirs.

Verified on the merged tree: suite **4131 passed / 0 failed**,
`gates_fast.sh` GATE 0–8 **`failures=0`**, `fixpoint_only.sh` **`FIXPOINT_HOLDS`**.
