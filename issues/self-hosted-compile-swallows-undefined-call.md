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

## 2026-08-10 — two more gates masked by the same swallow (P2.4 probe)

Porting `src/tests/unsafe-gate.test.ts` surfaced the same mechanism from a
different angle. In a file OUTSIDE the implicit-unsafe dirs, with no
`pragma(Pragma.AllowUnsafe)`:

| program (in `main`'s body)          | TS   | self-hosted    |
| ----------------------------------- | ---- | -------------- |
| `p := &(x);`                        | rc=1 | **rc=0** (gap) |
| `v := unsafe(i32(0));`              | rc=1 | **rc=0** (gap) |
| `foo :: (fn(p : *(i32)) -> i32)...` | rc=1 | rc=1           |

Both gates EXIST in yo-self (`evaluate_unsafe`'s privilege check in
`evaluator/builtins/unsafe.yo`; the `&(...)` structural gate) — they fire
inside function BODIES, so the def-time body-eval swallow eats the throw and
`compile` proceeds. The `*(i32)` case fires because the SIGNATURE is
evaluated eagerly (`function.yo:1469`), outside the swallow.

Consequence for P2.4: the unsafe-gate negative cli-cases (`&(x)` and bare
`unsafe(...)`) cannot pass until this issue is fixed — they would score
SELF-FAIL (TS rc=1, self rc=0). Do NOT add them to `tests/cli-cases/` before
then; the positive case (`unsafe-pragma-ok`) and the signature-level gate
case (`ptr-type-safe-code`) pass today and are added.
