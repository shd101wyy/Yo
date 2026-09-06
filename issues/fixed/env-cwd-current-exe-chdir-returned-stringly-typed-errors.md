# `env.cwd` / `env.current_exe` / `env.chdir` returned `Result(_, String)`

**Status: FIXED** (2026-09-06, `std/env.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 15 (the `env` half; the
`http.parse_request` / `parse_response` half is PR #454).

## Symptom

```rust
cwd         :: (fn() -> Result(Path, String))
current_exe :: (fn() -> Result(Path, String))
chdir       :: (fn(path : Path) -> Result(unit, String))
```

The three functions rendered every failure as English prose —
`` `Failed to change directory to: ${path_str}` `` — so the real reason was
destroyed at the point it was known. A caller could not tell "the directory
does not exist" from "permission denied" without matching on message text,
and the messages were not stable API.

The damage shows in the compiler itself: **all 28 call sites in `src/`
discard the payload**, every one of them falling back to `"."`:

```rust
base := match(cwd(), .Ok(cb) => cb.to_string(), .Err(_) => String.from("."))
```

Only `src/doc_command.yo` looked at the value, and only to splice it into
another string.

## Fix

The three now return `Result(_, IoError)`, matching Rust
(`env::current_dir`, `env::current_exe`, `env::set_current_dir` all return
`io::Result`). Rust does not *throw* here and neither do we — the plan's
"should throw `IoExn`" note was written before the call-site survey, and
throwing would have forced 28 sites to install a handler purely to rebuild a
`"."` fallback.

Error values now carry the real OS reason:

| path | source |
| --- | --- |
| POSIX `getcwd` / `chdir` / `readlink` / `realpath` | `IoError.from_errno(errno)` |
| Win32 `GetCurrentDirectoryW` / `SetCurrentDirectoryA` / `GetModuleFileNameW` / `WideCharToMultiByte` | `IoError.Other(GetLastError())` |
| wasm (no way to find the executable) | `IoError.NotSupported` |

**`errno` is read BEFORE the error path's `free()`.** Every failing arm had
a `free()` between the syscall and the error construction, and the allocator
is free to clobber `errno`; each such arm now captures the code first.

Two latent defects had to be fixed to make this possible — see
`issues/fixed/libc-errno-was-declared-as-a-pointer-and-was-unusable.md` and
`issues/fixed/ioerror-other-discarded-its-os-error-code.md`.

## Breaking change

Callers that matched `.Err(msg)` and used `msg` as a `String` must now call
`msg.to_string()`. Callers that ignore the payload (`.Err(_)`) are
unaffected — which is every call site in `src/` bar one.

## Regression tests

`tests/env.test.yo`:

- `chdir fails for non-existent directory` now asserts the error **is**
  `IoError.NotFound`, not merely that some error came back.
- `chdir reports the REAL errno, not a single catch-all error` — chdir into
  the running test binary (a regular file) must be `IoError.NotADirectory`
  on POSIX, `IoError.Other` on Windows. Two different failures mapping to two
  different variants is what proves `errno` is genuinely read, and read
  before the `free()` that would clobber it.

The Windows arms cannot run on the macOS/Linux legs; they were gated by
cross-emitting with `--target x86_64-pc-windows-msvc` and compiling the C
with `zig cc` for both `x86_64-windows-gnu` and `aarch64-windows-gnu`.
