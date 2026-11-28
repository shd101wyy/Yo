# A lemma (`unit` `ghost_fn` with an `ensures`) whose body panics proves any claim

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`), because a `ghost(lemma(x))` statement assumes an `ensures` that a panicking lemma body never had to establish.

**Status:** fixed by PR 1b of the plan (§8). **Found:** 2026-11-27 by the VERDICTS-91 probes (`p02`, `r02` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

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

PR 1b of `plans/backlog/SPEC_AND_PROOF.md` §8. A lemma's body is a proof, and a proof ends normally on every path (plan §4.3): `panic` and an early `return` in a lemma body or a law's proof block are E0930 (E_GHOST_FN_FORM). The reproducer now fails evaluation, so `yo verify --strict` exits 1.

```text
error[E0930]: a proof ends normally on every path, so 'panic(...)' is not allowed in it; for a case that cannot happen, write 'assert(false)'
  --> issues/repros/2026-11-27-a-panicking-lemma-proves-anything.yo:6:57
  |
6 | bogus :: ghost_fn((fn(x : i32, ensures(x > x)) -> unit)(panic("never proved")));
  |                                                         ^^^^^
```

Test: `tests/spec/fixtures/negative/lemma-body-panics.yo` (this program's shape; the tree binary rejects it, v0.2.80 accepts it), checked by the E0930 tests of `tests/internal/verifier-ghost.test.yo`; `tests/spec/fixtures/valid/lemma-impossible-case.yo` is the legal form (`assert(false)` under the contradicting path).
