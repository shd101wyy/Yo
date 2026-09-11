# `sys.copyfile` silently ignores its `flags` word on Windows

**Status:** open. Found by reading, during the `std/` `///` documentation
sweep. Not fixed here — this is a behaviour change and the sweep is
documentation-only.

## What happens

`std/sys/copy.yo`'s `copyfile(src, dst, flags)` documents `flags` bit 0 as
"fail if `dst` exists". Linux, macOS and wasm honour it. The Windows
implementation drops it on the floor and always overwrites:

`src/codegen/async/runtime_io_windows.yo` (the emitted C, at
`static int32_t __yo_sync_copyfile`):

```c
static int32_t __yo_sync_copyfile(const char* src_path, const char* dst_path, int32_t flags) {
  (void)flags;                              // <-- every bit discarded
  ...
  BOOL ok = CopyFileW(wsrc, wdst, FALSE);   // FALSE = bFailIfExists, so overwrite
  ...
}
```

`CopyFileW`'s third parameter IS `bFailIfExists`, so the fix is one
expression — but the two other flag bits macOS reads (`COPYFILE_CLONE`,
`COPYFILE_CLONE_FORCE`) have no Windows meaning, which is why this needs a
decision rather than a patch (see below).

For comparison, the POSIX arm in `runtime_io_common.yo` does read it:

```c
  int open_flags = O_WRONLY | O_CREAT | O_TRUNC;
  if (flags & 1) open_flags |= O_EXCL;
```

and the macOS arm:

```c
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;
```

## Why it matters

The failure mode is silent data loss, not an error: a caller asking for an
exclusive copy gets a successful return AND a clobbered destination. Nothing
in `std/` reaches it today (`std/fs` has no `copy`, and `tests/sys/copy.test.yo`
is the only caller in the tree), so this is latent rather than live — but it
is exactly the shape of bug that becomes a `std/fs.copy` bug the moment that
function is written on top of this one.

## Minimal reproducer

`issues/repros/stddoc-sys-windows-copyfile-ignores-flags.yo`. On Linux or
macOS it prints `rc=-17` (`-EEXIST`); on Windows it prints `rc=0` and the
destination has been replaced.

## Root cause

The Windows runtime emitter was written against `CopyFileW`, whose default
(`bFailIfExists = FALSE`) is the opposite of the flag's meaning, and the
parameter was suppressed with `(void)flags;` instead of being mapped. The
POSIX and macOS arms were each written with their own flag vocabulary, so
there was never one place where "what does bit 0 mean" was decided.

## Suggested fix

Two parts, in this order:

1. Decide the flag vocabulary in `std/sys/copy.yo` rather than per backend —
   a named set with a single documented meaning per bit, and a rule for a bit
   the platform cannot serve (the honest choice is `-ENOTSUP`, not silent
   success). `plans/reference/TARGET_TRIPLES.md` is the precedent for
   collapsing per-platform spellings into one vocabulary.
2. Then wire Windows: `CopyFileW(wsrc, wdst, (flags & 1) ? TRUE : FALSE)`,
   and reject the clone bits there instead of ignoring them.

A test belongs in `tests/sys/copy.test.yo`: create `dst`, copy with bit 0
set, assert the call fails AND that `dst`'s contents are unchanged. Written
that way it fails on Windows today and passes on POSIX, which is the right
red-first shape for a cross-platform behaviour bug.
