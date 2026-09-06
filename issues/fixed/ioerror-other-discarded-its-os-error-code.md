# `IoError.Other(code)`'s `to_string` threw the code away

**Status: FIXED** (2026-09-06, `std/sys/errors.yo`). Surfaced while giving
`std/env` structured errors.

## Symptom

`IoError.Other` exists precisely to carry an OS error code that the variant
list does not name:

```rust
  /// Other error with raw errno code.
  Other(code : i32)
```

but its rendering dropped it on the floor:

```rust
  .Other(errno) => String.from("unknown I/O error")
```

So an unmapped failure printed `unknown I/O error` with no way to find out
*which* failure — the one variant whose whole purpose is the code was the
one variant that hid it. Three test files already carry comments noting how
unhelpful this message is when it shows up
(`tests/net/unix.test.yo`, `tests/process/command.test.yo`), and
`src/codegen/async/runtime_io_windows.yo` has one too.

## Fix

```rust
  .Other(code) => `unknown I/O error (os error ${code})`.to_string()
```

matching Rust, which prints `... (os error 2)` for a raw
`io::Error::from_raw_os_error`.

The variant's doc comment now also states what the code *is*, which was
never written down: `errno` on POSIX, `GetLastError()` on Windows — the same
split as Rust's `io::Error::raw_os_error`.
