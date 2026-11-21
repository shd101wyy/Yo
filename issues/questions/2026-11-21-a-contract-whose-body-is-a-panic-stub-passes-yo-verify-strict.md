# A contract whose body is a `panic` stub passes `yo verify --strict`

**Kind:** design question — an open decision, not a defect.

**Status:** OPEN — found 2026-11-21 while measuring the spec-first workflow
for `plans/backlog/LOGIC_PROGRAMMING_ADOPTION_CANDIDATES.md` (LP3). Tree
`1e55e6c90`, `yo` 0.2.79 with the tree's `std`, Z3 5.1.0.

## What happens

```yo
pragma(Pragma.Verify);
{ panic } :: import("std/assert");

// The contract is written; the body is not.
isqrt :: (
  fn(
    n : u32,
    requires(n < u32(1000000)),
    ensures((r * r) <= n, ((r + u32(1)) * (r + u32(1))) > n)
  ) -> (r : u32)
)({
  panic("isqrt: not written yet")
});

// Proved against isqrt's contract alone.
caller :: (fn(n : u32, requires(n < u32(1000000)), ensures((r * r) <= n)) -> (r : u32))({
  isqrt(n)
});
```

`yo verify stub.yo --std-path ./std --strict` exits 0:

```text
  ok       fn@stub.yo:9 [verify] — no obligations
  ok       fn@stub.yo:15 [verify] — 2 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous) — 2 queries, 0 cached (0%), 0 folded, 95 ms
verify: strict — assumed, outside-subset and unproven count as failures
```

## Why it is by design today

Each step is a recorded decision:

- Partial correctness is the default (D12), and a path that reaches `panic`
  owes no `ensures` (`docs/en-US/FORMAL_VERIFICATION.md`, the subset table).
  The stub therefore has zero obligations.
- A function with zero obligations is `ok`, with `"vacuous": true` in the
  JSON report and a count in the summary line.
- `--strict` fails three classes: `assumed`, `outside-subset` and `unproven`
  (`src/main.yo:3377`). A vacuous `ok` is not one of them.
- The planned vacuity probes (`plans/backlog/FORMAL_VERIFICATION.md`,
  "Vacuity checking") do not reach it either: the hypotheses are consistent,
  and there is no `ensures` obligation for a conclusion probe to test.

## Why it is a question

`--strict` is described as the honest gate: "every stated contract holds".
A module made only of contracts and `panic` stubs passes it, and every caller
is proved against promises no body keeps. The stub is also indistinguishable,
in the outcome column, from a function that was proved; and writing
`assumed()` on it gives the same outcome as std's vouched contracts. Nothing
in the report says "this body is owed".

The same shape is legitimate elsewhere: a function that always panics and
states only `requires` has nothing to owe. So the rule cannot be "zero
obligations fails".

## Recommendation

Add an outcome `owed`: a function that states at least one `ensures` and
whose body owes it on no path. Callers still verify against its contract (as
with `assumed`); `--strict` fails it, as a fourth class. The JSON entry
carries the contract's source text, so the `owed` list is an agent's work
queue. This is detection from data the driver already has (the clause list
and the obligation count) and adds no keyword.

Open sub-question for the verdict: whether the state should also have an
explicit spelling, an `owed()` clause beside `assumed()`, with "an `ensures`
that no path owes" becoming an error wherever the clause is absent. The
"explicit over implicit" principle favors the clause; detection alone is the
smaller change.
