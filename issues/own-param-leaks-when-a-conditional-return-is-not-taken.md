# An `own` parameter is never dropped if the body contains an untaken `if(c, { return(param); })`

**Status:** OPEN. **Class**: silent memory leak of every RC type passed by
`own`. **Found:** 2026-09-14, while root-causing
`issues/stddoc-coll-imm-vec-dedup-leaks-rc-elements.md` — whose filed diagnosis
turned out to be a symptom of this, not the cause.

## Symptom

A function taking `own(h)` leaks its argument whenever the body contains an
`if(cond, { return(h); })` whose condition is **false at runtime**. The value
is then never disposed, however the function goes on to exit — through the
tail, or through a *later* `return(h)` that does fire.

`issues/repros/own-param-leaks-when-a-conditional-return-is-not-taken.yo`,
six one-line functions that differ only in control flow:

```
A if fires, first stmt        : disposed=1 (expected 1)
B if NOT taken, exits by tail : disposed=0 (expected 1)   <- leak
C first if NOT taken, 2nd does: disposed=0 (expected 1)   <- leak
D stmt, then if fires         : disposed=1 (expected 1)
E bare tail, no if            : disposed=1 (expected 1)
F two ifs, neither taken      : disposed=0 (expected 1)   <- leak
```

```rust
b_fn :: (fn(own(h) : H) -> H)({
  if(h.tag < i32(0), {      // never true
    return(h);
  });
  h                          // <- h reaches here, and is never dropped
});
```

The discriminator is sharp and is the whole finding: **A and B are the same
function with the comparison flipped.** A disposes correctly; B leaks. D shows
it is not "a return inside an `if`" — an `if` that FIRES is fine. E shows the
`own` parameter is fine with no `if` at all. So the trigger is specifically a
conditional `return(param)` that is *not* taken.

## How it was found, and why the original filing was wrong

`imm.Vec.dedup` leaks every refcounted element, and the filed diagnosis was its
unique-owner path storing into a live slot with `consume` (which does not drop
what it overwrites). That mechanism is real, but it is **not what makes the
repro leak**, and three controls prove it:

| variant | disposed |
| --- | ---: |
| `dedup` on a vector with NO duplicates — the compaction store never executes | **0** |
| the whole unique branch replaced by a bare `return(self)` — no loop at all | **0** |
| the same branch reached from the FIRST early return instead of the second | **3** (correct) |

The first two remove the `consume` store entirely and the leak survives. The
third changes nothing but *which* early return fires, and the leak disappears.
`dedup`'s prologue is `if(self._len <= usize(1), { return(self); });` followed
by `if(rc(self) == usize(1), { … return(self); });` — for any vector longer
than one element the first `if` is untaken, which is exactly shape C.

`contains`/`index_of` do the same pointer-deref element reads and do **not**
leak, which rules out the reads.

## Mechanism (diagnosed 2026-09-14 — the emitted C and the deciding line)

The emitted C for shape B is unambiguous:

```c
static inline H* b_fn(H* h) {
  if (((h->tag) < (0))) {
    return h;                              // early exit: TRANSFER. correct.
  }
  else {
  }
  ((H*)__yo_incr_rc_atomic((void*)(h)));   // <-- SPURIOUS +1 on the fall-through
  return h;
}
```

Both exits return the same reference. The early one transfers it; the tail one
**dups** it and nothing ever drops the parameter's incoming reference, so the
fall-through path is +1. A and B emit identical code — the divergence is purely
which branch runs, which is why the symptom looked runtime-dependent.

The deciding line is `src/evaluator/exprs/begin.yo:2318`:

```rust
if(rv.is_owning_the_rc_value && ((rv.frame_level == (env.frames.len() - usize(1))) || is_own_param_return) && rv.consumed_at_token.is_none(), {
  // Transfer: consumed — the scope-end scheduler (e5) skips it.
  rv.consumed_at_token = Option(Box(Token)).Some(box(ast_expr_token(last_expr)));
}, {
  // Borrow/outer-frame share: balancing dup.
  set_expr_as_needs_to_call_dup(return_value_expr, ctx, exn);
});
```

It runs twice for these bodies, because `return(h)` is itself the tail of a
nested begin and `is_own_param_return` deliberately transfers "from ANY nested
begin block":

1. **nested begin, tail `return(h)`** — not yet consumed, so it takes the
   transfer arm and sets `consumed_at_token` on the **env Variable**;
2. **function-body begin, tail `h`** — now sees `consumed_at_token.is_some()`,
   fails the guard, and falls into the else arm: **a dup**.

`consumed_at_token` is a property of the variable, not of a path, so a
consumption recorded by one branch is visible to a sibling branch. But the two
`return`s are **mutually exclusive function exits** — at most one executes, and
each should transfer.

### Scoped precisely to `own` parameters

Measured, same shape, same runtime path:

| returned thing | disposed |
| --- | ---: |
| a LOCAL (`loc := H(...)`, returned from an untaken conditional) | 1 ✅ |
| a BORROWED parameter (`p : H`) | 1 ✅ |
| an `own` parameter | **0** ❌ |

So the `rv.frame_level == env.frames.len() - 1` disjunct — the local case — is
fine; only the `is_own_param_return` disjunct leaks. That is consistent with
the mechanism: a local's transfer is decided in the frame that owns it, while
`is_own_param_return` deliberately reaches across nested begins, and the
consumed flag it sets then outlives the branch that set it.

## Why this is NOT fixed here

The obvious edits are both wrong:

- **Dropping the `consumed_at_token.is_none()` guard** for the own-param case
  would let two exits each transfer — right for mutually exclusive returns,
  wrong for a genuine earlier consumption on the SAME path
  (`x := h; use(x); … return(h)`), which would become a double transfer.
- **Not marking consumed at the early return** would let the early-return drop
  machinery ("Drop local variables before early return", the M3 driver noted
  just below this code) emit a drop of `h` immediately before `return h` — a
  use-after-free, strictly worse than the leak.

A correct fix needs the consumption to record that it came from a **function
exit**, so a sibling exit may also transfer while an in-path consumption still
blocks it. That is a new discriminator on `Variable` (which is constructed in
~8 places in `src/env.yo`) or an equivalent side record.

That change is in the family AGENTS.md requires an emit-diff gate plus an
OVER-cancellation canary for, because the failure mode of getting it wrong is a
double free rather than a leak. It wants its own session with those gates —
not a drive-by edit during a release freeze. Everything needed to make it a
short change is above: the deciding line, the two-visit sequence, the scoping
measurement that excludes locals and borrowed parameters, and the two wrong
fixes to avoid.

## Where to look

Not diagnosed further. The parameter-side ownership flag is the
obvious place: `Variable.is_owning_the_rc_value` gates the scope-end drop
scheduled by `begin.yo`'s parameters-frame pass
(`_schedule_scope_end_drops(..., params_only : true)`), and AGENTS.md already
records that a parameter is bound in THREE places with only the def-time
binder historically setting `own` correctly. The shape here suggests the
`return(param)` is marking the parameter consumed for the WHOLE body rather
than for that branch, so the fall-through path omits the drop while nothing on
that path ever took ownership.

Worth checking against the dup/drop pair optimizer too
(`_optimize_dup_drop_pairs`, `src/evaluator/exprs/begin.yo`), which AGENTS.md
warns must follow `ExprInfo.macro_expansion` — though `if` has been desugared
to `cond` at parse time since 2026-08-21, so the real `cond` node is visible
here.

## Severity

Silent, and it hits a shape that is idiomatic: "fast-path guard, then the real
work, returning the same owned value". `imm.Vec.dedup` is one instance found by
accident. Any `own` parameter of an RC type in a function with a guard clause
is a candidate, so the blast radius is `std` plus user code, and nothing in CI
can see it — leak detection is off everywhere
(`issues/leak-regression-tests-cannot-fail-in-ci-leak-verdicts-are-off-everywhere.md`),
so a leak is only observable as a MISSING disposal, which is what the repro
counts.

## Regression test

The repro asserts rather than returning a status, because `main`'s return value
is discarded
(`issues/main-return-value-is-discarded-so-a-main-computed-exit-code-is-always-zero.md`).
It aborts with rc=134 while the bug is present. It should become a
`tests/` case with the fix, covering all six shapes — A, D and E are the
controls that must keep passing, and without them a fix could "work" by
dropping the parameter twice.
