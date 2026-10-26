# The async_await A2 batch is poisoned three ways on develop

**Severity:** S2 — `yo test tests/async_await.test.yo` reports 85 of 285 tests
failed on develop @ `fdab9d551`: the batch holding the §3.13 A2 bodies fails
to compile, so every test placed in it "did not run". Two of the three causes
are valid code wrongly rejected. The file has been red under a develop-built
binary since #1619 landed (verified with the tree binary against develop's own
file content: 200 passed / 85 failed — not introduced by the B6-c tests sweep).

## Symptom

```text
error: comptime_expect_error: the expression raised an error, but not the expected one.
- Expected text: lives in a shared mutable cell
- Raised: A 'ref' argument ("xs(usize(0))") borrows into the container "xs", but
  argument 2 of the same call could hold a handle to "xs" and grow it, ...
    --> tests/.yo_selftest_batch_..._1_2.yo:381:91
```

A failing trial aborts the batch generation, so all 85 tests in that batch are
reported failed without running.

## Root causes (three; one per trial, in the order a fixed compiler meets them)

1. **`tests/async_await.test.yo:7625` — stale pin (S3 part).** The trial
   `io.await(_a2_bump_i32(&mut xs(usize(0)), io), io)` pinned
   `"lives in a shared mutable cell"` (§3.13 A2). B6-a's
   container-reachability check (#1619,
   `issues/fixed/2026-10-24-an-element-borrow-rejects-a-sibling-argument-that-cannot-reach-the-container.md`)
   rejects this shape earlier, at the call itself: the `&mut xs(usize(0))`
   borrow beside the `io` sibling that could hold `xs`. The A2 shared-cell
   check is never reached for this shape. The scenario is still rejected —
   only the message moved. **Fixed by re-pinning** in this PR's branch to
   `"argument 2 of the same call could hold a handle"`, with a comment naming
   the earlier check. The body's next two trials still hit their old rules
   (the Rc read-only rule, the shared-cell rule), so the A2 coverage stays.
2. **`tests/async_await.test.yo:7632` — a fixed-size `Array` element is
   falsely rejected (S2, OPEN).** The body's POSITIVE case —
   `mut(a) := _A2Cells(cells : Array(i32, 2)(i32(4), i32(5)));
   io.await(_a2_bump_i32(&mut a.cells(usize(1)), io), io);` — asserts that an
   element of a fixed-size array is part of the local's own storage (no
   reallocation is possible, so the borrow is safe). #1619's check rejects it
   with the reachability message (`"xs.get(i)" copies it` help included —
   advice that cannot even apply to a fixed array). Valid code wrongly
   rejected since #1619; latent until the stale pin above was re-pinned,
   because the body died earlier. Standalone repro:
   `issues/repros/2026-10-26-the-async-await-a2-batch-is-poisoned-three-ways-on-develop.yo`.
   The fix belongs in the container-reachability check (a fixed `Array(N, T)`
   field's buffer cannot grow; rule (b) of `_reject_if_container_reachable`,
   src/types/flowability.yo) — not in the test.
3. **`tests/async_await.test.yo:7728` — an await bundle ending in `io` is
   rejected as an implicit-variable assignment (S2, OPEN).** The body
   "a borrowing future's io.await takes a bundle that is a place (§3.13 A2)"
   feeds `io.await(_a2_count(&s, io), { s = ArrayList(i32).new(); io })`. The
   await-bundle lowering's internal "the bundle becomes the new io" step is
   emitted as an ASSIGNMENT of the implicit test-body `io`, and decision 47's
   implicit-variable rule rejects it (`Cannot use implicit variable "io" in
   assignment`) before the bundle-must-be-a-place check can fire. The fix
   belongs in the evaluator (evaluate the bundle into a temporary and pass
   it, or exempt the lowered assignment) — not in the pin, which would bless
   the leaked internal diagnostic.

## Reproducer

`issues/repros/2026-10-26-the-async-await-a2-batch-is-poisoned-three-ways-on-develop.yo`
(part 2 standalone): `yo check <file> --test-bodies --std-path ./std` prints
the false rejection. The full failing test is `tests/async_await.test.yo`
itself: `yo test tests/async_await.test.yo --parallel 1 --std-path ./std` →
200 passed / 85 failed on develop's own file content (verified on a clean
checkout of `origin/develop`'s copy of the file with a develop-built binary),
and the same counts on this branch after the sweep plus the part-1 re-pin.

## Fix

Part 1 is re-pinned on this branch. Parts 2 and 3 need evaluator changes and
stay open for the coordinator (a `fix(develop)` PR or the B6-c src half);
until they land, `tests/async_await.test.yo` stays red on develop, because
body 7617 dies at part 2 and body 7728 at part 3 — both in the same batch.

## Fixed (2026-10-26, `fix/b6a-async-diagnostic-order`)

All three parts in one PR:

1. The pin went BACK to `"lives in a shared mutable cell"` (the b6-c
   re-pin to the aliasing text was the right call while the evaluator bugs
   stayed open; with the fix below the §3.13 A2 diagnostic is the one that
   fires again, so the pin names it).
2. and the diagnostic order it pinned are both fixed in
   `src/types/flowability.yo`: `_reject_if_container_reachable`'s sibling rule
   (b) DEFERS its rejection for a future-PRODUCING callee
   (`flag_deferred_sibling_rule`) instead of throwing at the call, and
   `_note_future_producing_call` settles the complaint against the future's
   real capture list — a parameter a capture names is A2's (its cell
   diagnostic, or the deliberate shared-through-read-only-handle acceptance),
   any other complaint re-raises. A fixed-size `Array(N, T)` index place is
   exempt from rule (b) entirely: its buffer is inline and cannot be
   reallocated, so the `io.await(_a2_bump_i32(&mut a.cells(usize(1)), io), io)`
   positive case is accepted again.
3. did not reproduce on the rebased tip (#1631) in isolation
   (`io.await(_a2_count(&s, io), { s = ArrayList(i32).new(); io })` raises
   "the bundle must be a place" as pinned, in a test body and in the full
   file — `tests/async_await.test.yo` returns 285/285 with no evaluator
   change to the bundle lowering); whatever exposed it at `fdab9d551` was
   carried away by #1624–#1631 or by the parts 1–2 fixes.

See also
`issues/fixed/2026-10-26-an-element-borrow-beside-an-io-sibling-is-rejected-as-container-aliasing.md`
(the S2 half) and
`issues/fixed/2026-10-26-async-await-batch-2-fails-on-develop-b6-a-diagnostic-order.md`
(the batch-2 record).
