# Windows: a positioned disk read or write moves the descriptor's file pointer

**Severity:** S2. On Windows, `std/sys/file`'s `read`, `write` and `write_sync` with an explicit offset (POSIX `pread`/`pwrite`) moved the descriptor's file position to `offset + n`. A later transfer at the current position (offset `u64.MAX`, or CRT `_read`/`_write`) then started in the wrong place. The data landed in the wrong place silently, with no error.

**Status:** fixed (`fix/develop-windows-pwrite-runtime`).
- Found when develop's battery at `31ef8d7a3` failed both Windows legs (`test (windows-latest)` and `test (windows-11-arm)`, shard 2/4) on `tests/sys/seek.test.yo`'s "offset u64.MAX reads and writes at the descriptor's own position": "a positional write should leave the position at 8". The test arrived with #1376 and was the first to check the position after a positioned write; the divergence itself is older.
- #1392 first documented the behaviour instead, as Rust's `FileExt::seek_write` and Zig's `File.pwrite` do. The maintainer then chose the runtime fix, which this replaces it with.

## Root cause

`src/codegen/async/runtime_io_windows.yo` positions disk I/O through the `OVERLAPPED` offset (`__yo_sync_write`, and the async `ReadFile`/`WriteFile` submissions). On a handle opened without `FILE_FLAG_OVERLAPPED`, which includes every CRT descriptor from `open`/`mkstemp`, Windows also moves the file pointer past every completed transfer, positioned or not. #1376 handled only the `u64.MAX` case, advancing the pointer itself.

## Fix

- `__yo_win_resolve_offset` records the pointer before every disk transfer.
- `__yo_win_settle_position` (replacing `__yo_win_advance_position`) runs once the transfer completes, including a read that hits EOF:
  - a positioned transfer puts the pointer back;
  - a `u64.MAX` transfer moves it past the bytes.
- An overlapped handle keeps no pointer, so there the settle only records where the next `u64.MAX` transfer starts.
- The record and the settle are two calls, so two threads transferring through one handle at once can still see each other's pointer, as on POSIX with `read(2)`/`write(2)` on a shared descriptor. The async loop is single-threaded and never interleaves them.

## Test

`tests/sys/seek.test.yo`: "offset u64.MAX reads and writes at the descriptor's own position" asserts the POSIX position after a positioned write on every platform again. It failed on both Windows legs before; the CI Windows legs gate it.

## Verification without a Windows box

A tree-built compiler emitted a program using all three transfers for `--target x86_64-pc-windows-gnu`. The patched runtime text was spliced into it, and the result passed `clang -target x86_64-w64-windows-gnu -fsyntax-only` against zig's MinGW headers. An injected typo was caught, so the check is real.
