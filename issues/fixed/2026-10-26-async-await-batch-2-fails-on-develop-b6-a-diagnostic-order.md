# tests/async_await.test.yo batch 2 fails to compile on develop: the §3.13 A2 expectation loses to the P3 ref-vs-grow diagnostic

Filed 2026-10-26, found while re-gating VBD B4-3e (`vbd/b4-3e-evaluator-exprs`) on develop `6b288e5e1`.

**Severity:** S2 — 85 of 285 tests in `tests/async_await.test.yo` report failed on develop tip (the whole batch-2 synthesis fails to compile), so every gate that runs the file — develop's battery included — goes red.

## Verbatim error

```text
error: comptime_expect_error: the expression raised an error, but not the expected one.
- Expected text: lives in a shared mutable cell
- Raised: A 'ref' argument ("xs(usize(0))") borrows into the container "xs", but argument 2 of the same call could hold a handle to "xs" and grow it, reallocating the buffer the reference points into. Read the element into a local first ("xs.get(i)" copies it, std/mem's "take(&mut xs(i))" moves it out), or split the calls.
    --> tests/.yo_selftest_batch_<id>_1_2.yo:381:91
```

`yo: error: test: tests/async_await.test.yo — 0 of 85 tests in this batch ran: the batch failed to compile (exit != 0).`

## Reproducer

Run the file itself; no fixture needed:

```bash
yo test tests/async_await.test.yo --std-path ./std --parallel 1
```

The failing expression is the `§3.13 A2` case at test idx 71 (`tests/async_await.test.yo`, the `a borrowing method future ...` block):

```yo ignore
comptime_expect_error((io.await)(_a2_bump_i32(&mut(xs(usize(0))), io), io), "lives in a shared mutable cell")
```

The program is still **rejected** — only the selected diagnostic changed: the P3-family ref-vs-grow error now fires where the A2 "lives in a shared mutable cell" error used to.

## Where it came from (bisected with branch-tip binaries, 2026-10-26)

| Tree | Binary | Result |
| --- | --- | --- |
| `a27cd5f01` (#1615 tip, pre-range) | B4-3e's first base | 285/285 pass |
| `77984cb1d` (v3-std branch tip ≈ #1617 + #1616; **no** #1618) | v3-std worktree build | 285/285 pass |
| `7e03b388f` (b6-a branch tip ≈ #1617 + #1618 + b6-a) | b6-a worktree build | 200 pass / 85 fail (this error) |
| `6b288e5e1` (develop tip, #1621) | B4-3e final base | 200 pass / 85 fail (identical) |

The culprit range is therefore #1618–#1619. #1618 (`af67fdf59`, the windows-11-arm operand-spill fix) is a codegen-only change and cannot alter a `comptime_expect_error` diagnostic, which leaves **#1619** (VBD B6-a, decision 20's std accessors — "an element borrow beside an unreachable sibling is accepted") as the attribution: its accessor-borrow judgment reorder made `&mut(xs(usize(0)))` in an `io.await` call argument list reach the ref-vs-grow check first. Not excluded by binary alone, but by content.

B4-3e's own corpus gate is unaffected: `yo compile tests/async_await.test.yo --emit-c` succeeds byte-identically on base and head — the failure is specific to the test runner's batch synthesis (the guard `(__yo_test_idx == 71)` arm evaluating the `comptime_expect_error` at compile time).

## The fix (belongs to the B6-a owner / a fix(develop) PR)

Either of:

1. the A2 §3.13 shared-mutable-cell check must fire before the ref-vs-grow check for an `io.await` argument list (restore the pre-#1619 order), or
2. the two expectations at `tests/async_await.test.yo` idx 71 (and the batch's other A2 `comptime_expect_error`s that now raise the ref-vs-grow text) accept the new, more precise message.

The verdict needs the B6-a owner's intent for decision 20's accessor guidance; this file records the regression so the red develop battery has a name.

## Root cause (confirmed 2026-10-26, fix branch `fix/b6a-async-diagnostic-order`)

Not a literal reorder: `require_valid_ref_argument_places` (the ref-vs-grow
gate) has ALWAYS run inside call evaluation, before `_note_future_producing_call`'s
A2 check. What changed is rule (b)'s judgment of the `io` sibling. `Io` is a
struct of four plain `fn` fields; the pre-#1619 representation formulas
(`type_contains_rc_type`, `type_representation_contains_raw_ptr`) judge a bare
`fn` harmless, so rule (b) never fired beside it. #1619's reachability walk
(`_type_may_reach_any_of`) conservatively answers yes for every `Func` field
(it may be a closure that captured the container), so `io` now counts as "could
hold a handle to xs" in EVERY async call that lends an element or object-hop
place. That displaces A2's message on the rejected shapes — and also REJECTS
shapes A2 deliberately accepts (a shared borrow through an `Rc` payload, e.g.
`io.await(_a2_count(&r.*.items, io), io)`), which the batch failure masked
(the wrong-message `comptime_expect_error` kills the batch compile before any
assert runs).

## Fixed (2026-10-26)

The callee's DECLARED result cannot tell which parameters the future captures
(the registered captures live under the `io.async` value's per-call wrapper
id, a different SomeT from the signature annotation), so the fix DEFERS the
sibling rule instead of pre-deciding: `_reject_if_container_reachable`'s rule
(b) records its complaint for a future-PRODUCING callee
(`flag_deferred_sibling_rule`, src/types/flowability.yo) instead of throwing
at the call, and `_note_future_producing_call` (src/evaluator/calls/function.yo)
settles it against the future's real capture list — a parameter a capture
names is §3.13 A2's (its cell diagnostic, or the deliberate
shared-through-`Rc` acceptance; the #1629 re-pin to the aliasing text went
back to the A2 pin), any other complaint re-raises. Rule (a) (a module-level
container) is unchanged, a fixed-size `Array` index place is exempt from rule
(b) (inline storage; part 2 of
`issues/fixed/2026-10-26-the-async-await-a2-batch-is-poisoned-three-ways-on-develop.md`),
and #1619's sibling walk is unchanged for every non-future call (B6-a's
accepted borrows all stay accepted). `tests/async_await.test.yo`: 285/285.
