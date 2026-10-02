---
name: yo-verification
description: Write and discharge Yo proof obligations — requires/ensures contracts, loop invariants, law() claims, refinements, and gating with yo verify --strict. Use this when adding or debugging contracts, reading verifier outcomes and counter-examples, or wiring verification into a build.
argument-hint: "[contract, law, invariant, or outcome]"
---

For the full clause grammar and operator subset, see the yo-syntax skill; this skill covers the verification workflow. For API discovery, run `yo context <module>`.

# Yo Verification

Use this skill for proof work: contracts (`requires`/`ensures`), loop invariants (`invariant`/`decreases`), standalone `law(...)` claims, refinement types, reading `yo verify` outcomes and counter-examples, and gating a `spec/` directory or a build step.

## When to use this skill

Use this skill when you need to:

- add `requires(...)`/`ensures(...)` to a function and make it prove
- fix a `refuted`/`unproven`/`vacuous` outcome or interpret a counter-example
- write a `law(...)` claim about code you must not edit
- choose loop invariants and `decreases` measures
- gate specs with `yo verify --strict` (in CI or a build step)
- use `refine` types (`NonZero`, `Bounded`, ...) from `std/spec`

## Workflow

1. Put the file in a verify mode: `pragma(Pragma.Verify);` (proofs replace the `ensures` asserts) or `pragma(Pragma.VerifyOrAssert);` (prove, fall back to the runtime assert on budget exhaustion).
2. Run `yo verify <path>` and read the per-fn outcome lines; use `--explain <id-substring>` for every obligation's verdict and SMT-LIB goal (ids are `fn@<file>:<row>` — match the file path or line, a bare fn name matches nothing).
3. Fix what the solver tells you: a `refuted` carries a concrete counter-example model; `unproven` means the fact is not derivable (strengthen the invariant or the callee's `ensures`).
4. Gate with `--strict` so `assumed`/`outside-subset`/`unproven` cannot pass quietly.

## High-signal rules

- Name the return to use it in `ensures`: `-> (r : i32)` — there is NO magic `result` identifier (an unlabeled return leaves `result` unbound, E0401).
- Verification is modular: a caller assumes the callee's `ensures` and proves its `requires`; bodies are never opened. A `refuted` law usually means the callee's contract is weaker than the claim needs.
- `old(...)` reads the entry snapshot (params and `inout` names, not body locals).
- A plain `yo verify` PASSES on `assumed` and `outside-subset` — and on `unproven` in `verify+` files (in verify mode an `unproven` already fails the run) — so a green run is not "everything proved". `--strict` denies all three in every mode.
- `law(fn(..., requires(...), ensures(...)) -> unit)` states a claim outside the code, proved from the callee's contract alone. Today the callee must live in the SAME file (a law over an imported callee is an open issue); gate laws with `yo verify <path> --strict`.
- Do not confuse this `--strict` with safe mode's planned "strict mode" (denying safe-mode laxity) — different features, same word.
- Lemmas ARE available since #1075: a recursive `ghost_fn` with `decreases` becomes an uninterpreted function defined by a triggered axiom, proved as its own task; a `ghost_fn` without contracts is inlined at call sites.

## Resource

- [Yo verification cheatsheet](./verification-cheatsheet.md)
