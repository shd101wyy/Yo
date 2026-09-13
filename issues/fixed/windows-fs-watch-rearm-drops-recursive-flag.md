# Windows: `fs.watch` re-arm drops the recursive flag after the first delivered batch

**Status: FIXED (2026-09-12).** `__yo_fs_event_start`
(`src/codegen/async/runtime_io_windows.yo`) arms the initial
`ReadDirectoryChangesW` with `WatchSubtree = (flags & FS_EVENT_RECURSIVE)`,
but the re-arm in `__yo_poll_and_fs_event_tick` hard-coded `FALSE`:

```c
ReadDirectoryChangesW(fse->dir_handle,
  fse->notify_buf, sizeof(fse->notify_buf),
  FALSE,                     // <-- the caller's recursive choice, dropped
  FILE_NOTIFY_CHANGE_FILE_NAME | ... );
```

A recursive watch (`WatchOptions(recursive : true)`) therefore asked for
less than the caller requested from its second batch on.

Found 2026-09-12 by the Windows async-I/O runtime audit. **Severity: LOW
as it ships — masked.** A raw-C probe against Windows 10.0.26200 shows
the kernel keeps the FIRST arm's scope on the handle: a handle armed
`TRUE` at start still reports `sub\child.txt` events after a `FALSE`
re-arm (and, control probe: a FRESH handle armed `FALSE` reports nothing
for subdirectory changes, so the flag itself works). The narrowed re-arm
is thus not user-visible on current desktop Windows — but it is
semantically wrong, depends on undocumented handle state, and a kernel
that honors per-request scope (Server variants, future builds) would
silently stop recursive watches after their first delivered batch.

The same probe run observed the re-used OVERLAPPED/buffer delivering
one-batch-stale and duplicate records on this machine (both under
consistent and shrunken re-arm scope) — the duplication is consistent
with post-creation scanner touches (Defender/indexer) rather than the
re-arm itself, and `Watcher` already exposes each raw record as its own
`FsEvent`, so no claim is made against the delivery path here. If
duplicates ever become a reported problem, the structural fix is to
associate the directory handle with the IOCP and consume completions as
packets (the AcceptEx/read/write machinery) instead of polling
`GetOverlappedResult`.

## Fix

`__yo_fs_event_t` gains `watch_subtree`; `__yo_fs_event_start` records
the caller's choice and the tick re-arms with
`fse->watch_subtree ? TRUE : FALSE`.

Regression test: `tests/fs/watch.test.yo` "a recursive watch keeps
reporting subdirectory changes after the first batch" — round 1 touches
a root entry (forcing the delivered batch that triggers the re-arm),
round 2 touches only a subdirectory entry. Windows/macOS assert the
subdirectory event; Linux inotify is single-directory (recursive is
documented best-effort), so only the root round is asserted there.
