# The compiler's own runtime `?=` field defaults fail #1098's gate, so develop cannot compile itself

**Severity:** S1 — bootstrap breakage: a compiler built from develop at 26f315b06 rejects develop's `src/` (`compile src/main.yo` and `check ./src` both fail), so the stage-2 build and the fixpoint are red for every branch based on it

**Status:** FIXED on `fix/src-runtime-field-defaults` (2026-10-02). The regression gate is the
self-compile itself: `fixpoint_only.sh` and `check ./src` with a stage 1 built from the tree.

## Symptom (measured, a compiler built from 26f315b06 by v0.2.48)

```
$ yo-dev compile src/main.yo --optimize 2 --emit-c --skip-c-compiler --std-path ./std -o s2
error: A ?= default must be a compile-time known value: (String.new)() is a runtime call. Write the field explicitly at each construction site instead.
    --> src/evaluator/values/type_trait_methods.yo:186:31
    |
186 |     (owner : String) ?= String.new()

$ yo-dev check ./src --std-path ./std
check: 66/278 file(s) passed        (199 × the String.new() default, 5 × ArrayList(String).new())
```

The v0.2.48 seed does not have the gate, so `yo build` (stage 1) succeeds. The failure appears
only when stage 1 evaluates the tree: stage 2, the fixpoint, and every `check ./src` run with a
tree-built binary.

## Cause

#1098 made a runtime call as a `?=` struct-field default a compile-time error. Its value is
`Some(UnknownVal)`, which had slipped the known-value gate in `field.yo`. Five struct fields in
`src/` had exactly that shape. Each surfaced only after the previous ones were fixed, because a
module that fails to import stops `check` from reaching the next:

- `MethodEntry.owner : String ?= String.new()` (`src/evaluator/values/type_trait_methods.yo`)
- `Manifest.workspace_members : ArrayList(String) ?= ArrayList(String).new()` (`src/manifest.yo`)
- `VerifyTask.requires_enforced : ArrayList(bool) ?= ArrayList(bool).new()` (`src/evaluator/builtins/contracts.yo`)
- `VerifyFnInput.requires_enforced` (`src/verifier/vc.yo`) and `VerifyFnObligation.goal : String ?= String.new()` (`src/verifier/driver.yo`)

A syntactic sweep (every `?=` whose right side is a call, classified by its enclosing
`struct(` or `fn(`) finds no others in `src/` or `std/`. The one in `tests/` is #1098's own
rejection fixture.

The PR's own CI run was cancelled and it was merged on local gates, so no stage-2 job ran on it.

## Fix

The defaults are removed, and every construction site writes the field, as the error says:

- 15 `MethodEntry(…)` sites (`src/env.yo`, `src/evaluator/values/impl.yo`,
  `src/evaluator/calls/trait_type.yo`, `src/codegen/functions/collection.yo`,
  `tests/internal/type_trait_methods.test.yo`) gain `owner : String.new()`.
- 3 `VerifyTask(…)` sites gain `requires_enforced`.
- The `VerifyFnInput`/`VerifyFnObligation` constructions in `tests/internal/verifier*.test.yo` (6 sites) gain theirs.
- The `src/` constructions of `Manifest`, `VerifyFnInput` and `VerifyFnObligation` already set their fields. Function-parameter defaults (`(x : String) ?=
String.new()` in a `fn(...)` signature) are a different construct, and the gate does not
cover them.
