# Windows stat timestamps round-trip through local wall clock, so a DST fall-back hour reports mtime exactly 3600 s off UTC

**Severity:** S2 — `Statx`'s `mtime_sec`/`atime_sec`/`ctime_sec` are wrong by exactly one hour on Windows for any file stamped inside a DST fall-back local hour (and generally whenever the CRT's DST resolution disagrees with Windows'), which poisons `Metadata.modified/accessed/status_changed` and everything that compares an mtime to `SystemTime.now()`. Not S1: bounded to Windows, to timestamp accessors, and to transition windows; sizes/modes/paths are unaffected and no data is lost.

## What happened

The v0.2.74-window develop battery (run 41280749116, job "test (windows-11-arm) shard 2/4", 2026-11-01T08:03Z) failed the fs metadata test with exactly one DST-sized hour of skew:

```text
tests/fs/metadata.test.yo:308
assert(skew.as_secs() < i64(60), `mtime is within a minute of now, ${skew.as_secs()}s away`);
  → mtime is within a minute of now, 3599s away   (at std/assert.yo:39:17, exit code 22)
```

All four `windows-latest` (x64) shards of the same battery were green; only the `windows-11-arm` shard failed. 08:03Z on 2026-11-01 is 1:03 AM Pacific — inside the 1:00–1:59 AM local hour that repeats when US DST falls back that night (2:00 AM PDT → 1:00 AM PST at 09:00Z). The x64 image runs a UTC clock, so its CRT round trip below cancels exactly; the arm image runs a DST-observing zone, where the round trip is ambiguous.

## Root cause

On Windows, both stat backends take the whole-second timestamps from the CRT:

- path form (`__yo_async_statx_start`): `_wstat64(wpath, &ws->stat)` → `st_mtime`/`st_atime`/`st_ctime`;
- fd form (`__yo_fstat`): `_fstat64(fd, &ws->stat)` → same fields;

while the nanoseconds already come from the Win32 `FILETIME`s (`GetFileAttributesExW` / `GetFileInformationByHandle`) via `__yo_win_filetime_to_timespec`, which is pure UTC arithmetic.

The UCRT derives `_wstat64`/`_fstat64`'s time fields through `FileTimeToLocalFileTime` (DST bias at the file's instant, Windows rules) followed by `_mktime64` with `tm_isdst = -1` (the CRT guesses DST for the resulting local wall time). Outside transitions the two offsets cancel and `st_mtime` happens to equal the UTC epoch. Inside a fall-back hour the local time is ambiguous, the two resolutions pick different candidates, and `st_mtime` lands exactly 3600 s off. `SystemTime.now()` reads `GetSystemTimeAsFileTime` (pure UTC), so the test's skew is 3600 s minus the ~1 s between write and read: 3599 s.

A second, permanent manifestation of the same round trip: if the `TZ` environment variable names a zone that differs from the system zone, `FileTimeToLocalFileTime` follows the system zone while `_mktime64` follows `TZ`, and the offsets never cancel.

The test (`tests/fs/metadata.test.yo`, "Metadata.modified reports a wall-clock timestamp near now") is correct: it already compares absolute epochs with a 60 s two-sided window. It caught a genuine std/runtime bug; the fix belongs in the runtime, not the assertion.

## Reproducer

Any Windows host inside the repeated fall-back hour (or with `TZ` set to a zone other than the system's):

```yo
{ metadata } :: import("std/fs/metadata");
fs_file :: import("std/fs/file");
fs_dir :: import("std/fs/dir");
{ Path } :: import("std/path");
{ temp_dir } :: import("std/env");
{ SystemTime } :: import("std/time/instant");
{ String } :: import("std/string");
{ eprintln } :: import("std/fmt");
{ Exception, IoExn } :: import("std/error");

main :: (fn(io : Io) -> unit)({
  exn := Exception(
    throw : (
      err -> {
        eprintln(`stat error: ${err}`);
        unwind(());
      }
    )
  );
  p := Path.new(temp_dir()).join("yo_tz_repro.txt");
  io.await(fs_file.write_string(&p, String.from("x"), io), IoExn(io : io, exn : exn));
  m := io.await(metadata(&p, io), IoExn(io : io, exn : exn)).modified();
  now := SystemTime.now();
  skew := match(
    now.duration_since(m),
    .Ok(d) => d,
    .Err(e) => match(e, .EarlierThan({ by }) => by)
  );
  eprintln(`skew = ${skew.as_secs()}s`); // 3599 before the fix, ~0 after
  io.await(fs_dir.remove_file(&p, io), IoExn(io : io, exn : exn));
});
```

On Linux this prints `skew = 0s` both before and after (the `statx` backend is UTC); on Windows inside the fall-back hour it printed 3599 before and prints ~0 after. The regression test that fires is the existing `tests/fs/metadata.test.yo` assertion named above — it failed on the CI leg before the fix and is the gate after it.

## Fix

`src/codegen/async/runtime_io_windows.yo`, both stat sites: after the CRT call succeeds and the Win32 query (`GetFileAttributesExW` / `GetFileInformationByHandle`) returns, overwrite `st_atime`/`st_mtime`/`st_ctime` with the UTC seconds of the very FILETIMEs the nanoseconds already come from (`st_ctime` keeps its Windows meaning, the creation time, now with the correct epoch). The CRT values survive only as the fallback when the Win32 query fails. `SystemTime.now()` was already UTC and is untouched.
