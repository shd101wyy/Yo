# macOS: `fs/dir.read_dir` silently truncated directories larger than one getdents buffer

**Status: FIXED** (2026-08-10). Found by the P2.4 formatter-fixture port: a
walker test over `tests/internal/formatter_fixtures/` (92 files) saw only 19
`.input` entries; a minimal probe confirmed `read_dir` returned **45 of 92**
entries. No error — just silent truncation of any directory that didn't fit
one 4096-byte `getdents` buffer (~45 entries at typical name lengths).

## Root cause

The macOS `getdents` emulation (`__yo_async_getdents_start` in
`src/codegen/async/runtime-io-common.ts` / mirrored in
`yo-self/codegen/async/runtime_io_common.yo`) re-opened the directory on
EVERY call: `dup(fd)` → `fdopendir` → `readdir` loop → `seekdir` (on buffer
overflow) → `closedir`.

The flaw: `readdir` reads ahead in large chunks, advancing the file offset
that the dup'd fd **shares** with the caller's fd — typically consuming the
whole directory on the first call. `seekdir` rewinds only the DIR stream's
in-memory state, not the shared offset, and `closedir` throws that state
away. The next call's fresh `fdopendir` starts at the already-consumed
shared offset and sees EOF: every entry that didn't fit the first caller
buffer was lost. `std/fs/dir.yo`'s loop dutifully stopped at the `n == 0`.

Linux was never affected (`SYS_getdents64` on the fd directly — the kernel
manages the position). Windows was never affected (persistent per-fd
`__yo_win_get_dir_state` FindFirstFile emulation).

## Fix

Keep a per-fd `DIR*` stream alive across calls (a process-global linked
registry, mirroring the Windows design): first call for an fd creates the
stream, buffer-overflow breaks leave it registered (resumable via
`seekdir` within the SAME stream, which is well-defined), and end-of-
directory unregisters + `closedir`s it. Single-threaded event loop — no
locking, per the async threading model. Fixed identically in BOTH emitters.

## Tests

- `tests/fs/dir.test.yo` "read_dir survives directories larger than one
  getdents buffer" — 200 files, asserts all 200 come back (returned ~45
  before the fix).
- The formatter fixture corpus test (`tests/internal/formatter.test.yo`)
  walks a 92-file directory and asserts ≥46 inputs found.
