# The task-abort registry's array is never freed

**Severity:** S3 — one array per thread that ever registered an escaped task (224 B on macOS arm64) leaks at thread exit; it does not grow per task, but it is noise in every `leaks --atExit` run of an async program that unwinds

**Status:** FIXED 2026-09-29 (branch `fix/sm-dup-temp-leak`, after the release).
**Found:** 2026-09-29, alongside `issues/fixed/a-dyn-temp-in-a-state-machine-is-never-stored-to-its-field.md`.

## Measured

A task whose body throws to an unwinding handler without awaiting first (lowered as a sync future):

```
$ leaks --atExit -- ./a.out
1 (224 bytes) ROOT LEAK: <malloc in …_sync_fut_t_resume> [224]
```

The return address in the stack (`resume + 344`) follows the `bl _realloc` of the inlined
`__yo_task_abort_register`: the block is `__yo_task_aborts.items`.

## Root cause

`emit_task_abort_registry` (`src/codegen/functions/gc_runtime.yo`) keeps the registry in a
`_Thread_local` struct. `__yo_task_abort_register` grows its array with `realloc`, and nothing ever
frees it. The main body runs on a worker thread, so when that thread exits the only pointer to the
array goes with it.

## Fix

`__yo_task_abort_registry_free` releases the array and resets it. `__yo_task_abort_take_entry` calls
it when it removes the last entry, and so does `__yo_task_abort_report_unobserved` at the end of the
program. Aborts are rare, so reallocating on the next one costs nothing measurable. Freeing on empty
also covers pool and `Thread` workers, which never reach the end-of-program report. With the change
spliced into the emitted C, `leaks --atExit` reports 0 leaks.

## Test

`tests/internal/gc_runtime_atomics.test.yo`, "the task-abort registry frees its array when it empties",
pins the emitted template: taking the last entry and the end-of-program report both free the array.
A Yo test cannot observe the thread-local array, and the cli-case harness ignores emitted C.
