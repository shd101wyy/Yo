# yo-self passes `-sEXIT_RUNTIME=1` alongside `-sSTANDALONE_WASM`, which emcc rejects

**Status: FIX APPLIED 2026-08-16, awaiting CI.** Found by the converted
`test-wasm32_wasi` leg (PR #127), which is the first time that leg drove the
self-hosted compiler instead of the TypeScript one.

## Symptom

A WASI batch that uses parallelism fails at the emcc link step:

```
emcc: error: explicitly setting EXIT_RUNTIME not compatible with STANDALONE_WASM.
      EXIT_RUNTIME will always be True for programs (with a main function) and
      False for reactors (not main function).
yo: error: compile: C compiler failed (exit 1) on tests/.yo_selftest_batch_33_0.c
```

The leg gets through 32 files first — the failure is specific to a batch whose
`uses_parallelism` is true.

## Root cause

`yo-self/main.yo`'s emcc block gated the pthread flags on `get_uses_parallelism()`
alone:

```yo
if(get_uses_parallelism(), {
  cmd.arg(String.from("-pthread"));
  cmd.arg(String.from("-sPTHREAD_POOL_SIZE=4"));
  cmd.arg(String.from("-sEXIT_RUNTIME=1"));
});
```

That is a faithful port of **`src/codegen/index.ts:626-634`**, which has the
same shape — and the same latent bug. But TS's **test runner** carries an extra
guard that codegen does not:

```ts
if (usesParallelism && !isWasi) {          // test-runner.ts:667
```

TS therefore never hits it in CI, because the wasm legs run through the test
runner. yo-self has a single compile path, so it inherited the broken copy.

**This is a case where the more authoritative-looking source was the wrong one
to port from.** Two TS call sites build emcc flags; they disagree; only one is
exercised by the wasm legs.

## Second, related gap: WASI memory limits

`test-runner.ts:655-663` also adds, for WASI only:

```
-sSTACK_SIZE=16777216 -sINITIAL_MEMORY=134217728
```

with the note that the evaluator's `evaluate()` has 693+ locals, so emcc's
default 64 KB stack and 16 MB initial memory cannot hold a single frame. yo-self
had neither, so even past the link error the batch would not have run.

## Fix

1. `get_uses_parallelism() && !(is_target_standalone_wasi(target))` in
   `run_compile` — the unambiguous half, since emcc rejects the combination.
2. The memory flags travel from `run_test` as `--cflags` when the run is WASI,
   rather than becoming a compile-wide default. That keeps TS's scoping: they
   are a test-harness accommodation, not a property of every WASI build.

## Note for whoever fixes the TS side

`src/codegen/index.ts:626` still has the unguarded version. It is unreachable
in CI today, but `yo compile --target wasm-wasi` on a parallel program fails
there too. Out of scope for the P2.5 conversion; recorded so it is not lost
when `src/` is deleted.
