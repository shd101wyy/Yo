# A borrowing future can carry an `imm` borrow across an `Rc` deref with no mark held

**Severity:** S1

Filed 2026-10-07 from the soundness audit in
[issue #1251](https://github.com/shd101wyy/Yo/issues/1251) (finding 1).
The design gap is CLOSED in the plan — decision 38 D was extended on
2026-10-07 — and this doc tracks the V3 async implementation requirement:
the rule must be enforced by §3.13 A2's PR, with the tests below, or the
UAF below ships with async borrowing futures.

## The gap as written

`plans/VALUES_BY_DEFAULT.md` §3.13 A2 rejected only the *exclusive* case
("a `mut` argument whose place passes through an `Rc`/`Arc` deref is a
compile error"), while decision 28's shared marks are call-scoped and
decision 38 D covered closure captures only. So an `imm` borrow whose path
crosses an `Rc` deref into a future was neither rejected nor given a mark
for the suspension:

```rust
// task A:
io.await(f(&rc.items), io);        // f's future imm-captures &rc.items
// scheduler runs task B while A is suspended:
rc.items.push(x);                  // B's own Rc handle; reallocates the buffer
//   — §3.10's write-site assert fires only if a conflicting mark is held.
//   — decision 28's mark died when the call to f returned. No mark is held.
// A resumes inside f's body and reads the freed buffer.
```

That is a use-after-free in generated code.

## The decision (2026-10-07, maintainer)

Decision 38 D's rule is extended to borrowing future captures: a future's
`imm` parameter whose place crosses an `Rc`/`Arc` deref is a compile
error. The error names the fix, as 38 D does for closures: pass the
handle (`f(imm(r), io)`, deriving `r.*.field` at each use) or own the
value in the task. This was chosen over await-scoped marks, which would
be the model's only non-call mark scope.

## What the implementation PR (§3.13 A2, V3 async) must carry

- the rejection at future-creation for `imm` argument places crossing an
  `Rc`/`Arc` deref, with the error text naming the handle-passing fix;
- the move-only-receiver allowance stays (unique `Box` cells cross no
  `Rc` deref);
- negative tests: `io.await(f(&rc.items), io)` rejected; the handle
  spelling accepted; a `mut` through an `Rc` deref still rejected;
- a positive test that the accepted spelling survives a concurrent
  `push` on the other handle (re-derived places read the new buffer).

## Fix (2026-10-12, §3.13 A2)

A2 landed borrowing futures with the rule enforced. A borrowing future can be
used in one place only, as the direct operand of `io.await`, because binding,
storing and spawning it are E0909. So the check sits there:
`_check_awaited_future_lends` (`src/evaluator/calls/function.yo`) maps each
borrow the awaited future carries back to the argument its call lent (a
`&`/`&mut` marker argument by the parameter's label, and a method receiver as
`self`). It rejects a lent place that crosses an `Rc`/`Arc` or `ref`
dereference, including an auto-dereferenced receiver (`k.bump(io)` on an
`Rc(Counter)`). The error names the handle-passing fix. A capture list
written directly on the `io.async` body already rejected such places
(decision 38 D, `capture_place_crosses_cell`).

Tests, in `tests/async_await.test.yo`, "a borrowing future cannot hold a
place lent through an Rc deref":
- `io.await(_a2_count(&r.*.items, io), io)` is rejected;
- the `&mut` twin is rejected;
- the auto-dereferenced receiver `k.bump(io)` is rejected;
- the handle spelling `_a2_count_through(&r, io)` is accepted, and it reads a
  push that another task made through its own handle while the future was
  suspended.
