# Chunked emission: a POSIX-constant fallback `#define` is visible in one chunk only

**Severity:** S3 — `yo compile src/main.yo --emit-chunks auto` on the compiler tree failed at
the C compiler on Windows (`use of undeclared identifier 'FD_CLOEXEC'`); the single-file
emission and every non-chunked command were unaffected

**Status:** FIXED 2026-10-06 (feat/vbd-send-sync). The guarded fallback constants moved from
the Windows platform runtime's CODE block to the DECLARATIONS buffer, which chunked emission
turns into the shared header every translation unit compiles against.

## Symptom

On Windows (MSVC target, whose `<fcntl.h>` defines none of the POSIX constants below):

```
yo compile src/main.yo --emit-chunks auto --jobs 8
…
yo-dbg/yo_chunk013.c:643:130: error: use of undeclared identifier 'FD_CLOEXEC'
  __yo_sync_fcntl_setfd(__yo_v_fd, ((int32_t)(FD_CLOEXEC))), …)
```

The compile failed or succeeded depending on where the chunk boundaries happened to fall
(adding lines to an unrelated module shifted them): `generate_platform_sys_runtime_windows`
emitted its `#ifndef FD_CLOEXEC / #define FD_CLOEXEC 1 / #endif` family as part of one big
CODE-buffer block, which lands in exactly ONE chunk, while the Yo functions that spell those
constants — `std/sys/constants`' `AT_FDCWD`, `std/fs/dir`'s `O_DIRECTORY`/`DT_*`,
`std/process/command`'s `FD_CLOEXEC`/`O_NONBLOCK` — hash into any chunk. The same shape as
the `environ` fix before it
(`issues/fixed/chunked-emission-drops-probed-include-flags-and-an-extern-runtime-declaration.md`,
whose "Open note" tracked the class). CI's `chunked-gate` never saw it: it runs on Unix
targets, where the real headers define every constant and each `#ifndef` guard keeps the
header's value.

## Root cause

A macro `#define` is a PREPROCESSOR construct: it is only visible to the translation unit
whose text contains it. Chunked emission shares the DECLARATIONS buffer (the header) across
every unit, but the CODE buffer is split — so anything other units' C needs at compile time
must live in declarations.

## Fix

`src/codegen/async/runtime_io_windows.yo`: the contiguous run of guarded fallback defines
(`DT_*`, `O_CLOEXEC`/`O_DIRECTORY`/`O_NONBLOCK`, `FD_CLOEXEC`, `PROT_*`, `MAP_*`, `MS_*`,
`AT_FDCWD`/`AT_REMOVEDIR`/`AT_SYMLINK_NOFOLLOW`, `AF_UNIX`, `UNIX_PATH_MAX`) is emitted via
`emit_declaration_string_line` before the platform block, and removed from the code string.
The `#ifndef` guards make the move a no-op where a real header defines the constant, so the
single-file emission is unchanged apart from the block's position. The Windows-only typedefs
and `SYMBOLIC_LINK_FLAG_*`/`PROCESS_QUERY_LIMITED_INFORMATION` (used only by runtime
functions adjacent in the same block) stay in the code buffer.

## Verification

- The failing build was `yo compile src/main.yo --std-path ./std --emit-chunks auto --jobs 8`
  on this tree on Windows (the error above). The fix changes where THIS tree's compiler puts
  the defines, so the direct re-check is the same `--emit-chunks` compile driven by a
  TREE-built binary (`yo-out/…/bin/yo.exe compile src/main.yo --emit-chunks auto`), which
  places the fallback constants in the shared header and links. A SEED-driven chunked build
  of the tree keeps the old layout by construction — the v0.2.52 seed emits from its own
  sources — and stays luck-of-the-hashing until the next seed; that is the Generation A/B
  split, not a defect of this fix.
- The single-file build (`yo build --std-path ./std`) passes both before and after — the
  emitted program text is unchanged, only the buffer placement of the define block moved.
