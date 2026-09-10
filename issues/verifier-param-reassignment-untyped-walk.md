# Verifier: reassigning a PARAMETER inside a verified body trips "untyped expression"

- **Status:** open (surfaced 2026-09-10 during the V4.2 exit-havoc probe)
- **Component:** verifier walk × evaluator table keying (`src/verifier/vc.yo`
  `_expr_term` vs the VerifyTask's body/table)
- **Severity:** completeness only — the verifier LOUDLY rejects the function
  ("untyped expression"); it never proves anything false. `verify+` falls
  back to the runtime assert.

## Reproducer

```rust
pragma(Pragma.Verify);

pin_exit :: (
  fn(x : i32, requires(x >= i32(0)), ensures(result >= i32(0))) -> (result : i32)
)({
  y := x;
  while(x < i32(0), {
    invariant(x >= i32(0));
    x = i32(5);
  });
  y
});
```

`yo verify` (or the standalone driver) reports:

```text
SUBSET-ERROR: untyped expression @ begin(y := x, while(...), y)
```

The cited node is the function body's ROOT begin — its id has no
`ExprInfo` entry in the task's table, i.e. the AST the task holds is not
the AST instance the evaluator filled the table for.

## Bisection

- `y := x; while(y < 0, { invariant(y >= 0); y = 5; }); y` — WALKS
  (same shape, but the loop reassigns the LOCAL `y`, not the param).
- Adding `ensures`, removing the `assert`, dropping the leading binding:
  no effect — the trigger is exactly **`x = <expr>` where `x` is a
  parameter** (here inside the loop body; the minimal position is not
  yet pinned down).

## Likely cause (to verify)

Parameter reassignment is desugared/rewritten somewhere on the
evaluator side (params are immutable bindings; `x = 5` presumably
becomes a hidden local or a cloned body region). The rewrite gives the
body fresh node ids, so the VerifyTask's body no longer matches the
`ExprInfoTable` it carries. The task should either receive the table
that matches the rewritten body or hold the pre-rewrite AST with its
original ids.

## Direction

Whichever side is wrong, the fix belongs with the VerifyTask capture
(`src/evaluator/calls/function_type.yo` registration or the body
rewrite site), not in the verifier walk. A regression fixture belongs
in `tests/spec/fixtures/valid/` once it walks (param-reassignment loops
are legal Yo and the havoc rule handles them fine once the table
matches).
