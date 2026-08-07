# yo-self-generated binaries hang in ASan's macOS init (before `main`)

**Status: RESOLVED (2026-08-07)** — the "TS runs fine" comparison was a
mirage: `otool -L` shows the TS `--sanitize address` binary links **no ASan
runtime at all**. TS's `getSanitizerFlags` runs a functionality probe
(`asanRuntimeIsUsable`, src/compiler-utils.ts: compile+run a trivial
`-fsanitize=address` program with a timeout) and on this box it detects the
mismatch (Nix clang 21's `libclang_rt.asan_osx_dynamic.dylib` deadlocking in
its own dyld initializer) and SKIPS the sanitizer with a warning. The yo-self
CLI lacked the probe, passed the flags unconditionally, and produced a
faithfully-instrumented binary linked against the broken runtime — which then
hung exactly as ASan does on this setup for ANY binary.

**Fix:** ported the probe to `yo-self/main.yo` (`_asan_runtime_is_usable`,
cached in `g_asan_usable`): trivial C program compiled via the system `cc`
with `-fsanitize=address`, then run under a 3-second `sh` watchdog
(`"$0" & p=$!; { sleep 3; kill -9 $p; } & wait $p` — Command has no timeout
support); non-zero/killed → skip the flags and print TS's exact warning.
Verified: `--sanitize address` on this box now warns, emits an
uninstrumented binary that runs (was rc=124 hang), and links only
libSystem — byte-for-byte the TS behavior. On a machine with a working ASan
the probe exits 0 and the flags apply as before.

The underlying environment defect (Nix clang 21 + this macOS ASan runtime
deadlock, stack below) is NOT ours to fix; with flag-parity restored this
issue is closed.

## Symptom

A binary produced by `yo-self-bin compile <x>.yo --sanitize address` hangs at
startup (no output, never reaches `main`); `rc=124` under a 25s timeout. The
**same program compiled by the TypeScript `yo-cli` with `--sanitize address`
runs fine and is LeakSanitizer-clean** (`rc=0`). The non-ASan yo-self binary
also runs fine.

Reproduces with a trivial program (`println("hello")`) — **not** ref-enum- or
RC-specific. Independent of `YO_MAIN_STACK_MB` (32 MB still hangs) and of
`--allocator`.

## Diagnosis (`sample`)

```
dyld4::APIs::runAllInitializersForMain()
  __sanitizer::MemoryRangeIsAvailable(...)
    __sanitizer::MemoryMappingLayout::Next(...)  / get_dyld_hdr()
      __sanitizer_mz_malloc
        __sanitizer::StaticSpinMutex::LockSlow()  → internal_sched_yield()  (spins forever)
```

The deadlock is **inside ASan's own runtime initializer** (the
`libclang_rt.asan_osx_dynamic.dylib` constructor), in the macOS malloc-zone
interceptor (`__sanitizer_mz_malloc`) spinning on a static spin-mutex while
ASan scans the process memory map (`MemoryRangeIsAvailable`). It never returns
control to dyld, so `main` never runs.

This is ASan-runtime-internal and runs **before** any Yo code. TS's generated
binary does not trigger it; yo-self's does — so some difference in the
**binary structure** yo-self emits (segments/sections/mappings, or a load-time
malloc path) perturbs ASan's macOS init. yo-self's C is _smaller_ than TS's
(1657 vs 9671 lines for `hello`) and has no `__attribute__((constructor))`, so
it is not a size or explicit-static-initializer problem.

## Status / scope

- **Pre-existing & general**: affects every yo-self binary under ASan on macOS,
  not just ref(enum) / RC. Surfaced now only because the yo-self CLI gained
  `--sanitize` (commit f6cafb455 — flag parity with TS). The flag itself is
  implemented correctly (passes the same `-fsanitize=address
-fno-omit-frame-pointer` as TS).
- **Not a correctness regression**: the program is correct — runs clean
  without ASan, matches the TS reference exactly, and the corpus is 83/83.
  ref(enum) RC was validated leak-clean via the **TS** `--sanitize address`
  binary (LeakSanitizer on, no leak) plus the clean non-ASan run.
- Orthogonal to the bootstrapping goal (P1 transpile markers / the
  REF_REFERENCE_SEMANTICS phases). Logged for a focused follow-up.

## Next steps (when picked up)

- Diff the Mach-O segment/section layout (`size -m`, `otool -l`) of a yo-self
  vs TS binary to find the structural trigger.
- Check whether yo-self emits a thread-local / `_Atomic` global or a malloc on
  a load-time path that ASan's zone interceptor re-enters.
- Try `ASAN_OPTIONS=start_deactivated=1` / a newer/older asan runtime to
  confirm it's the macOS init re-entrancy.
