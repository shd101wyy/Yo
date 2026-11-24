# std's per-platform constants read FreeBSD as Linux

**Severity:** S3: on a FreeBSD target, std's `cond`-per-platform constants that have a macOS arm and no FreeBSD arm take Linux's value, which differs on FreeBSD for at least `CLOCK_MONOTONIC`, four signal numbers, `AF_INET6`, the `SOL_SOCKET`/`SO_*` family and the `utsname` layout; latent while the FreeBSD target emits no I/O backend.

Found 2026-11-24 while fixing `issues/fixed/2026-11-24-std-sys-mmap-gives-freebsd-the-linux-map-anonymous-and-ms-sync.md`
(the same pattern in `std/sys/mmap.yo`); on develop `34359627e`.

## What is wrong

std writes a platform constant as `cond((platform == Platform.Macos) => <macOS>, true => <Linux>)`, sometimes
with a Windows arm. `Platform.FreeBSD` exists (`std/process/index.yo`) and `x86_64-unknown-freebsd` /
`aarch64-unknown-freebsd` are supported triples (`src/target.yo`), so a FreeBSD build gets the Linux value.
FreeBSD's ABI follows BSD/macOS numbering for most of these. Values checked against FreeBSD 14's headers (zig
0.16's `lib/libc/include/generic-freebsd/`):

| Constant (file) | std on FreeBSD (the Linux value) | FreeBSD header |
| --- | --- | --- |
| `CLOCK_MONOTONIC` (`std/sys/clock.yo`) | 1 | 4 (`sys/_clock_id.h`) |
| `SIGCHLD`, `SIGCONT`, `SIGSTOP`, `SIGTSTP` (`std/sys/signals.yo`) | 17, 18, 19, 20 | 20, 19, 17, 18 (`sys/signal.h`) |
| `AF_INET6` (`std/sys/socket.yo`) | 10 | 28 (`sys/socket.h`) |
| `SOL_SOCKET`, `SO_REUSEADDR` (`std/sys/socket.yo`) | 1, 2 | `0xffff`, `0x4` (`sys/socket.h`) |
| `UTSNAME_FIELD_SIZE` (`std/sys/sysinfo.yo`) | 65 | 256 (`SYS_NMLN`, `sys/utsname.h`) |

The other `SO_*`, `TCP_KEEP*`, `NI_*`, `MSG_NOSIGNAL` / `SO_NOSIGPIPE` arms of `std/sys/socket.yo` and the
signal arms of `std/signal.yo` have the same shape and need the same check; `grep -rn "platform ==
Platform.Macos" std | grep -v FreeBSD` lists the sites.

## Why it is latent

`src/codegen/async/runtime.yo` emits a platform I/O backend for Linux, macOS, Windows and wasm only, so a
FreeBSD build of a program that reaches the `std/sys` runtime functions does not link
(`docs/en-US/STD_SYS_MODULE.md` lists FreeBSD's kqueue backend as planned). The values matter the day that
backend lands, and they fail quietly then (`EINVAL`, a wrong signal, a wrong clock).

## Fix

When the FreeBSD backend is built: give each such constant a `Platform.FreeBSD` arm read from FreeBSD's headers,
or bind the constant through `c_include` of the platform header so no value is mirrored in Yo, and a
per-target test like `tests/sys/mmap.test.yo`'s "the mapping flags are the target's <sys/mman.h> values".
