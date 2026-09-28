# Linux `copyfile` truncates files over 2 GiB and copies `/proc` files as empty

**Status: FIXED (2026-09-28).** Found by reading `runtime_io_common.yo`
during the 2026-09-28 Linux async-runtime audit.

## Symptom

`std/sys/copy.copyfile` (`__yo_sync_copyfile`) on Linux:

1. copied a 2,200,000,000-byte file as exactly **2,147,479,552** bytes and
   returned 0 (success). Measured on WSL2 6.6 ext4 with a sparse source.
2. copied `/proc/self/status` as an **empty file**, again returning 0.

## Root cause

It made ONE `copy_file_range(src, dst, st.st_size)` call (and one `sendfile`
as the fallback), treating any non-negative return as done. The kernel moves
at most `MAX_RW_COUNT` (`INT_MAX & PAGE_MASK` = 2,147,479,552) bytes per
call, so the tail of a larger file was silently dropped. And `st_size` is not
the length of every file: procfs and sysfs report 0, so nothing was copied at
all.

## Fix

Copy to end of file: `copy_file_range` in a loop until it returns 0. When it
copies nothing at all (procfs's answer) or the kernel refuses the pair
(`EXDEV`, `EINVAL`, `ENOSYS`, `EOPNOTSUPP`, `EPERM`), a `pread`/`write` loop
continues from the current offset to EOF, handling short writes and `EINTR`.

## Tests

`tests/sys/copy.test.yo`:
- "copyfile copies a file whose reported size is 0 (/proc)" — fails before
  the fix (the copy is empty), passes after.
- "copyfile copies a file larger than 2 GiB (YO_TEST_HEAVY=1)" — writes
  2.2 GB, so it runs only when `YO_TEST_HEAVY=1`; verified locally before
  (2,147,479,552 of 2,200,000,000 bytes) and after (all of them).
