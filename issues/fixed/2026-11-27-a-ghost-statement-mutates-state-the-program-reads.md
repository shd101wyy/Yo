# A `ghost(...)` statement that mutates program state is walked by the verifier and erased by codegen

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 1)` is false (the binary prints `0`): `ghost(xs.push(i32(7)))` is walked as a real push, and codegen erases it.

**Status:** fixed by PR 1a of the plan (§8). **Found:** 2026-11-27 by the VERDICTS-91 probes (`p05b`, `r05` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-ghost-statement-mutates-state-the-program-reads.yo`:

```yo
pragma(Pragma.Verify);
{ ArrayList } :: import("std/collections/array-list");

// The verifier walks the push; codegen erases it.
// `yo verify --strict` proves r == 1.
wrong :: (fn(ensures(r == usize(1))) -> (r : usize))({
  mut(xs) := ArrayList(i32).new();
  ghost(xs.push(i32(7)));
  xs.len()
});
```

`yo verify --strict issues/repros/2026-11-27-a-ghost-statement-mutates-state-the-program-reads.yo` exits 0:

```
  ok       fn@2026-11-27-a-ghost-statement-mutates-state-the-program-reads.yo:5 [verify] — 1 obligation(s) proved
verify: 1 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

`issues/repros/2026-11-27-a-ghost-statement-mutates-state-the-program-reads-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `0`, which contradicts the proved `r == usize(1)`:

```
$ yo compile issues/repros/2026-11-27-a-ghost-statement-mutates-state-the-program-reads-run.yo -o run && ./run
0
```

## Root cause

`ghost(e)` walks any expression (`src/verifier/vc.yo`, the "ghost(e): a spec STATEMENT (A1)" case of `_expr_term`: it walks `e` and returns `true`). The walk of `xs.push(i32(7))` updates the list model of `xs` (length `+ 1`), and the later `xs.len()` reads it. Codegen erases every `ghost(...)` statement, so the program never pushes and returns `0`. The evaluator accepts the statement because `ghost(...)` takes any expression.

The missing rule: erased code may not change state the program reads. `ghost(e)` takes a ghost binding or a proof step (a lemma call), nothing else (`plans/backlog/SPEC_AND_PROOF.md` §3.4 and §4.2, diagnostic 10).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1a of `plans/backlog/SPEC_AND_PROOF.md` §8. `ghost(e)` now takes a ghost binding `ghost(name := e)` or one proof step, a lemma call; any other statement is E0929 (E_GHOST_STATEMENT_FORM). The reproducer now fails evaluation, so `yo verify --strict` exits 1:

```text
error[E0929]: 'ghost(...)' takes a ghost binding 'ghost(name := e)' or a proof step, a lemma call 'ghost(lemma(args))'; erased code may not do anything else, got:
ghost((xs.push)(i32(7)))
  --> issues/repros/2026-11-27-a-ghost-statement-mutates-state-the-program-reads.yo:8:3
  |
8 |   ghost(xs.push(i32(7)));
  |   ^^^^^
```

Test: `tests/spec/fixtures/negative/ghost-statement-mutates-state.yo` (this program; the tree binary rejects it, v0.2.80 accepts it), checked by `tests/internal/verifier-ghost.test.yo` "ghost(...) takes a binding or a lemma call — a push is E0929".
