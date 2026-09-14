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

## Where to look

Not diagnosed in the compiler yet. The parameter-side ownership flag is the
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
