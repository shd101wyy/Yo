# yo-self cross-emission bakes HOST platform constants (AT_FDCWD = -2 on a linux target)

**Status: OPEN** (found 2026-08-14 during the GATE 3 emit-diff hunt,
issues/seed-built-stage1-array-fill-method-miss.md).

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
