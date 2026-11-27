# A lemma whose body loops forever proves any claim

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`), because a lemma whose body is `while(true, …)` proves `x > x` under partial correctness and every `ghost(...)` use assumes it.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p03`, `r03` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-looping-lemma-proves-anything.yo`:

```yo
pragma(Pragma.Verify);

// A lemma whose body never terminates: partial correctness proves any ensures.
bogus :: ghost_fn((fn(x : i32, ensures(x > x)) -> unit)({
  while(true, {
    invariant(true);
  });
}));

// `yo verify --strict` proves r == 42 for every x.
wrong :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))({
  ghost(bogus(x));
  x
});
```

`yo verify --strict issues/repros/2026-11-27-a-looping-lemma-proves-anything.yo` exits 0:

```
  ok       fn@2026-11-27-a-looping-lemma-proves-anything.yo:3 [verify] — 3 obligation(s) proved
  ok       fn@2026-11-27-a-looping-lemma-proves-anything.yo:10 [verify] — 1 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

`issues/repros/2026-11-27-a-looping-lemma-proves-anything-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-a-looping-lemma-proves-anything-run.yo -o run && ./run
7
```

## Root cause

Partial correctness is the default (D12 of `plans/backlog/FORMAL_VERIFICATION.md`): a loop needs no `decreases`, and a function that never returns satisfies every post-condition. The lemma's task proves its `ensures` after a `while(true, …)` that never exits (the loop's exit condition `!true` makes the post-state unreachable), so the task is `ok`. That is true of a run, and false of a fact assumed where the lemma was never run: `ghost(bogus(x))` is erased by codegen, and the caller assumes `x > x`.

The missing rule: a loop in a proof must terminate (every `while` in a lemma body needs a `decreases`; `plans/backlog/SPEC_AND_PROOF.md` §4.3).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1b of `plans/backlog/SPEC_AND_PROOF.md` §8 (a lemma is total: its loops need `decreases`). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
