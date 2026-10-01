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
`Some(UnknownVal)`, which had slipped the known-value gate in `field.yo`. Two struct fields in
`src/` had exactly that shape:

- `MethodEntry.owner : String ?= String.new()` (`src/evaluator/values/type_trait_methods.yo`)
- `Manifest.workspace_members : ArrayList(String) ?= ArrayList(String).new()` (`src/manifest.yo`)

The PR's own CI run was cancelled and it was merged on local gates, so no stage-2 job ran on it.

## Fix

Both defaults are removed, and every construction site writes the field, as the error says:
15 `MethodEntry(…)` sites (`src/env.yo`, `src/evaluator/values/impl.yo`,
`src/evaluator/calls/trait_type.yo`, `src/codegen/functions/collection.yo`,
`tests/internal/type_trait_methods.test.yo`) gain `owner : String.new()`. Both `Manifest(…)`
sites already set `workspace_members`. Function-parameter defaults (`(x : String) ?=
String.new()` in a `fn(...)` signature) are a different construct, and the gate does not
cover them.
