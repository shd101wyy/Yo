# A `comptime_assert` over a promoted call in a function body accepts a false condition

**Severity:** S2 — a compile-time assertion that is false is accepted without a diagnostic when it sits in a function or `test(...)` body and its condition calls a function promoted there with `comptime_fn`; one of the tree's own tests passes for this reason.

Filed 2026-11-22 while measuring compile-time search for
`plans/backlog/LOGIC_PROGRAMMING_ADOPTION_CANDIDATES.md` (LP5). Reproduced
with `yo` 0.2.79 running the tree's `std` at `1e55e6c90`, and with a binary
built from a v0.2.80 worktree.

## Reproducer

```yo
_rt_factorial :: (fn(x : i32) -> i32)({
  step := i32(1);
  cond((x <= i32(1)) => step, true => (x * recur(x - step)))
});

test("5! is not 7", {
  ct_factorial :: comptime_fn(_rt_factorial);
  comptime_assert(ct_factorial(i32(5)) == 7);
});
```

`yo test repro.test.yo --std-path ./std --parallel 1`:

```text
  ✓ 5! is not 7
1 passed
```

The same two lines at module level are decided correctly. `== 120` checks
clean, and `== 7` is rejected:

```text
error[E1101]: Assertion failed for "comptime_assert":
ct_factorial(i32(5)) == 7
```

`tests/comptime.test.yo:3667` is the body shape
(`ct_factorial :: comptime_fn(_rt_factorial); comptime_assert(ct_factorial(i32(5)) == 120);`
inside a `test`), so that assertion verifies nothing today.

## Cause

`evaluate_comptime_assert` (`src/evaluator/builtins/comptime-assert.yo:111-176`)
has a validation path for a body that is type-checked but not executed. It
fails on a concrete `false` and, by design, only type-checks an UNKNOWN value
(`:142-157`): "a runtime condition, or a generic body whose types are not
bound yet, genuinely cannot be decided here". Inside a body, a call through a
binding made there by `comptime_fn(...)` evaluates to an unknown `bool`, so
the assertion takes that branch. Nothing decides it later: a `test` body is
not generic and is not evaluated again with the value known.

This is the remaining half of
`issues/fixed/comptime-assert-never-fires-inside-a-function-body.md`, which
made a concrete `false` fire in a body and left the unknown case open.

Not traced: why the promoted call is unknown in a body when the same call is
known at module level.

## A second observation, not root-caused

A function that recurses by its own name instead of `recur` promotes without
an error and then yields an unknown value at module level too:

```yo
fact :: (fn(n : i32) -> i32)(cond((n <= i32(1)) => i32(1), true => (n * fact(n - i32(1)))));
ct_fact :: comptime_fn(fact);
comptime_assert(ct_fact(i32(5)) == 120);
```

```text
error[E1101]: Expected bool value for "comptime_assert", got:
ct_fact(i32(5)) == 120

Value:
<unknown: bool>
```

Here the unknown value is reported, which is the behaviour the body case
lacks. Whether `comptime_fn` should reject this function or evaluate it is a
separate question; it may be its own defect.

## Fix

In a non-generic body, a `comptime_assert` whose condition is still unknown
when the body's validation ends is an error (the second E1101 text above),
not a pass. The generic case keeps deferring to instantiation, where the same
rule then applies.

## Test

The reproducer with `comptime_expect_error`, or a cli-case whose golden is the
failing `yo test`; and `tests/comptime.test.yo:3667` gains a negative twin so
it cannot pass vacuously again.
