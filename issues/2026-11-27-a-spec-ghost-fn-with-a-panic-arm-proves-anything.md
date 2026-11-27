# A value `ghost_fn` with a `panic` arm proves any claim through a ghost binding

**Severity:** S1 — `yo verify --strict` passes a function whose `ensures(r == 42)` is false (the binary prints `7`): `ghost(t := only42(x))` inlines a logic function whose other arm panics, and the panic path is treated as dead, so the walk learns `x == 42`.

**Status:** open. **Found:** 2026-11-27 by the VERDICTS-91 probes (`p13b`, `r13` in the coordinator's `probe-ghost/` scratch), reproduced on v0.2.80 with Z3 5.1.0. **Plan:** `plans/backlog/SPEC_AND_PROOF.md` §2.1 (one of the seven false proofs).

## Reproducer

`issues/repros/2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything.yo`:

```yo
pragma(Pragma.Verify);
{ panic } :: import("std/assert");

// A value ghost_fn whose body panics off its intended domain.
only42 :: ghost_fn((fn(x : i32) -> bool)(cond((x == i32(42)) => true, true => panic("no value"))));

// `yo verify --strict` proves r == 42 for every x.
wrong :: (fn(x : i32, ensures(r == i32(42))) -> (r : i32))({
  ghost(t := only42(x));
  x
});
```

`yo verify --strict issues/repros/2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything.yo` exits 0:

```
  ok       fn@2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything.yo:4 [verify] — no obligations
  ok       fn@2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything.yo:7 [verify] — 1 obligation(s) proved
verify: 2 ok, 0 assumed, 0 outside-subset, 0 unproven, 0 refuted, 0 solver-error, 0 subset-error (1 of the ok vacuous)
```

`issues/repros/2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything-run.yo` is the same program with a `main` that prints the result. `yo compile` reports every function except `main` as `ok`, and the binary prints `7`, which contradicts the proved `r == i32(42)` for every `x`:

```
$ yo compile issues/repros/2026-11-27-a-spec-ghost-fn-with-a-panic-arm-proves-anything-run.yo -o run && ./run
7
```

## Root cause

A non-recursive value `ghost_fn` is inlined at its use (`_ghost_fn_inline_term` in `src/verifier/vc.yo`). Its body is walked in the caller's context, and the `panic` arm sets `ctx.path_dead` like a `panic` in running code: after the `cond`, the walk keeps only the arm that continues, `x == 42`. For code that runs, the program stops at the `panic`. The binding is erased by codegen, so nothing stops, and the caller's `ensures(r == 42)` is proved from a fact the program never established.

The missing rule: a logic function has a value on every path; `panic` (and every other non-value) is not allowed in its body (`plans/backlog/SPEC_AND_PROOF.md` §4.3, diagnostic 4).

This is not a bug to patch alone: each of the seven false proofs of `plans/backlog/SPEC_AND_PROOF.md` §2.1 is an executable-code rule applied to erased code.

## Fix

PR 1b of `plans/backlog/SPEC_AND_PROOF.md` §8 (a value `ghost_fn` has a functional body). The fixing PR adds a `tests/spec/fixtures/negative/` fixture of this program that the tree binary rejects and v0.2.80 accepts, and moves this doc to `issues/fixed/`.
