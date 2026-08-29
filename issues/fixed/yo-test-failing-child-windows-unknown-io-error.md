# `yo test` on Windows: any FAILING test kills the run with `unknown I/O error` instead of a ✗ report

**Fixed 2026-08-29.**

## Symptom

On Windows, `yo test` reported PASSING tests normally, but the first FAILING
test aborted the whole run with a bare I/O error — no `✗` line, no assert
message, no failure diagnostics:

```
$ yo test ./tmp/redcheck/red.test.yo --parallel 1

./tmp/redcheck/red.test.yo
AddressSanitizer is not functional with this compiler setup (likely a version
mismatch between clang and the ASAN runtime library). Skipping sanitizer. [...]
Using system allocator
yo: error: unknown I/O error
```

rc=1, deterministic, on both the v0.2.19 release binary and a tree build —
not a regression. A minimal reproducer is any test whose body is
`assert(false, "boom")`.

## Root cause

`__yo_async_waitpid_start` (`src/codegen/async/runtime_io_windows.yo`)
returned `future->result = (int32_t)exit_code` — the raw DWORD from
`GetExitCodeProcess`, with the identity `__yo_process_exit_status` and a
zero `__yo_process_term_signal`. Windows reports abnormal terminations as
NTSTATUS failure codes (`abort()`/fastfail = `0xC0000409`, access violation
= `0xC0000005`, `cmd /c exit -1` = `0xFFFFFFFF`), and every code ≥
`0x80000000` is NEGATIVE as a signed i32.

`Command.status`/`Command.output` (`std/process/command.yo`) pass that raw
value to `IoError.check`, which reads any negative waitpid result as
`-errno`. An NTSTATUS-derived value is not a errno, so `IoError.from_errno`
fell through to `.Other` → "unknown I/O error" → the throw killed the runner
before the ✗ branch could report anything.

Why only Windows, and only aborting children: clean exits are small positive
DWORDs, and POSIX kernels hand waitpid a small encoded status (SIGABRT
children give 6), so Linux never produced a negative "status". A failing Yo
test aborts (`panic` → `fprintf(stderr, …); abort()`), which is exactly the
abnormal-termination class — so on Windows every red test looked like an
infrastructure error. (Bash showing the child as `127` was MSYS's mapping of
the abnormal exit, not the process's own code.)

## Fix

`src/codegen/async/runtime_io_windows.yo`, mirroring the POSIX contract that
`runtime_io_common.yo` already decodes:

- `__yo_win_encode_exit_code`: normal exits (< `0x80000000`) encode as
  `(exit_code & 0xFF) << 8` (what `W_EXITCODE(code, 0)` produces; codes above
  255 truncate exactly as on POSIX); NTSTATUS failures encode as a signal in
  the `WIFSIGNALED` position via `__yo_win_ntstatus_to_signal`
  (access-violation/stack-overflow → SIGSEGV, fastfail/abort → SIGABRT,
  Ctrl-C → SIGINT, default SIGTERM — mirroring libuv's exit-code table,
  using the CRT's own `<signal.h>` numbering).
- `__yo_process_exit_status`/`__yo_process_term_signal` now decode
  WIFEXITED/WEXITSTATUS/WTERMSIG with the same masks as the POSIX decoders,
  instead of identity/zero.

`ExitStatus.code()`/`.success()`/`.raw != 0` are unchanged for clean exits
0–255 (the only range any consumer relied on); signal deaths become
`code() == None` + `signal() != 0` instead of an exception.

Regression test: `tests/process/command.test.yo` — "an abnormally-terminated
child reports a signal, not an I/O error" (`cmd /c exit -1` on Windows,
`sh -c 'kill -TERM $$'` elsewhere; both SIGTERM → 15, `output()` must not
throw).

## Verification notes (two gotchas worth remembering)

1. **The runtime template lags one build generation.** The runtime C a
   compiler emits comes from the compiling binary's own compiled-in
   template, while the tree's template only becomes the next binary's data —
   the documented stage-1 rule ("changes to `src/` codegen are only
   observable under a stage-1 built from the new tree",
   `.github/instructions/testing.instructions.md`). So one `yo build` after
   editing `runtime_io_windows.yo` produces a binary that EMITS the fix but
   does not RUN it — `yo-out/…/yo.c` showed the old waitpid as plain code
   next to the fixed string constant. Build a second time (seed → yo.exe →
   yo.exe) and the fix materializes.
2. **`yo build` invoked AS `yo-out/<target>/bin/yo.exe` cannot relink
   itself** — Windows refuses to overwrite a running executable
   (LNK1104). Workaround: `yo-out/…/yo.exe compile src/main.yo --optimize 2
   -o <other-path>`.

End-to-end on Windows 11 with the twice-built binary: the minimal failing
test now prints `✗ always fails` / `Test failed with exit code 22` (raw
SIGABRT status, the same convention Linux prints), the summary (`1 failed /
1 total`), and exits 1. `tests/process/command.test.yo` 9 passed (including
the pre-existing clean `exit 1` case), `tests/internal/lexer.test.yo` 47/47,
`tests/basic.test.yo` 35/35, `yo check ./src` 262/262.
