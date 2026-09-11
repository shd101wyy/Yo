# `TempDir`/`TempFile` creation on Windows is a TOCTOU with 26 candidate names and no retry

**Found:** 2026-09-11, during the `std/` `///` documentation sweep (code reading).
**Status:** OPEN — filed, not fixed (documentation-only PR).
**Severity:** spurious failure + a name-prediction window. Not memory-unsafe.

## What the code does

`std/fs/temp.yo` builds both temporaries out of `std/sys/temp.yo`'s `mkdtemp`
and `mkstemp`, whose module doc says only "Synchronous wrappers for
`mkdtemp`/`mkstemp`". On POSIX those are exactly that, and their whole point is
that picking the name and creating the entry is ONE uninterruptible step that
retries internally until it wins.

The Windows runtime cannot call them, and its stand-ins split the step in two
(`src/codegen/async/runtime_io_windows.yo:1590` and `:1607`):

```c
static int32_t __yo_sync_mkdtemp(char* template_str) {
  ...
  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) { ...; return -errno; }
  int result = _wmkdir(wtemplate);          // <-- separate step
  ...
}

static int32_t __yo_sync_mkstemp(char* template_str) {
  ...
  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) { ...; return -errno; }
  int fd = _wopen(wtemplate, _O_CREAT | _O_EXCL | _O_RDWR | _O_BINARY,
                  _S_IREAD | _S_IWRITE);    // <-- separate step
  ...
}
```

Two consequences, neither of them present on POSIX:

1. **A window.** `_wmktemp_s` only INVENTS a name; it does not create anything.
   Between it and the `_wmkdir`/`_wopen`, another process that can guess or
   watch the name can create that entry. The `_O_EXCL` on the file path means
   the loser gets an error rather than a hijacked file (good), but `_wmkdir` has
   no equivalent guarantee about what it opens afterwards.
2. **26 names, zero retries.** MSVC's `_mktemp_s` replaces the six trailing
   `X`s with one letter plus a five-digit per-instance value, giving at most 26
   distinct names for a given template in a process. Neither wrapper loops, and
   `std/fs/temp.yo` does not loop either, so the first collision surfaces to the
   caller as `EEXIST` — an `IoExn` out of `TempDir.new` / `TempFile.new` on a
   perfectly writable parent directory. On POSIX the same situation is invisible
   because `mkdtemp`/`mkstemp` keep trying.

A loop creating many temporaries (a test suite, a build step) is therefore
flaky on Windows and reliable everywhere else.

## Reproducer

Needs a Windows host, so this is a code reading rather than a run. The shape:

```rust
{ TempDir } :: import("std/fs/temp");
{ ArrayList } :: import("std/collections/array_list");

main :: (fn(io : Io, exn : Exception) -> unit)({
  // Hold them all so no name is released, then walk past 26.
  held := ArrayList(TempDir).new();
  (i : usize) = usize(0);
  while(i < usize(40), i = (i + usize(1)), {
    // On Windows this throws EEXIST once _wmktemp_s runs out of letters;
    // on POSIX all 40 succeed.
    held.push(io.await(TempDir.new(io), { io, exn }));
  });
});
```

## Root cause

Windows has no `mkdtemp`/`mkstemp`, and the runtime's stand-in reproduces the
NAME generation but not the retry loop or the atomicity that make the POSIX
functions safe. `std/sys/temp.yo`'s doc calls both "wrappers for
`mkdtemp`/`mkstemp`", which is true on three platforms out of four.

## Suggested fix (not applied here)

Give the Windows branch the loop POSIX has, in the runtime rather than in
`std/`, so `std/sys/temp.yo`'s contract holds on every platform:

* generate the candidate with the process id plus a counter or
  `BCryptGenRandom` bytes rather than `_wmktemp_s`, so the name space is not 26
  wide;
* retry on `EEXIST` (POSIX `mkdtemp` uses ~62^6 candidates and gives up with
  `EEXIST` only after exhausting its attempts);
* keep `_O_CREAT | _O_EXCL` for the file and use `CreateDirectoryW`'s failure
  as the directory's exclusivity check, so the create still decides the race.
