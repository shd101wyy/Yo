# `File.read`/`write_*` always pread/pwrite at offset 0, and `File.seek` is a silent no-op

**Status: FIXED 2026-08-25** in `8825bbb39` ("std: File never tracked its
position", PR #277) — `File` gained a `_pos : u64` field that `read`/`write_*`
advance and `seek` sets, with `tests/fs/file.test.yo` covering sequential reads,
sequential writes, and all three `SeekFrom` origins. Found 2026-08-25 by the
STD_API_AUDIT scoping survey, verified directly against `develop`. Three faces
of one bug.

## The bug

`std/fs/file.yo` hardcodes the offset argument to zero:

```
101:      result := e.io.await(IO_file.read(fd, buf, size, u64(0)), e.io);
114:      result := e.io.await(IO_file.write(fd, data_bytes.ptr().unwrap(), u32(...), u64(0)), e.io);
129:      result := e.io.await(IO_file.write(fd, data.ptr().unwrap(), u32(data.len()), u64(0)), e.io);
```

That last parameter is the file offset — `std/sys/file.yo:37,42` declare
`read`/`write` as `(fd, buffer, size, offset : u64)`, and the runtime implements
them with **positional** I/O (`pread`/`pwrite`/`preadv`/`pwritev`, e.g.
`src/codegen/async/runtime_io_wasm.yo:113-118,309`). Positional I/O neither reads
nor advances the descriptor's file position.

So:

| call | actual behaviour |
| --- | --- |
| `file.read(buf, n, io)` repeatedly | returns the SAME first `n` bytes forever |
| `file.write_string(s, io)` repeatedly | each call OVERWRITES at offset 0 |
| `file.seek(off, from, exn)` then read/write | **seek has no effect** |

`seek` (`std/fs/file.yo`) calls `IO_seek.lseek`, which moves the *descriptor's*
position — the one `pread`/`pwrite` ignore. It returns the new offset and reports
success, so the API looks correct and silently is not. That is the worst of the
three: a caller who seeks before reading gets no error, just wrong data.

## Why it has gone unnoticed

`File` has no position field at all:

```rust
File :: ref(struct(_fd : i32, _path : Path, _is_closed : bool));
```

and the WHOLE-FILE paths do their own offset bookkeeping, so they are correct:
`read_bytes` (`std/fs/file.yo:144`) keeps a local `offset` and advances it by `n`
each iteration. Everything the compiler itself uses — `read`, `read_to_string`,
`write_string`, `write` — goes through those whole-file helpers, so the tree's
biggest consumer never exercises the incremental API. The bug lives only in the
per-call `File` methods.

## Fix

`File` must carry its own position, because the underlying primitive is
positional:

- add `_pos : u64` to the struct,
- `read`/`write_string`/`write_bytes` pass `self._pos` and advance it by the
  number of bytes actually transferred,
- `seek` computes and sets `_pos` (`.Start`/`.Current`/`.End`, the last needing
  the file size), instead of relying on `lseek` to affect later calls.

An alternative — switch the runtime to non-positional `read`/`write` — is worse:
it would make every caller share one kernel-side position, break `read_bytes`'s
explicit-offset loop, and remove the ability to do concurrent positional reads on
one descriptor, which is the reason the async runtime uses `pread` in the first
place.

## Regression test

Red-first, all three faces:
1. write twice, expect the file to contain BOTH writes (today: only the second),
2. read twice in `size`-sized chunks, expect the second chunk to differ from the
   first (today: identical),
3. `seek` then read, expect data from the sought position (today: from 0).
