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

## First self-hosted run (run 31874422392) — what it proved and what it did not

The converted legs found a bug on their first run, which is the point of
converting them: #128, whose wasm legs still drive the TS compiler, passed the
same check on the same day.

PROVED WORKING:

- `Build stage-1 with the seed` passed — the new `build-stage1` composite
  action is sound.
- **emcc compiled the C emitted by the ported backend with 3 warnings and no
  errors.** The port reaches the C compiler intact; this was the open question.

FAILED: `yo build run` produced `hello-world.html` and then died on
`Cannot find module .../hello-world.js` — emcc normally emits that shim beside
the `.html`.

### ROOT CAUSE FOUND (run 31875845879) — it was NOT the link line

The `ls -lR yo-out` diagnostic answered it in one cycle:

```
yo-out/wasm32-emscripten/bin:
-rw-r--r--  hello-world.c      56293
-rwxr-xr-x  hello-world.html   18312
```

No `.js`, no `.wasm`, and the `.html` is an **18 KB EXECUTABLE** — a native ELF
binary, not an Emscripten HTML shell. **emcc was never invoked.** clang built a
host binary, and the build runner wrapped it in a wasm-shaped path and
extension (`get_artifact_output_file_name` computes those from the ARTIFACT's
target, independently of what the child actually compiled).

The bug is in `build_runner.yo`: `--target` was passed only

```yo
if(effective_target != artifact.target, ...)
```

and `effective_target` IS `artifact.target` unless the CLI overrides it — so an
artifact declaring its own target, the normal case, never got one. The child
`yo compile` saw no target, resolved the host, and auto-selected clang. TS does
not hit this because it calls codegen IN-PROCESS with `parsedTarget`; we shell
out, so the target has to travel on the command line.

Fixed by passing `--target` whenever it is not the host (still skipped for
native builds, so no `--target=<host>` appears on proven link lines), and by
forcing `--cc emcc` for wasm targets exactly as `build-runner.ts:902-907` does.

**This class of bug is invisible to `yo compile --target wasm32-emscripten`,
which always passes the target explicitly. Only `yo build` reaches it** — which
is why the smoke test, not the test suite, is what caught it.

### Regression coverage, and a broader exposure

**The regression test is the WASM build-system smoke test itself**, and it only
became one with this conversion. `yo build run` against
`CompilationTarget.Wasm32_Emscripten`, driven by the stage-1 binary, fails
exactly when `--target` stops travelling. Before the conversion that step ran
the TS compiler, which compiles in-process and cannot exhibit the bug — so the
step existed but was structurally incapable of catching it.

No cheaper test is available: `--dry-run` only names steps
(`build_runner.yo:1385`), it does not print the compile command, so a
`tests/cli-cases` entry cannot assert the flag. And `yo compile --target …`
always passes the target explicitly, so the whole `compile` surface is blind to
this.

**The bug was never wasm-specific.** `effective_target` is `artifact.target`
whenever the CLI does not override it, so ANY artifact declaring a non-host
`target` in `build.yo` — a cross-compile to `aarch64-linux-gnu`, say — was
silently built for the host, with the cross-shaped output path and extension
applied around a native binary. wasm is simply where it was visible, because a
host ELF cannot pretend to be a `.wasm` module. Nothing in CI declares a
non-host non-wasm target, so that case had no coverage at all and still has
none; the fix covers it, a test does not.

### The earlier hypothesis, which was WRONG

yo-self passed `-lm -pthread` on every non-Windows link, so wasm got them; TS
gates all platform system libraries on `!isWasm` and passes neither. `-pthread`
is not inert for emcc — it switches Emscripten into pthreads mode. That is a
REAL parity bug and is now fixed.

**But it is not confirmed to be the root cause.** The inference that the link
never ran came from a 0.2 s gap between the last warning and the node error,
which is too fast for an Emscripten link — not from seeing what was on disk.
With `-pthread` emcc still normally emits a `.js` (plus a `.worker.js`), so the
mechanism is not fully explained.

The smoke test now dumps `ls -lR yo-out` on failure, so the next run answers it
directly instead of by inference. If the `.js` is present and the runner still
cannot find it, the bug is in the run path (`build_runner.yo`'s `.html` -> `.js`
derivation), not the link line.

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
