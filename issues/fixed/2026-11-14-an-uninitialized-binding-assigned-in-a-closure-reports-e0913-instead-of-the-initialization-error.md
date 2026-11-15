# An uninitialized binding assigned in a closure reports E0913 instead of the initialization error

**Severity:** S2 — `x : i32;` assigned inside an `Fn` closure (`() => { x = 12; }`) reported E0913 ("the closure captures it implicitly, by value … the caller still owns") instead of "Cannot initialize a variable that is defined outside the function body."; the program was rejected either way, but the message describes a copy and a release that do not exist, and `tests/basic.test.yo`'s batch failed to compile on develop.

Found 2026-11-14 by develop's battery 43468394893 on `57fb978f9` (`test-wasm32_wasi shard 1/2`: `tests/basic.test.yo` —
"0 of 60 tests in this batch ran: the batch failed to compile"). Introduced by #1932 (audit §9 cluster 2, A46).

## Reproducer

`tests/basic.test.yo`, "Test assignments":

```yo ignore
x : i32;
(test1 : Impl(Fn() -> unit)) = (
  () => {
    comptime_expect_error(
      x = 12,
      "Cannot initialize a variable that is defined outside the function body."
    );
  }
);
```

```text
error[E0913]: Cannot assign to `x` here: the closure captures it implicitly, by value, and its call borrows the
captures shared (…). The write would change the closure's copy and release storage `x` still owns.
```

## Root cause

#1932 added `reject_implicit_capture_write` to `evaluate_assignment` (`src/evaluator/exprs/assignment.yo`), before
the initialization gate that runs after the right-hand side. A binding declared without a value holds nothing: an
assignment to it is its initialization, not a write over a value the closure copied, so neither the copy nor the
release E0913 describes exists. The initialization gate is the rule that applies (a closure body may not initialize
a binding defined outside it), and it never ran.

## Fix

`evaluate_assignment` calls `reject_implicit_capture_write` only when the assigned binding is already initialized
(`initialized_at_token()` is set before the right-hand side is evaluated). An initializing assignment reaches the
initialization gate, which rejects it with its own message. A write of an initialized implicit capture is E0913 as
before.

## Test

`tests/basic.test.yo` "Test assignments" (unchanged; its batch failed to compile before the fix and passes after).
`tests/fn_mut.test.yo`'s A46 cases keep E0913 for an initialized capture.
