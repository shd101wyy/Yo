# `std/libc/errno.yo` declared `errno : *int` — reading it was a C type error

**Status: FIXED** (2026-09-06, `std/libc/errno.yo`). Surfaced while giving
`std/env` structured errors (`issues/fixed/env-cwd-current-exe-chdir-returned-stringly-typed-errors.md`).

## Symptom

```rust
c_include(
  "<errno.h>",
  errno : *int,     // WRONG
  ...
)
```

C's `errno` is not a pointer. It is an lvalue of type `int` — in practice a
macro expanding to `(*__errno_location())` (glibc) or `(*__error())`
(macOS). Declaring it `*int` means the only way to read it, a dereference,
emits a dereference of an `int`:

```rust
e := unsafe(errno.*);
```

```
error: indirection requires pointer operand ('int' invalid)
 1564 |   int _file____priv_temp_8627 = (*errno);
      |                                  ^~~~~~
```

The binding had been exported since the file was written and **no code in
the tree ever read it**, so nothing caught it. Every std module that needed
an errno got one from somewhere else — the `IO_*` sync wrappers return a
negative errno, which is why `IoError.from_errno(i32(0) - result)` is the
common spelling.

## Fix

```rust
  errno : int,
```

`unsafe(errno)` now reads the current thread's errno. Verified against a
`chdir` to a missing path:

```
rc=-1 errno=2 ENOENT=2
```

The value is a C `int`, so callers converting to `IoError` write
`IoError.from_errno(i32(unsafe(errno)))`.

## Regression test

Covered indirectly but sharply by `tests/env.test.yo`'s
"chdir reports the REAL errno" test: it requires two *different* failures to
map to two *different* `IoError` variants, which is only possible if `errno`
is really being read.
