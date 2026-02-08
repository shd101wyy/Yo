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
| **Timer**            | `std/io/timer.yo`     | ✅ Complete | `sleep(ms)`, `timeout(ms)`                                 |
| **File**             | `std/io/file.yo`      | ✅ Complete | Async+sync file ops (openat, read, write, etc.)            |
| **Dir**              | `std/io/dir.yo`       | ✅ Complete | mkdir, unlink, rename, symlink, link, readlink             |
| **Readdir**          | `std/io/readdir.yo`   | ✅ Complete | getdents, dirent accessors (size, reclen, type, name, ino) |
| **Index**            | `std/io/index.yo`     | ❌ Removed  | Users import submodules directly                           |

### C Runtime Status (in `src/codegen/async/runtime*.ts`)

The runtime has been refactored into 4 modules:

- `runtime.ts` — Thin coordinator that calls the others
- `runtime-core.ts` — Core scheduler (continuation queue, spawn, wait, concurrency helpers)
- `runtime-io-linux.ts` — Linux io_uring async I/O
- `runtime-io-macos.ts` — macOS GCD async I/O
- `runtime-io-common.ts` — Cross-platform stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll

| Category                   | Linux (io_uring)      | macOS (dispatch_io) | Windows (IOCP)         |
| -------------------------- | --------------------- | ------------------- | ---------------------- |
| **Event loop integration** | ✅                    | ✅                  | ❌ (queue only, no IO) |
| **File read/write**        | ✅                    | ✅                  | ❌                     |
| **File open/close**        | ✅                    | ✅                  | ❌                     |
| **Stat**                   | ✅ (statx)            | ✅ (struct stat)    | ❌                     |
| **mkdir/unlink/rename**    | ✅                    | ✅ (sync wrappers)  | ❌                     |
| **symlink/link**           | ✅                    | ✅ (sync wrappers)  | ❌                     |
| **fsync/fdatasync**        | ✅                    | ✅ (sync wrappers)  | ❌                     |
| **ftruncate**              | ✅                    | ✅ (sync wrapper)   | ❌                     |
| **chmod/chown**            | ✅                    | ✅                  | ❌                     |
| **readlink**               | ✅                    | ✅                  | ❌                     |
| **dup/dup2/pipe**          | ✅                    | ✅                  | ❌                     |
| **Socket ops**             | ✅                    | ✅                  | ❌                     |
| **Timer (sleep/timeout)**  | ✅ (timerfd+io_uring) | ✅ (dispatch_after) | ✅ (ThreadpoolTimer)   |
| **getdents/readdir**       | ✅ (getdents64)       | ✅ (getdirentries)  | ❌                     |
| **access/realpath**        | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **utime**                  | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **mkdtemp/mkstemp**        | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **copyfile/sendfile**      | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **statfs**                 | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **DNS**                    | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **Signals**                | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **TTY**                    | ✅ (sync)             | ✅ (sync)           | ❌                     |
| **FS Events**              | ❌                    | ❌                  | ❌                     |
| **Poll**                   | ❌                    | ❌                  | ❌                     |

### Known Issues Fixed

- ✅ **errno naming conflict**: Enum variant destructuring (`.Other(errno)`) now properly sanitizes variable names in C codegen to avoid conflicts with C's `errno` macro.
- ✅ **Timer resource leak (Linux)**: timerfd and read buffer are now properly tracked and cleaned up via `dispose_fn` on an extended future struct.
- ✅ **Bitwise OR on c_include constants**: `c_include` constants (O_WRONLY, O_CREAT, etc.) had `UnknownValue` causing `ComptimeBitOr` to be selected. Fixed in `identifer-and-operator.ts` to treat extern "c" unknowns as runtime values.
- ✅ **Barrel re-export removed**: `std/io/index.yo` removed to avoid naming conflicts. Users now import submodules directly: `import "std/io/file"`, `import "std/io/timer"`, etc.
- ✅ **Runtime refactored**: 4012-line `runtime.ts` split into 4 focused modules for maintainability.
- ✅ **SSA variable mutation in async loops**: Variable reassignment inside loops in async state machines created new SSA variable IDs (e.g., `offset` → `offset_1`) but the loop condition always read the original, causing infinite loops. Fixed by adding `variableIdRemapping` to the await analysis that maps all SSA-renamed IDs back to the first version's captured variable. Also fixed `break` inside async while loop resume code breaking the C `switch` instead of the loop.
- ✅ **macOS async continuation threading**: GCD callbacks run on background threads, but the async task queue is thread-local. Added a cross-thread continuation queue in the macOS runtime and drain it on the event-loop thread during polling to ensure `sleep/timeout` and dispatch_io completions resume correctly.

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

### 2.1 Create `std/io/tcp.yo` — TCP Socket Operations

```yo
// std/io/tcp.yo

// Create a TCP socket
socket :: (fn(domain: i32) -> IOFuture)(...);

// Bind to an address
bind :: (fn(fd: i32, addr: *(u8), addrlen: u32) -> IOFuture)(...);

// Listen for connections
listen :: (fn(fd: i32, backlog: i32) -> IOFuture)(...);

// Accept an incoming connection
accept :: (fn(fd: i32) -> IOFuture)(...);

// Connect to a remote address
connect :: (fn(fd: i32, addr: *(u8), addrlen: u32) -> IOFuture)(...);

// Send data
send :: (fn(fd: i32, buf: *(u8), len: usize) -> IOFuture)(...);

// Receive data
recv :: (fn(fd: i32, buf: *(u8), len: usize) -> IOFuture)(...);

// Shutdown a socket
shutdown :: (fn(fd: i32, how: i32) -> IOFuture)(...);
```

### 2.2 Create `std/io/udp.yo` — UDP Socket Operations

```yo
// std/io/udp.yo

// Send datagram to address
sendto :: (fn(fd: i32, buf: *(u8), len: usize, dest: *(u8), addrlen: u32) -> IOFuture)(...);

// Receive datagram with source address
recvfrom :: (fn(fd: i32, buf: *(u8), len: usize, src: *(u8), addrlen: *(u32)) -> IOFuture)(...);
```

### 2.3 Create `std/io/addr.yo` — Socket Address Helpers

Wraps the extern `__yo_sockaddr_*` helpers into a typed Yo API:

```yo
// std/io/addr.yo

SockAddrIn :: object(
  _buf: [u8]
);

impl(SockAddrIn,
  new :: (fn(ip: *(u8), port: u16) -> Self)(...),
  ip :: (fn(self: Self) -> u32)(...),
  port :: (fn(self: Self) -> u16)(...),
  as_ptr :: (fn(self: Self) -> *(u8))(...),
  size :: (fn() -> u32)(...)
);
```

---

## Phase 3: DNS and Network Utilities (Priority: Medium)

### 3.1 Create `std/io/dns.yo` — DNS Resolution

```yo
// std/io/dns.yo

// Resolve hostname to addresses
getaddrinfo :: (fn(host: *(u8), service: *(u8)) -> IOFuture)(...);

// Reverse lookup
getnameinfo :: (fn(addr: *(u8), addrlen: u32) -> IOFuture)(...);
```

---

## Phase 4: Permission and Metadata Operations (Priority: Medium)

### 4.1 Create `std/io/perm.yo` — File Permissions

```yo
// std/io/perm.yo

// Change file permissions
chmod :: (fn(dirfd: i32, path: *(u8), mode: u32, flags: i32) -> IOFuture)(...);

// Change file ownership
chown :: (fn(dirfd: i32, path: *(u8), uid: u32, gid: u32, flags: i32) -> IOFuture)(...);

// Check file accessibility
access :: (fn(dirfd: i32, path: *(u8), mode: i32, flags: i32) -> IOFuture)(...);
```

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

## Phase 6: Windows IOCP Backend (Priority: Medium-High)

**Goal**: Implement the Windows async I/O backend using I/O Completion Ports.

This is the largest remaining gap. The timer is now implemented using `CreateThreadpoolTimer`, but all other IO operations are missing.

### 6.1 Windows Event Loop Integration

Add IOCP initialization, poll, and wait to `__yo_async_run_until_complete`:

```c
#if defined(_WIN32)
static HANDLE __yo_io_iocp = NULL;
static _Atomic size_t __yo_pending_io_count = 0;

static void __yo_io_init(void) {
  if (__yo_io_iocp) return;
  __yo_io_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
}

static int __yo_io_poll(void) {
  OVERLAPPED_ENTRY entries[64];
  ULONG count = 0;
  BOOL ok = GetQueuedCompletionStatusEx(__yo_io_iocp, entries, 64, &count, 0, FALSE);
  if (!ok || count == 0) return 0;
  for (ULONG i = 0; i < count; i++) {
    yo_io_future_t* future = (yo_io_future_t*)entries[i].lpOverlapped;
    // Process completion...
  }
  return (int)count;
}

static void __yo_io_wait(void) {
  OVERLAPPED_ENTRY entry;
  ULONG count = 0;
  GetQueuedCompletionStatusEx(__yo_io_iocp, &entry, 1, &count, INFINITE, FALSE);
  if (count > 0) {
    yo_io_future_t* future = (yo_io_future_t*)entry.lpOverlapped;
    // Process completion...
  }
}
```

### 6.2 Windows File I/O

| Operation | Win32 API                      | Notes                            |
| --------- | ------------------------------ | -------------------------------- |
| read      | `ReadFile` + `OVERLAPPED`      | Associate handle with IOCP       |
| write     | `WriteFile` + `OVERLAPPED`     | Associate handle with IOCP       |
| open      | `CreateFileW`                  | `FILE_FLAG_OVERLAPPED` for async |
| close     | `CloseHandle`                  | Sync                             |
| stat      | `GetFileInformationByHandleEx` | Sync wrapper                     |
| mkdir     | `CreateDirectoryW`             | Sync wrapper                     |
| unlink    | `DeleteFileW`                  | Sync wrapper                     |
| rename    | `MoveFileExW`                  | Sync wrapper                     |
| symlink   | `CreateSymbolicLinkW`          | Requires privileges              |
| fsync     | `FlushFileBuffers`             | Sync wrapper                     |
| truncate  | `SetFileInformationByHandle`   | Sync wrapper                     |

### 6.3 Windows Socket I/O

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

- Need `#include <winsock2.h>` and `#include <ws2tcpip.h>` before `<windows.h>`
- Must call `WSAStartup` before any Winsock operations
- File paths need `\\?\` prefix for long path support
- Statx doesn't exist — use `GetFileInformationByHandleEx`
- Symlinks require `SE_CREATE_SYMBOLIC_LINK_NAME` privilege

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

1. **Timer tests** — ✅ Done in `fixme.yo` (sleep, timeout)
2. **File I/O tests** — Open, read, write, close, stat a temp file
3. **Directory tests** — mkdir, readdir, rmdir
4. **Socket tests** — TCP echo server/client on localhost
5. **DNS tests** — Resolve `localhost`
6. **Permission tests** — chmod, access checks

For cross-platform validation:

- Linux: Run tests with `./yo-cli test` (uses AddressSanitizer)
- macOS: Same but links with system frameworks instead of liburing
- Windows: Use `zig` compiler, link with `ws2_32.lib`, `kernel32.lib`

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
  timer.yo         ← sleep, timeout                       ✅
  file.yo          ← Async file operations                ✅
  dir.yo           ← Async directory operations           ✅
  tcp.yo           ← TCP socket operations                Phase 2
  udp.yo           ← UDP socket operations                Phase 2
  addr.yo          ← Socket address helpers               Phase 2
  dns.yo           ← DNS resolution                       Phase 3
  perm.yo          ← File permissions                     Phase 4
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
