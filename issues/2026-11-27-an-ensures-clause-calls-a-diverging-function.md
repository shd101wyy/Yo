# An `ensures` clause that calls a contracted executable function is proved and its run-time check erased

**Severity:** S1 — `yo verify --strict` proves a caller's `ensures(r == 42)` that is false (the binary prints `7`): `wrong`'s `ensures` calls `spin`, a function that never returns, so the clause is proved under partial correctness, its run-time assert is erased, and `caller` assumes it.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p17`, `r17` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-an-ensures-clause-calls-a-diverging-function.yo`:

```yo
pragma(Pragma.Verify);

spin :: (fn(x : i32, ensures(r > r)) -> (r : i32))({
  mut(i) := x;
  while(true, {
    invariant(true);
    i = i;
  });
  i
});

// The ensures clause is proved, so its run-time assert is erased; it calls a
// contracted executable fn that never returns.
wrong :: (fn(x : i32, ensures((spin(x) == spin(x)) && (r == i32(42)))) -> (r : i32))(x);

// The caller trusts wrong's ensures. `yo verify --strict` proves r == 42.
caller :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))(wrong(x));
```

`yo verify --strict issues/repros/2026-11-27-an-ensures-clause-calls-a-diverging-function.yo` exits 0:

```
  ok       fn@2026-11-27-an-ensures-clause-calls-a-diverging-function.yo:2 [verify] — 3 obligation(s) proved
  ok       fn@2026-11-27-an-ensures-clause-calls-a-diverging-function.yo:13 [verify] — 1 obligation(s) proved
  ok       fn@2026-11-27-an-ensures-clause-calls-a-diverging-function.yo:16 [verify] — 1 obligation(s) proved
verify: 3 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

`issues/repros/2026-11-27-an-ensures-clause-calls-a-diverging-function-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved the caller's `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-an-ensures-clause-calls-a-diverging-function-run.yo -o run && ./run
7
```

## Root cause

The same rule as the ghost binding (`issues/2026-11-27-a-ghost-binding-calls-a-diverging-function.md`), for a clause. Walking `spin(x)` inside `wrong`'s `ensures` assumes `spin`'s `ensures(r > r)`, which is `false`, so `wrong`'s clause is proved; a proved clause's run-time assert is erased, so the program never evaluates `spin(x)`, and `caller` assumes `r == 42` from `wrong`'s contract.

The missing rule: a specification (a `requires`, `ensures`, `invariant` or `decreases` predicate) may not call a contracted executable function, except in a `law`'s clauses, which nothing can cite (`plans/backlog/SPEC_AND_PROOF.md` §4.2, diagnostic 9).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1a of `plans/backlog/SPEC_AND_PROOF.md` §8 (the call rules; `tests/spec/fixtures/valid/ensures-call-in-and.yo`, the one existing clause of this shape, moves into a `law`). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
