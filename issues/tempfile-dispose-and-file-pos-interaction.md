# `TempFile`/`TempDir` Dispose-on-drop fails when the file is run standalone, and making `read_bytes` position-aware SIGSEGVs six of those tests

**Status: OPEN.** Two observations about the same corner, both measured
2026-08-25 on `develop` at `340a9e735`.

## 1. Two Dispose tests fail standalone but pass in the suite

```
$ yo test tests/fs/temp.test.yo --parallel 1
  ✗ TempDir Dispose removes the directory on drop     exit code 6
  ✗ TempFile Dispose removes the file on drop         exit code 6
  8 passed  2 failed                                  (rc=1)

$ yo test ./tests --exclude tests/internal --exclude tests/cli-cases
  2905 passed 2905 total                              (rc=0)
```

`tests/fs/` is NOT excluded from the suite, so both tests DO run there and pass.
Only the standalone batch fails. That is the batch-composition hole tracked in
`issues/where-bound-gc-trace-still-fails-when-run-standalone.md`; this is its
second known instance and the first outside the era-copy family.

Whether the Dispose behaviour itself is wrong, or only its observability under a
different batch, is NOT yet established — that is the open question here.

## 2. Making `read_bytes` honour `File._pos` crashes six of these tests

While fixing `issues/fixed/file-read-write-ignore-position-always-offset-zero.md`,
`read_bytes` was changed to start from `self._pos` and leave it at EOF (rather
than a local `offset := u64(0)`), so that mixing it with the incremental `read`
stays coherent. That is the correct behaviour and mirrors Rust's `read_to_end`.

It fails hard:

```
tests/fs/temp.test.yo:   4 passed  6 failed     — exit code 11 (SIGSEGV)
  ✗ TempFile.new creates a file
  ✗ TempFile.new_in creates in specified parent
  ✗ TempFile.file returns usable File
  ✗ TempFile.remove is idempotent
  ✗ TempDir Dispose removes the directory on drop
  ✗ TempFile Dispose removes the file on drop
```

The change was REVERTED and the File fix shipped without it: a freshly opened
handle has `_pos == 0`, so every whole-file caller (`read`, `read_to_string`
and their `_str`/`_cstr` forms) behaves identically either way.

The two edits that crash are reading `self._pos` for the initial offset and
assigning `self._pos = offset` after the loop — both inside
`io.async((e) => {...})`, i.e. touching a captured `ref` struct's field across
the async boundary. `read`/`write_string`/`write_bytes` do exactly the same and
do NOT crash, so the interaction is specific to `read_bytes` or to how
`TempFile` holds its `File`.

## Why the two are filed together

Both involve `TempFile`, both involve Dispose/drop timing, and one of them turns
a latent assertion failure into a segfault. They may share a root — a `File`
reached through `TempFile._file` whose lifetime or RC differs from a directly
opened handle. Worth investigating as one.

## Next step

Reproduce (2) minimally outside the test harness — a `TempFile`, a `read_bytes`,
and a drop — and check whether the `File` is being disposed before the async
continuation writes `_pos` back.
