# `read_dir` maps `DT_UNKNOWN` to `FileType.Other`, so a recursive walk silently returns a flat listing and `remove_dir_all` calls `remove_file` on directories

**Found**: 2026-09-04, during the std-API audit re-measurement of the fs row.
**Status**: OPEN. **Severity**: wrong-value. **Verified by code reading** — the
mechanism and the platform asymmetry are established below from the source and
from emitted C; the triggering filesystems (XFS with `ftype=0`, several FUSE and
network mounts) are not available on the machine this was found on, so no
runtime reproduction is recorded here.

## What goes wrong

`d_type` is optional in POSIX. A directory read may answer `DT_UNKNOWN` (0) for
any entry, and several real filesystems do — XFS formatted with `ftype=0`,
older reiserfs, many FUSE filesystems, and some network mounts. `std/fs`'s
`read_dir` turns that into `FileType.Other`, and two consumers then take the
wrong branch:

1. **`walk`/`walk_with` never descend into such an entry.** The descent push
   lives only in the `.Directory` arm (`std/fs/walker.yo:166-182`, `stack.push`
   at `:181`); `FileType.Other` falls to the catch-all `_ =>` arm
   (`std/fs/walker.yo:204-213`), which records the entry and moves on. A
   recursive walk of a tree on such a filesystem returns the top level only,
   with no error — it looks like an empty subtree.

2. **`remove_dir_all` calls `remove_file` on a directory.** Its dispatch is
   `.Directory => remove_dir`, `_ => remove_file` (`std/fs/walker.yo:342-350`),
   so an `Other` directory is `unlink`ed, which fails with EISDIR (EPERM on
   macOS). The failure is thrown, so it is at least loud — but it comes from a
   walk that has already silently skipped the directory's contents, so the
   thrown error is a symptom of failure 1 and points at the wrong place.

Both are data-dependent: identical code works on ext4/APFS/NTFS and fails on
the user's XFS or FUSE mount. "Works on my machine" is the exact shape.

## Root cause

The type mapping has no fallback (`std/fs/dir.yo:313-319`):

```rust
dt := IO_dir.dirent_type(entry_ptr);
ft := cond(
  (dt == DT_REG) => FileType.File,
  (dt == DT_DIR) => FileType.Directory,
  (dt == DT_LNK) => FileType.Symlink,
  true => FileType.Other
);
```

`DT_UNKNOWN` is `u8(0)` (`std/sys/constants.yo:60`) and is not imported into
`std/fs/dir.yo` at all (`:29` imports only `DT_REG`, `DT_DIR`, `DT_LNK`), so the
"I don't know" answer and the "it really is a socket/FIFO/device" answer are
indistinguishable downstream — `FileType.Other` means both.

`__yo_dirent_type` in the shared runtime is a raw passthrough
(`src/codegen/async/runtime_io_common.yo:117-119`):

```c
static uint8_t __yo_dirent_type(void* entry) {
  return ((struct dirent*)entry)->d_type;
}
```

### The platform asymmetry — which is the surprising part

The runtimes do NOT agree on whether `DT_UNKNOWN` is resolved before it reaches
Yo:

| target | `getdents` implementation | `DT_UNKNOWN` resolved? |
| --- | --- | --- |
| linux | raw `syscall(SYS_getdents64, …)`, `runtime_io_common.yo:954-976` | **no** |
| macos | `readdir` emulation, `runtime_io_common.yo:994-1085` | **yes** — `fstatat(dir_fd, entry->d_name, …, AT_SYMLINK_NOFOLLOW)` fills `d_type` at `:1037-1057` |
| wasm | `readdir` emulation, `runtime_io_wasm.yo:762-810` | **no** — the same loop, without the fallback |
| windows | `FindFirstFile` emulation, `runtime_io_windows.yo:2987+` | n/a — synthesizes `DT_DIR`/`DT_REG` from `dwFileAttributes` |

Measured from the emitted C (yo v0.2.24, `--emit-c --skip-c-compiler` on a
program that calls `fs_dir.read_dir`):

```
--target x86_64-unknown-linux-gnu : occurrences of DT_UNKNOWN in emitted C = 0
                                    (line 3642: long nread = syscall(SYS_getdents64, fd, buf, buf_size);)
--target aarch64-apple-darwin     : occurrences of DT_UNKNOWN in emitted C = 2
                                    (line 3670: if (entry->d_type == DT_UNKNOWN) { … fstatat … })
```

So the mitigation exists and is already written — it just lives in the one
runtime that needed `readdir` for unrelated reasons (macOS has no `getdents`),
and was never carried to the raw-syscall path where the answer is most likely to
be `DT_UNKNOWN` in the first place. Linux is both the platform most exposed and
the one with no fallback.

## Fix

Fix it in ONE place, on the Yo side, so no runtime can diverge again:

1. Import `DT_UNKNOWN` into `std/fs/dir.yo` (`:29`) and give `read_dir` an
   explicit arm for it, distinct from `FileType.Other`.
2. Resolve it with a stat relative to the directory being read. `read_dir`
   already holds the open dirfd (`std/fs/dir.yo:283-288`, closed at `:336`), so
   the resolution is `fstatat(dirfd, name, AT_SYMLINK_NOFOLLOW)` — O(1), no path
   re-resolution — for `DT_UNKNOWN` entries only. There is no `fstatat`-shaped
   extern today (`IO_file.statx` takes `AT_FDCWD` plus a path); adding one is
   the same seed-gated shape as the `__yo_fstat` this row's sibling issue
   (`file-from-fd-metadata-stats-the-current-directory.md`) needs, so the two
   should share a PR and a seed bump.
3. Until that extern exists, the non-gated interim is to resolve by path
   (`symlink_metadata(parent.join(name))`) for `DT_UNKNOWN` entries only. It
   costs one extra statx per unknown entry and zero on filesystems that answer
   properly, which is the overwhelmingly common case.
4. Delete the macOS-side fallback at `runtime_io_common.yo:1037-1057` once (2)
   lands, so there is exactly one implementation of this rule.

Keep `FileType.Other` meaning "genuinely not a file, directory or symlink"
(sockets, FIFOs, devices) — after this change it will, for the first time,
actually mean that.

**Also worth fixing while in there**: `remove_dir_all`'s `_ => remove_file` arm
(`std/fs/walker.yo:346-348`) is unnecessarily trusting. Even with the type
resolved, an entry can change between the walk and the delete. Falling back to
`remove_dir` when `remove_file` fails with EISDIR/EPERM (or checking the type at
delete time) makes the operation robust rather than merely correct-in-the-
common-case.

## Regression test

`tests/fs/walker.test.yo` and `tests/fs/dir.test.yo`. The honest test needs a
filesystem that reports `DT_UNKNOWN`, which CI does not have, so:

- **Unit-level**: assert that `read_dir` on a directory containing a
  subdirectory reports `.Directory` for it — already true today, but it is the
  assertion the fallback must keep true. Then add the case that fails today:
  once `DT_UNKNOWN` has its own arm, a test can force it by pointing the
  resolution helper at an entry it cannot stat and asserting the error is
  reported rather than silently becoming `Other`.
- **Integration-level**: a Linux-only CI job that formats a small loopback image
  as XFS with `-n ftype=0`, mounts it, and runs `walk` + `remove_dir_all` over a
  two-level tree on it. That is the only test that reproduces the real failure,
  and it is cheap (a `mkfs.xfs` on a 32 MB file).

Whichever is chosen, the assertion is: a recursive `walk` over a two-level tree
returns the nested entries, and `remove_dir_all` empties the tree — on a
filesystem whose `d_type` is always `DT_UNKNOWN`.

## Breaking change

No. `FileType.Other` stops being returned for entries that are really files,
directories or symlinks — which is the fix, not a contract change. Adding the
`fstatat` extern (option 2) is seed-gated; the interim path-stat (option 3) is
not.
