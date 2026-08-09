# `yo build run` built the program, said "run ok", and never ran it

**Status: FIXED** 2026-08-09 (`yo-self/evaluator/builtins/build.yo`).
Self-hosted compiler only. Found by `tests/cli-cases/build-run`.

```
$ yo-self build run --summary
Building probe → yo-out/aarch64-macos/bin/probe
…
Build Summary: 2/2 steps succeeded
run ok
└── compile exe probe ok
```

Exit code 0, every step green — and `Hello, world!` never printed. The reference
compiler prints it. **A silent no-op reported as success**, which is the worst
shape a build-system bug can take.

## Root cause

yo-self stores enum variants **dot-prefixed**. `evaluator/calls/function.yo`
builds them as:

```rust
dot_variant := `.${variant_name}`;
Option(EvalValue).Some(EvalValue.EnumVal(dot_variant, fvals_e))
```

TS's `isEnumValue(v).variantName` is bare. `_build_extract_variant` returned the
stored string as-is, so the port of

```ts
if (depKindValue.variantName === "Run") resolvedDepName = `run:${depName}`;
```

compared `".Run" == "Run"` — always false. `step.depend_on(build.run(exe))` then
recorded the dependency under the ARTIFACT's name (`probe`) instead of the run
step's synthesized name (`run:probe`).

From there everything is consistent and wrong: `resolve_dependency("probe")`
finds the artifact, so the DAG has two nodes (the `run` step and the artifact)
and no Run node. Nothing ever calls `run_executable`, and since no node failed,
the summary reports success.

The two nodes are visible in the summary above — the reference compiler's DAG has
three.

## Fix

Strip the dot at the boundary, where the port crosses from yo-self's
representation into TS-shaped comparisons:

```rust
.EnumVal(variant, _) => Option(String).Some(
  if(variant.starts_with(String.from(".")), variant.substring(usize(1), variant.len()), variant.clone())
),
```

Rather than dot-prefixing each comparison — there is one boundary function and
several call sites, and the next ported comparison would hit the same trap.

## Worth remembering

**yo-self's `EvalValue.EnumVal` variant names carry a leading dot; TS's
`variantName` does not.** Any ported `variantName === "X"` comparison needs the
strip. This is a silent-failure trap: the comparison compiles, type-checks, runs,
and is simply never true.
