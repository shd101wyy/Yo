# A recursive value `ghost_fn` whose termination leans on its `requires` gets an inconsistent definitional axiom

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`): the unconditional axiom `forall n. bad(n) == bad(0) + 1` of a spec function whose `decreases` was proved only under an unchecked `requires` is false at `n = 0`, and any query that mentions `bad` can prove anything.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p04`, `r04` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent.yo`:

```yo
pragma(Pragma.Verify);

// Termination is proved under requires(n > 0); the self call's own requires
// (0 > 0) is not checked, and the definitional axiom is unconditional:
//   forall n : u8. bad(n) == bad(0) + 1     -- false at n = 0
bad :: ghost_fn(
  (fn(n : u8, requires(n > u8(0)), decreases(n)) -> u32)(bad(u8(0)) + u32(1))
);

// `yo verify --strict` proves r == 42 for every x (the requires is a tautology
// that only mentions `bad`, which brings the inconsistent axiom in).
wrong :: (fn(x : i32, requires(bad(u8(0)) == bad(u8(0))), ensures(r == i32(42))) -> (r : i32))(x);
```

`yo verify --strict issues/repros/2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent.yo` exits 0:

```
  ok       fn@2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent.yo:6 [verify] — 2 obligation(s) proved
  ok       fn@2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent.yo:11 [verify] — 1 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

`issues/repros/2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-a-recursive-ghost-fn-axiom-is-inconsistent-run.yo -o run && ./run
7
```

## Root cause

A recursive `ghost_fn` (one with `decreases`) becomes an uninterpreted function with the axiom `forall args. f(args) == body` (`_ghost_fn_app_term` in `src/verifier/vc.yo`). Termination is what keeps that axiom consistent, and it is proved in the function's own task **under the function's `requires`** (`n > 0`, so `0 < n` holds for the self call `bad(0)`). The self call's own `requires` (`0 > 0`) is never checked: the `requires` of a value `ghost_fn` is documented as a comment at a call (the "total reading"). The axiom is then emitted unconditionally, and `bad(0) == bad(0) + 1` is a contradiction. `wrong`'s `requires(bad(u8(0)) == bad(u8(0)))` is a tautology whose only job is to mention `bad`, which brings the axiom into the query.

The missing rule: a spec function's termination may not lean on a precondition nobody checks. A spec function has no `requires`, and its measure is proved from the body's own guards (`plans/backlog/SPEC_AND_PROOF.md` §4.3, diagnostic 1).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1b of `plans/backlog/SPEC_AND_PROOF.md` §8 (termination of a recursive spec function without assumptions; no `requires` on a value `ghost_fn`). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
