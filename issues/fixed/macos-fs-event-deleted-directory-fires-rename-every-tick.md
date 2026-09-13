# macOS: a deleted watched directory fires a rename event on every tick

Found during the async I/O runtime audit on macOS (2026-09-13).

## Symptom

`fs_event` watching a directory on macOS: after the directory is deleted, the
callback fires with `("", 1, …)` (nameless rename class) on **every event-loop
tick** — roughly every 10 ms while the loop idles on watches — forever. Linux
reports the deletion once (inotify `IN_DELETE`, then the watch is dead).

Observed with a watcher whose directory was `rmdir`'d, then `sleep(400)`:

```
count after quiet period=0
rmdir rc=0
count after delete=4          <-- one per ~100 ms, would continue indefinitely
```

Four callbacks for one deletion, and the storm never stops. A callback that
does work per event (re-scan, log, wake a task) turns into constant CPU and
log spam for the rest of the process lifetime.

## Minimal reproducer

```rust
// watch a directory with events.fs_event_start, rmdir it, sleep, count callbacks
```

(See the regression test added to `tests/sys/fs_event.test.yo` —
"a deleted watch directory reports one event, not one per tick".)

## Root cause

The macOS directory-watch path is snapshot-diff based
(`__yo_fs_event_detect_snapshot_changes`, emitted from
src/codegen/async/runtime_io_common.yo): each tick re-snapshots the directory
and diffs it against the previous snapshot. When `opendir` fails with
`ENOENT`, the code unconditionally reports a rename event:

```c
if (snap_err != 0) {
  if (snap_err == ENOENT && handle->callback && handle->active) {
    handle->callback("", 1, handle->user_data);
    emitted++;
  }
  return emitted;
}
```

There is no "already reported the deletion" state. The FILE branch of the
same function already models this with `handle->exists` (report 1 on
disappear, 1 on reappear); the DIRECTORY branch never consults it, so every
tick after the deletion re-reports it.

## Fix

Gate the ENOENT report on `handle->exists`, clear it after reporting, and
release the stale snapshot so a recreated directory starts a clean diff
(its entries re-report as creations, which is the diff-watching semantics
the emulation already promises). A directory that reappears flips `exists`
back on and takes a fresh snapshot — so delete → recreate is still two
events, not zero and not a storm.

## Verification

Regression test in `tests/sys/fs_event.test.yo`: after `rmdir` + 300 ms of
loop time, the macOS callback count is exactly 1 (was ≥ 4). Gated to
macOS/Linux (the Windows backend has its own deletion reporting).
