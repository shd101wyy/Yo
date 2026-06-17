# yo-self evaluator accepts `io.await(fut)` with the `e : E` arg missing

## Status
OPEN — surfaced 2026-06-17 while establishing the Phase-5 (async) eval baseline.
Evaluator-level divergence; fix as part of the Phase-5 async work.

## Symptom
`io.await` is declared (std/prelude.yo:8184) as:
```rust
await : (fn(forall(T : Type, E : Type.Struct), fut : Impl(Future(T, E)), e : E) -> T)
```
i.e. TWO runtime args: `fut` and `e`. Calling it with only `fut`:
```rust
task := io.async((io : Io) => { x := i32(42); x });
io.await(task)        // missing `e` (the Io)
```
- **TS** correctly rejects: `Too few arguments for function call: io.await(task)`.
- **yo-self** ACCEPTS it (`check` → evaluator OK). Over-permissive arg-count check
  for this (field-fn) call shape.

The correct form `io.await(task, io)` is accepted by both.

## Suspected root
The arg-count / required-arg validation for a struct-FIELD function value call
(`io.await(...)` resolves the `await` field of the `Io` struct to a `fn(...)`
value, then calls it) does not enforce the minimum runtime arg count the way the
direct-function-call path does. Likely the field-fn call path skips the
`n_args < n_required` check (helper.yo:1796 enforces it for the regular path).
Possibly interacts with the forall(T, E) inference masking the missing `e`.

## Minimal repro
`/tmp/io1.yo` above (1-arg `io.await(task)`): yo-self OK, TS fails.

## Next steps
1. Locate the field-fn / `io.*` builtin call path in the evaluator and ensure it
   runs the same required-arg-count check as the regular call path.
2. Add a `comptime_expect_error` test (`io.await(task)` must be rejected).
Part of Phase 5 (async/effects) — see plans/BOOTSTRAPPING_CODEGEN.md.
