# std/io Module Implementation Plan

## Overview

The `std/io` module provides Yo's low-level async I/O foundation. It sits between the raw C runtime (`src/codegen/async/runtime.ts`) and the high-level APIs (`std/fs`, `std/net`). This plan covers completing the module from its current state (constants, errors, externs, timer, statx) to a fully functional cross-platform async I/O layer.

## Current Status

### What's Done

| Component            | File                                       | Status      | Notes                                                      |
| -------------------- | ------------------------------------------ | ----------- | ---------------------------------------------------------- |
| **Constants**        | `std/io/constants.yo`                      | ✅ Complete | File mode, permissions, AT*\*, DT*\*, open flags           |
| **Socket Constants** | `std/io/socket.yo`                         | ✅ Complete | Platform-aware AF*\*, SOCK*\_, SO\_\_, TCP\_\*             |
| **Signals**          | `std/io/signals.yo`                        | ✅ Complete | Platform-aware POSIX signal numbers                        |
| **Events**           | `std/io/events.yo`                         | ✅ Complete | TTY, poll, FS event constants                              |
| **IOError**          | `std/io/errors.yo`                         | ✅ Complete | Enum with errno mapping, ToString impl                     |
| **IOFuture**         | `std/io/future.yo`                         | ✅ Complete | Extern type wrapping `yo_io_future_t`                      |
| **Externs**          | `std/io/externs.yo`                        | ✅ Complete | All C extern function declarations                         |
| **Statx**            | `std/io/statx.yo`                          | ✅ Complete | File metadata accessor object                              |
| **Timer**            | `std/io/timer.yo`                          | ✅ Complete | `sleep(ms)`                                                |
| **File**             | `std/io/file.yo`                           | ✅ Complete | Async+sync file ops (openat, read, write, etc.)            |
| **Dir**              | `std/io/dir.yo`                            | ✅ Complete | mkdir, unlink, rename, symlink, link, readlink             |
| **Readdir**          | `std/io/readdir.yo` (merged into `dir.yo`) | ✅ Complete | getdents, dirent accessors (size, reclen, type, name, ino) |
| **TCP**              | `std/io/tcp.yo`                            | ✅ Complete | Socket, bind, listen, accept, connect, send, recv, close   |
| **UDP**              | `std/io/udp.yo`                            | ✅ Complete | Socket, bind, sendto, recvfrom, send, recv, close          |
| **DNS**              | `std/io/dns.yo`                            | ✅ Complete | getaddrinfo, getnameinfo, addrinfo accessors               |
| **Perm**             | `std/io/perm.yo`                           | ✅ Complete | fchmod, chmodat, fchown, chownat, access                   |
| **Time**             | `std/io/time.yo`                           | ✅ Complete | utime, futime, lutime (file timestamp operations)          |

### C Runtime Status (in `src/codegen/async/runtime*.ts`)

The runtime has been refactored into 4 modules:

- `runtime.ts` — Thin coordinator that calls the others
- `runtime-core.ts` — Core scheduler (continuation queue, spawn, wait, concurrency helpers)
- `runtime-io-linux.ts` — Linux io_uring async I/O
- `runtime-io-macos.ts` — macOS GCD async I/O
- `runtime-io-windows.ts` — Windows IOCP async I/O
- `runtime-io-common.ts` — Cross-platform stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll

| Category                   | Linux (io_uring)      | macOS (dispatch_io)  | Windows (IOCP)                           |
| -------------------------- | --------------------- | -------------------- | ---------------------------------------- |
| **Event loop integration** | ✅                    | ✅                   | ✅ (IOCP)                                |
| **File read/write**        | ✅                    | ✅                   | ✅ (IOCP)                                |
| **File open/close**        | ✅                    | ✅                   | ✅ (sync wrappers)                       |
| **Stat**                   | ✅ (statx)            | ✅ (struct stat)     | ✅ (\_stat64)                            |
| **mkdir/unlink/rename**    | ✅                    | ✅ (sync wrappers)   | ✅ (sync wrappers)                       |
| **symlink/link**           | ✅                    | ✅ (sync wrappers)   | ✅ (CreateSymbolicLinkW/CreateHardLinkW) |
| **fsync/fdatasync**        | ✅                    | ✅ (sync wrappers)   | ✅ (\_commit)                            |
| **ftruncate**              | ✅                    | ✅ (sync wrapper)    | ✅ (\_chsize_s)                          |
| **chmod/chown**            | ✅                    | ✅                   | ⚠️ (chmod only)                          |
| **readlink**               | ✅                    | ✅                   | ✅ (GetFinalPathNameByHandleW)           |
| **dup/dup2/pipe**          | ✅                    | ✅                   | ✅                                       |
| **Socket ops**             | ✅                    | ✅ (dispatch_source) | ✅ (IOCP WSASend/WSARecv)                |
| **Timer (sleep)**          | ✅ (timerfd+io_uring) | ✅ (dispatch_after)  | ✅ (IOCP wait timeout)                   |
| **getdents/readdir**       | ✅ (getdents64)       | ✅ (getdirentries)   | ✅ (getdents only)                       |
| **access/realpath**        | ✅ (sync)             | ✅ (sync)            | ✅ (sync)                                |
| **utime**                  | ✅ (sync)             | ✅ (sync)            | ✅ (sync)                                |
| **mkdtemp/mkstemp**        | ✅ (sync)             | ✅ (sync)            | ✅ (sync)                                |
| **copyfile/sendfile**      | ✅ (sync)             | ✅ (sync)            | ⚠️ (copyfile only)                       |
| **statfs**                 | ✅ (sync)             | ✅ (sync)            | ✅ (GetDiskFreeSpaceEx)                  |
| **DNS**                    | ✅ (sync)             | ✅ (sync)            | ✅ (sync)                                |
| **Signals**                | ✅ (sync)             | ✅ (sync)            | ❌                                       |
| **TTY**                    | ✅ (sync)             | ✅ (sync)            | ⚠️ (isatty only)                         |
| **Unix sockets**           | ✅ (sockaddr_un)      | ✅ (sockaddr_un)     | ⚠️ (AF_UNIX Win10 1803+)                 |
| **Process spawn**          | ❌                    | ❌                   | ❌                                       |
| **fcntl**                  | ❌                    | ❌                   | ❌ (different model)                     |
| **mmap**                   | ❌                    | ❌                   | ❌ (CreateFileMapping)                   |
| **flock**                  | ❌                    | ❌                   | ❌ (LockFileEx)                          |
| **FS Events**              | ❌                    | ❌                   | ❌                                       |
| **Poll**                   | ❌                    | ❌                   | ❌                                       |

### Known Issues Fixed

- ✅ **errno naming conflict**: Enum variant destructuring (`.Other(errno)`) now properly sanitizes variable names in C codegen to avoid conflicts with C's `errno` macro.
- ✅ **Timer resource leak (Linux)**: timerfd and read buffer are now properly tracked and cleaned up via `dispose_fn` on an extended future struct.
- ✅ **Bitwise OR on c_include constants**: `c_include` constants (O_WRONLY, O_CREAT, etc.) had `UnknownValue` causing `ComptimeBitOr` to be selected. Fixed in `identifer-and-operator.ts` to treat extern "c" unknowns as runtime values.
- ✅ **Barrel re-export removed**: `std/io/index.yo` removed to avoid naming conflicts. Users now import submodules directly: `import "std/io/file"`, `import "std/io/timer"`, etc.
- ✅ **Runtime refactored**: 4012-line `runtime.ts` split into 4 focused modules for maintainability.
- ✅ **SSA variable mutation in async loops**: Variable reassignment inside loops in async state machines created new SSA variable IDs (e.g., `offset` → `offset_1`) but the loop condition always read the original, causing infinite loops. Fixed by adding `variableIdRemapping` to the await analysis that maps all SSA-renamed IDs back to the first version's captured variable. Also fixed `break` inside async while loop resume code breaking the C `switch` instead of the loop.
- ✅ **macOS async continuation threading**: GCD callbacks run on background threads, but the async task queue is thread-local. Added a cross-thread continuation queue in the macOS runtime and drain it on the event-loop thread during polling to ensure `sleep` and dispatch_io completions resume correctly.
- ✅ **macOS getdents linker fix**: Replaced the unavailable `getdirentries` call with a `readdir`-based emulation using `dup(fd)` + `fdopendir` to avoid 64-bit inode stub symbols on arm64.
- ✅ **Windows test runner missing ws2_32**: The test runner (`src/test-runner.ts`) did not link `-lws2_32` on Windows, causing all Windows async I/O tests to fail with linker errors. Fixed by adding ws2_32 linking in the test runner compile step.
- ✅ **Windows AT_FDCWD not defined**: The Windows IOCP runtime used `AT_FDCWD` without defining it. Fixed by adding `#ifndef AT_FDCWD / #define AT_FDCWD -100 / #endif`.
- ✅ **Windows IOCP double handle association**: `openat` associated the file handle with IOCP, then `read`/`write` tried to associate the same handle again. The second `CreateIoCompletionPort` call fails with `ERROR_INVALID_PARAMETER` (87), causing reads to return -87. Fixed by making `__yo_win_associate_handle` tolerate already-associated handles (returns true on `ERROR_INVALID_PARAMETER`) and making read/write call it best-effort instead of failing.
- ✅ **Windows winsock.h/winsock2.h header conflict**: When `.yo` files import `std/process` (which uses `c_include "<windows.h>"` via `std/libc/windows.yo`), the bare `#include <windows.h>` pulls in `winsock.h` before the IOCP runtime's `winsock2.h`, causing redefinition errors. Fixed by emitting `WIN32_LEAN_AND_MEAN` and `_WINSOCKAPI_` defines at the top of every generated C file on Windows (in `c/collection.ts`), and adding the same guards to `runtime-io-common.ts`.
- ✅ **Windows file test path**: `file.test.yo` hardcoded `/tmp/` which doesn't exist on Windows. Fixed by using cross-platform `temp_dir()` + `path_join()` (same pattern as `dir.test.yo`).
- ✅ **Comptime constant C macro name collision**: When compile-time-only constants (e.g., `AF_INET :: i32(2)`) were passed directly as function call arguments, the C codegen created local variables with the original names (`int32_t AF_INET = 2;`), which conflicted with C preprocessor macros from system headers. Fixed in `src/codegen/exprs/other-fn-call.ts` by detecting `isCompileTimeOnly` variables and skipping temp variable creation — the inlined literal is used directly as the call argument.
- ✅ **Pointer-to-nullable-pointer codegen bug**: `*(?*(T))` (pointer to nullable-pointer-optimized enum) generated `uint8_t*` in C instead of `uint8_t**`. The nullable pointer optimization makes `?*(T)` a bare pointer in C, so a pointer TO that needs an extra `*`. Fixed in `src/codegen/utils/index.ts` `getTypeString()` PtrType case to return `${baseTypeStr}*` instead of `baseTypeStr` for nullable-pointer-optimized enum children.
- ✅ **Async state machine dangling reassignment temps**: In async state machine codegen, reassignment expressions (e.g., `count = (count + 1)`) inside begin blocks emitted undeclared temp variable references as bare statements. The `skipTempVar` path in `generateAssignment` skipped declaring the temp (correct for state machines where variables are in `sm->var_xxx`) but still returned the temp name. Fixed in `src/codegen/exprs/assignment.ts` to return `""` when `skippedTempVar` is true.
- ✅ **macOS socket ops were synchronous (blocking event loop)**: `accept`, `connect`, `send`, `recv`, `sendto`, `recvfrom` on macOS used blocking POSIX calls wrapped in immediately-completed futures. Fixed by setting `O_NONBLOCK` on socket creation and using GCD `dispatch_source` for true async: `DISPATCH_SOURCE_TYPE_READ` for accept/recv/recvfrom, `DISPATCH_SOURCE_TYPE_WRITE` for connect/send/sendto. Each operation first attempts a non-blocking call, and only creates a dispatch_source if `EAGAIN`/`EWOULDBLOCK`/`EINPROGRESS` occurs. Connect uses `SO_ERROR` check after writable event. Accepted sockets also get `O_NONBLOCK` set automatically.
- ✅ **macOS getnameinfo NI_NUMERICHOST wrong value**: The `dns.test.yo` test hardcoded `i32(1)` for `NI_NUMERICHOST` (Linux value). On macOS, `NI_NUMERICHOST = 2` (and `1` is `NI_NOFQDN`). Added platform-aware `NI_*` constants (`NI_NUMERICHOST`, `NI_NUMERICSERV`, `NI_NOFQDN`, `NI_NAMEREQD`, `NI_DGRAM`) to `std/io/socket.yo` and updated the test.
- ✅ **Compile-time constants not inlined in async state machines**: Compile-time-only constants (e.g., `STATX_BASIC_STATS`, `AT_FDCWD`) were emitted as raw C identifiers inside async state machine resume functions instead of being inlined to their literal values. Two bugs: (1) In `src/codegen/exprs/atom.ts`, the state machine variable lookup fallback returned the raw variable name without checking `isCompileTimeOnly`. (2) In `src/codegen/exprs/other-fn-call.ts`, inlined literal values (e.g., `"-2"` for `AT_FDCWD`) were passed through `sanitizeForCIdentifier()`, mangling them (e.g., `-2` → `_u45_2`). Fixed by adding comptime-only check before the state machine fallback, and bypassing sanitization for comptime-only args.
- ✅ **Windows socket close used `_close()` instead of `closesocket()`**: On Windows, `__yo_async_close_start` used CRT `_close(fd)` which fails for Winsock `SOCKET` handles (they are not CRT file descriptors). Fixed by trying `closesocket()` first, falling back to `_close()` only if `WSAENOTSOCK`.
- ✅ **Windows socket constants used Linux values**: `SOL_SOCKET`, `SO_REUSEADDR`, `SO_KEEPALIVE`, `SO_BROADCAST`, etc. in `std/io/socket.yo` only had Darwin-specific branches — the `true` default gave Linux values. Windows uses BSD-style values (same as macOS for most). Added `Platform.Win32` to all platform-aware socket constant conditions. Also added Windows-specific `AF_INET6 = 23` and `TCP_KEEP*` values.
- ✅ **Windows double `htonl` in `__yo_sockaddr_in_set_addr`**: The Windows runtime called `htonl(ip)` inside `set_addr`, but Yo code already called `__yo_htonl()` before passing the value, causing double byte-swap (binding to `1.0.0.127` instead of `127.0.0.1`). Fixed to match Linux/macOS: direct assignment (`= ip`).
- ✅ **Windows TCP send/recv now truly async**: `__yo_async_send_start` and `__yo_async_recv_start` now use `WSASend`/`WSARecv` with OVERLAPPED I/O through the IOCP event loop instead of blocking `send()`/`recv()` calls. Sockets are associated with IOCP at creation (`__yo_async_socket_start`) and accept (`__yo_async_accept_start`) time.
- ✅ **Windows DNS `WSANOTINITIALISED` (10093)**: `__yo_async_getaddrinfo_start` and `__yo_async_getnameinfo_start` did not call `__yo_io_init()`, so `WSAStartup` was never called if DNS was the first Winsock operation. Fixed by adding `__yo_io_init()` at the start of both functions.
- ✅ **Windows `_waccess` does not support `X_OK`**: Windows CRT `_waccess()` only supports F_OK(0), R_OK(4), W_OK(2). Passing X_OK(1) caused `EINVAL`. Since Windows has no executable permission bit, fixed by stripping X_OK from the mode before calling `_waccess`.
- ✅ **Windows `fchown(-1,-1)` returned `-ENOSYS`**: The test expects `fchown(fd, -1, -1)` (no change) to succeed. Windows has no Unix UID/GID, so `fchown` was stubbed returning `-ENOSYS`. Fixed to return 0 when both uid and gid are `(uint32_t)-1` (no-change sentinel).
- ✅ **Windows `futime` failed on read-only fd**: `__yo_async_futime_start` used `_get_osfhandle(fd)` directly, but `SetFileTime` requires `FILE_WRITE_ATTRIBUTES` access which a read-only fd doesn't have. Fixed by getting the file path via `GetFinalPathNameByHandleW` and reopening with `FILE_WRITE_ATTRIBUTES`.
- ✅ **Windows statx nanosecond timestamps always 0**: `_wstat64` only provides second-precision timestamps. Introduced `yo_win_stat_t` struct extending `_stat64` with nsec fields, populated via `GetFileAttributesExW` which returns FILETIME (100ns precision). Also added birth time (`btime_sec`/`btime_nsec`) from creation time.
- ✅ **Windows Win32 error codes not mapped to POSIX errno**: `__yo_win_last_error_to_errno` returned raw Win32 error codes (e.g., `ERROR_PATH_NOT_FOUND`=3) instead of POSIX errno (e.g., `ENOENT`=2). Added proper mapping for common Win32 errors: `ERROR_FILE_NOT_FOUND`/`ERROR_PATH_NOT_FOUND` → `ENOENT`, `ERROR_ACCESS_DENIED` → `EACCES`, `ERROR_FILE_EXISTS` → `EEXIST`, etc.

### Known Windows Limitations

- **Symlinks require elevated privileges**: `CreateSymbolicLinkW` requires admin privileges or Developer Mode on Windows. The `lutime` symlink test is expected to fail without elevation.
- **NTFS nanosecond precision is 100ns**: FILETIME stores time in 100-nanosecond intervals. Nanosecond values not divisible by 100 are truncated (e.g., 123456789ns → 123456700ns). The `utime with nanosecond precision` test expects exact ns values that exceed NTFS precision.
- **UDP sendto/recvfrom are synchronous**: Unlike TCP send/recv (which use WSASend/WSARecv via IOCP), UDP sendto/recvfrom use blocking Winsock calls. Acceptable for UDP datagrams which complete instantly, but noted as a potential future improvement.

---

## Phase 1: High-Level File I/O Wrappers (Priority: High)

**Goal**: Provide ergonomic async file operations that wrap the low-level externs.

### 1.1 Create `std/io/file.yo` — Async File Operations ✅

Wraps the extern functions into safe async functions. Implemented with both async operations (openat, close, read, write, statx, fsync, fdatasync, ftruncate) and sync helpers (open_sync, close_sync, file_size). Tests in `tests/io/file.test.yo`.

Original plan:

```yo
// std/io/file.yo

// Open a file and return its fd (or IOError)
open :: (fn(dirfd: i32, path: *(u8), flags: i32, mode: i32) -> IOFuture)(...);

// Read from fd into buffer, returns bytes read or IOError
read :: (fn(fd: i32, buffer: *(u8), size: u32, offset: u64) -> IOFuture)(...);

// Write buffer to fd, returns bytes written or IOError
write :: (fn(fd: i32, buffer: *(u8), size: u32, offset: u64) -> IOFuture)(...);

// Close a file descriptor
close :: (fn(fd: i32) -> IOFuture)(...);

// Get file status
stat :: (fn(dirfd: i32, path: *(u8), flags: i32, mask: u32, statxbuf: *(u8)) -> IOFuture)(...);

// Sync file data to disk
fsync :: (fn(fd: i32) -> IOFuture)(...);

// Truncate file to given length
truncate :: (fn(fd: i32, length: i64) -> IOFuture)(...);
```

### 1.2 Create `std/io/dir.yo` — Async Directory Operations ✅

Wraps extern directory functions into async operations. All functions take `AT_FDCWD` for relative paths. Uses `AT_REMOVEDIR` flag with `unlink` for removing directories. Tests in `tests/io/dir.test.yo`.

**Import pattern**: Use namespace import (`dir :: import "std/io/dir"`) to avoid naming conflicts with libc's `rename` brought in by `open import "std/libc/stdio"`.

Implemented functions: `mkdir`, `unlink`, `rename`, `symlink`, `link`, `readlink`.

Tests in `tests/io/dir.test.yo` (8 tests):

- `async mkdir and rmdir` — create/remove directory
- `mkdir existing returns -EEXIST` — duplicate mkdir error
- `async rename` — rename file, verify old gone/new readable
- `async symlink and readlink` — symlink creation and target readback
- `async hard link` — hard link, read data through link
- `async unlink file` — create file, unlink, verify gone
- `unlink nonexistent returns -ENOENT` — error on missing file
- `async getdents lists directory entries` — getdents with dirent iteration, counts files/dirs/entries

### 1.3 Create `std/io/readdir.yo` — Directory Listing ✅

Wraps the `__yo_async_getdents_start` and dirent accessor externs. The C runtime uses `getdents64` syscall on Linux and `getdirentries` on macOS. Dirent accessors (`dirent_size`, `dirent_reclen`, `dirent_type`, `dirent_name`, `dirent_ino`) use the platform's `struct dirent` layout.

Implemented functions: `getdents`, `dirent_size`, `dirent_reclen`, `dirent_type`, `dirent_name`, `dirent_ino`.

Required compiler fixes:

- Added `#include <sys/syscall.h>` for `SYS_getdents64` in `runtime-io-common.ts`
- Added `O_DIRECTORY` to `std/io/constants.yo` exports
- Fixed SSA variable mutation bug in async loops (see Known Issues Fixed)
- Fixed `break` in async while loop resume code

**Windows**: Not yet implemented. Will use `FindFirstFileW`/`FindNextFileW` in completed future pattern.

---

## Phase 2: Socket I/O Wrappers (Priority: High)

**Goal**: Provide typed socket operations for TCP/UDP/Unix sockets.

### 2.1 Create `std/io/tcp.yo` — TCP Socket Operations ✅

Wraps the extern socket functions into async TCP operations. Provides both raw socket operations (socket, bind, listen, accept, connect, send, recv, shutdown, close) and helper functions for socket address creation. Tests in `tests/io/tcp.test.yo`.

**Implementation highlights:**

- `socket(domain, type, protocol)` — Create TCP socket (uses `AF_INET`/`AF_INET6` and `SOCK_STREAM`)
- `bind(fd, addr_buf, addr_len)` — Bind socket to address
- `listen(fd, backlog)` — Listen for incoming connections
- `accept(fd, peer_addr_buf, peer_addr_len)` — Accept client connection
- `connect(fd, addr_buf, addr_len)` — Connect to remote server
- `send(fd, buf, len, flags)` — Send data
- `recv(fd, buf, len, flags)` — Receive data
- `shutdown(fd, how)` — Shutdown socket (SHUT_RD/SHUT_WR/SHUT_RDWR)
- `close(fd)` — Close socket descriptor
- `setsockopt(fd, level, optname, optval, optlen)` — Set socket option (e.g. SO_REUSEADDR)
- `getsockopt(fd, level, optname, optval, optlen_ptr)` — Get socket option

**Socket address helpers:**

- `SockAddr` struct with `buf: *(u8)` and `len: u32`
- `make_sockaddr_in(ip, port)` — Create IPv4 address from IP string
- `make_sockaddr_in6(ip, port)` — Create IPv6 address from IP string
- `make_sockaddr_in_any(port)` — Create INADDR_ANY (0.0.0.0) address
- `make_sockaddr_in_loopback(port)` — Create loopback (127.0.0.1) address
- `free_sockaddr(addr)` — Free socket address buffer
- `get_port_in(addr_buf)` — Extract port from IPv4 address
- `get_addr_in(addr_buf)` — Extract IPv4 address as u32
- `get_family(addr_buf)` — Get address family (AF_INET/AF_INET6)
- `htons/ntohs/htonl/ntohl` — Byte order conversion

**Known issue fixed:**

- C macro name conflict: `AF_INET` and `AF_INET6` are C macros from `<sys/socket.h>`. When compile-time constants with those names (e.g., `AF_INET :: i32(2)`) were passed directly as function call arguments, the C codegen created local variables with the original names (e.g., `int32_t AF_INET = 2;`), causing preprocessor conflicts. Fixed in `src/codegen/exprs/other-fn-call.ts` by detecting `isCompileTimeOnly` variables and skipping temp variable creation — the inlined literal value (e.g., `2`) is used directly as the call argument instead.

**Tests (6 tests, all passing on Linux and macOS):**

1. `TCP socket creation and close` — Basic socket lifecycle
2. `Set SO_REUSEADDR socket option` — setsockopt test
3. `Bind to loopback and listen` — Server setup test
4. `TCP echo server-client` — Full connection: bind, listen, connect, accept, send, recv, shutdown, close
5. `SockAddr helper functions` — sockaddr creation and accessors

**macOS async implementation:**

All blocking socket operations use GCD `dispatch_source` for true async on macOS:

- `socket()` sets `O_NONBLOCK` via `fcntl` after creation
- `accept()` uses `DISPATCH_SOURCE_TYPE_READ` on the listening socket
- `connect()` uses `DISPATCH_SOURCE_TYPE_WRITE` with `SO_ERROR` check after `EINPROGRESS`
- `send()` uses `DISPATCH_SOURCE_TYPE_WRITE` on `EAGAIN`/`EWOULDBLOCK`
- `recv()` uses `DISPATCH_SOURCE_TYPE_READ` on `EAGAIN`/`EWOULDBLOCK`
- Instant operations (`socket`, `bind`, `listen`, `shutdown`, `setsockopt`, `getsockopt`, `close`) use sync wrappers (correct — these are fast kernel calls)

### 2.2 Create `std/io/udp.yo` — UDP Socket Operations ✅

Wraps the extern socket functions into async UDP operations. Reuses `SockAddr` and address helpers from `tcp.yo`. Tests in `tests/io/udp.test.yo`.

**Implementation highlights:**

- `socket(domain, protocol)` — Create UDP socket (hardcodes `SOCK_DGRAM` internally)
- `bind(fd, addr_buf, addr_len)` — Bind socket to local address
- `sendto(fd, buf, len, flags, dest_addr, addrlen)` — Send datagram to specific address
- `recvfrom(fd, buf, len, flags, src_addr, addrlen_ptr)` — Receive datagram with sender address
- `send(fd, buf, len, flags)` — Send on connected UDP socket
- `recv(fd, buf, len, flags)` — Receive on connected UDP socket
- `close(fd)` — Close socket descriptor
- `setsockopt(fd, level, optname, optval, optlen)` — Set socket option
- `getsockopt(fd, level, optname, optval, optlen_ptr)` — Get socket option

**Design notes:**

- `socket()` takes `(domain, protocol)` and hardcodes `SOCK_DGRAM` — users don't need to specify socket type
- Address helpers (`make_sockaddr_in_loopback`, `free_sockaddr`, `get_family`, etc.) are reused from `tcp.yo`
- Must bind UDP sockets before first `sendto` if you need to receive replies on a known port (kernel auto-bind on unbound `sendto` prevents later explicit bind)

**Tests (6 tests, all passing on Linux and macOS):**

1. `UDP socket creation and close` — Basic socket lifecycle
2. `UDP socket bind to loopback` — Bind to specific port
3. `UDP setsockopt SO_REUSEADDR` — Socket option test
4. `UDP sendto and recvfrom` — Send datagram, receive with byte verification and source address check
5. `UDP bidirectional ping-pong` — Server and client exchange datagrams using `recvfrom` sender address for reply
6. `UDP sockaddr helpers from tcp module` — Verify tcp address helpers work for UDP

**macOS async implementation:**

- `sendto()` uses `DISPATCH_SOURCE_TYPE_WRITE` on `EAGAIN`/`EWOULDBLOCK`
- `recvfrom()` uses `DISPATCH_SOURCE_TYPE_READ` on `EAGAIN`/`EWOULDBLOCK`
- UDP sockets are also set to `O_NONBLOCK` at creation time

---

## Phase 3: DNS and Network Utilities (Priority: Medium)

### 3.1 Create `std/io/dns.yo` — DNS Resolution ✅

Wraps `getaddrinfo`/`getnameinfo` externs into async DNS operations, plus accessors for iterating the linked list of `addrinfo` results. Tests in `tests/io/dns.test.yo`.

**Implementation highlights:**

- `getaddrinfo(node, service, hints, result)` — Resolve hostname (async, returns `IOFuture`)
- `getnameinfo(addr, addrlen, host, hostlen, service, servlen, flags)` — Reverse lookup (async)
- `freeaddrinfo(ai)` — Free the result linked list
- Addrinfo accessors: `addrinfo_family`, `addrinfo_socktype`, `addrinfo_protocol`, `addrinfo_addrlen`, `addrinfo_addr`, `addrinfo_canonname`, `addrinfo_next`
- `alloc_result() -> *(?*(u8))` / `get_result(ptr) -> ?*(u8)` / `free_result(ptr)` — Result pointer helpers
- `alloc_hints() -> *(u8)` / `free_hints(ptr)` — Hints allocation helpers
- `addrinfo_size() -> usize` — Get `struct addrinfo` size

**Design notes:**

- Uses `?*(u8)` (nullable pointer optimization) for optional params: `service`, `hints`, addrinfo `next`/`canonname`
- Uses `*(?*(u8))` (pointer to nullable pointer) for the result output parameter
- Error codes returned as-is from `getaddrinfo()` (already negative on glibc, positive on macOS)
- Addrinfo results form a linked list navigated via `addrinfo_next(ai) -> ?*(u8)` with `match`

**Tests (6 tests, all passing on Linux and macOS):**

1. `DNS resolve localhost` — Resolve "localhost", walk linked list, verify family and addrlen
2. `DNS resolve numeric IP 127.0.0.1` — Verify AF_INET, addrlen=16, sockaddr family matches
3. `DNS resolve with service port` — Resolve with service "80", verify port in result address
4. `DNS getnameinfo reverse lookup` — Reverse lookup 127.0.0.1, verify "127.0.0.1" returned
5. `DNS failed resolution for nonexistent host` — Verify non-zero error for invalid hostname
6. `DNS alloc_hints and addrinfo_size` — Verify struct size > 0, alloc/free hints

**macOS fix:** Added platform-aware `NI_*` constants to `std/io/socket.yo` — `NI_NUMERICHOST` differs between Linux (1) and macOS (2). Test updated to use the constant instead of hardcoded value.

---

## Phase 4: Permission and Metadata Operations (Priority: Medium)

### 4.1 Create `std/io/perm.yo` — File Permissions ✅

Wraps `fchmod`/`fchmodat`/`fchown`/`fchownat`/`access` externs into async permission operations. Tests in `tests/io/perm.test.yo`.

**Implementation highlights:**

- `fchmod(fd, mode)` — Change file permissions by fd
- `chmodat(dirfd, path, mode, flags)` — Change file permissions by path (AT_FDCWD for cwd)
- `fchown(fd, uid, gid)` — Change file ownership by fd
- `chownat(dirfd, path, uid, gid, flags)` — Change file ownership by path
- `access(dirfd, path, mode)` — Check file accessibility (F_OK, R_OK, W_OK, X_OK)

**Design notes:**

- All operations return `IOFuture` resolving to 0 on success, `-errno` on failure
- Uses constants from `std/io/constants.yo`: `F_OK`, `R_OK`, `W_OK`, `X_OK`, `S_I*`, `AT_FDCWD`, `AT_SYMLINK_NOFOLLOW`
- `fchown` with uid/gid = `4294967295` (u32 max, i.e. `-1`) means "no change" (POSIX semantics)
- Root can bypass permission checks, so write-after-chmod-readonly tests check for `-EACCES` only as non-root

**Tests (6 tests, all passing on Linux and macOS):**

1. `access F_OK R_OK W_OK on existing file` — Create file, verify exists/readable/writable
2. `access on nonexistent file returns -ENOENT` — Verify -2 for missing file
3. `chmodat changes and restores permissions` — chmod to 0444, verify read-only, restore to 0644
4. `fchmod by fd sets executable bit` — fchmod to 0755, verify X_OK, restore
5. `chmodat on nonexistent file returns -ENOENT` — Error on missing file
6. `fchown with -1 -1 succeeds (no change)` — No-op ownership change succeeds

**macOS async assessment:** All permission operations (`fchmod`, `fchmodat`, `fchown`, `fchownat`, `access`) are inherently fast kernel metadata operations (inode permission/ownership changes). Sync wrappers are correct — making them async via GCD would add overhead with no benefit.

### 4.2 Create `std/io/time.yo` — File Timestamps ✅

Wraps `utime`/`futime`/`lutime` externs into async timestamp operations. Tests in `tests/io/time.test.yo`.

**Implementation highlights:**

- `utime(path, atime_sec, atime_nsec, mtime_sec, mtime_nsec)` — Change file timestamps by path (uses `utimensat` with `AT_FDCWD`)
- `futime(fd, atime_sec, atime_nsec, mtime_sec, mtime_nsec)` — Change file timestamps by fd (uses `futimens`)
- `lutime(path, atime_sec, atime_nsec, mtime_sec, mtime_nsec)` — Change symlink timestamps without following (uses `utimensat` with `AT_SYMLINK_NOFOLLOW`)

**Design notes:**

- All operations return `IOFuture` resolving to 0 on success, `-errno` on failure
- Timestamps use `(i64 seconds, i64 nanoseconds)` pairs for both atime and mtime
- `lutime` modifies the symlink itself, not the target file
- C runtime uses `utimensat`/`futimens` (sync wrappers in completed futures)

**Additional changes:**

- `Statx` type changed from `object` to `struct` (it's a lightweight wrapper, no ownership semantics needed)
- Added `atime_sec`, `atime_nsec`, `ctime_sec`, `ctime_nsec` accessors to `Statx` (previously only had `mtime`)
- Tests use `MaybeUninit(Array(u8, usize(256)))` for stack-allocated statx buffers instead of manual `malloc`/`free`
- Tests use `ArrayList(u8)` return from `make_test_file` to avoid dangling pointer from dropped cstr

**Tests (6 tests, all passing on Linux and macOS):**

1. `utime sets specific timestamps` — Set atime/mtime, verify via statx
2. `futime sets timestamps by fd with nanosecond precision` — Set via fd, verify sec+nsec fields
3. `utime on nonexistent file returns -ENOENT` — Error on missing file
4. `lutime changes symlink timestamps without affecting target` — Verify target timestamps unchanged
5. `utime with nanosecond precision` — Verify nanosecond-level accuracy
6. `futime preserves file content` — Verify file data unchanged after timestamp update

**macOS async assessment:** All timestamp operations (`utimensat`, `futimens`) are inherently fast kernel metadata operations (inode timestamp updates). Sync wrappers are correct — no benefit from GCD async.

**macOS compilation fix:** Tests failed on macOS because compile-time constants (`STATX_BASIC_STATS`, `AT_FDCWD`) were not inlined in async state machine contexts. Fixed in `atom.ts` and `other-fn-call.ts` (see Known Issues Fixed).

---

## Phase 5: Advanced Operations (Priority: Low)

### 5.1 Create `std/io/pipe.yo` — Pipe Operations

```yo
// std/io/pipe.yo

// Create a pipe pair (returns read_fd, write_fd via IOFuture)
pipe :: (fn(pipefd: *(i32)) -> IOFuture)(...);

// Duplicate a file descriptor
dup :: (fn(fd: i32) -> IOFuture)(...);
dup2 :: (fn(oldfd: i32, newfd: i32) -> IOFuture)(...);
```

### 5.2 Create `std/io/copy.yo` — Zero-Copy File Operations

```yo
// std/io/copy.yo

// Copy file using kernel acceleration (sendfile/copy_file_range)
copyfile :: (fn(src: *(u8), dst: *(u8), flags: i32) -> IOFuture)(...);

// Transfer data between fds (sendfile)
sendfile :: (fn(out_fd: i32, in_fd: i32, offset: i64, count: usize) -> IOFuture)(...);
```

### 5.3 Create `std/io/signal.yo` — Signal Handling Functions

```yo
// std/io/signal.yo

// Register a signal handler
on_signal :: (fn(signum: i32, handler: *(u8)) -> i32)(...);

// Remove a signal handler
off_signal :: (fn(signum: i32) -> i32)(...);

// Send a signal to a process
kill :: (fn(pid: i32, signum: i32) -> i32)(...);
```

### 5.4 Create `std/io/tty.yo` — TTY Operations

```yo
// std/io/tty.yo

// Initialize TTY for a fd
tty_init :: (fn(fd: i32) -> i32)(...);

// Set TTY mode (normal, raw, IO)
tty_set_mode :: (fn(fd: i32, mode: i32) -> i32)(...);

// Reset TTY to original mode
tty_reset :: (fn() -> i32)(...);

// Get terminal window size
tty_winsize :: (fn(fd: i32) -> struct(width: i32, height: i32))(...);

// Check if fd is a TTY
isatty :: (fn(fd: i32) -> bool)(...);
```

### 5.5 Create `std/io/temp.yo` — Temporary File/Directory Operations

Wraps `mkdtemp`/`mkstemp` externs. Externs and C runtime already exist on all 3 platforms (sync wrappers).

```yo
// std/io/temp.yo

// Create a temporary directory from template (e.g., "/tmp/myapp-XXXXXX")
// The template is modified in-place with the actual path. Returns 0 on success.
mkdtemp :: (fn(template: *(u8)) -> IOFuture)(...);

// Create a temporary file from template (e.g., "/tmp/myfile-XXXXXX")
// The template is modified in-place. Returns the fd on success.
mkstemp :: (fn(template: *(u8)) -> IOFuture)(...);
```

**Cross-platform notes:**

- Linux/macOS: Uses POSIX `mkdtemp()`/`mkstemp()` directly
- Windows: Uses `_mktemp_s()` + `_wmkdir()`/`CreateFileW()` in sync wrappers
- Template must end with `XXXXXX` (6 X's replaced with unique suffix)

### 5.6 Create `std/io/path.yo` — Path Resolution

Wraps `realpath` extern. Externs and C runtime already exist on all 3 platforms.

```yo
// std/io/path.yo

// Resolve a path to its canonical absolute form (resolves symlinks, . and ..)
// Writes result to `resolved` buffer (must be at least PATH_MAX bytes).
// Returns 0 on success, -errno on failure.
realpath :: (fn(path: *(u8), resolved: *(u8)) -> IOFuture)(...);
```

**Cross-platform notes:**

- Linux/macOS: Uses POSIX `realpath()` directly
- Windows: Uses `GetFullPathNameW()` in sync wrapper

### 5.7 Create `std/io/statfs.yo` — Filesystem Statistics

Wraps `statfs` extern and provides typed accessors. Externs and C runtime already exist on all 3 platforms.

```yo
// std/io/statfs.yo

// Get filesystem statistics for the given path.
// Writes result to `buf` (use statfs_buf_size() to allocate).
statfs :: (fn(path: *(u8), buf: *(u8)) -> IOFuture)(...);

// Get required buffer size for statfs
statfs_buf_size :: (fn() -> usize)(...);

// Accessors for statfs result buffer
statfs_type   :: (fn(buf: *(u8)) -> u64)(...);
statfs_bsize  :: (fn(buf: *(u8)) -> u64)(...);
statfs_blocks :: (fn(buf: *(u8)) -> u64)(...);
statfs_bfree  :: (fn(buf: *(u8)) -> u64)(...);
statfs_bavail :: (fn(buf: *(u8)) -> u64)(...);
statfs_files  :: (fn(buf: *(u8)) -> u64)(...);
statfs_ffree  :: (fn(buf: *(u8)) -> u64)(...);
```

**Cross-platform notes:**

- Linux: `statfs()` syscall
- macOS: `statfs()` syscall (slightly different struct layout)
- Windows: `GetDiskFreeSpaceExW()` mapped to block-style fields

---

## Phase 6: Windows IOCP Backend ✅ (Completed)

**Status**: Fully implemented and tested. All 4 file I/O tests pass on Windows.

The Windows async I/O backend uses I/O Completion Ports (IOCP) for true async
file read/write. Other operations (close, stat, mkdir, unlink, rename, symlink,
fsync, ftruncate, chmod) use synchronous wrappers in completed futures, matching
the macOS approach.

### Architecture

- **Event loop**: Single IOCP handle created with `CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1)`
- **Poll**: `GetQueuedCompletionStatusEx` (batched, non-blocking) with up to 64 entries
- **Wait**: `GetQueuedCompletionStatus` (blocking) with timer-aware timeout
- **Timer**: Software timer list integrated with IOCP wait timeout (no thread pool)
- **Handle association**: `openat` opens files with `FILE_FLAG_OVERLAPPED`, associates handle with IOCP via `CreateIoCompletionPort`. Tolerates double-association (returns true on `ERROR_INVALID_PARAMETER`).
- **fd round-trip**: `CreateFileW` → `_open_osfhandle` (HANDLE→fd) in openat, then `_get_osfhandle` (fd→HANDLE) in read/write
- **Overlapped I/O**: Custom `yo_win_overlapped_t` struct embeds `OVERLAPPED` + future pointer + handle info
- **Winsock**: `WSAStartup` at init, links `-lws2_32` for future socket support

### Implementation Files

| File                                      | Purpose                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `src/codegen/async/runtime-io-windows.ts` | IOCP event loop, file ops, dir ops, socket stubs                   |
| `src/codegen/async/runtime-io-common.ts`  | Cross-platform timer sleep, stat helpers                           |
| `src/codegen/c/collection.ts`             | Emits `WIN32_LEAN_AND_MEAN` / `_WINSOCKAPI_` at top of generated C |
| `src/test-runner.ts`                      | Links `-lws2_32` on Windows                                        |

### Windows File I/O (Implemented)

| Operation | Win32 API                      | Status | Notes                            |
| --------- | ------------------------------ | ------ | -------------------------------- |
| read      | `ReadFile` + `OVERLAPPED`      | ✅     | IOCP overlapped I/O              |
| write     | `WriteFile` + `OVERLAPPED`     | ✅     | IOCP overlapped I/O              |
| open      | `CreateFileW`                  | ✅     | `FILE_FLAG_OVERLAPPED` for async |
| close     | `_close`                       | ✅     | Sync wrapper                     |
| stat      | `_wstat64`                     | ✅     | Sync wrapper                     |
| mkdir     | `_wmkdir`                      | ✅     | Sync wrapper                     |
| unlink    | `_wunlink`/`_wrmdir`           | ✅     | Sync wrapper                     |
| rename    | `_wrename`                     | ✅     | Sync wrapper                     |
| symlink   | `CreateSymbolicLinkW`          | ✅     | Requires privileges              |
| link      | `CreateHardLinkW`              | ✅     | Sync wrapper                     |
| fsync     | `_commit`                      | ✅     | Sync wrapper                     |
| truncate  | `_chsize_s`                    | ✅     | Sync wrapper                     |
| readlink  | `GetFinalPathNameByHandleW`    | ✅     | Sync wrapper                     |
| readdir   | `FindFirstFileW/FindNextFileW` | ✅     | Sync wrapper via getdents        |

### 6.3 Windows Socket I/O (Planned)

| Operation | Win32 API          | Notes                 |
| --------- | ------------------ | --------------------- |
| socket    | `WSASocket`        | `WSA_FLAG_OVERLAPPED` |
| bind      | `bind` (Winsock)   | Sync                  |
| listen    | `listen` (Winsock) | Sync                  |
| accept    | `AcceptEx`         | Overlapped            |
| connect   | `ConnectEx`        | Overlapped            |
| send      | `WSASend`          | Overlapped            |
| recv      | `WSARecv`          | Overlapped            |
| close     | `closesocket`      | Sync                  |

### 6.4 Windows-Specific Considerations

- `WIN32_LEAN_AND_MEAN` and `_WINSOCKAPI_` are emitted at the top of every generated C file to prevent `winsock.h`/`winsock2.h` conflicts
- `winsock2.h` + `ws2tcpip.h` are included before `windows.h` in the IOCP runtime
- `WSAStartup` is called during I/O initialization
- File paths are converted via `MultiByteToWideChar` (UTF-8 → UTF-16) for `CreateFileW` and other W-suffix APIs
- `_open_osfhandle` / `_get_osfhandle` convert between Windows HANDLEs and POSIX-style fds
- `AT_FDCWD` is defined as -100 (matching Linux convention)
- Test runner links `-lws2_32` on Windows

---

## Phase 7: FS Events and Poll (Priority: Low)

### 7.1 FS Events

| Platform | API                            | Notes                 |
| -------- | ------------------------------ | --------------------- |
| Linux    | `inotify` + io_uring read      | Watch fd events async |
| macOS    | `FSEvents` / `dispatch_source` | GCD-based             |
| Windows  | `ReadDirectoryChangesW`        | Overlapped with IOCP  |

### 7.2 Poll Operations

| Platform | API                           | Notes           |
| -------- | ----------------------------- | --------------- |
| Linux    | `io_uring_prep_poll_add`      | True async poll |
| macOS    | `dispatch_source` on fd       | GCD-based       |
| Windows  | `WSAPoll` or `WSAEventSelect` | Winsock events  |

---

## Phase 8: Unix Domain Sockets (Priority: Medium)

**Goal**: Provide Unix domain socket (IPC) operations reusing the existing TCP/UDP socket infrastructure.

The C runtime already has `sockaddr_un` helpers (`__yo_sockaddr_un_size`, `__yo_sockaddr_un_set_path`, `__yo_sockaddr_un_get_path`) on all 3 platforms. The socket operations (`socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`, `close`) from `tcp.yo` work with any address family, so `unix.yo` primarily provides address helpers and convenience wrappers.

### 8.1 Create `std/io/unix.yo` — Unix Domain Socket Operations

```yo
// std/io/unix.yo

// Unix socket address helpers
UnixAddr :: struct(
  buf : *(u8),
  len : u32
);

// Create a Unix socket (SOCK_STREAM for connection-oriented)
socket_stream :: (fn() -> IOFuture)(...);

// Create a Unix socket (SOCK_DGRAM for datagram)
socket_dgram :: (fn() -> IOFuture)(...);

// Create a sockaddr_un from a filesystem path
make_sockaddr_un :: (fn(path: *(u8)) -> UnixAddr)(...);

// Extract the path from a sockaddr_un buffer
get_path :: (fn(addr_buf: *(u8)) -> *(u8))(...);

// Free a UnixAddr buffer
free_addr :: (fn(addr: UnixAddr) -> unit)(...);

// Bind, listen, accept, connect, send, recv, close reused from tcp.yo
```

**Cross-platform notes:**

- Linux/macOS: Full `AF_UNIX` support with filesystem and abstract sockets
- Windows: `AF_UNIX` supported since Windows 10 version 1803. Our runtime currently returns 0 for `sockaddr_un_size` (needs implementation). Filesystem paths only (no abstract sockets).
- Abstract sockets (Linux-only, path starts with `\0`) can be supported later

---

## Phase 9: Process Management (Priority: Medium)

**Goal**: Provide cross-platform child process spawning, waiting, and signal delivery.

This requires **new C runtime externs** — no process management functions exist in the runtime yet.

### 9.1 Create `std/io/process.yo` — Child Process Operations

```yo
// std/io/process.yo

// Spawn a child process.
// Returns the child PID on success, -errno on failure.
// `argv` is a NULL-terminated array of argument strings.
// `envp` is a NULL-terminated array of "KEY=VALUE" strings (or null for inherit).
// `stdin_fd`, `stdout_fd`, `stderr_fd`: fd redirections (-1 = inherit)
spawn :: (fn(
  file: *(u8),
  argv: *(*(u8)),
  envp: ?*(*(u8)),
  stdin_fd: i32,
  stdout_fd: i32,
  stderr_fd: i32
) -> IOFuture)(...);

// Wait for a child process to exit.
// Returns the exit status (encoded: use WEXITSTATUS/WTERMSIG macros).
waitpid :: (fn(pid: i32, options: i32) -> IOFuture)(...);

// Send a signal to a process.
// Returns 0 on success, -errno on failure.
kill :: (fn(pid: i32, signum: i32) -> i32)(...);

// Helper: extract exit code from waitpid status
exit_status :: (fn(status: i32) -> i32)(...);

// Helper: check if process was terminated by signal
term_signal :: (fn(status: i32) -> i32)(...);
```

**Cross-platform implementation:**

| Operation | Linux/macOS                          | Windows                                          |
| --------- | ------------------------------------ | ------------------------------------------------ |
| spawn     | `posix_spawn()` or `fork()+execvp()` | `CreateProcessW()`                               |
| waitpid   | `waitpid()` (sync wrapper)           | `WaitForSingleObject()` + `GetExitCodeProcess()` |
| kill      | `kill()` (POSIX)                     | `TerminateProcess()` (SIGKILL only)              |

**Design notes:**

- `spawn` takes explicit fd redirections for stdin/stdout/stderr, enabling pipe-based IPC (combine with `pipe.yo`)
- `envp` is nullable — pass null to inherit parent environment
- `waitpid` with `options=0` blocks; `WNOHANG` polls without blocking
- On Windows, signal support is limited: only `SIGKILL` → `TerminateProcess()` is reliable
- Exit status encoding follows POSIX conventions on Unix; Windows maps directly to exit code

### 9.2 Runtime Implementation Needed

New C runtime functions required in `runtime-io-common.ts` (or platform-specific files):

```c
// Spawn child process
yo_io_future_t* __yo_async_spawn_start(
  const char* file, char* const argv[], char* const envp[],
  int stdin_fd, int stdout_fd, int stderr_fd);

// Wait for child process
yo_io_future_t* __yo_async_waitpid_start(int32_t pid, int32_t options);

// Extract exit status from waitpid result
int32_t __yo_process_exit_status(int32_t status);
int32_t __yo_process_term_signal(int32_t status);
```

---

## Phase 10: Advanced System Operations (Priority: Low)

**Goal**: Provide low-level system operations for fd control, memory mapping, and file locking.

All of these require **new C runtime externs**.

### 10.1 Create `std/io/fcntl.yo` — File Descriptor Control

```yo
// std/io/fcntl.yo

// Get file descriptor flags
getfl :: (fn(fd: i32) -> i32)(...);

// Set file descriptor flags
setfl :: (fn(fd: i32, flags: i32) -> i32)(...);

// Get file descriptor close-on-exec flag
getfd :: (fn(fd: i32) -> i32)(...);

// Set file descriptor close-on-exec flag
setfd :: (fn(fd: i32, flags: i32) -> i32)(...);

// Constants
O_NONBLOCK :: i32(...);
FD_CLOEXEC :: i32(...);
```

**Cross-platform implementation:**

| Operation | Linux/macOS          | Windows                                     |
| --------- | -------------------- | ------------------------------------------- |
| getfl     | `fcntl(fd, F_GETFL)` | `ioctlsocket(FIONBIO)` for sockets          |
| setfl     | `fcntl(fd, F_SETFL)` | `ioctlsocket(FIONBIO)` for sockets          |
| getfd     | `fcntl(fd, F_GETFD)` | N/A (handles inherit by default)            |
| setfd     | `fcntl(fd, F_SETFD)` | `SetHandleInformation(HANDLE_FLAG_INHERIT)` |

**Design notes:**

- Primary use case: toggling `O_NONBLOCK` on sockets/pipes
- Windows has a fundamentally different model — `ioctlsocket` for sockets, `SetNamedPipeHandleState` for pipes. The Yo wrapper abstracts this.
- Close-on-exec (`FD_CLOEXEC`) is less relevant on Windows where handles don't survive `CreateProcess` unless explicitly inherited

### 10.2 Create `std/io/mmap.yo` — Memory-Mapped I/O

```yo
// std/io/mmap.yo

// Map a file or device into memory.
// Returns pointer to mapped region, or -errno cast to pointer on failure.
mmap :: (fn(
  addr: ?*(u8),
  length: usize,
  prot: i32,
  flags: i32,
  fd: i32,
  offset: i64
) -> ?*(u8))(...);

// Unmap a previously mapped region
munmap :: (fn(addr: *(u8), length: usize) -> i32)(...);

// Change protection flags on a mapped region
mprotect :: (fn(addr: *(u8), length: usize, prot: i32) -> i32)(...);

// Sync mapped region to disk
msync :: (fn(addr: *(u8), length: usize, flags: i32) -> i32)(...);

// Protection constants
PROT_NONE  :: i32(0);
PROT_READ  :: i32(1);
PROT_WRITE :: i32(2);
PROT_EXEC  :: i32(4);

// Mapping flags
MAP_SHARED    :: i32(...);
MAP_PRIVATE   :: i32(...);
MAP_ANONYMOUS :: i32(...);
```

**Cross-platform implementation:**

| Operation | Linux/macOS  | Windows                                    |
| --------- | ------------ | ------------------------------------------ |
| mmap      | `mmap()`     | `CreateFileMappingW()` + `MapViewOfFile()` |
| munmap    | `munmap()`   | `UnmapViewOfFile()`                        |
| mprotect  | `mprotect()` | `VirtualProtect()`                         |
| msync     | `msync()`    | `FlushViewOfFile()`                        |

**Design notes:**

- Windows mmap requires a two-step process (create mapping object, then map view), so the runtime will combine both into one call
- `MAP_ANONYMOUS` + `fd=-1` for anonymous mappings (useful for custom allocators)
- Prot/flag constants will be platform-aware (values differ between Linux and macOS for some flags)

### 10.3 Create `std/io/lock.yo` — Advisory File Locking

```yo
// std/io/lock.yo

// Acquire an advisory lock on a file.
// operation: LOCK_SH (shared), LOCK_EX (exclusive), LOCK_UN (unlock)
// Can be OR'd with LOCK_NB for non-blocking.
flock :: (fn(fd: i32, operation: i32) -> i32)(...);

// Lock constants
LOCK_SH :: i32(1);  // Shared lock
LOCK_EX :: i32(2);  // Exclusive lock
LOCK_UN :: i32(8);  // Unlock
LOCK_NB :: i32(4);  // Non-blocking
```

**Cross-platform implementation:**

| Operation | Linux/macOS     | Windows                           |
| --------- | --------------- | --------------------------------- |
| flock     | `flock()` (BSD) | `LockFileEx()` / `UnlockFileEx()` |

**Design notes:**

- Advisory locks only — they don't prevent other processes from accessing the file unless they also use `flock`
- On Windows, `LockFileEx` is mandatory (not advisory), but this is acceptable for most use cases (database locks, PID files, etc.)
- `LOCK_NB` returns `-EWOULDBLOCK` if lock cannot be acquired immediately

---

## Implementation Order & Dependencies

```
Phase 1 (File I/O wrappers)         ✅ DONE
  └── Depends on: existing externs + C runtime

Phase 2 (Socket wrappers)           ✅ DONE
  └── Depends on: Phase 1 patterns

Phase 3 (DNS)                        ✅ DONE
  └── Depends on: Phase 2 (socket types)

Phase 4 (Permissions/Metadata)       ✅ DONE
  └── Depends on: Phase 1 (file operations)

Phase 5 (Advanced ops)               ← CURRENT
  ├── 5.1-5.4 (pipe, copy, signal, tty)
  │     └── Depends on: Phase 1 + Phase 2
  └── 5.5-5.7 (temp, path, statfs)   ← Easy wins, externs exist
        └── Depends on: Phase 1 only

Phase 6 (Windows IOCP)               ✅ DONE
  └── Independent of Yo-side wrappers

Phase 7 (FS Events + Poll)
  └── Depends on: Phase 6 for Windows support

Phase 8 (Unix Domain Sockets)
  └── Depends on: Phase 2 (reuses socket infra)

Phase 9 (Process Management)         ← Needs new runtime
  └── Depends on: Phase 5.1 (pipe for stdio redirection)

Phase 10 (System Operations)         ← Needs new runtime
  ├── 10.1 fcntl    └── Independent
  ├── 10.2 mmap     └── Independent
  └── 10.3 flock    └── Independent
```

## Testing Strategy

Each phase should include a `.test.yo` file exercising the new APIs:

1. **Timer tests** — ✅ Done in `fixme.yo` (sleep)
2. **File I/O tests** — Open, read, write, close, stat a temp file
3. **Directory tests** — mkdir, readdir, rmdir
4. **Socket tests** — TCP echo server/client on localhost
5. **DNS tests** — Resolve `localhost`
6. **Permission tests** — chmod, access checks
7. **Timestamp tests** — utime, futime, lutime, verify via statx
8. **Pipe tests** — pipe creation, dup/dup2, read/write through pipe
9. **Temp file tests** — mkdtemp, mkstemp, verify creation and cleanup
10. **Path tests** — realpath on symlinks, relative paths, nonexistent paths
11. **Statfs tests** — filesystem stats, verify block size > 0
12. **Unix socket tests** — stream echo server/client, dgram send/recv
13. **Process tests** — spawn child, wait for exit, pipe stdout capture
14. **Mmap tests** — map file, read/write, msync, munmap
15. **Lock tests** — flock exclusive/shared, non-blocking conflict detection

For cross-platform validation:

- Linux: Run tests with `./yo-cli test` (uses AddressSanitizer)
- macOS: Same but links with system frameworks instead of liburing
- Windows: Use `clang -std=c11 -w -O2 -lws2_32`, or `zig` compiler. Tests use `temp_dir()` + `path_join()` for cross-platform temp paths.

## File Layout After All Phases

```
std/io/
  constants.yo     ← FS constants (modes, flags, etc.)    ✅
  errors.yo        ← IOError enum                         ✅
  future.yo        ← IOFuture type                        ✅
  externs.yo       ← C extern declarations                ✅
  socket.yo        ← Socket constants                     ✅
  signals.yo       ← Signal constants                     ✅
  events.yo        ← TTY/poll/FS event constants           ✅
  statx.yo         ← File metadata accessors              ✅
  timer.yo         ← sleep                                ✅
  file.yo          ← Async file operations                ✅
  dir.yo           ← Async directory operations           ✅
  tcp.yo           ← TCP socket operations                ✅
  udp.yo           ← UDP socket operations                ✅
  dns.yo           ← DNS resolution                       ✅
  perm.yo          ← File permissions                     ✅
  time.yo          ← File timestamp operations            ✅
  pipe.yo          ← Pipe/dup operations                  Phase 5
  copy.yo          ← Zero-copy file transfer              Phase 5
  signal.yo        ← Signal handling functions            Phase 5
  tty.yo           ← TTY mode/winsize                     Phase 5
  temp.yo          ← Temporary files/directories          Phase 5
  path.yo          ← Path resolution (realpath)           Phase 5
  statfs.yo        ← Filesystem statistics                Phase 5
  unix.yo          ← Unix domain sockets                  Phase 8
  process.yo       ← Child process management             Phase 9
  fcntl.yo         ← FD flags control                     Phase 10
  mmap.yo          ← Memory-mapped I/O                    Phase 10
  lock.yo          ← Advisory file locking                Phase 10
```

## Notes

- **macOS sync wrappers**: Many macOS operations (mkdir, stat, rename, etc.) use synchronous POSIX calls wrapped in completed futures. This is acceptable because these operations are fast and `dispatch_io` only supports read/write. A future optimization could use `dispatch_async` on a global queue to avoid blocking the event loop for slow operations.

- **Windows IOCP model**: Unlike io_uring (which can do arbitrary syscalls async), IOCP only supports file handles opened with `FILE_FLAG_OVERLAPPED`. Directory operations, stat, chmod, etc. will use sync wrappers like macOS.

- **Import pattern**: No barrel re-export. Import specific submodules: `{ openat, read } :: import "std/io/file"`, `{ sleep } :: import "std/io/timer"`, etc. Use destructured imports, not namespace access (e.g. `io.O_RDONLY`), for c_include constants to avoid codegen issues.

- **`*(u8)` not `str` for paths**: The low-level `std/io` functions use `*(u8)` raw pointers to match the C extern signatures directly. `str` is a higher-level newtype wrapping `Slice(u8)` — the `std/fs` module will accept `str` and extract the pointer before calling into `std/io`.

- **Error handling**: All functions return `IOFuture` (which resolves to `i32`). The pattern is: positive = success (often bytes count), negative = `-errno`. The `IOError.from_result(result)` helper converts this to `Result(i32, IOError)`.

- **Breaking changes are OK**: Per project guidelines, the Yo language is still evolving. API surface can change between phases.

- **Process management on Windows**: `CreateProcessW` has a very different API from `posix_spawn`/`fork+exec`. The runtime abstraction will normalize to a common interface: file path, argv array, envp array, and stdio fd redirections. Signal delivery via `kill()` is limited to `SIGKILL` → `TerminateProcess()` on Windows.

- **Unix sockets on Windows**: `AF_UNIX` is supported since Windows 10 version 1803, but only filesystem-path sockets (no abstract sockets). The runtime currently stubs `sockaddr_un_size` to 0 on Windows — this needs to be implemented for Phase 8.

- **mmap on Windows**: Requires a two-step `CreateFileMappingW()` + `MapViewOfFile()` dance internally. The runtime will present a unified `mmap()`-style interface. Anonymous mappings use `INVALID_HANDLE_VALUE` as the file handle.

- **fcntl on Windows**: There is no direct equivalent. Non-blocking mode for sockets uses `ioctlsocket(FIONBIO)`. For files/pipes, Windows uses overlapped I/O instead of non-blocking mode. The runtime will provide best-effort abstraction.
