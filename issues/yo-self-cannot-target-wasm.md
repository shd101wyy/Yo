# yo-self cannot target wasm — `src/` retirement would silently drop two targets

**Status: PORT DONE, NOT YET PROVEN.** Found 2026-08-15 while executing P2.5
step 22; option 1 (port) chosen and implemented the same day.

## What landed (2026-08-15)

- `yo-self/codegen/async/runtime_io_wasm.yo` — 835 lines against the TS 832.
  The file turned out to have **zero `${}` interpolations**, so all seven
  templates are literal C and were EXTRACTED, not hand-transcribed (Yo backtick
  strings share TS's escape rules — both already carry `'\\0'` verbatim). A
  checked script asserts all 7 round-trip, and re-asserts after `fmt`.
- `runtime.yo` dispatches to it instead of panicking; `runtime_io_common.yo`
  dispatches the wasm sys-runtime alongside macOS/Linux. WASM deliberately
  SHARES the POSIX block rather than early-returning the way Windows does,
  because Emscripten's MEMFS implements it.
- The **emcc link-flag branch was missing entirely** and is now ported:
  `--target=`/`--sysroot=` skipped for emcc, sanitizers skipped,
  `-sEMULATE_FUNCTION_POINTER_CASTS=1`, `-fno-exceptions`, `-sSTANDALONE_WASM`
  vs `-sNODERAWFS=1`, and the pthread trio behind a new `g_uses_parallelism`.
- `--emcc-environment` — TS keeps `emccEnvironment` internal because it calls
  codegen in-process; yo-self SHELLS OUT, so the value needs a flag to travel
  on. `build_runner.yo` passes `web` for wasm targets.

`check ./yo-self` is clean.

## Why this is NOT yet proof — the remaining step

**The two CI legs still drive the TypeScript compiler**
(`node ./out/cjs/yo-cli.cjs`), exactly as quoted below. So a green
`test-wasm32_emscripten` / `test-wasm32_wasi` today says nothing about the port
— it exercises `src/`, not `yo-self/`. Do not read those greens as validation.

The actual proof, and the thing that unblocks Group E, is converting both legs
to drive the **stage-1 self-hosted binary**. Note this does NOT conflict with
the "these legs can never be node-free" point below: `emcc` stays a node
program either way. What changes is only which _Yo_ compiler drives it.

Sequencing: the conversion needs a stage-1 build in each wasm leg, so it should
land after the stage-1 emit/compile split, otherwise both legs inherit the
memory failure that split exists to fix.

## The gap (as originally found — kept for the record; resolved above)

`yo-self/codegen/async/` had `runtime_io_linux.yo`, `runtime_io_macos.yo`,
`runtime_io_windows.yo` and `runtime_io_common.yo`, and **no
`runtime_io_wasm.yo`**. Asking the self-hosted compiler for a wasm target
panicked:

```
yo-self/codegen/async/runtime.yo:40-42
  if(is_target_wasm(target_info), {
    __yo_panic("runtime: WASM async I/O runtime is a Phase-5 follow-up (deferred)");
  });
```

The two CI legs (`test-wasm32_emscripten`, `test-wasm32_wasi`) therefore still
drive the **TypeScript** compiler:

```yaml
node ./out/cjs/yo-cli.cjs init ./tmp/hello-world --name hello-world
node ../../out/cjs/yo-cli.cjs build run
```

Both legs are green today and both are **required status checks**.

## Why this is a Group E blocker, not a Group D one

P2.5's goal is a bun/node-free CI, and these legs can never be node-free:
`emcc` is itself a node program (the plan says so at step 22). So there is no
Group D conversion to perform — the legs are allowed to stay as they are.

What forces the issue is **Group E deleting `src/`**. At that moment:

- the TS compiler these legs invoke no longer exists, and
- yo-self panics on the same targets,

so `wasm32-emscripten` and `wasm32-wasi` stop being supported targets. Deleting
the two legs would make that silent — CI would go green having dropped a whole
target class.

## The decision

Either:

1. **Port** `runtime_io_wasm.yo`, plus the wasm sys-runtime branch and the
   emcc flag branch (P2.5 step 10's first option); or
2. **Retire wasm support explicitly** — delete the legs AND their required
   contexts, remove `Wasm32_Emscripten`/`Wasm32_Wasi` from
   `std/build.yo`'s `CompilationTarget`, and say so in the docs and release
   notes. This is a user-visible product change.

This is a product decision about whether Yo supports wasm after self-hosting
completes. It should not be made implicitly by whoever happens to run the `src/`
deletion PR.

## Measured scope of option 1

|                                        |                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `src/codegen/async/runtime-io-wasm.ts` | **832 lines**, only **7** emitter calls                                      |
| shape                                  | overwhelmingly large C template strings, not logic                           |
| exported entry points                  | `generatePlatformSysRuntimeWasm` (:23), `generateAsyncRuntimeIOWasm` (:316)  |
| precedent                              | `runtime-io-macos.ts` 1779 lines → `runtime_io_macos.yo` 1746 — close to 1:1 |

So the port is mechanical and roughly one file, in line with ports already
done. The cost is not the writing; it is that **none of it can be validated
locally** — it needs an emsdk runner (and wasmtime for the WASI leg), so it is
`[CI-only]` in the plan's terms. Expect to iterate through CI.

Also needed beyond the runtime file, per step 10:

- the wasm branch of the sys-runtime emitter, and
- the emcc flag branch (`yo-self/main.yo` already auto-selects `emcc` for
  `wasm*` targets at :1188 and infers `wasm32-emscripten` from `--cc emcc` at
  :1204, so the CLI half may largely exist — verify before estimating).

## Verification for whichever option

- Option 1: `yo compile <async program> --target wasm32-wasi --cc emcc`
  produces a `.wasm` that runs under wasmtime, and both CI legs go green
  driving the stage-1 binary instead of `node out/cjs/yo-cli.cjs`.
- Option 2: the two required contexts are removed from ruleset 13548862 in the
  same change that deletes the legs (see
  `issues/test-matrix-stage1-silent-failure.md` for why the ordering matters),
  and `docs/{en-US,zh-CN}` no longer advertise wasm targets.
