# std/io Module Implementation Plan

## Overview

The `std/io` module provides Yo's low-level async I/O foundation. It sits between the raw C runtime (`src/codegen/async/runtime.ts`) and the high-level APIs (`std/fs`, `std/net`). This plan covers completing the module from its current state (constants, errors, externs, timer, statx) to a fully functional cross-platform async I/O layer.

## Current Status

### What's Done

| Component            | File                  | Status      | Notes                                                      |
| -------------------- | --------------------- | ----------- | ---------------------------------------------------------- |
| **Constants**        | `std/io/constants.yo` | ✅ Complete | File mode, permissions, AT*\*, DT*\*, open flags           |
| **Socket Constants** | `std/io/socket.yo`    | ✅ Complete | Platform-aware AF*\*, SOCK*\_, SO\_\_, TCP\_\*             |
| **Signals**          | `std/io/signals.yo`   | ✅ Complete | Platform-aware POSIX signal numbers                        |
| **Events**           | `std/io/events.yo`    | ✅ Complete | TTY, poll, FS event constants                              |
| **IOError**          | `std/io/errors.yo`    | ✅ Complete | Enum with errno mapping, ToString impl                     |
| **IOFuture**         | `std/io/future.yo`    | ✅ Complete | Extern type wrapping `yo_io_future_t`                      |
| **Externs**          | `std/io/externs.yo`   | ✅ Complete | All C extern function declarations                         |
| **Statx**            | `std/io/statx.yo`     | ✅ Complete | File metadata accessor object                              |
| **Timer**            | `std/io/timer.yo`     | ✅ Complete | `sleep(ms)`                                                |
| **File**             | `std/io/file.yo`      | ✅ Complete | Async+sync file ops (openat, read, write, etc.)            |
| **Dir**              | `std/io/dir.yo`       | ✅ Complete | mkdir, unlink, rename, symlink, link, readlink             |
| **Readdir**          | `std/io/readdir.yo`   | ✅ Complete | getdents, dirent accessors (size, reclen, type, name, ino) |
| **TCP**              | `std/io/tcp.yo`       | ✅ Complete | Socket, bind, listen, accept, connect, send, recv, close   |
| **UDP**              | `std/io/udp.yo`       | ✅ Complete | Socket, bind, sendto, recvfrom, send, recv, close          |
| **DNS**              | `std/io/dns.yo`       | ✅ Complete | getaddrinfo, getnameinfo, addrinfo accessors               |
| **Perm**             | `std/io/perm.yo`      | ✅ Complete | fchmod, chmodat, fchown, chownat, access                   |

### C Runtime Status (in `src/codegen/async/runtime*.ts`)

The runtime has been refactored into 4 modules:

- `runtime.ts` — Thin coordinator that calls the others
- `runtime-core.ts` — Core scheduler (continuation queue, spawn, wait, concurrency helpers)
- `runtime-io-linux.ts` — Linux io_uring async I/O
- `runtime-io-macos.ts` — macOS GCD async I/O
- `runtime-io-windows.ts` — Windows IOCP async I/O
- `runtime-io-common.ts` — Cross-platform stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll

| Category                   | Linux (io_uring)      | macOS (dispatch_io) | Windows (IOCP)                           |
| -------------------------- | --------------------- | ------------------- | ---------------------------------------- |
| **Event loop integration** | ✅                    | ✅                  | ✅ (IOCP)                                |
| **File read/write**        | ✅                    | ✅                  | ✅ (IOCP)                                |
| **File open/close**        | ✅                    | ✅                  | ✅ (sync wrappers)                       |
| **Stat**                   | ✅ (statx)            | ✅ (struct stat)    | ✅ (\_stat64)                            |
| **mkdir/unlink/rename**    | ✅                    | ✅ (sync wrappers)  | ✅ (sync wrappers)                       |
| **symlink/link**           | ✅                    | ✅ (sync wrappers)  | ✅ (CreateSymbolicLinkW/CreateHardLinkW) |
| **fsync/fdatasync**        | ✅                    | ✅ (sync wrappers)  | ✅ (\_commit)                            |
| **ftruncate**              | ✅                    | ✅ (sync wrapper)   | ✅ (\_chsize_s)                          |
| **chmod/chown**            | ✅                    | ✅                  | ⚠️ (chmod only)                          |
| **readlink**               | ✅                    | ✅                  | ✅ (GetFinalPathNameByHandleW)           |
| **dup/dup2/pipe**          | ✅                    | ✅                  | ✅                                       |
| **Socket ops**             | ✅                    | ✅                  | ✅ (Winsock sync)                        |
| **Timer (sleep)**          | ✅ (timerfd+io_uring) | ✅ (dispatch_after) | ✅ (IOCP wait timeout)                   |
| **getdents/readdir**       | ✅ (getdents64)       | ✅ (getdirentries)  | ✅ (getdents only)                       |
| **access/realpath**        | ✅ (sync)             | ✅ (sync)           | ✅ (sync)                                |
| **utime**                  | ✅ (sync)             | ✅ (sync)           | ✅ (sync)                                |
| **mkdtemp/mkstemp**        | ✅ (sync)             | ✅ (sync)           | ✅ (sync)                                |
| **copyfile/sendfile**      | ✅ (sync)             | ✅ (sync)           | ⚠️ (copyfile only)                       |
| **statfs**                 | ✅ (sync)             | ✅ (sync)           | ✅ (GetDiskFreeSpaceEx)                  |
| **DNS**                    | ✅ (sync)             | ✅ (sync)           | ✅ (sync)                                |
| **Signals**                | ✅ (sync)             | ✅ (sync)           | ❌                                       |
| **TTY**                    | ✅ (sync)             | ✅ (sync)           | ⚠️ (isatty only)                         |
| **FS Events**              | ❌                    | ❌                  | ❌                                       |
| **Poll**                   | ❌                    | ❌                  | ❌                                       |

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

**Tests (6 tests, all passing on Linux):**

1. `TCP socket creation and close` — Basic socket lifecycle
2. `Set SO_REUSEADDR socket option` — setsockopt test
3. `Bind to loopback and listen` — Server setup test
4. `TCP echo server-client` — Full connection: bind, listen, connect, accept, send, recv, shutdown, close
5. `SockAddr helper functions` — sockaddr creation and accessors

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

**Tests (6 tests, all passing on Linux):**

1. `UDP socket creation and close` — Basic socket lifecycle
2. `UDP socket bind to loopback` — Bind to specific port
3. `UDP setsockopt SO_REUSEADDR` — Socket option test
4. `UDP sendto and recvfrom` — Send datagram, receive with byte verification and source address check
5. `UDP bidirectional ping-pong` — Server and client exchange datagrams using `recvfrom` sender address for reply
6. `UDP sockaddr helpers from tcp module` — Verify tcp address helpers work for UDP

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

**Tests (6 tests, all passing on Linux):**

1. `DNS resolve localhost` — Resolve "localhost", walk linked list, verify family and addrlen
2. `DNS resolve numeric IP 127.0.0.1` — Verify AF_INET, addrlen=16, sockaddr family matches
3. `DNS resolve with service port` — Resolve with service "80", verify port in result address
4. `DNS getnameinfo reverse lookup` — Reverse lookup 127.0.0.1, verify "127.0.0.1" returned
5. `DNS failed resolution for nonexistent host` — Verify non-zero error for invalid hostname
6. `DNS alloc_hints and addrinfo_size` — Verify struct size > 0, alloc/free hints

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

**Tests (6 tests, all passing on Linux):**

1. `access F_OK R_OK W_OK on existing file` — Create file, verify exists/readable/writable
2. `access on nonexistent file returns -ENOENT` — Verify -2 for missing file
3. `chmodat changes and restores permissions` — chmod to 0444, verify read-only, restore to 0644
4. `fchmod by fd sets executable bit` — fchmod to 0755, verify X_OK, restore
5. `chmodat on nonexistent file returns -ENOENT` — Error on missing file
6. `fchown with -1 -1 succeeds (no change)` — No-op ownership change succeeds

### 4.2 Create `std/io/time.yo` — File Timestamps

```yo
// std/io/time.yo

// Update file access and modification times
utime :: (fn(path: *(u8), atime_sec: i64, atime_nsec: i64, mtime_sec: i64, mtime_nsec: i64) -> IOFuture)(...);
```

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

## Implementation Order & Dependencies

```
Phase 1 (File I/O wrappers)    ← START HERE
  └── Depends on: existing externs + C runtime ✅

Phase 2 (Socket wrappers)
  └── Depends on: Phase 1 patterns

Phase 3 (DNS)
  └── Depends on: Phase 2 (socket types)

Phase 4 (Permissions/Metadata)
  └── Depends on: Phase 1 (file operations)

Phase 5 (Advanced ops)
  └── Depends on: Phase 1 + Phase 2

Phase 6 (Windows IOCP)          ← Can be done in parallel
  └── Independent of Yo-side wrappers

Phase 7 (FS Events + Poll)
  └── Depends on: Phase 6 for Windows support
```

## Testing Strategy

Each phase should include a `.test.yo` file exercising the new APIs:

1. **Timer tests** — ✅ Done in `fixme.yo` (sleep)
2. **File I/O tests** — Open, read, write, close, stat a temp file
3. **Directory tests** — mkdir, readdir, rmdir
4. **Socket tests** — TCP echo server/client on localhost
5. **DNS tests** — Resolve `localhost`
6. **Permission tests** — chmod, access checks

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
  pipe.yo          ← Pipe/dup operations                  Phase 5
  copy.yo          ← Zero-copy file transfer              Phase 5
  signal.yo        ← Signal handling functions            Phase 5
  tty.yo           ← TTY mode/winsize                     Phase 5
```

## Notes

- **macOS sync wrappers**: Many macOS operations (mkdir, stat, rename, etc.) use synchronous POSIX calls wrapped in completed futures. This is acceptable because these operations are fast and `dispatch_io` only supports read/write. A future optimization could use `dispatch_async` on a global queue to avoid blocking the event loop for slow operations.

- **Windows IOCP model**: Unlike io_uring (which can do arbitrary syscalls async), IOCP only supports file handles opened with `FILE_FLAG_OVERLAPPED`. Directory operations, stat, chmod, etc. will use sync wrappers like macOS.

- **Import pattern**: No barrel re-export. Import specific submodules: `{ openat, read } :: import "std/io/file"`, `{ sleep } :: import "std/io/timer"`, etc. Use destructured imports, not namespace access (e.g. `io.O_RDONLY`), for c_include constants to avoid codegen issues.

- **`*(u8)` not `str` for paths**: The low-level `std/io` functions use `*(u8)` raw pointers to match the C extern signatures directly. `str` is a higher-level newtype wrapping `Slice(u8)` — the `std/fs` module will accept `str` and extract the pointer before calling into `std/io`.

- **Error handling**: All functions return `IOFuture` (which resolves to `i32`). The pattern is: positive = success (often bytes count), negative = `-errno`. The `IOError.from_result(result)` helper converts this to `Result(i32, IOError)`.

- **Breaking changes are OK**: Per project guidelines, the Yo language is still evolving. API surface can change between phases.
