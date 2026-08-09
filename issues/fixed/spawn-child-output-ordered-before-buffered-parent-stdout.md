# A spawned child's output landed BEFORE parent lines printed earlier

**Status: FIXED** 2026-08-09 (`src/codegen/async/runtime-io-common.ts`,
`runtime-io-windows.ts` — the WASM spawn is an ENOSYS stub, nothing to fix).
Found by `tests/cli-cases/build-run` the moment the SIGSEGV in front of it was
fixed: the case went SELF-FAIL → DIFF, with both compilers exiting 0 but the
lines swapped.

```
$ ts-yo build run            # reference
Building probe → yo-out/aarch64-macos/bin/probe
Hello, world!

$ self-yo build run          # BEFORE — same lines, wrong order
Hello, world!
Building probe → yo-out/aarch64-macos/bin/probe
```

## Root cause

Not a build-runner bug — a C runtime buffering gap that affects every compiled
Yo program that prints and then spawns a child with inherited stdio.

libc's stdout is FULLY buffered when attached to a pipe (line-buffered only on
a tty). `println` before the spawn writes into the parent's stdio buffer; the
child inherits fd 1 and writes to the PIPE directly; the parent's buffer
flushes at process exit. Result: the child's output overtakes any not-yet-
flushed parent output whenever stdout is a pipe — which is exactly what test
harnesses, differential runners, and shell pipelines see. On a terminal the
order looks right, so the bug hides interactively.

The TS reference never had the problem because node's `console.log` issues a
write syscall per call.

## Fix

`fflush(stdout); fflush(stderr);` at the top of `__yo_async_spawn_start`
(POSIX `posix_spawnp` and Windows `CreateProcessW` variants), before the child
is created. Flushing unconditionally is harmless when the child's stdio is
redirected elsewhere.

## Regression coverage

`tests/cli-cases/build-run` — the differential compares stdout byte-for-byte
under a pipe, so this exact interleaving is what it gates.

## Worth remembering

Interleaving bugs between parent `println` and child output are invisible on a
tty and deterministic under a pipe. If a compiled Yo program's progress lines
appear AFTER a child's output in CI but look fine locally, check for a spawn
path that doesn't flush stdio first.
