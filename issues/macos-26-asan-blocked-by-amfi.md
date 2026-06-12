# macOS 26.4.1 AMFI/XProtect blocks ASAN test binaries (Nix-store dylib path)

> **Status update (2026-06-11, evening):** re-tested with Developer Mode
> ENABLED (`DevToolsSecurity -enable`) — still blocked, and the root cause
> is now known to be BROADER than the Nix dylib path: a minimal C
> double-free probe compiled with **Apple CLT clang** (`/usr/bin/clang
> -fsanitize=address`, Apple-signed runtime dylib) ALSO hangs forever at
> startup, sampled inside `dyld4::prepare`. The Nix-clang probe hangs
> identically. So macOS 26.5 blocks ASan-instrumented binaries at the
> dyld level regardless of toolchain or Developer Mode — this is an
> OS-level regression, not a signing/Nix issue. Practical consequence:
> ASan is unusable on this machine for ANY local build; the
> libgmalloc + lldb + MallocStackLogging=full + malloc_history workflow
> (issues/fixed/yo-self-macro-dispatch-corruption.md) is the supported
> local alternative, and Linux CI provides real ASan coverage.
>
> **Status update (2026-06-11 triage):** mitigated, still unresolved.
> `--disable-sanitize` + the `asanRuntimeIsUsable` smoke-probe landed
> (ASan auto-skips instead of hanging tests), but `--sanitize address`
> still emits an uninstrumented binary on this machine. The working
> alternative for memory bugs is the libgmalloc + lldb +
> `MallocStackLogging=full` + `malloc_history` workflow (Developer Mode is
> now enabled) — documented in
> `issues/fixed/yo-self-macro-dispatch-corruption.md`; it produced full
> alloc/free/use stacks for both UAF root causes without ASan.

## Status: OPEN

## Symptom

On macOS 26.4.1 (Build 25E253, kernel 25.4.0) every `./yo-cli test` invocation
produces:

```
✗ Test trivial (60004ms)
  Test failed with exit code null
```

Even a trivial `test "x", { assert(true); };` hangs for 60 s and is then killed
by the test-runner watchdog. The compiled test binary starts (state R, busy CPU)
but produces no output and never exits on its own.

This affects **all branches**, including a fresh `origin/develop` clone — it is
**not** a bootstrap regression.

## Root cause

`Console.app` / `log show` shows the kernel rejects the test binary because it
cannot load `libclang_rt.asan_osx_dynamic.dylib` from the Nix store:

```
AMFI: '/private/tmp/yotest/.yo_test_batch_…' has no CMS blob?
AMFI: '...': Unrecoverable CT signature issue, bailing out.
XprotectService: File … failed on loadCmd /nix/store/…/libclang_rt.asan_osx_dynamic.dylib
```

The test binary itself is adhoc-signed (linker-signed), but it has a `LC_LOAD_DYLIB`
pointing at a Nix-store ASAN dylib that AMFI/XProtect on macOS 26 will not load.
The dyld load fails before `main()` runs, but the process is not killed cleanly —
it lingers until the test runner watchdog kills it.

`src/test-runner.ts` always passes ASAN flags
(`getSanitizerFlags({ sanitize: "address" })`) when not building for MSVC or
Emscripten. There is currently no way to disable this from the CLI.

## Reproducer

```bash
cat > /tmp/trivial.test.yo <<'EOF'
test "x", { assert(true, "ok"); };
EOF
./yo-cli test /tmp/trivial.test.yo            # hangs ~60 s, "exit code null"
```

Re-compile the same `.c` file by hand without `-fsanitize=address`:

```bash
clang -std=c11 -O0 tests/.yo_test_batch_*.c -o /tmp/x  # add -k to keep the .c
/tmp/x                                                   # exit 0, instant
```

## Workarounds

1. `./yo-cli test ... --target wasm-wasi` — runs through `wasmtime`, never
   hits AppleSystemPolicy. Currently the only reliable way to run the suite
   on macOS 26 locally.
2. Re-codesign the ASAN dylib with a developer ID (not done in the Nix shell).
3. Manually rebuild C with no sanitizer (see reproducer above).

## Fix (implemented)

Added `--disable-sanitize` flag to `yo test` (commit pending) so the suite can
be exercised natively on macOS 26. Note: the name is `--disable-sanitize` rather
than `--no-sanitize` because yargs treats `--no-X` as the negation of `--X` and
would refuse the flag.

Long-term, prefer a sanitizer dylib distributed via a path AMFI/XProtect will
accept (e.g. ship it with the Yo binary).
