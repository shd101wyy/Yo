# verifier: a contracted GENERIC function is silently unverified in verify mode

Found 2026-09-17 while scoping task 2's abstract-verification slice
(plans/backlog/FORMAL_VERIFICATION.md §680). This is the SILENT GAP the
V5-era "honest diagnostics over silent skips" principle forbids, and it
is the concrete entry point for task 2's remaining half.

## Symptom

```rust
pragma(Pragma.Verify);

identity :: (
  fn(generic(T : Type), x : T, ensures(result == x)) -> (result : T)
)(x);
```

`yo verify` over this file exits green: `identity` registers NO verify
task at all, because the task-registration gate skips DEFERRED
(`should_defer_ft`) bodies — a generic fn's body has no ExprInfo (its
def-time trial is skipped), so there is nothing to walk. The fn's
contracts are enforced at CALL SITES (#687's per-site stash), but the
body itself — its internal obligations, its ensures as a PROOF — is
never checked, and nothing says so. The same silence applies to
`assumed()`-less generic helpers whose internal obligations (index
math over T, AoRTE on T-typed division) go unproven and unmentioned.

## Why it is hard (the measured obstacles)

- The def-time trial of a generic body would need the generic params
  bound to usable placeholders; operator dispatch over same-SomeT
  unknowns fails and is swallowed, so the body's ExprInfo is hollow —
  the walk then fails "untyped expression" on every node.
- The plan's design ("type variables become uninterpreted sorts")
  needs: a `VcSort.Uninterpreted(name)` (+ encoder `declare-sort`),
  `==` on same-sort terms (plain `(= a b)` — SMT-expressible today),
  and LOUD subset failures for every other operation over T (BV
  arithmetic on an uninterpreted sort must be a walk-side subset fail,
  never a z3 error).
- The handover (§4.1) measured "verify per specialization" as
  insufficient: instances minted only at runtime calls never exist at
  verify-drain time.

## Suggested first slice (per the handover §4.1)

Support ONLY "type variables used opaquely": bind / equality / return /
cond-with-T-value... and FAIL THE SUBSET LOUDLY on arithmetic and
trait-method calls over T. The first fixture:

```rust
identity :: (
  fn(generic(T : Type), x : T, ensures(result == x)) -> (result : T)
)(x);
```

`==` on opaque terms is already SMT-expressible. Until this slice
lands, the minimal honest improvement is a LOUD diagnostic: a
verify-mode task whose body is deferred should report
`unsupported: generic body (task 2)` instead of registering nothing —
with the exit policy decision (fail vs warn) made explicitly in the
plan, not by silence.
