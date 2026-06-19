# yo-self Windows async I/O codegen port (IOCP) — DONE

## Status

RESOLVED (2026-06-19). The self-hosted codegen now covers **all three first-class
platforms: Linux (io_uring), macOS (kqueue), and Windows (IOCP)**. Windows was the
only platform still stubbed (the macOS/Linux backends were already ported); per the
requirement that the port cover Linux/macOS/Windows, it is now ported and validated.

## What was missing

TS fully implements the Windows async runtime via IOCP in
`src/codegen/async/runtime-io-windows.ts` (4228 lines, two emitters:
`generatePlatformSysRuntimeWindows` + `generateAsyncRuntimeIOWindows`), but yo-self
panicked on Windows targets at three sites:
- `runtime.yo` (async dispatch) — Windows async backend.
- `runtime_io_common.yo` `generate_sys_runtime` — Windows platform sync runtime.
- `runtime_io_common.yo` `generate_async_runtime_io_common` — Windows threadpool timer.

## The port

New file `yo-self/codegen/async/runtime_io_windows.yo` (4201 lines):
`generate_platform_sys_runtime_windows` + `generate_async_runtime_io_windows`, each a
single `emitter.emit_string_line(\`...\`)` of the **verbatim** TS C template (0
interpolations, like the macOS/Linux ports — so the quadratic-concat template hang
does not apply). Wiring:
- `runtime.yo`: Windows async branch → `generate_async_runtime_io_windows`.
- `runtime_io_common.yo` `generate_sys_runtime`: Windows → emit only the Windows
  platform sys-runtime and skip the POSIX-common helpers (mirrors TS's early
  `return;` — expressed as a Windows-vs-else split since Yo `return` is the
  effect-resume keyword, not an early function exit).
- `runtime_io_common.yo` `generate_async_runtime_io_common`: Windows threadpool-timer
  branch (TS runtime-io-common.ts:724-754) now emitted instead of panicking.
- `main.yo`: added `--target <triple>` (uses the already-ported `parse_target`) and
  `--emit-c`/`--skip-c-compiler` so the self-hosted CLI can cross-emit + inspect (the
  host C compiler cannot link a Windows binary). Faithful — `yo-cli` has both.

## Bug found + fixed in TS (not just ported around)

The Windows C template uses C NUL char literals written as single-backslash `'\0'`.
In a backtick/template literal `\0` is the NUL **escape**, so the emitted Windows C
contained **6 raw NUL bytes** — invalid C (clang truncates at the NUL). This was a
latent bug in TS's Windows codegen (Windows target evidently never compiled end to
end). The debug strings already used the correct double-backslash convention
(`\\n`). Fix: `'\0'` → `'\\0'` in **both** `src/codegen/async/runtime-io-windows.ts`
and the yo-self port, so the emitted C is the valid 2-char escape `'\0'`. Em-dashes
(U+2014) in Windows-template comments were also normalized to ASCII `--` in both
files: the TS string-literal emitter encodes a re-emitted constant's multi-byte
UTF-8 as per-byte `\u00XX`, and the em-dash continuation bytes (0x80/0x94) are C1
control chars → "universal character name refers to a control character". macOS/Linux
templates are pure ASCII and never hit this.

## Validation (macOS host — no Windows machine needed)

- `yo-self/codegen/async/runtime_io_windows.yo` C templates diff **byte-identical**
  to the TS templates (both normalized): `diff` rc=0 on both the 1875-line sync block
  and the 2301-line IOCP block; the injected timer block (31 lines) also rc=0.
- yo-self-bin builds clean with the Windows runtime compiled in (valid string
  constants, correct wiring).
- `yo-self-bin compile <awaiting-fixture> --target x86_64-windows-gnu --emit-c` emits
  the full IOCP runtime: `CreateIoCompletionPort`×5, `__yo_async_sleep_start`×1,
  `__yo_win_timer_add`×3 — identical marker counts to TS, and **0 NUL bytes** (TS had
  6 before the fix; 0 after).
- codegen-bootstrap corpus stays **76/76** (host codegen unaffected — the Windows
  branches are reached only for Windows targets).

## Remaining platform gap

WASM (`src/codegen/async/runtime-io-wasm.ts`, 797 lines) is still deferred — not part
of the Linux/macOS/Windows requirement. It is TS-backed and portable the same way
when needed (`runtime.yo`/`runtime_io_common.yo` still panic for WASM).
