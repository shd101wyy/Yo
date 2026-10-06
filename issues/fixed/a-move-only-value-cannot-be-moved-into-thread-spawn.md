# A move-only value cannot be moved into `Thread.spawn`

**Severity:** S2 — a closure capturing a `Dispose` value was rejected at `Thread.spawn` and
`spawn(pool, …)`, though moving the value to the thread is sound

**Status:** FIXED 2026-10-06 (feat/vbd-send-sync). The spawn boundaries now take the closure
`own`, the parallelism lowering's heap copy inherits the call-site capture struct's references,
and the spawn wrapper disposes the move-only content it owns.

## Symptom

`issues/repros/move-only-capture-through-thread-spawn.yo` (a `Dispose` struct `f` captured by a
`Thread(unit).spawn` closure) was rejected:

```
error: This closure does not implement Send: it borrows its captures (it is the literal argument
of a borrowing parameter and captures a value that is not implicitly copyable, so that value
stays in the caller's frame), and a borrow capture is never Send. ...
note: raised here, inside the standard library
   --> std/thread.yo: __yo_thread_spawn((io : Io) => {
```

Before the `Send`/`Sync` split it compiled and disposed `f` twice
(`issues/fixed/a-move-only-capture-sent-to-another-thread-is-disposed-twice.md`). The rejection
was sound, but the program is valid: `Thread.spawn` takes `own(cb)`, so the value should be MOVED
to the thread.

## Root cause

Three pieces, one per layer:

1. **The externs borrowed the relay.** The relay closures in `std/thread.yo` (`Thread.spawn`,
   `spawn(pool, cb)`, `spawn_blocking`) are literals passed to the plain, hence borrowing,
   parameters of the runtime externs `__yo_thread_spawn` and `__yo_worker_spawn`, so each relay
   borrowed a move-only `cb` instead of moving it in. `spawn(pool, cb)`'s own `cb` parameter was
   plain too.
2. **An `own` closure parameter was unmovable inside its specialized body.** A function with an
   `Impl(Fn(…))` parameter is specialized per closure type, and the specialization re-binds that
   parameter as a NON-OWNING callable shadow (`create_specialized_function_inline`'s re-bind
   loop — an owning re-bind was measured as a second, double release). The owning `own(cb)`
   binding sits in an outer frame of the same env, so `move_captured_explicit_copy_variable`
   saw only the non-owning shadow and raised E0901 ("a by-value parameter borrows").
3. **The lowering dup'd the heap copy.** `src/codegen/exprs/parallelism.yo` heap-copied the
   spawn closure's capture struct and retained a second reference per RC'd field, balanced by
   the relay temp's scope-end release. With the extern taking the closure `own` the temp is
   consumed (no release), so the dup over-retained — and a move-only capture, which has no dup,
   was never disposed on the thread at all: the wrapper's field walk only releases fields that
   contain an RC type.

## Fix

1. `std/thread.yo`: `__yo_thread_spawn` and `__yo_worker_spawn` take `own(cb)`, and so does
   `spawn(pool, own(cb))`. Each relay is now an escaping closure that MOVES `cb` in
   (decision 22), and the user's literal moves its captures into `spawn`'s `own(cb)` the same
   way.
2. `move_captured_explicit_copy_variable` (`src/evaluator/utils.yo`): when the innermost
   binding is a non-owning parameter, the move looks for the OWNING parameter binding of the
   same name it shadows (`_owning_param_binding_for_capture_move`) and consumes THAT — its
   scope-end release is skipped and the capture struct owns the reference.
3. `src/codegen/exprs/parallelism.yo`: the heap copy INHERITS the call-site capture struct's
   references (the dup block is deleted — the spawn is a move), and `_emit_capture_drop_lines`
   additionally runs `_emit_capture_dispose_lines` per field, which disposes the move-only
   content `generate_drop_code_for_value` cannot see (its early `!type_contains_rc_type`
   return): a value-nominal leaf's `___dispose`, recursing through structs, tuples, arrays,
   newtypes, closure capture structs embedded by value, and value-enum variants behind the same
   tag switch the drop walk uses.

The reference counts now balance with one fewer +1/−1 pair than before: construction dups the
RC captures, the heap copy inherits them, and the wrapper releases each once and disposes the
move-only content once.

## Verification

- `tests/send_sync.test.yo`: "a move-only capture crosses Thread.spawn and disposes once" and
  "…spawn(pool, …) and disposes once" — the capture is read on the thread and disposed exactly
  once; "a borrow capture is never Send" keeps the rule pinned through a plain borrowing
  parameter (`_ss_run_send`), which is still rejected.
- `tests/thread.test.yo` (all 20, incl. "Thread spawn releases its closure's captures") and
  `tests/send_sync_raw_pointer.test.yo` still pass — the RC-capture accounting is unchanged in
  effect.
- The repro prints `thread sees 3` then `dispose 3` exactly once each.
