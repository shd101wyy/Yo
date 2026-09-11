# `Metadata.status_changed()` on Windows mixes creation seconds with write-time nanoseconds

**Found:** 2026-09-11, during the `std/` `///` documentation sweep (reading, not running).
**Status:** OPEN — filed, not fixed (documentation-only PR).
**Severity:** wrong value, Windows only. Not memory-unsafe.

## What the code does

`std/fs/metadata.yo` builds the POSIX-ctime accessors out of two runtime
primitives:

```rust
status_changed : (fn(self : Self) -> SystemTime)(
  SystemTime.from_unix_parts(self._statx.ctime_sec(), i64(self._statx.ctime_nsec()))
),
```

On Windows those two primitives are filled from DIFFERENT timestamps
(`src/codegen/async/runtime_io_windows.yo`):

* `__yo_statx_ctime_sec` reads `((__yo_win_stat_t*)buf)->stat.st_ctime`, which
  `_wstat64` fills with the file's **creation** time (the MSVC CRT has no POSIX
  ctime; `st_ctime` is documented as the creation time, and only valid on NTFS).
* `__yo_statx_ctime_nsec` reads `->ctime_nsec`, and both fill sites set that
  field from the **last write** time:

```c
  // path form, __yo_async_statx_start (line 2751)
  __yo_win_filetime_to_timespec(fad.ftLastWriteTime, &sec, &ws->mtime_nsec);
  __yo_win_filetime_to_timespec(fad.ftCreationTime, &ws->btime_sec, &ws->btime_nsec);
  ws->ctime_nsec = ws->mtime_nsec;

  // fd form, __yo_fstat (line 1237)
  __yo_win_filetime_to_timespec(info.ftLastWriteTime, &sec, &ws->mtime_nsec);
  ws->ctime_nsec = ws->mtime_nsec;
```

So `status_changed()` on Windows returns a `SystemTime` whose SECONDS come from
the creation time and whose NANOSECONDS come from the last write. The two are
unrelated, so the composed value corresponds to no event at all: for a file
created at `T0.000_000_000` and written at `T1.750_000_000`, it reports
`T0.750_000_000`.

`status_changed_time()` (seconds only) is unaffected by the mixing, but is still
the creation time under a name that says "status changed".

## Reproducer

Needs a Windows host, so this is a code reading rather than a run:

```rust
{ Path } :: import("std/path");
{ metadata } :: import("std/fs/metadata");
{ write_string } :: import("std/fs/file");
{ println } :: import("std/fmt");
{ sleep } :: import("std/time/sleep");
{ Duration } :: import("std/time/duration");

main :: (fn(io : Io, exn : Exception) -> unit)({
  p := Path.new(`ctime_probe.txt`);
  io.await(write_string(p, `a`, io), { io, exn });
  io.await(sleep(Duration.from_millis(i64(1500)), io), io);
  io.await(write_string(p, `b`, io), { io, exn });
  m := io.await(metadata(p, io), { io, exn });
  // On Windows the nanoseconds below belong to the SECOND write while the
  // seconds belong to the creation, so this value is between the two events.
  println(`status_changed = ${m.status_changed()}`);
  println(`modified       = ${m.modified()}`);
});
```

## Root cause

Windows has no POSIX ctime, and the runtime papers over the gap by reusing the
write time's sub-second part for a seconds field taken from the creation time.
Either half alone would be defensible; combining them is not.

## Suggested fix (not applied here)

Two coherent options, and the choice is an API decision rather than a bug fix,
which is why this is filed rather than patched:

1. Set `ws->ctime_nsec` from `ftCreationTime` (the timestamp its seconds
   already come from). `btime_nsec` is already computed from exactly that call,
   so this is one line, and it makes the Windows `status_changed()` honestly
   equal to the creation time.
2. Expose `created()` (`STATX_BTIME` on Linux, `st_birthtimespec` on macOS,
   `ftCreationTime` on Windows — all three runtimes already implement
   `__yo_statx_btime_sec`/`_nsec`; only wasm does not), and make the ctime
   accessors report `NotSupported`/`.None` on Windows rather than a synthesised
   value.

Option 2 is what `std/fs/metadata.yo`'s `## Stability` section now names as the
open question blocking that module's freeze.
