# `DateTime.now()` returned UTC and called it local

**Status: FIXED** (2026-09-06, `std/time/datetime.yo`, `std/libc/time.yo`,
`std/libc/windows.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 9.

## Symptom

```rust
now : (fn() -> Self)(
  DateTime.now_utc()   // "Current local date/time (UTC offset not resolved…)"
),
```

`now()` was `now_utc()` with `utc_offset_secs == 0`, so it printed `Z`,
`to_unix_utc` agreed with the wall clock only in UTC, and a log line stamped
with `now()` in Tokyo was nine hours off from the clock on the wall.

## Fix

`now()` resolves the zone offset in force at this instant through the C
library's local-time tables (`_local_utc_offset`): break the instant down with
`localtime_r` (`_localtime64_s` on Windows), read the broken-down wall clock
back as an epoch as if it were UTC, and difference the two. DST is included
because the C library applies it. The result has `utc_offset_secs` set, so
`to_string` renders `±HH:MM` and `to_unix_utc` is exact. Where the libc has
no zone data (wasm) the offset is 0.

Two details worth recording:

- **MSVC's `localtime_s` has its arguments REVERSED** from C11 Annex K
  (`(struct tm*, const time_t*)` vs `(const time_t*, struct tm*)`).
  `std/libc/time.yo` declares the Annex K prototype, so calling it on Windows
  would pass the pointers swapped. The Windows arm binds `_localtime64_s`
  (MSVC's own name) in `std/libc/windows.yo` instead.
- Only the first nine `int` members of `struct tm` are read (`tm_sec` …
  `tm_isdst`), which glibc, Apple, MSVC and musl/wasi all lay out in that
  order; the buffer is 64 bytes, larger than any of their `struct tm`.

## Regression tests

`tests/time/datetime.test.yo` — with `TZ=Asia/Tokyo` set before the first
local-time call, `now().utc_offset_secs == 32400` and `to_string()` ends in
`+09:00` (not on Windows, whose TZ syntax differs); and, everywhere, the
fields agree with the offset and the instant agrees with `now_utc()`.
