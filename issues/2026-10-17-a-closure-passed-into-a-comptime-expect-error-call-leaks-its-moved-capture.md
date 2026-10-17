# A closure passed into a `comptime_expect_error` call leaks its moved capture

**Severity:** S3. This is a leak in a program that runs and is correct. It shows up only under the local leak verdict, and only for an expression that `comptime_expect_error` rejects, so it never runs.

**Status: OPEN.** Found 2026-10-17 while running the Tier 1 gate for `fix/derive-clone-recursive-and-generic-containers`. **Measured on:** `yo-dev-5425cd7bf` (develop with #1380), which fails the same way as the branch binary, so the leak was already on develop.

## Symptom

`tests/copy_trait.test.yo`, test "Copy: where(T <: Copy) rejects a closure that owns a String", fails under the default local leak verdict:

```
✗ Copy: where(T <: Copy) rejects a closure that owns a String
  Memory leak detected:
  ==…==ERROR: LeakSanitizer: detected memory leaks
  Direct leak of 32 byte(s) in 1 object(s) allocated from: …
```

CI runs with `YO_TEST_LEAK_VERDICT=0`, so CI stays green.

Reproduce with `yo test tests/copy_trait.test.yo --parallel 1 --test-name-pattern "rejects a closure that owns a String"`.

## Suspected cause

The body moves `s : String` into `({ s }() => s.len())`, and then passes the closure only to calls that `comptime_expect_error` rejects (`_ct_need_copy(type_of(c), c)`). The rejected call is never emitted, so nothing consumes the closure. The 32-byte block matches the `String`'s buffer. The likely gap is that the local's drop is skipped because the evaluator recorded the closure as moved into the rejected argument. This is unconfirmed: the next step is to compare the emitted C for `c` with and without the `comptime_expect_error` lines.

## Fix direction

A value moved into an argument of a `comptime_expect_error`-rejected expression should still be dropped at its scope's end. Add a `Drop`-counter test, so the leak shows under CI's leak-verdict-off setting.
