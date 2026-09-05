# `File.metadata` re-stats by PATH (a `from_fd` handle reports the CWD), and `read_dir` calls `DT_UNKNOWN` `.Other` so the walker skips whole subtrees

**Found**: 2026-09-05, auditing `std/fs` after `File.from_fd` landed
(2026-09-04, `plans/STD_API_AUDIT.md` fs row). **Fixed**: same day. Two
independent wrong-value defects, both of them silent — no error, no
diagnostic, just an answer about the wrong object.

## Defect 1 — `File.metadata()` describes whatever the PATH resolves to today

`File.metadata` was `_metadata_mod.metadata(self._path, io)`: it threw away the
open descriptor and re-`stat`ed a string. `File.from_fd` owns a raw descriptor
and has no path — it stores `Path.new(String.new())` — and `Path.to_string`
renders an empty relative path as **`"."`** (`std/path.yo:557-566`, a
deliberate render rule so `yo check .` works). So `metadata()` on a `from_fd`
handle stats the **current working directory**.

```rust
main :: (fn(io : Io, exn : Exception) -> unit)({
  fpath := Path.new(String.from("/tmp/yo_from_fd_meta.txt"));
  io.await(fs_file.write_string(fpath, String.from("0123456789"), io), IoExn(io : io, exn : exn));
  opened := io.await(File.open(fpath, .Read, io), IoExn(io : io, exn : exn));
  wrapped := File.from_fd(opened.fd());
  opened._is_closed = true;
  m := io.await(wrapped.metadata(io), IoExn(io : io, exn : exn));
  unsafe(printf("from_fd metadata size    = %lld\n", m.size()));
  unsafe(printf("from_fd metadata is_file = %d\n", cond(m.is_file() => i32(1), true => i32(0))));
  unsafe(printf("from_fd metadata is_dir  = %d\n", cond(m.is_dir() => i32(1), true => i32(0))));
  unsafe(printf("File.size() (fstat)      = %lld\n", wrapped.size()));
  io.await(wrapped.close(io), IoExn(io : io, exn : exn));
});
```

Observed (run from `/tmp`, `--optimize 2`, rc=0, no error):

```
from_fd metadata size    = 20480
from_fd metadata is_file = 0
from_fd metadata is_dir  = 1
File.size() (fstat)      = 10
```

Expected:

```
from_fd metadata size    = 10
from_fd metadata is_file = 1
from_fd metadata is_dir  = 0
File.size() (fstat)      = 10
```

`20480` is `/tmp`'s directory size — the number moves with the caller's cwd.
`File.size()` on the same handle, which has always been an `fstat`, gives the
right answer two lines later.

The `from_fd` case is only the loudest face. A path is not a handle: any file
renamed, replaced or unlinked after the open had `metadata()` describing a
different inode, or throwing `ENOENT`, while the descriptor was perfectly
readable.

### Root cause

`std/fs/file.yo:283` (pre-fix) — `metadata` forwarded `self._path`, not
`self._fd`:

```rust
metadata : (fn(self : Self, io : Io) -> Impl(Future(Metadata, IoExn)))(
  _metadata_mod.metadata(self._path, io)
)
```

and there was no fd-based stat in the tree to forward to: `std/sys/file.yo`
exposed only `statx(dirfd, path, …)`, whose every backend takes a path.

### Fix

An `fstat` at the layer the other stat lives at, all four backends:

- `src/codegen/async/runtime_io_linux.yo` — `__yo_fstat` = `statx(fd, "",
  AT_EMPTY_PATH, STATX_BASIC_STATS, buf)`, which IS `fstat(2)` and fills the
  same `struct statx` the accessors read.
- `src/codegen/async/runtime_io_macos.yo` — plain `fstat(fd, buf)`. macOS has
  no `AT_EMPTY_PATH`; measured on Darwin 25.6, `fstatat(fd, "", &st, 0)` is
  `ENOENT` and `fstatat(fd, "", &st, 0x1000)` is `EINVAL`, so the path binding
  genuinely cannot express this.
- `src/codegen/async/runtime_io_wasm.yo` — `fstat(fd, buf)`.
- `src/codegen/async/runtime_io_windows.yo` — `_fstat64` for size/mode/whole
  seconds, plus `GetFileInformationByHandle` on `_get_osfhandle(fd)` for the
  sub-second times, the creation time and the NTFS file index that stands in
  for the inode — exactly what the path version already takes from it.

Then `__yo_fstat` in `std/sys/externs.yo`, `IO_file.fstat(fd, statxbuf)` in
`std/sys/file.yo` (synchronous, like `file_size`: `fstat` reads an already-open
inode and cannot block), `metadata_fd(fd, io)` in `std/fs/metadata.yo`, and
`File.metadata` now forwards `self._fd`.

This also closes the audit's separate "stop `metadata` re-stat by path" item:
the path-resolution walk is gone from every `File.metadata` call.

## Defect 2 — `readdir`'s `DT_UNKNOWN` became `.Other`, so the walker never descended

`read_dir` mapped `d_type` with

```rust
ft := cond(
  (dt == DT_REG) => FileType.File,
  (dt == DT_DIR) => FileType.Directory,
  (dt == DT_LNK) => FileType.Symlink,
  true => FileType.Other
);
```

`DT_UNKNOWN` is not an exotic case: XFS, many network and overlay
filesystems, and any filesystem that does not carry the type inline answer it
for **every** entry — POSIX only guarantees `d_type` where the filesystem
happens to provide it. Calling that `.Other` makes `std/fs/walker.yo` skip the
`.Directory` arm, so it never pushes the subdirectory and silently returns an
incomplete tree; and `remove_dir_all`, which lives in the walker and deletes
by walk order, then falls through to `remove_file` on a directory.

Reproduced by making `read_dir` answer `DT_UNKNOWN` for every entry (one
patch to the `cond` above — the condition cannot be provoked on APFS, and the
macOS `getdents` emulation in `src/codegen/async/runtime_io_common.yo:1039`
resolves what is left with `fstatat` before std ever sees it) over a tree of
`sub/deep/c.txt`, `sub/b.txt`, `a.txt`, `link`:

```
walk found 2 entries
  /tmp/yo_walk_probe/sub : Other
  /tmp/yo_walk_probe/a.txt : Other
ERROR: permission denied
```

Two entries instead of six, every type wrong, and `remove_dir_all` failing
with the `unlink`-on-a-directory errno. Expected — and what the same probe
prints after the fix, byte for byte the same as the `d_type` fast path:

```
walk found 6 entries
  /tmp/yo_walk_probe/sub : Directory
  /tmp/yo_walk_probe/link : Symlink
  /tmp/yo_walk_probe/a.txt : File
  /tmp/yo_walk_probe/sub/deep : Directory
  /tmp/yo_walk_probe/sub/b.txt : File
  /tmp/yo_walk_probe/sub/deep/c.txt : File
remove_dir_all OK
```

### Root cause

`std/fs/dir.yo:314-319` (pre-fix), the `true => FileType.Other` arm of
`read_dir`'s `d_type` mapping. The mapping is in `read_dir`, not in the
walker, so every `read_dir` consumer had the wrong answer, not just the walk.

### Fix

`std/fs/dir.yo` gains `file_type(path, io)` — the entry's type by **`lstat`**
(`AT_SYMLINK_NOFOLLOW`) — and `read_dir` calls it for, and only for,
`DT_UNKNOWN`. A filesystem that reports a type keeps the syscall-free fast
path.

`lstat`, not `stat`, on purpose: `d_type` reports `DT_LNK` for a symlink, so
the fallback must agree or the same entry would classify differently
depending on the filesystem underneath — and it is
`WalkOptions.follow_symlinks` (audit C9), not the stat, that decides whether
to descend through a link. The symlink case is checked first in
`_statx_file_type` for the same reason.

The fallback is best-effort: an entry that cannot be stat'ed (removed under
us, or a parent that is readable but not searchable) keeps the `.Other` it
has today rather than failing the whole listing, so the change can only ever
improve the answer.

`file_type` deliberately ships WITHOUT the `_str`/`_cstr` siblings the rest
of the module carries. There is no way to spell a portable `str` path in a
test (`temp_dir()` yields a `String` and `String.as_str` was removed), so a
`file_type_str` would be frozen with no test — the §6 rule — and the audit's
fs row already wants the whole `_str`/`_cstr` matrix replaced by an `AsPath`
trait rather than extended.

`read_dir` also had to be restructured into two passes — pass 1 drains the
kernel's dirent buffers keeping `d_type` raw, pass 2 maps and stats — because
the stat needs an `await` and an await inside the getdents scan (a `while` in
a `while` in a `cond` arm) is the state-machine shape
`issues/async-nested-cond-await-duplicate-while-labels.md` warns about.

### A compiler bug found on the way

The natural spelling of pass 2 —

```rust
ft := cond(… , (r.dt == DT_UNKNOWN) => e.io.await(_file_type_or_other(…), e.io), …);
```

compiles clean and returns the ZERO value for **every** arm. A value-position
`cond` with an awaiting arm inside a `while` inside `io.async` never writes
its binding; the same cond without the `while` is fine, an unconditional
await inside the `while` is fine, and the statement form that assigns an
outer variable is fine. Filed, minimized, as
`issues/async-cond-value-with-await-arm-inside-while-yields-zero.md`;
`read_dir` ships the statement form with a comment pointing there.

## Tests

- `tests/fs/metadata.test.yo`: `File.metadata fstats THIS descriptor: a
  from_fd handle reports the file, not the CWD` (verified RED — reported the
  cwd's size and `is_dir`) and `File.metadata follows the descriptor across a
  rename, not the path` (verified RED — threw `ENOENT`).
- `tests/fs/dir.test.yo`: three `file_type` tests — file/directory, the
  symlink cases (a link to a file AND a link to a directory are both
  `.Symlink`, pinning the `lstat` choice), and a missing path throwing.
  `file_type` IS the function `read_dir` calls for a `DT_UNKNOWN` entry, so
  the fallback is under test even though the platform condition is not
  reachable on the CI filesystems.
- `DT_UNKNOWN` itself is **not** provoked by any test, and this doc does not
  claim it is: APFS and ext4 both report a type and the macOS emulation
  resolves the rest in the runtime. The end-to-end proof recorded above is the
  simulated-`DT_UNKNOWN` probe, red before and green after.
- `tests/fs/fs_convenience.test.yo`'s existing `remove_dir_all removes a
  nested tree (files, subdirs, symlink as link)` is the `remove_dir_all` pin
  and stays green.
