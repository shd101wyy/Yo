# `spawn_blocking`'s detached worker can outlive `main`, and LeakSanitizer reports what it still holds

**Severity:** S3 — about one run in a few hundred, a program that awaits `spawn_blocking` and then exits gets a 104-byte LeakSanitizer report: the detached worker thread has not yet released its closure when the process ends. This makes `tests/spawn_blocking.test.yo` flaky under a local leak verdict.

**Found:** 2026-10-17, by the `fix/generic-binder-sink-closure-fn-type` Tier 1 gate (`tests/spawn_blocking.test.yo`, "a sibling task keeps running while spawn_blocking blocks", one failure). CI runs with `YO_TEST_LEAK_VERDICT=0`, so CI does not see it.
**Status:** open.

## Symptom

The test's body, run as a standalone `main(io : Io)` program built with
`--sanitize address --allocator system`:

```text
Direct leak of 40 byte(s) in 1 object(s) allocated from:
Indirect leak of 64 byte(s) in 1 object(s) allocated from:
SUMMARY: AddressSanitizer: 104 byte(s) leaked in 2 allocation(s).
```

Measured on the same machine: the develop binary `5425cd7bf` leaked on run
391 of a loop; the branch's binary leaked once in a 20-run loop and on run 102 of another. It was 0 of 200 in
other loops, so the rate is low and timing-dependent. The branch does not
cause it.

## Root cause (suspected)

- `spawn_blocking` (`std/thread.yo`) detaches its worker (`_detached :=
  worker`). The worker closure sends the value, wakes the loop and ends the
  blocking bracket. Only then does the closure return and release its
  captures: the `Channel` handle `sink` and the user closure.
- Once the wake has been delivered, `main` can finish and the process can
  exit before the worker thread runs that release. LeakSanitizer then reports
  the captures that are still live. The 40 + 64 bytes match a `Channel` object
  and its buffer.

## Fix direction

Either join detached workers at process exit (a runtime-level registry of
live detached threads), or release the worker closure's captures before the
wake that lets the awaiting task finish. The second fix only narrows the
window, because the thread's own teardown still races the exit.
