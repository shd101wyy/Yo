# Two stale `comptime_expect_error` pins poison one `async_await` batch

**Severity:** S2 — `yo test tests/async_await.test.yo` reports 85 of 285 tests
failed on develop @ `fdab9d551`: the batch holding the two §3.13 A2 bodies
fails to compile, so every test placed in it "did not run". The file has been
red under a develop-built binary since #1619 landed (measured with the tree
binary; develop's own file content fails identically, 200 passed / 85 failed,
so this is not introduced by the B6-c tests sweep).

## Symptom

```text
error: comptime_expect_error: the expression raised an error, but not the expected one.
- Expected text: lives in a shared mutable cell
- Raised: A 'ref' argument ("xs(usize(0))") borrows into the container "xs", but
  argument 2 of the same call could hold a handle to "xs" and grow it, ...
    --> tests/.yo_selftest_batch_..._1_2.yo:381:91
```

and, from the second body:

```text
- Expected text: the bundle must be a place
- Raised: Cannot use implicit variable "io" in assignment. Implicit variables
  must be passed via  parameters.
```

A failing trial aborts the batch generation, so all 85 tests in that batch are
reported failed without running.

## Root causes (two, one per body)

1. **`tests/async_await.test.yo:7620`** — the trial
   `io.await(_a2_bump_i32(&mut xs(usize(0)), io), io)` pinned
   `"lives in a shared mutable cell"` (§3.13 A2). B6-a's
   container-reachability check (#1619,
   `issues/fixed/2026-10-24-an-element-borrow-rejects-a-sibling-argument-that-cannot-reach-the-container.md`)
   rejects this shape earlier, at the call itself: the `&mut xs(usize(0))`
   borrow beside the `io` sibling that could hold `xs`. The A2 shared-cell
   check is never reached for this shape. The scenario is still rejected —
   only the message moved. **Fixed here by re-pinning** to
   `"argument 2 of the same call could hold a handle"` with a comment naming
   the earlier check. The other two trials of the same body still hit their
   old rules (the Rc read-only rule, the shared-cell rule), so the body keeps
   its A2 coverage.
2. **`tests/async_await.test.yo:7727`** — the body
   "a borrowing future's io.await takes a bundle that is a place (§3.13 A2)"
   feeds `io.await(_a2_count(&s, io), { s = ArrayList(i32).new(); io })`. The
   await-bundle lowering's internal "the bundle becomes the new io" step is
   emitted as an ASSIGNMENT of the implicit test-body `io`, and decision 47's
   implicit-variable rule rejects it (`Cannot use implicit variable "io" in
   assignment`) before the bundle-must-be-a-place check can fire. **Open.**
   The fix belongs in the evaluator (evaluate the bundle into a temporary and
   pass it, or exempt the lowered assignment), not in the pin: pinning the
   leaked internal diagnostic would bless it.

## Reproducer

`issues/repros/2026-10-26-two-stale-comptime-expect-error-pins-poison-an-async-await-batch.yo`
(the second body verbatim, standalone): `yo check <file> --test-bodies
--std-path ./std` prints the second mismatch above. The full failing test is
`tests/async_await.test.yo` itself: `yo test tests/async_await.test.yo
--parallel 1 --std-path ./std` → 200 passed / 85 failed on develop's own file
content (verified on a clean checkout of `origin/develop`'s copy of the file
with a develop-built binary).

## Fix

Part 1 re-pins `tests/async_await.test.yo:7620` (this PR). Part 2 needs an
evaluator change and is left open for the coordinator (a `fix(develop)` PR or
the B6-c src half); until it lands, `tests/async_await.test.yo` stays red on
develop regardless of this re-pin, because body 7723 still poisons its batch.
