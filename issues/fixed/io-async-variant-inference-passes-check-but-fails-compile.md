# `io.async` variant inference through an intermediate local passes `check` but fails `compile`

**Severity:** S3 — a check/compile divergence: `yo check` accepts a shape
`yo compile` rejects, so the failure appears only at the codegen gate
agents run later.

**Status: FIXED** (2026-10-04, branch `s3/batch-2-fixes`). Found 2026-10-01 by
the agent-loop PR's adversarial review (the verifier compiled the yo-design
instructions' own example).
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

## Fixed

Fixed 2026-10-04 on branch `s3/batch-2-fixes`. The root cause was narrower
than the original narrative above: there was NO successful evaluator
inference in `check` for this shape — `check` accepted a HOLLOW closure
body. The def-time trial of the `io.async` closure body ran with
`ctx.expected_type` cleared, because a `:=` RHS that is not a bare variant
literal is evaluated with no expected type
(`src/evaluator/exprs/initialization_assignment.yo`), and #792's look-ahead
hint only fired when the RHS itself WAS a bare variant literal
(`_is_bare_variant_literal` gate in `_variant_local_hint`,
`src/evaluator/exprs/begin.yo`). The body's `.Ok` tail then hit the "Failed
to infer enum variant type" throw, the anon-body trial swallowed and
recorded it (`record_hollow_body_error`,
`src/evaluator/values/anonymous_function.yo`), so `check` (which generates
no code) passed; `compile`'s codegen hit the hollow-io.async poison gate and
replayed the recorded diagnostics verbatim — the 6:5 error. The fix extends
the #792 return-site look-through to see through the `io.async` wrapper:
`_variant_local_hint` (begin.yo) and the hint consumption in
`evaluate_initialization_assignment` (initialization_assignment.yo) now also
match `name := io.async(closure)` where a later statement returns `name` (or
`name` is the body tail), and evaluate that RHS with the enclosing fn's
declared result type as expected type, gated on that type carrying a Future
with a CONCRETE (non-SomeT) output. The call-side machinery — Step 6b in
`src/evaluator/calls/helper.yo` / `resolve_param_types_from_expected` in
`src/evaluator/calls/function.yo`, the same flow the direct tail form always
took — unwraps `Impl(Future(T, E))`, pre-binds `T`, and the closure's
`.Variant` tail gets its expected enum; `check` and `compile` now agree (the
symptom file above: `check` rc=0 and `compile --skip-c-compiler` rc=0).
Gated by two new cases in `tests/enum_variant_local_inference.test.yo`
("an io.async local returned later infers the closure's variant from the
function result" and "an io.async local as the body tail infers too"); the
test batch failed to compile before the fix and passes 7/7 after, and the
async regression files (`async_await` 262, `closure_inside_io_async` 7,
`async_assign_await` 2, `async_generic_future_return` 12,
`match_async_arms` 15) plus `yo check ./src` 278/278 stayed green. The
yo-design instruction now teaches both forms.
