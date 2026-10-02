# `io.async` variant inference through an intermediate local passes `check` but fails `compile`

**Severity:** S3 — a check/compile divergence: `yo check` accepts a shape
`yo compile` rejects, so the failure appears only at the codegen gate
agents run later.

**Status: OPEN.** Found 2026-10-01 by the agent-loop PR's adversarial
review (the verifier compiled the yo-design instructions' own example).
**Measured on:** yo 0.2.48 (PATH) and the worktree's tree-built binary at
`8042cc5b9`, `--std-path ./std`.

## Symptom

```rust
{ String } :: import("std/string");

my_fn :: (fn(io : Io) -> Impl(Future(Result(i32, String), Io)))({
  task := io.async((io : Io) => {
    zero := i32(0);
    .Ok((i32(42) + zero))
  });
  return(task);
});

export(my_fn);
```

- `yo check my_fn.yo` — **evaluator OK** (the #792 return-site variant
  inference covers the local in the evaluator).
- `yo compile my_fn.yo --skip-c-compiler` — **error: Failed to infer enum
  variant type** at the `.Ok(...)` inside the async closure.

## Root cause (narrowed, not fixed)

#792's inference runs in the evaluator, and `check` accepts its verdict;
the codegen-side re-inference over the io.async closure's result variant
does not perform the equivalent return-site look-through for a local bound
to `io.async(...)`, so `compile` re-derives the variant and fails. Same
file, two verdicts — the class AGENTS.md tells agents to treat as a
compiler bug.

## Fix direction

Make the codegen path consume the evaluator's already-inferred variant for
the closure-result local (or re-run the same return-site rule there);
gate with the file above as a fixture once it lives in `tests/` (check
must stay green; compile must go green).

## Interim mitigation (shipped with this issue)

`.github/instructions/yo-design.instructions.md` teaches the direct form
(`io.async(...)` as the returned tail expression) as the rule and names
this issue for the divergence.
