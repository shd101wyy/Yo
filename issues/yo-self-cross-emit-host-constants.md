# yo-self cross-emission bakes HOST platform constants (AT_FDCWD = -2 on a linux target)

**Status: FIX APPLIED 2026-08-16, awaiting CI** (found 2026-08-14 during the
GATE 3 emit-diff hunt, issues/fixed/seed-built-stage1-array-fill-method-miss.md).

## Root cause (2026-08-16)

`yo-self/evaluator/builtins/process.yo` answered all three comptime builtins —
`__yo_process_platform`, `__yo_process_arch`, `__yo_pointer_size_bits` — from
`detect_host()`. TS answers the first two from `getCurrentTarget()`
(`src/evaluator/builtins/process.ts:41,64`) and the third from
`getTargetPointerSizeBits()` (`:88`). Since `cond` evaluates only the taken
arm, every target-conditional in `std/` was selected for the emitting machine
during evaluation, and the untaken (correct) arm never reached the AST — which
is why no amount of codegen-side target awareness could recover it.

`__yo_pointer_size_bits` was wrong by a factor of two for any wasm32 target
emitted from a 64-bit host, which had not been noticed before.

## How it surfaced a second time

Converting the wasm CI legs to the self-hosted compiler (PR #127) made it fail
loudly rather than silently: on a Linux runner targeting wasm,
`std/crypto/random.yo` took its **Linux** arm, and the link died with

```
wasm-ld: error: undefined symbol: getrandom
```

even though `random.yo:78` has an explicit
`(platform == Platform.Emscripten) || (platform == Platform.Wasi)` arm. The
file is only pragma-skipped for WASI, so the Emscripten leg compiled it.

## Fix

A module-level current target in `yo-self/target.yo` — `g_current_target` with
`set_current_target` / `get_current_target`, falling back to `host_target()`
when unset — mirroring TS's `currentTarget` (`src/target.ts:296-317`).
`run_compile` calls `set_current_target(target)` immediately after resolving
the target and **before** the module is evaluated (TS: `codegen/index.ts:194`),
and the three builtins now read it.

The fallback matters: `check` and other entry points never set a target, and
they must keep answering for the host exactly as before.

**Verify:** the original pin still applies — grep the emitted C for `-100` at
the `statx` call site under `--target x86_64-linux-gnu` from a macOS host. The
new pin is the Emscripten leg linking at all.

Cross-emitting `std/fs/file.yo`'s `exists` from macOS with
`--target x86_64-linux-gnu`:

```
TS:   fn_..._statx((int32_t)(-100), ...)   // AT_FDCWD, linux value — correct
self: yo_id_5742((int32_t)(-2), ...)       // AT_FDCWD, MACOS value — wrong
```

The self-hosted evaluator resolves the target-conditional constant
`AT_FDCWD` for the HOST platform instead of the `--target` platform; TS
resolves it for the target. On Linux, `statx(dirfd=-2, <relative path>)`
fails EBADF — every relative-path `exists`/`is_file`/`is_dir` under a
macOS→linux cross-compiled binary is broken.

NOT the GATE 3 CI bug (CI emits on Linux for Linux, host == target), but a
real divergence: find where std's target-conditional constants evaluate
(comptime `cond` on the target? `std/sys/const` tables?) and key them on
`--target` in the self evaluator as TS does. Add a cross-emission
differential pin (grep the emitted C for `-100` at the statx call site
under `--target x86_64-linux-gnu` from a macOS host).

Repro: scratchpad fsprobe (exists/is_file/is_dir), both compilers,
`--release --target x86_64-linux-gnu --emit-c --skip-c-compiler`.
