# A move-only capture sent to another thread is disposed twice

**Severity:** S1 — a `Dispose` value captured by a `Thread.spawn` or `spawn(pool, …)` closure ran its `dispose` twice and was read after the first, with no diagnostic

**Status:** FIXED 2026-10-06 (feat/vbd-send-sync), by rejecting it: decision 38 E of
`plans/VALUES_BY_DEFAULT.md` ("a borrow capture is never `Send`"). Moving the value into the
thread is the open follow-up `issues/a-move-only-value-cannot-be-moved-into-thread-spawn.md`.

## Symptom

On develop `f946af074` (tree compiler, `--allocator system`), the repro
`issues/repros/move-only-capture-through-thread-spawn.yo`:

```rust
Fd :: struct(fd : i32);
impl(Fd, Dispose(dispose : ((self) -> println(`dispose ${self.fd}`))));
main :: (fn() -> unit)({
  f := Fd(fd : i32(3));
  t := Thread(unit).spawn(io => {
    println(`thread sees ${f.fd}`);
    ()
  });
  t.join();
});
```

printed

```
dispose 3
thread sees 3
dispose 3
```

`spawn(pool, io => … f.fd …)` behaved the same. The value was disposed by the spawner's scope
end, read by the thread afterwards, and disposed again by the thread's wrapper. For a file
descriptor that is a double `close`.

## Root cause

`#1217` made a closure literal passed straight to a borrowing parameter BORROW its captures when
one is not implicitly copyable (`note_borrowing_argument`, `closure_literal_is_borrowed`): no dup,
no move, on the reasoning that such a literal cannot outlive the call (decision 22). The relays
inside `std/thread.yo` break that reasoning:

- `Thread.spawn` hands `(io : Io) => { … cb(io) … }` to the extern `__yo_thread_spawn(cb : …)`,
  and `spawn(pool, cb)` hands a relay to `__yo_worker_spawn(cb : …)`. Both parameters are plain,
  hence borrowing, so each relay literal borrowed `cb`, a closure whose capture struct holds the
  move-only `Fd`.
- The parallelism lowering (`src/codegen/exprs/parallelism.yo`) heap-copies the relay's capture
  struct for the thread and "dups" each field. A move-only value has no dup, so the copy aliased
  the spawner's value, and both sides dropped it.

The user's own literal passed to `spawn(pool, …)`'s plain `cb` parameter was borrowed the same
way.

## Fix

A closure that borrows its captures is never `Send` (decision 38 E). `record_closure_capture_verdicts`
records that verdict, and `validate_capture_trait_requirements` rejects such a literal in a `Send`
slot (`src/evaluator/utils/closure.yo`). Both programs are now a compile error naming the rule;
nothing that compiles disposes a value twice.

## Verification

`tests/send_sync.test.yo`, "A borrow capture is never Send": the `spawn(pool, …)` literal over a
`Dispose` value is a `comptime_expect_error`. On develop it compiled (the expectation failed);
with the fix it is rejected with "a borrow capture is never Send".
