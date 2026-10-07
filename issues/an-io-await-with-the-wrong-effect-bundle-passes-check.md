# An `io.await` with the wrong effect bundle passes `check`

**Severity:** S3: a check/compile divergence. `yo compile` rejects the program with a correct diagnostic, but `yo check` accepts it, so an agent that gates on `check` meets the error only at the later codegen gate.

**Status: OPEN.** Found 2026-10-03 while fixing the async-effects recipes' worklist example (agent-knowledge consolidation K0). **Measured on:** yo 0.2.49, `--std-path ./std`. Related, but a different shape: `issues/fixed/io-async-variant-inference-passes-check-but-fails-compile.md`.

## Symptom

Inside an `io.async` body whose bundle is `WalkCtx :: struct(io : Io, exn : Exception)`, a `read_dir` future is awaited with `ctx.io` instead of its own `{ io, exn }` bundle:

```rust
entries := ctx.io.await(read_dir(cur, ctx.io), ctx.io);
```

- `yo check`: evaluator OK.
- `yo compile --skip-c-compiler`: `error: Effect argument does not match the future's effect bundle:`.

## Expected

`check` reports the same "Effect argument does not match the future's effect bundle" error that `compile` does.
