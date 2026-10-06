# A move-only value cannot be moved into `Thread.spawn`

**Severity:** S2 — a closure capturing a `Dispose` value is rejected at `Thread.spawn` and `spawn(pool, …)`, though moving the value to the thread is sound

**Status:** OPEN. Found 2026-10-06 while landing the `Send`/`Sync` split (feat/vbd-send-sync).

## Symptom

`issues/repros/move-only-capture-through-thread-spawn.yo` (a `Dispose` struct `f` captured by a
`Thread(unit).spawn` closure) is rejected:

```
error: This closure does not implement Send: it borrows its captures (it is the literal argument
of a borrowing parameter and captures a value that is not implicitly copyable, so that value
stays in the caller's frame), and a borrow capture is never Send. ...
note: raised here, inside the standard library
   --> std/thread.yo: __yo_thread_spawn((io : Io) => {
```

Before the split it compiled and disposed `f` twice
(`issues/fixed/a-move-only-capture-sent-to-another-thread-is-disposed-twice.md`). The rejection is
sound, but the program is valid: `Thread.spawn` takes `own(cb)`, so the value should be MOVED to
the thread.

## Root cause

The relay closures in `std/thread.yo` (`Thread.spawn`, `spawn(pool, cb)`, `spawn_blocking`) are
literals passed to the plain, hence borrowing, parameters of the runtime externs
`__yo_thread_spawn` and `__yo_worker_spawn`, so they borrow a move-only `cb` instead of moving it
in. `spawn(pool, cb)`'s own `cb` parameter is plain too.

## Fix (not yet done)

1. Declare the externs' closure parameters owning (`sink(cb)`), and `spawn(pool, sink(cb) : …)`,
   so each relay is an escaping closure that moves `cb` in (decision 22).
2. Make the parallelism lowering (`src/codegen/exprs/parallelism.yo`) MOVE a move-only capture
   into the heap copy instead of "dup"ing it, with the spawner's drop of the moved capture
   suppressed, and check the reference-type captures still balance (`tests/thread.test.yo`,
   "Thread spawn releases its closure's captures").

Step 1 changes the externs' ownership convention, which the runtime C is emitted for, so it must
land together with step 2 and be measured for leaks under ASan/LSan on a tree-built stage-1. It
is V3's std half (resources become move-only values moved into threads,
`plans/VALUES_BY_DEFAULT.md` §6 V3) or V3b's flip, whichever comes first.
