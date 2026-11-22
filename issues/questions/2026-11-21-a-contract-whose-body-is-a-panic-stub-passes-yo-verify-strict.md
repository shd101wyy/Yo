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

Amended 2026-11-22, assuming
[`plans/backlog/DEFAULT_ON_VERIFICATION.md`](../../plans/backlog/DEFAULT_ON_VERIFICATION.md)
is carried out.

Add a contract clause `owed()`, beside `assumed()`, for a body that is not
written yet:

- The verifier does not walk the body. Callers assume the contract, as with
  `assumed()`. The outcome is `owed`, and its JSON entry carries the
  contract's source text, so the `owed` list is an agent's work queue.
- `--strict` and the strict pragma fail on it, as a fourth class. The default
  mode reports it in the build's summary and passes (D2: the default stops a
  build only for a refuted claim).
- It never erases a guard, and gate G1 and S6a's coverage line count it
  outside "proved".
- `owed()` needs at least one `ensures`; `owed()` with `assumed()` is an
  error.
- A function that states an `ensures`, has zero obligations and has no
  `owed()` gets a hint in the report, not a failure.

Why a clause and not detection alone: `ensures(false)` on a function that
always panics is a meaningful claim ("this does not return") with the same
shape as a stub, so detection would either miss stubs or reject that claim.
A clause states the author's intent, which is the "explicit over implicit"
rule, and gives the report an exact count.

It should land before S6a: after it, every module is proved by default and
the summary states how much is proved, and a `panic` stub must not count as
proved there.
