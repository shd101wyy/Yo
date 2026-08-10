# An `if` whose branch awaits, as a `while` body, emitted NOTHING

**Status: FIXED** 2026-08-09 in BOTH compilers, with a regression test
(`tests/async_await.test.yo`, "Test an if whose branch awaits as a while loop
body"). **Silent** — the program compiled, ran, and exited 0 having done nothing.

Reproducer:
[`repros/async-if-else-await-in-while-loop-body.yo`](repros/async-if-else-await-in-while-loop-body.yo)

```rust
while(runtime(i < n), {
  name := names(i);
  if(dry, {
    println(`would run ${name}`);
  }, {
    io.await(step(name, io), io);
  });
  i = (i + usize(1));
});
```

```
$ ./yo-cli compile … && ./a.out      # BEFORE
--- dry ---
--- wet ---                          # exit 0, both loops printed NOTHING
```

Neither branch ran. Not the awaiting one, not the plain one.

## Root cause

`if` is a `cond` wearing a macro head: the AST node stays an `if`, and the branch
structure only exists in `$.macroExpansion` (see AGENTS.md — "an `if(...)` keeps
its macro head in the AST; its `cond` expansion is where branch structure is
visible").

`generateWhileBodyWithAwait` dispatches the await-carrying statement through a
chain of checks — nested `while`, `x := await(…)`, bare `await(…)`, `cond`,
`match` — and an `if` matches NONE of them. Control fell off the end of the
chain, so the loop body emitted no branch code and never assigned
`sm->cond_branch_N`. The emitted C jumps from the loop's pre-body straight to
`while_loop_0_end`:

```c
sm->var_…_name_1 = _…_temp_40747;
while_loop_0_end:                    // the entire `if` is gone
```

`generateAwaitExpression` — the top-level dispatcher — already recurses through
`$.macroExpansion` for exactly this reason. The while-body dispatcher never got
the same treatment, so the bug only appears when the `if` is inside a loop.

## Fix

Dispatch on the expansion, in the same shape as the `cond` case beside it, and
keep collecting the ORIGINAL body's trailing expressions — the loop counter
increment lives there, and losing it turns a silent no-op into an infinite loop:

```ts
} else if (
  awaitExpr.$?.macroExpansion &&
  exprIsFunctionCall(awaitExpr.$.macroExpansion) &&
  exprIsFunctionCallOf(awaitExpr.$.macroExpansion, BuiltinKeywords.cond)
) {
  generateCondWithAwait(awaitExpr.$.macroExpansion, awaitPoint, indent, context, undefined);
  for (let i = awaitFoundIndex + 1; i < bodyExprs.length; i++) {
    remainingExprs.push(bodyExprs[i]!);
  }
  return remainingExprs;
}
```

Ported to `yo-self/codegen/async/state_code_gen.yo` via `_await_macro_expansion`.

## How it was found

Writing the `--dry-run` branch of `run_build` in `yo-self/build_runner.yo`:

```rust
if(options.dry_run, { println(`[dry-run] Would execute step: ${step_name}`); },
                    { e.io.await(execute_step(step_name, ctx, e.io, e.exn), e); });
```

`yo build` then printed nothing and exited 0 — no steps, no dry-run lines, no
error. The fix was to the compiler, not the build runner.

## Worth remembering

Any dispatcher that matches on `cond`/`match`/`while` in async codegen needs an
`if` case, and `if` is invisible to a head check. Grep for
`exprIsFunctionCallOf(…, BuiltinKeywords.cond)` in `state-code-gen.ts` when
adding one; each site is a candidate for this bug.
