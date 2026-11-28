# A contradictory `assumed()` contract makes every caller "proved", and nothing in the report says so

**Severity:** S2 — `yo verify` reports a false postcondition as `ok … proved` with `vacuous: false`, and in `verify` mode the binary runs with no check that would catch it.

Filed 2026-11-13 from the audit behind
[`plans/backlog/PROVEN_CORE.md`](../plans/backlog/PROVEN_CORE.md) (§8 item 1).
Measured with `yo 0.2.77`, Z3 5.1.0; no commit touches `src/verifier/` or
`src/evaluator/builtins/contracts.yo` between that tag and `origin/develop`
`0f82f79ee`.

## Reproducer

```yo
pragma(Pragma.Verify);
{ println } :: import("std/fmt");

oracle :: (fn(x : i32, ensures(r > x, r < x), assumed()) -> (r : i32))(x);

bad :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))(oracle(x));

main :: (fn() -> unit)({
  println(bad(i32(1)));
});
export(main);
```

`oracle`'s two `ensures` clauses contradict each other. `bad` claims to return
42 and returns whatever `oracle` returns.

## What happens

`yo verify`:

```text
  assumed  fn@run_probe.yo:3 [verify] — contracts assumed — body outside the verifiable subset (assumed())
  ok       fn@run_probe.yo:5 [verify] — 1 obligation(s) proved
verify: 1 ok, 1 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

The JSON report for `bad` is `"outcome":"ok","vacuous":false`, with the one
obligation `ensures#0` `"verdict":"proved"`.

`yo compile --optimize 2` and run, in `verify` mode:

```text
1
```

Exit status 0. The function proved to return 42 returned 1, and no assertion
fired.

The same program without the pragma (`runtime` mode) aborts, as it should:

```text
ensures failed: r > x (at run_probe_runtime.yo:4:34)
```

`--strict` fails the run, but only because an `assumed` outcome exists. Nothing
flags `bad`, and nothing separates this from a run whose `assumed()` contracts
are all satisfiable.

## Why it matters

- An `assumed()` contract is an axiom. An unsatisfiable axiom proves every
  obligation downstream of the call, in every caller, transitively.
- `ok` carries no record of the assumptions it rests on. The M4 sentence of
  [`plans/backlog/SELF_VERIFICATION.md`](../plans/backlog/SELF_VERIFICATION.md)
  ("green … except the N functions at the FFI boundary, listed here") is
  honest only if each of those N contracts is satisfiable; one that is not
  voids every `ok` that depends on it.
- The planned vacuity gate (same document, "The vacuity gate") probes the
  **entry premise set** and explicitly not per-path conditions. The
  contradiction here enters *after a call*, so that gate as written does not
  see it.
- The planned distrust lane (`--verify-mode paranoid`) would catch this
  instance at run time, on inputs that actually run. It does not catch a
  contract that is contradictory only on inputs no test exercises.
- Guard elision is not affected: an `assumed()` callee's `ensures` never
  elides a guard
  ([`plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md`](../plans/backlog/SAFE_MODE_5B_VERIFIED_GUARD_ELISION.md)).
  The damage is to the report and to the erased contract check.

## Root cause

`src/verifier/vc.yo` splices a callee's `ensures` into the path as assumptions
(`_callee_call_term`) and never asks whether the path is still satisfiable
afterwards. An `assumed` report carries zero obligations, so the callee's own
contract is never examined either.

## Proposed fix

Three parts, each a query or a report field; proof verdicts never change.

1. **A satisfiability probe per `assumed()` contract.** One query: the
   function's `requires` and parameter refinements together with its `ensures`
   must be satisfiable. `unsat` is a new failure in every mode, not only under
   `--strict`: an axiom that cannot hold is never intentional.
2. **A context-feasibility probe after a call to an `assumed()` callee.** When
   the path becomes unsatisfiable by the spliced `ensures` (and was satisfiable
   before it), every later discharge on that path is marked vacuous instead of
   proved. This catches a contract that is satisfiable alone and contradictory
   in combination with the caller's own facts.
3. **`ok` names what it rests on.** The report lists, per function, the
   `assumed()` callees whose contracts its proofs used (transitively through
   the unsat cores once they render,
   [`plans/backlog/LEAN_ADOPTION_CANDIDATES.md`](../plans/backlog/LEAN_ADOPTION_CANDIDATES.md)
   LE2; by syntactic reachability until then).

Part 1 and part 2 extend the vacuity gate's "Order and cost" row; part 3 is the
trust-pin inventory's per-function view.

## Test

A `tests/spec/fixtures/negative/` twin of the reproducer that must fail
`yo verify` without `--strict`, and a `valid/` twin with a satisfiable
`assumed()` contract whose caller stays `ok` and lists the callee. Both land
with the fix.

## Fix (2026-11-26, DEFAULT_ON_VERIFICATION step S2)

The three parts of the proposed fix, as built:

1. **The contract probe** (`probe_assumed_contract`, `src/verifier/vc.yo`):
   every `assumed()` task gets one query, its `requires`, parameter
   refinements and `ensures` together with the goal `false`. A parameter
   the function may change (`&mut`, or named in `old(...)`) is a fresh
   post-call value in the `ensures`. `unsat` makes the outcome
   `contradictory`, a failure in every mode.
2. **The call probe** (`_record_callee_fact`, `vc.yo`; `_run_call_probes`,
   `src/verifier/driver.yo`): after a call to an `assumed()` callee, one
   query asks whether the path with the callee's `ensures` is satisfiable.
   On `unsat` a second asks about the path before the call: `unsat` again is
   `dead-path` (dead code, not the call's doing); otherwise each proved
   obligation whose path carries the call's facts is re-asked with the goal
   `false`, and an `unsat` turns its verdict into `Infeasible`. The function
   is `infeasible`: a failure in `verify`, a runtime-assert fallback in
   `verify+` (the strip pass keeps only `Proved` asserts out).
3. **What `ok` rests on**: each report carries `assumes`, the sorted ids of
   the `assumed()` contracts on its proved obligations' paths, closed over
   the callees verified in the same run (syntactic reachability: the unsat
   cores of LE2 are not used yet). The text report prints
   `rests on assumed: …` on the `ok` line.

After the fix, `yo verify` on the reproducer reports `oracle` as
`contradictory` and `bad` as `infeasible` (its `ensures#0` is
`INFEASIBLE … fn@…:3`), and exits 1 without `--strict`. `yo compile` of the
same file fails instead of producing the binary that printed `1`.

Fixtures: `tests/spec/fixtures/negative/assumed-contradictory.yo` (this
reproducer), `tests/spec/fixtures/negative/assumed-infeasible-after-call.yo`
(a contract satisfiable alone that contradicts the caller's `requires`) and
the valid twin `tests/spec/fixtures/valid/assumed-satisfiable-callers-list-it.yo`
(callers stay `ok` and list the callee, directly and through a verified
callee; a call on a path dead before it is `dead-path`). Tests:
`tests/internal/verifier-assumed.test.yo`.
