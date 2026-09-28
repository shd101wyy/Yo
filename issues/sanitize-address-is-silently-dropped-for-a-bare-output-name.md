# `--sanitize address` is silently dropped when `-o` is a bare file name

**Severity:** S2 — `--sanitize address` is silently dropped for a bare `-o` name — an uninstrumented binary plus a warning blaming the toolchain, so memory-bug tests falsely pass

**Status: OPEN.** Found 2026-09-28 during the async state-machine audit, when
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
