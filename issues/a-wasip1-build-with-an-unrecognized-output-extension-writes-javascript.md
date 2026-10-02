# A `wasm32-wasip1` build with an unrecognized output extension writes JavaScript

**Severity:** S3: a wrong artifact that fails late. `--target wasm32-wasip1` asks for a WASI module, but the output extension silently decides the format, and the failure shows up only when something tries to run the file.

**Status: OPEN.** Found 2026-10-03 while writing `docs/en-US/WASM.md` (agent-knowledge consolidation K1). **Measured on:** yo 0.2.49, Emscripten 4.0.12, wasmtime 38.

## Symptom

```
yo compile main.yo --target wasm32-wasip1 -o out.bin    # out.bin: JavaScript source
yo compile main.yo --target wasm32-wasip1 -o out.wasm   # out.wasm: WebAssembly binary module
yo compile main.yo --target wasm32-wasip1 -o out        # out.wasm (and out.c)
```

The C compiler (emcc) picks its output format from the `-o` extension, and an unrecognized one such as `.bin` gets JavaScript glue. Executing that file fails as `permission denied`, far from the cause.

## Expected

Either the target decides the format, so a `wasm32-wasip1` build always writes a WASI module, or `yo compile` rejects an output path whose extension contradicts `--target` with a diagnostic naming the right extension. `docs/en-US/WASM.md` §Pitfalls documents today's behaviour; update it, and its zh-CN mirror, with the fix.
