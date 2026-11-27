# A lemma (`unit` `ghost_fn` with an `ensures`) whose body panics proves any claim

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`), because a `ghost(lemma(x))` statement assumes an `ensures` that a panicking lemma body never had to establish.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p02`, `r02` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-panicking-lemma-proves-anything.yo`:

```yo
pragma(Pragma.Verify);
{ panic } :: import("std/assert");

// A lemma (unit ghost_fn with an ensures) whose body panics: the panic path
// owes no ensures, so the false claim `x > x` is "proved".
bogus :: ghost_fn((fn(x : i32, ensures(x > x)) -> unit)(panic("never proved")));

// `yo verify --strict` proves r == 42 for every x.
wrong :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))({
  ghost(bogus(x));
  x
});
```

`yo verify --strict issues/repros/2026-11-27-a-panicking-lemma-proves-anything.yo` exits 0:

```
  ok       fn@2026-11-27-a-panicking-lemma-proves-anything.yo:5 [verify] — no obligations
  ok       fn@2026-11-27-a-panicking-lemma-proves-anything.yo:8 [verify] — 1 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous)
```

`issues/repros/2026-11-27-a-panicking-lemma-proves-anything-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-a-panicking-lemma-proves-anything-run.yo -o run && ./run
7
```

## Root cause

A path that reaches `panic` is dead and owes no `ensures` (`src/verifier/vc.yo`, the `panic` case of `_expr_term`: `ctx.path_dead = true`). That rule is right for code that runs: the program stops at the `panic`. A lemma never runs (codegen erases `ghost(...)`), so nothing stops: the lemma's own task is vacuously `ok` (`no obligations`), and every use assumes `x > x` (`_callee_call_term` on the lemma path, `vc.yo` "A1 … a LEMMA"), from which anything follows.

The missing rule: a proof must end normally on every path. `panic` in a proof context is an error (`plans/backlog/SPEC_AND_PROOF.md` §4.3, diagnostic 6).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1b of `plans/backlog/SPEC_AND_PROOF.md` §8 (the form rules: a lemma's body is total). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
