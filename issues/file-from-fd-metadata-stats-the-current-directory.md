# `File.from_fd(fd).metadata()` returns the CURRENT DIRECTORY's metadata, not the file behind the descriptor

**Found**: 2026-09-04, during the std-API audit re-measurement of the fs row
(`plans/STD_API_AUDIT.md` item "stop `metadata` re-stat by path", which the plan
files under EXTEND + POLISH). It is not polish — it is a wrong-value bug that
hands a caller plausible metadata for a completely different object with no
error. **Status**: OPEN. **Severity**: wrong-value.

## Symptom

`File.from_fd` wraps an already-open descriptor. Ask the wrapped handle for its
metadata and you get the metadata of the process's current working directory:

```rust
{ String } :: import("std/string");
{ Path } :: import("std/path");
{ println } :: import("std/fmt");
{ Exception, IoExn } :: import("std/error");
fs_file :: import("std/fs/file");
{ File } :: fs_file;
fs_dir :: import("std/fs/dir");

main :: (fn(io : Io) -> unit)({
  exn := Exception(throw : (err -> { println(`error: ${err}`); unwind(()); }));
  e := IoExn(io : io, exn : exn);
  p := Path.new(String.from("/tmp/yo_fromfd_probe.txt"));
  io.await(fs_file.write_string(p, String.from("0123456789"), io), e);
  f := io.await(File.open(p, .Read, io), e);

  w := File.from_fd(f.fd());
  println(`from_fd().path().to_string() = "${w.path().to_string()}"`);
  println(`f.metadata().size()          = ${io.await(f.metadata(io), e).size()}`);
  println(`f.size()   (fstat)           = ${f.size()}`);
  println(`w.size()   (fstat)           = ${w.size()}`);
  wm := io.await(w.metadata(io), e);
  println(`from_fd().metadata().size()   = ${wm.size()}`);
  println(`from_fd().metadata().is_dir() = ${wm.is_dir()}`);
  println(`from_fd().metadata().is_file()= ${wm.is_file()}`);

  io.await(f.close(io), e);
  io.await(fs_dir.remove_file(p, io), e);
});
export(main);
```

Observed (yo v0.2.24, `YO_STD=./std`, `--optimize 2`, run with cwd `/tmp`):

```
from_fd().path().to_string() = "."
f.metadata().size()          = 10
f.size()   (fstat)           = 10
w.size()   (fstat)           = 10
from_fd().metadata().size()   = 20576
from_fd().metadata().is_dir() = true
from_fd().metadata().is_file()= false
```

Expected: `from_fd().metadata()` describes the 10-byte regular file the
descriptor is open on — `size() == 10`, `is_dir() == false`, `is_file() == true`
— or, if the implementation cannot answer, it throws. It does neither. The
20576/`is_dir() == true` answer is `stat(".")` — the cwd. Run the same binary
from a different directory and the numbers change again.

Two secondary lies fall out of the same line:

- **The same handle contradicts itself.** `w.size()` is 10 while
  `w.metadata().size()` is 20576, because `File.size` already goes through the
  descriptor (`std/fs/file.yo:237-239`, `IO_file.file_size` → `fstat`) while
  `File.metadata` goes through the path.
- **The doc comment is wrong.** `std/fs/file.yo:194-197` says "The path is
  unknown, so `path()` reports an empty path." `path().to_string()` reports
  `"."`, which is not an empty path — it is a real, resolvable path, and that is
  precisely why the stat succeeds instead of failing.

## Root cause

Three lines, each individually defensible, compose into the wrong answer.

1. `File.metadata` never uses the descriptor it holds. It re-stats by path:

   ```rust
   // std/fs/file.yo:267-269
   metadata : (fn(self : Self, io : Io) -> Impl(Future(Metadata, IoExn)))(
     _metadata_mod.metadata(self._path, io)
   )
   ```

   and `std/fs/metadata.yo:114-120` lowers that to
   `IO_file.statx(AT_FDCWD, cstr, …)` — a path resolution against the cwd, with
   `self._fd` unused.

2. `File.from_fd` has no path to give, so it stores the empty one:

   ```rust
   // std/fs/file.yo:198-205
   from_fd : (fn(fd : i32) -> Self)(
     Self(
       _fd : fd,
       _path : Path.new(String.new()),
       …
   ```

3. The empty relative path does not render as the empty string. `Path.to_string`
   has a deliberate render rule (`std/path.yo:567-569`):

   ```rust
   if(!self._is_absolute && (segments.len() == usize(0)), {
     return(String.from("."));
   });
   ```

   That rule is correct on its own terms — it was added because `stat("")` is
   ENOENT and it broke `yo test .` / `yo check .`. But it converts step 2's
   "unknown" sentinel into the cwd, so step 1's `statx(AT_FDCWD, ".")` succeeds
   and returns a plausible answer instead of ENOENT.

Had the render rule not existed, this would surface as a thrown ENOENT — bad,
but honest. With it, the failure is silent.

## Why the tests did not catch it

- `tests/fs/file.test.yo:405-431` ("File.from_fd wraps an existing descriptor")
  exercises only `read` and the first/last byte. It never calls `metadata()`,
  `path()` or `size()` on the wrapped handle.
- `File.metadata` *is* tested (`tests/fs/metadata.test.yo:191-210`), but only on
  a handle obtained from `File.open`, where `_path` is the real path and the
  re-stat happens to give the right answer. That is a vacuous green for the
  mechanism under test: it passes whether `metadata` uses the fd or the path.

## Fix

Two independent halves. Half 1 closes the wrong-value face immediately and is
not seed-gated; half 2 is the real fix and needs a new runtime extern, so it
must wait for a seed that carries it.

**Half 1 — stop lying (do this first).**

- Change `File._path` to `Option(Path)`; `File.open_with` stores `.Some(path)`,
  `from_fd` stores `.None`.
- `File.path()` returns `Option(Path)` — `.None` for a from_fd handle. This is
  the honest signature: there is no path, and `.` is not a substitute.
- `File.metadata()` on a `.None` handle throws `IoError.from_errno(i32(EBADF))`
  (`EBADF` needs adding to file.yo's `../libc/errno` import; `EINVAL` is already
  imported at `std/fs/file.yo:31`) rather than statting `"."`.
- Fix the `from_fd` doc comment at `std/fs/file.yo:194-197`.
- `std/fs/temp.yo:165` constructs `File` by field name and must be updated to
  wrap its path in `.Some(...)`; `tests/fs/file.test.yo:423` touches
  `opened._is_closed` only and is unaffected.

**Half 2 — make it correct (seed-gated).** Add `__yo_fstat(fd, buf)` to all four
runtimes and route `File.metadata` through the descriptor, so a from_fd handle
answers correctly instead of throwing. Linux alone could reuse the existing
extern (`statx(fd, "", AT_EMPTY_PATH, …)`), but macOS has no `AT_EMPTY_PATH` —
`src/codegen/async/runtime_io_macos.yo:1141-1149` branches `AT_FDCWD` →
`stat`/`lstat`, else `fstatat(dirfd, path, …)`, which ENOENTs on `""` — so a
dedicated extern is required for portability. The shape already exists as
`__yo_file_size` (`src/codegen/async/runtime_io_macos.yo:484-493`); copy it.
Once it lands, `copy` (`std/fs/file.yo:456-463`) should also fstat the handle it
has already opened instead of re-statting `from` by path.

Note the seed gate: a `__yo_*` symbol called from `std/fs` sits inside
`src/main.yo`'s import closure, and stage-1 is compiled by the SEED, whose
emitted runtime C would not define the new function. Half 1 has no such
constraint.

**Design decision to state explicitly.** Half 1 changes `File.path()`'s return
type. The alternative — keep `path() -> Path` and add a separate
`has_path() -> bool` — leaves `path()` returning `.` for a handle that has no
path, i.e. it keeps the lie in the type. Recommend `Option(Path)`: `File` has
exactly one constructor that lacks a path, and the option makes that visible.
The sweep is one line — `File.path()` has exactly ONE caller in the whole tree,
`tests/fs/file.test.yo:201` (`p := f.path().to_string()`); `src/` never calls it
(the `tmp_dir.path()` hits in `src/version_cache.yo:644-738` are
`TempDir.path()`, a different method).

## Regression test

`tests/fs/file.test.yo`, extending the existing "File.from_fd wraps an existing
descriptor" test (:405-431) or beside it. It must assert, RED before the fix:

- `File.from_fd(f.fd()).path()` is `.None` (today: `.Some` rendering `"."`);
- `File.from_fd(f.fd()).metadata(io)` throws (half 1) / reports
  `size() == <the file's size>` and `is_file()` (half 2) — today it reports the
  cwd;
- `w.size() == io.await(w.metadata(io), e).size()` for a from_fd handle — the
  self-consistency assertion that fails today (10 vs 20576).

Run it from a directory that is NOT the file's directory, otherwise the two
stats can coincide.

`tests/fs/metadata.test.yo` should additionally gain a `File.metadata` case on a
handle whose file was **renamed after opening**: the fd still names the data, the
path does not, so a path-based `metadata` throws ENOENT where an fd-based one
succeeds. That is the assertion that makes half 2 non-vacuous.

## Breaking change

Yes. `File.path()` changes from `Path` to `Option(Path)`, and
`File.from_fd(...).metadata()` changes from "returns the cwd's metadata" to
"throws" (half 1) or "returns the descriptor's metadata" (half 2). Both must be
called out in the release notes for the v0.2.x patch that carries them.
