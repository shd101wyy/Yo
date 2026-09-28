# `--sanitize address` is silently dropped when `-o` is a bare file name

**Status: FIXED (2026-09-29).** Found 2026-09-28 during the async state-machine audit, when
a known heap-use-after-free produced no ASan report. Linux (WSL2, nix
toolchain), seed v0.2.45.

## Symptom

```
$ yo compile hello.yo --sanitize address --cc clang -o hello2
hello2.asan_probe: line 1: hello2.asan_probe: command not found
AddressSanitizer is not functional with this compiler setup (likely a version mismatch
between clang and the ASAN runtime library). Skipping sanitizer. ...
$ nm hello2 | grep -c asan
0

$ yo compile hello.yo --sanitize address -o ./hello4 && nm hello4 | grep -c asan
656
$ yo compile hello.yo --sanitize address -o "$PWD/hello3" && nm hello3 | grep -c asan
656
```

The sanitizer works, but the warning blames the toolchain, so the user's next
step (reinstalling clang or ASan) cannot help. Without `--cc`, the "command
not found" line is not always printed, and the binary still comes out
uninstrumented. A test or repro that trusts `--sanitize address` then reports
a memory bug as a pass.

## Root cause

`_asan_runtime_is_usable` (`src/main.yo`) builds the probe at
`${base}.asan_probe` and runs it as

```
sh -c 'ASAN_OPTIONS=detect_leaks=0 "$0" & p=$!; …' <probe_bin>
```

When `base` has no directory component, `"$0"` is a bare word, and `sh`
searches `PATH` for it instead of running the file in the current directory.
The probe "fails", and the result is cached as unusable for the process.

## Fix direction

Pass an absolute path (or prefix `./` when the path has no `/`) as the probe
binary. Add a CLI case to `tests/cli-cases/` that compiles with
`--sanitize address -o <bare-name>` and asserts the binary links the ASan
runtime.

## Fix (2026-09-29)

`_asan_runtime_is_usable` (`src/main.yo`) passes the probe binary as `./<name>` when the path has no directory component, so `sh` runs the file instead of searching `PATH` for it. Regression: `tests/cli-cases/sanitize-address-bare-output-name` compiles with `--sanitize address -o probe` and asserts that no `asan_probe` / `command not found` line appears. That holds whether or not ASan then arms (macOS AMFI refuses it). The case gives a golden diff with the v0.2.45 seed and passes with the fixed build.
