# A ghost binding that calls a contracted executable function proves that function's `ensures` without running it

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`): `ghost(v := spin(x))` assumes the `ensures(r > r)` of a function that never returns, and the binding is erased so the program never calls it.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p06`, `r06` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-ghost-binding-calls-a-diverging-function.yo`:

```yo
pragma(Pragma.Verify);

// An executable fn that never returns: partial correctness proves any ensures.
spin :: (fn(x : i32, ensures(r > r)) -> (r : i32))({
  mut(i) := x;
  while(true, {
    invariant(true);
    i = i;
  });
  i
});

// Called from an erased ghost binding: the program never runs `spin`.
// `yo verify --strict` proves r == 42 for every x.
wrong :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))({
  ghost(v := spin(x));
  x
});
```

`yo verify --strict issues/repros/2026-11-27-a-ghost-binding-calls-a-diverging-function.yo` exits 0:

```
  ok       fn@2026-11-27-a-ghost-binding-calls-a-diverging-function.yo:3 [verify] — 3 obligation(s) proved
  ok       fn@2026-11-27-a-ghost-binding-calls-a-diverging-function.yo:14 [verify] — 1 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (0 of the ok vacuous)
```

`issues/repros/2026-11-27-a-ghost-binding-calls-a-diverging-function-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-a-ghost-binding-calls-a-diverging-function-run.yo -o run && ./run
7
```

## Root cause

Partial correctness is the default (D12): `spin` never returns, so its `ensures(r > r)` is proved, and its task is `ok`. A call to a contracted function assumes its `ensures` (the modular rule). For a call that runs that is sound: a program that reaches the call never gets past it. A ghost binding is erased by codegen, so the call never runs and the caller continues with `false` assumed.

The missing rule: erased code may not call a function that is correct only if it returns. A contracted executable function is not callable from a specification or a proof (`plans/backlog/SPEC_AND_PROOF.md` §4.2, diagnostic 9; Dafny's rule for a `method`, Verus's for an exec function).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1a of `plans/backlog/SPEC_AND_PROOF.md` §8 (the three contexts and the call rules). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
