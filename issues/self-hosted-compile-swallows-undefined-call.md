# Self-hosted `compile` builds a runnable no-op binary from an undefined call

**Status: OPEN** (found 2026-08-10 while building the `build-fail`
differential case). The known def-time body-eval swallow
(`yo-self check masks porting gaps` in the memory/plan lore) is worse than
documented: it affects **`compile`**, not just `check`.

## Symptom

```rust
main :: (fn(io : Io) -> unit)({
  this_function_does_not_exist();
});
export(main);
```

```
$ node out/cjs/yo-cli.cjs compile main.yo      # TS reference
Error: Variable "this_function_does_not_exist" not found.   (rc=1)

$ /tmp/yo-s27 compile main.yo -o probe          # self-hosted
(no output)                                     (rc=0)
$ ./probe; echo $?
0
```

The self-hosted compiler exits 0, emits a 34 KB binary, and the binary runs
and does nothing. No diagnostic anywhere. A typo'd call in `main` becomes a
silent no-op program.

## Root cause (as far as established)

The self-hosted evaluator's def-time function-body evaluation swallows
errors (the trial-eval swallow — see
`issues/…` history and the memory notes `yo-self-defeval-swallow-masks-typeerrors`
/ `yo-self-test-trial-eval-swallow`). `main` is only body-evaluated at
definition time; the undefined-variable error is caught and discarded, the
FuncVal is registered anyway, and codegen emits the body minus the broken
call.

## Why it matters / what blocks on it

- `tests/cli-cases/build-fail` had to use a MISSING-IMPORT fixture instead of
  a semantic error, because a semantic error does not fail the self side.
- Any P2.5 world where the self-hosted binary is the only compiler makes this
  the user-facing behavior: typos compile clean.

Fixing it means revisiting the def-eval swallow with `is_executing` set for
the ENTRY module's exported roots — the historically hard part is that
def-eval must stay lenient for generic bodies that only type-check after
specialization. Needs its own campaign; do not quick-patch.
