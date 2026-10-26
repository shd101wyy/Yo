# async_await §3.13 A2 tests expect "lives in a shared mutable cell" but the ref-argument realloc error fires

**Fixed by #1634** (`c3526f3fe`, 2026-10-26): §3.13 A2 owns the places a
borrowing future captures — the flowability sibling-reachability rule defers
to the A2 diagnostic (part 1), and a fixed-size Array index place is exempt
(part 2); `tests/async_await.test.yo` passes 285/285 on `c3526f3fe`. The
canonical fix docs are
`issues/fixed/2026-10-26-an-element-borrow-beside-an-io-sibling-is-rejected-as-container-aliasing.md`
and
`issues/fixed/2026-10-26-async-await-batch-2-fails-on-develop-b6-a-diagnostic-order.md`;
this record is kept for its clean-binary attribution table (the failure
reproduced with compilers carrying none of b4-1b's edits).

**Severity:** S2 — the `tests/async_await.test.yo` §3.13 A2 batch fails to
compile on the develop tip (85 of 285 cases report failed), and a real program
shape gets the realloc diagnostic where `plans/VALUES_BY_DEFAULT.md` §3.13 A2
(decision 38 D) specifies the shared-mutable-cell one.

Found during VBD B4-1b's gate run (2026-10-26), on the develop tip `6b288e5e1`
and still present at `d66d483d8`.

## The failure

```text
error: comptime_expect_error: the expression raised an error, but not the expected one.
-- Expected text: lives in a shared mutable cell
-- Raised: A 'ref' argument ("xs(usize(0))") borrows into the container "xs", but
   argument 2 of the same call could hold a handle to "xs" and grow it, reallocating
   the buffer the reference points into. Read the element into a local first
   ("xs.get(i)" copies it, std/mem's "take(&mut xs(i))" moves it out), or split the calls.
    --> tests/.yo_selftest_batch_652805_1_2.yo:381:91
```

`yo test tests/async_await.test.yo --std-path ./std --parallel 1` →
`200 passed / 85 failed`, rc=1. Every §3.13 A2 case after the first
`comptime_expect_error` fails with "the batch failed to compile".

## Attribution — NOT a b4-1b regression

Measured with clean binaries (no b4-1b edits), same worktree std:

| Binary | Std | Result |
| --- | --- | --- |
| b4-1b pre-rebase head (my edits on `a27cd5f01`) | `a27cd5f01` std | PASS (2026-10-26 15:20, previous agent's gate log) |
| clean base build of `6b288e5e1` | `6b288e5e1` std | FAIL 200/85 |
| clean build of `a27cd5f01` (`yo-base`) | `6b288e5e1` std | FAIL 200/85 |
| b4-1b head `445ffa1ca` | `6b288e5e1` std | FAIL 200/85, same error text |

So the trigger is the std/compiler delta of the `a27cd5f01..6b288e5e1` window
(#1616–#1621: B4-1a, V3 std, B6-a's decision-20 accessor family, B7c's
`HashMap.entry`, B4-2) — most plausibly B6-a's F1 rule ("a function-typed
sibling is judged by its representation"), which changed what
`src/types/flowability.yo`'s "any OTHER argument could hold a handle" arm
concludes for the `io` argument of an `io.await` call. Bisecting the exact PR
is left to develop's fix-forward.

## Reproducer

The batch case at `tests/async_await.test.yo` §3.13 A2 (the
`comptime_expect_error((io.await)(_a2_bump_i32(&mut(xs(usize(0))), io), io), "lives in a shared mutable cell")`
line) is the in-tree test; it fails before any fix and must pass after.

## Recommendation

Decide which diagnostic the A2 shape should carry when BOTH the
shared-mutable-cell rule (§3.13 A2, `src/evaluator/calls/function.yo`) and the
ref-argument-grow rule (`src/types/flowability.yo`) match: either the cell
diagnostic wins (the A2 rule is the more specific — the tests then pass
unchanged), or the tests' expected text moves to the realloc diagnostic and
§3.13 A2's plan section records the new message.
