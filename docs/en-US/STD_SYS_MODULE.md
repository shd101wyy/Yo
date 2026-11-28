# std/sys Module

## Philosophy

Yo integrates platform-native async I/O APIs with the single-threaded async/await event loop:

| Platform    | Backend  | Status      | Description                                                                                    |
| ----------- | -------- | ----------- | ---------------------------------------------------------------------------------------------- |
| **Linux**   | io_uring | ✅ Complete | True async I/O with kernel-performed operations (kernel 5.6+; ring layer vendored, no library) |
| **macOS**   | kqueue   | ✅ Complete | kqueue event loop with non-blocking I/O for sockets/pipes, sync pread/pwrite for regular files |
| **Windows** | IOCP     | ✅ Complete | I/O Completion Ports with overlapped I/O                                                       |
| **FreeBSD** | kqueue   | 🔜 Planned  | Event notification + non-blocking I/O                                                          |

All async I/O operations run on the **same thread** as other async tasks — no worker threads involved.

### Why Not libuv?

We considered using **libuv** (Node.js's cross-platform async I/O library) but chose manual platform-specific implementations:

| Factor           | libuv                             | Manual Approach (Yo)                        |
| ---------------- | --------------------------------- | ------------------------------------------- |
| **Event Loop**   | Has its own event loop            | Integrates with Yo's async/await scheduler  |
| **Dependencies** | Requires libuv runtime            | No runtime dependencies (statically linked) |
| **Performance**  | Good, but abstraction overhead    | Maximum — native APIs directly              |
| **Control**      | Limited to libuv's model          | Full control over state machine integration |
| **Complexity**   | Lower initial, higher integration | Higher initial, cleaner long-term           |

**Key Insight**: Yo's async/await compiles to state machines. Platform-native async I/O (io_uring, kqueue, IOCP) integrates perfectly with this model — completions wake state machines directly. libuv's callback-based design would require an awkward bridge layer.

## Design Goals

1. **Single-threaded**: All async I/O runs on the event loop thread
2. **Non-atomic RC**: No synchronization overhead (single thread)
3. **Cross-platform**: Unified API across Linux/macOS/Windows
4. **Efficient**: Platform-native backends (io_uring/kqueue/IOCP)
5. **Simple API**: async/await syntax, no callbacks
6. **Memory efficient**: State machines (~200 bytes) per operation

---

## Module Structure

The `std/sys/` directory provides the low-level async I/O foundation. Users import submodules directly — there is no barrel `index.yo`:

```
std/sys/
├── advise.yo       — fadvise/madvise file advice hints
├── clock.yo        — clock_gettime (realtime + monotonic)
├── constants.yo    — File mode, permissions, AT_*, DT_*, open flags, O_*
├── copy.yo         — copyfile, sendfile
├── dir.yo          — mkdir, unlink, rename, symlink, link, readlink, getdents/readdir
├── dns.yo          — getaddrinfo, getnameinfo, addrinfo accessors
├── errors.yo       — IoError enum with errno mapping, Display impl
├── events.yo       — TTY/poll/FS event constants + FS-event / poll wrappers
├── externs.yo      — Runtime helper externs (sync syscalls, accessors, wakers)
├── fallocate.yo    — fallocate (pre-allocate file space)
├── fcntl.yo        — getfl/setfl/getfd/setfd (file descriptor flags)
├── file.yo         — Async + sync file ops (openat, read, write, stat, fsync, etc.)
├── future.yo       — park, yield, completed (IoFuture lives in the prelude)
├── iov.yo          — readv/writev/preadv/pwritev + iovec helpers
├── lock.yo         — flock advisory locking
├── mmap.yo         — mmap, munmap, mprotect, msync
├── path.yo         — realpath
├── perm.yo         — fchmod, chmodat, fchown, chownat, access
├── pipe.yo         — pipe, dup, dup2
├── process.yo      — spawn, waitpid, kill
├── seek.yo         — lseek wrappers
├── signal.yo       — on_signal, off_signal, kill
├── signals.yo      — Platform-aware POSIX signal number constants
├── socket.yo       — Platform-aware AF_*, SOCK_*, SO_*, TCP_* constants + NI_* constants
├── socketpair.yo   — Connected socket pair
├── sockinfo.yo     — getsockname, getpeername, getsockopt, setsockopt
├── statfs.yo       — statfs + accessors (sync)
├── statx.yo        — File metadata accessor object (wraps __yo_statx_t)
├── sysinfo.yo      — uname, gethostname
├── tcp.yo          — Socket, bind, listen, accept, connect, send, recv, close
├── temp.yo         — mkdtemp, mkstemp
├── time.yo         — utime, futime, lutime (file timestamp operations)
├── timer.yo        — sleep(ms)
├── tty.yo          — tty init/mode/winsize/isatty
├── udp.yo          — Socket, bind, sendto, recvfrom, send, recv, close
├── umask.yo        — process file creation mask
└── unix.yo         — Unix domain sockets
```

**Import pattern**: Use namespace import to avoid naming conflicts, e.g.:

```yo
file :: import("std/sys/file");
dir :: import("std/sys/dir");
tcp :: import("std/sys/tcp");
timer :: import("std/sys/timer");
```

**Every operation takes the `Io`.** A function that returns an `IoFuture`
(`openat`, `read`, `accept`, `sleep`, …) takes the `Io` it runs on as its last
argument and calls that `Io`'s table (`io.vtable.*.read(io.ctx, …)`, the
prelude's `IoVTable`). The watch registrations in `events.yo` (`poll_*`,
`fs_event_*`) take it too. Await an operation where you make it:

```yo
pragma(Pragma.AllowUnsafe);
file :: import("std/sys/file");
{ AT_FDCWD, O_RDONLY } :: import("std/sys/constants");

main :: (fn(io : Io) -> unit)({
  fd := io.await(file.openat(AT_FDCWD, (*u8)("/etc/hostname"), O_RDONLY, i32(0), io), io);
  if(fd >= i32(0), {
    _c := io.await(file.close(fd, io), io);
  });
});
export(main);
```

The synchronous helpers (`open_sync`, `fcntl`, `mmap`, the address and stat
accessors) are blocking calls and take no `Io`.

---

## Component Status

### Yo Modules (`std/sys/`)

| Component        | File            | Status      | Notes                                                    |
| ---------------- | --------------- | ----------- | -------------------------------------------------------- |
| Constants        | `constants.yo`  | ✅ Complete | File mode, permissions, AT*\*, DT*\*, open flags         |
| Socket Constants | `socket.yo`     | ✅ Complete | Platform-aware AF*\*, SOCK*\_, SO\_\_, TCP*\*, NI*\*     |
| Signals          | `signals.yo`    | ✅ Complete | Platform-aware POSIX signal numbers                      |
| Events           | `events.yo`     | ✅ Complete | TTY/poll/FS event constants + FS/poll wrappers           |
| IoError          | `errors.yo`     | ✅ Complete | Enum with errno mapping, Display impl                   |
| Future           | `future.yo`     | ✅ Complete | `park`, `yield`, `completed`; `IoFuture` is the prelude's |
| Externs          | `externs.yo`    | ✅ Complete | Runtime helper externs; operations go through the `Io`   |
| Statx            | `statx.yo`      | ✅ Complete | File metadata accessor object                            |
| Timer            | `timer.yo`      | ✅ Complete | `sleep(ms)`                                              |
| File             | `file.yo`       | ✅ Complete | Async+sync file ops (openat, read, write, etc.)          |
| Dir              | `dir.yo`        | ✅ Complete | mkdir, unlink, rename, symlink, link, readlink, getdents |
| TCP              | `tcp.yo`        | ✅ Complete | Socket, bind, listen, accept, connect, send, recv, close |
| UDP              | `udp.yo`        | ✅ Complete | Socket, bind, sendto, recvfrom, send, recv, close        |
| Unix             | `unix.yo`       | ✅ Complete | Unix domain sockets + tests                              |
| Process          | `process.yo`    | ✅ Complete | spawn, waitpid, kill + tests                             |
| DNS              | `dns.yo`        | ✅ Complete | getaddrinfo, getnameinfo, addrinfo accessors             |
| Perm             | `perm.yo`       | ✅ Complete | fchmod, chmodat, fchown, chownat, access                 |
| Time             | `time.yo`       | ✅ Complete | utime, futime, lutime (file timestamp operations)        |
| Pipe             | `pipe.yo`       | ✅ Complete | pipe, dup, dup2 + tests                                  |
| Copy             | `copy.yo`       | ✅ Complete | copyfile, sendfile + tests                               |
| Signal           | `signal.yo`     | ✅ Complete | on_signal, off_signal, kill + tests                      |
| TTY              | `tty.yo`        | ✅ Complete | tty init/mode/winsize/isatty + tests                     |
| Temp             | `temp.yo`       | ✅ Complete | mkdtemp, mkstemp + tests                                 |
| Path             | `path.yo`       | ✅ Complete | realpath + tests                                         |
| Statfs           | `statfs.yo`     | ✅ Complete | statfs + accessors (sync)                                |
| Fcntl            | `fcntl.yo`      | ✅ Complete | getfl/setfl/getfd/setfd + tests                          |
| Mmap             | `mmap.yo`       | ✅ Complete | mmap, munmap, mprotect, msync + tests                    |
| Lock             | `lock.yo`       | ✅ Complete | flock advisory locking + tests                           |
| SockInfo         | `sockinfo.yo`   | ✅ Complete | getsockname, getpeername, getsockopt, setsockopt + tests |
| SocketPair       | `socketpair.yo` | ✅ Complete | Connected socket pair + tests                            |
| Clock            | `clock.yo`      | ✅ Complete | clock_gettime (realtime + monotonic) + tests             |
| SysInfo          | `sysinfo.yo`    | ✅ Complete | uname, gethostname + tests                               |
| Umask            | `umask.yo`      | ✅ Complete | Process file creation mask + tests                       |
| Iov              | `iov.yo`        | ✅ Complete | readv/writev/preadv/pwritev + iovec helpers + tests      |
| Seek             | `seek.yo`       | ✅ Complete | lseek wrappers                                           |
| Fallocate        | `fallocate.yo`  | ✅ Complete | fallocate (pre-allocate file space)                      |
| Advise           | `advise.yo`     | ✅ Complete | fadvise/madvise file advice hints                        |

### API Coverage

| Category           | APIs                                                                                  | Status      |
| ------------------ | ------------------------------------------------------------------------------------- | ----------- |
| **Timers**         | `sleep`                                                                               | ✅ Complete |
| **File I/O**       | `read`, `write`, `open`, `close`, `stat`, `truncate`, `fsync`, `fdatasync`            | ✅ Complete |
| **File Extras**    | `access`, `realpath`, `utime`, `mkdtemp`, `mkstemp`, `copyfile`, `sendfile`, `statfs` | ✅ Complete |
| **File Advice**    | `fadvise`, `madvise`, `fallocate`, `lseek`                                            | ✅ Complete |
| **Directory Ops**  | `mkdir`, `unlink`, `rename`, `symlink`, `link`, `readdir`, `getdents`                 | ✅ Complete |
| **Permissions**    | `chmod`, `chown`, `access`                                                            | ✅ Complete |
| **FD Ops**         | `dup`, `dup2`, `pipe`, `fcntl`                                                        | ✅ Complete |
| **Memory Mapping** | `mmap`, `munmap`, `mprotect`, `msync`                                                 | ✅ Complete |
| **File Locking**   | `flock`                                                                               | ✅ Complete |
| **Sockets**        | `socket`, `bind`, `listen`, `accept`, `connect`, `send`, `recv`, `sendto`, `recvfrom` | ✅ Complete |
| **Socket Options** | `setsockopt`, `getsockopt`, `shutdown`, `getsockname`, `getpeername`, `socketpair`    | ✅ Complete |
| **DNS**            | `getaddrinfo`, `getnameinfo`                                                          | ✅ Complete |
| **Signals**        | `on_signal`, `off_signal`, `kill`                                                     | ✅ Complete |
| **TTY**            | `tty_init`, `tty_set_mode`, `tty_reset_mode`, `tty_get_winsize`, `isatty`             | ✅ Complete |
| **FS Events**      | `fs_event_init`, `fs_event_start`, `fs_event_stop`, `fs_event_close`                  | ✅ Complete |
| **Poll**           | `poll_init`, `poll_start`, `poll_stop`, `poll_close`                                  | ✅ Complete |
| **Clocks**         | `clock_gettime` (realtime + monotonic)                                                | ✅ Complete |
| **System Info**    | `uname`, `gethostname`, `umask`                                                       | ✅ Complete |
| **Process**        | `spawn`, `waitpid`, `kill`                                                            | ✅ Complete |
| **Vectored I/O**   | `readv`, `writev`, `preadv`, `pwritev`                                                | ✅ Complete |

---

## C Runtime Architecture

The C runtime is split into focused modules under `src/codegen/async/`:

| File                    | Responsibility                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `runtime.yo`            | Thin coordinator — calls the other runtime modules                                       |
| `runtime-core.yo`       | Core scheduler: continuation queue, spawn, wait, concurrency helpers                     |
| `runtime-io-linux.yo`   | Linux io_uring async I/O                                                                 |
| `runtime-io-macos.yo`   | macOS kqueue async I/O (non-blocking sockets/pipes, sync pread/pwrite for regular files) |
| `runtime-io-windows.yo` | Windows IOCP async I/O                                                                   |
| `runtime-io-common.yo`  | Cross-platform: stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll     |

### Per-Platform Feature Matrix

| Category                    | Linux (io_uring)      | macOS (kqueue)         | Windows (IOCP)                                        |
| --------------------------- | --------------------- | ---------------------- | ----------------------------------------------------- |
| **Event loop integration**  | ✅                    | ✅                     | ✅ (IOCP)                                             |
| **File read/write**         | ✅                    | ✅                     | ✅ (IOCP)                                             |
| **File open/close**         | ✅                    | ✅                     | ✅ (sync wrappers)                                    |
| **Stat**                    | ✅ (statx)            | ✅ (struct stat)       | ✅ (\_\_yo_win_stat_t + FILETIME 100ns precision)     |
| **fstat (by descriptor)**   | ✅ (statx + `AT_EMPTY_PATH`) | ✅ (`fstat`)     | ✅ (`_fstat64` + GetFileInformationByHandle)          |
| **mkdir/unlink/rename**     | ✅                    | ✅ (sync wrappers)     | ✅ (sync wrappers)                                    |
| **symlink/link**            | ✅                    | ✅ (sync wrappers)     | ✅ (CreateSymbolicLinkW/CreateHardLinkW)              |
| **fsync/fdatasync**         | ✅                    | ✅ (sync wrappers)     | ✅ (`_commit`)                                        |
| **ftruncate**               | ✅                    | ✅ (sync wrapper)      | ✅ (`_chsize_s`)                                      |
| **chmod/chown**             | ✅ (sync)             | ✅ (sync)              | ✅ (sync; chmod only; chown returns 0 for -1/-1)      |
| **readlink**                | ✅ (sync)             | ✅ (sync)              | ✅ (sync, FSCTL_GET_REPARSE_POINT)                    |
| **dup/dup2/pipe**           | ✅ (sync)             | ✅ (sync)              | ✅ (sync)                                             |
| **Socket ops**              | ✅                    | ✅ (kqueue readiness)  | ✅ (IOCP WSASend/WSARecv)                             |
| **Timer (sleep)**           | ✅ (per-thread timer heap bounding the io_uring/epoll wait) | ✅ (EVFILT_TIMER)      | ✅ (IOCP wait timeout)                                |
| **getdents/readdir**        | ✅ (getdents64)       | ✅ (readdir emulation) | ✅ (FindFirstFileW/FindNextFileW)                     |
| **access/realpath**         | ✅ (sync)             | ✅ (sync)              | ✅ (sync)                                             |
| **utime**                   | ✅ (sync)             | ✅ (sync)              | ✅ (sync, FILE_WRITE_ATTRIBUTES reopen)               |
| **mkdtemp/mkstemp**         | ✅ (sync)             | ✅ (sync)              | ✅ (sync)                                             |
| **copyfile/sendfile**       | ✅ (sync)             | ✅ (sync)              | ✅ (CopyFileW; sendfile via read/write)               |
| **statfs**                  | ✅ (sync)             | ✅ (sync)              | ✅ (GetDiskFreeSpaceEx)                               |
| **DNS**                     | ✅ (sync)             | ✅ (sync)              | ✅ (sync, WSAStartup auto-init)                       |
| **Signals**                 | ✅ (sync)             | ✅ (sync)              | ✅ (local handlers + kill(pid=0) + kill(pid,SIGKILL)) |
| **TTY**                     | ✅ (sync)             | ✅ (sync)              | ✅ (Console API, GetConsoleScreenBufferInfo)          |
| **Unix sockets**            | ✅ (sockaddr_un)      | ✅ (sockaddr_un)       | ✅ (AF_UNIX Win10 1803+)                              |
| **Process spawn**           | ✅ (posix_spawn)      | ✅ (posix_spawn)       | ✅ (CreateProcessW)                                   |
| **fcntl**                   | ✅ (sync)             | ✅ (sync)              | ✅ (best-effort abstraction)                          |
| **mmap**                    | ✅ (sync)             | ✅ (sync)              | ✅ (CreateFileMapping/MapViewOfFile)                  |
| **flock**                   | ✅ (sync)             | ✅ (sync)              | ✅ (LockFileEx/UnlockFileEx)                          |
| **FS Events**               | ✅ (inotify)          | ✅ (kqueue+snapshot)   | ✅ (ReadDirectoryChangesW)                            |
| **Poll**                    | ✅ (poll)             | ✅ (poll)              | ✅ (select/PeekNamedPipe)                             |
| **lseek**                   | ✅ (sync)             | ✅ (sync)              | ✅ (`_lseeki64`)                                      |
| **getsockname/getpeername** | ✅ (sync)             | ✅ (sync)              | ✅ (sync, Winsock)                                    |
| **socketpair**              | ✅ (sync)             | ✅ (sync)              | ✅ (loopback emulation)                               |
| **clock_gettime**           | ✅ (sync)             | ✅ (sync)              | ✅ (realtime FILETIME + monotonic QPC)                |
| **uname/gethostname**       | ✅ (sync)             | ✅ (sync)              | ✅ (Winsock gethostname + uname emulation)            |
| **umask**                   | ✅ (sync)             | ✅ (sync)              | ✅ (custom emulation — CRT `_umask` broken)           |
| **readv/writev**            | ✅ (sync)             | ✅ (sync)              | ✅ (Win32 ReadFile/WriteFile + WSA for sockets)       |
| **fallocate**               | ✅ (sync)             | ✅ (sync)              | ✅ (FileAllocationInfo)                               |
| **fadvise/madvise**         | ✅ (sync)             | ✅ (sync)              | ✅ (fadvise no-op + MADV_DONTNEED best-effort)        |

---

## Architecture

### Event Loop with Async I/O

```
┌────────────────────────────────────────────────────────────────┐
│                    Event Loop (Main Thread)                    │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Ready Queue                          │   │
│  │  ┌─────┐ ┌─────┐ ┌─────┐                               │   │
│  │  │Task1│ │Task2│ │Task3│  ...                          │   │
│  │  └─────┘ └─────┘ └─────┘                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Poll next ready task                       │   │
│  │    - Run until await                                    │   │
│  │    - If I/O await, submit to platform backend           │   │
│  │    - If ready, continue                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              I/O Completion Check (non-blocking poll)   │   │
│  │    - Extract result (bytes read/written, error)         │   │
│  │    - Wake waiting state machine                         │   │
│  │    - Add to ready queue                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │    If no ready tasks but pending I/O, block on backend  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Platform Abstraction Layer

```c
// Initialize platform backend (called once at event loop start)
void __yo_io_init(void);
void __yo_io_cleanup(void);

// Check pending I/O
bool __yo_has_pending_io(void);

// Poll/wait for completions
int __yo_io_poll(void);   // Non-blocking, returns completion count
int __yo_io_wait(void);   // Blocking, waits for at least one completion
```

### Linux: io_uring

io_uring is Linux's modern async I/O interface (introduced in kernel 5.1; this runtime's floors are below):

- **Submission Queue (SQ)**: Ring buffer for submitting I/O requests
- **Completion Queue (CQ)**: Ring buffer for completed I/O results
- **Zero-copy**: Shared memory between user space and kernel
- **Batching**: Multiple I/O operations per syscall
- **True async**: Kernel performs I/O, not just notification

**No library dependency**: the ring layer (setup/mmap, submission, completion, the SQE prep helpers) is vendored into the emitted C under the `__yo_uring_*` namespace (`plans/reference/DROP_LIBURING.md`). A compiled program links against libc only — nothing to install, and the kernel, not the build box, decides whether io_uring exists.

**Kernel version requirements:**

| Kernel Version | Features                                                     |
| -------------- | ------------------------------------------------------------ |
| **5.6+**       | The core operation set: read/write, openat/close/statx/fsync, sockets (accept/connect/send/recv/sendmsg/recvmsg) |
| **5.11+**      | `renameat` / `unlinkat` (rename, remove a file or directory) |
| **5.15+**      | `mkdirat` / `symlinkat` / `linkat` (create a directory, symlink, hard link) |
| **5.19 / 6.0 / 6.1** | `COOP_TASKRUN` / `SINGLE_ISSUER` / `DEFER_TASKRUN` setup flags — requested together, retried without flags when the kernel refuses |
| **6.14+**      | Async `ftruncate` (older kernels answer `-EINVAL` through the future) |

On a kernel that has io_uring but predates an operation's row, the runtime completes that operation synchronously, the way the epoll fallback does. It asks the kernel once, at ring setup (`IORING_REGISTER_PROBE`), which opcodes exist, so the operation still works rather than failing with `-EINVAL`. Where io_uring cannot initialise at all (kernel < 5.6's ring, Docker's default seccomp profile, gVisor, hardened kernels), the runtime runs on the epoll fallback, which completes the name operations synchronously (`docs/en-US/ASYNC_AWAIT.md`, the backend ladder).

### macOS: kqueue

macOS uses `kqueue` for async I/O — a single-threaded, pull-based event notification mechanism similar to Linux's io_uring.

For **file I/O**, macOS uses synchronous `pread`/`pwrite` for regular files (fast on macOS with the unified buffer cache). A `pread` that answers `ESPIPE` (pipe, socket, FIFO) or `ENXIO` (tty) moves the operation to non-blocking I/O with `EVFILT_READ`/`EVFILT_WRITE` readiness notifications; an `O_APPEND` descriptor writes at end-of-file (macOS `pwrite` would honor the offset).

For **socket I/O**, every socket the runtime creates is `O_NONBLOCK`:

- Each `accept`/`recv`/`recvfrom`/`send`/`sendto` first attempts a non-blocking call (`MSG_DONTWAIT`), unless an earlier operation of the same direction is still parked on the descriptor; on `EAGAIN`/`EWOULDBLOCK` it parks on the descriptor's registration
- A descriptor's registration is one `EV_DISPATCH` knote per direction, re-enabled per park (`EV_ADD|EV_ENABLE`, which rides the loop's next `kevent()`); parked operations are a FIFO per direction, found by `(ident, filter)` through a per-fd slot table; `connect` completion checks `SO_ERROR`
- Aborting a task cancels its parked operation (`-ECANCELED`), and closing or `dup2`-ing over the descriptor fails its parked operations with `-EBADF`
- All completions are harvested on the event loop thread via `kevent()` — no cross-thread synchronization needed

**Timer**: a per-thread timer heap; the loop's blocking `kevent()` is bounded by the earliest deadline, so arming and cancelling a sleep costs no syscall.

### Windows: IOCP

IOCP is Windows' native async I/O mechanism:

- **Completion-based**: Notifies when I/O operation completes
- **True async**: Kernel performs the I/O operation
- **Overlapped I/O**: Uses OVERLAPPED structures for async state
- Sockets are associated with IOCP at creation/accept time
- TCP send/recv use `WSASend`/`WSARecv` with OVERLAPPED
- File handles are associated via `CreateIoCompletionPort` at open time; duplicate association is tolerated (`ERROR_INVALID_PARAMETER` on second call is ignored)
- Winsock is initialized lazily via `WSAStartup` in `__yo_io_init()`
- Winsock error codes are translated to errno at every socket-error site (`__yo_wsa_to_errno`), so `IoError.from_errno` classifies them on Windows like everywhere else: `WSAEADDRINUSE` surfaces as `AddressInUse`, would-block as `WouldBlock`, a code with no errno counterpart as `EIO` (2026-10; before, socket failures came back as raw `os error 10048`-style "unknown I/O error")
- `readlink` reads the reparse point (`FSCTL_GET_REPARSE_POINT`): a symlink/junction answers its substitute name with the object-manager prefix stripped, and a non-link throws `EINVAL` — the POSIX `readlink` contract (2026-10; the previous `GetFinalPathNameByHandleW` shim answered the link's own path and never threw)

**Header conflict guard**: Every generated C file on Windows emits `WIN32_LEAN_AND_MEAN` and `_WINSOCKAPI_` to prevent `winsock.h`/`winsock2.h` redefinition errors.

### State Machine Integration

An `io.await(file.read(fd, buf, n, offset, io), io)` inside a task calls the
`Io`'s `read` entry, which for the native `Io` submits the operation to this
thread's backend and returns its `IoFuture` (`__yo_io_future_t`, laid out like
a state machine: the future prefix plus `result`). The await then reads the
future's `state`: an operation that already completed (`-1`, the common case
for regular files on macOS and Windows) continues inline; otherwise the task
registers itself as the future's continuation and returns to the loop, and the
backend's completion wakes it.

---

## Performance Characteristics

### Memory Usage

**10,000 concurrent async I/O operations:**

| Resource                     | Cost                            |
| ---------------------------- | ------------------------------- |
| State machines               | 10,000 × ~200 bytes = **~2 MB** |
| io_uring SQEs (ring, reused) | 1024 × 64 bytes = **64 KB**     |
| **Total**                    | **~2 MB**                       |

Compare to 10,000 blocking threads × 1 MB stack = **10 GB** ❌

### Throughput

- io_uring batches submissions: fewer syscalls
- Zero-copy for many operations (Linux)
- No thread context switching (single-threaded)
- State machine resumption: ~10–50 ns

### Latency

| Stage               | Approximate Cost |
| ------------------- | ---------------- |
| io_uring submission | ~50–100 ns       |
| io_uring completion | ~100–200 ns      |
| kqueue kevent()     | ~200 ns with an event ready; ~12 µs for a zero-timeout call that finds nothing (macOS 26), which the runtime avoids with a ~0.2 µs `select()` probe |
| IOCP completion     | ~100–300 ns      |

---

## Known Windows Limitations

- **Symlinks require elevated privileges**: `CreateSymbolicLinkW` requires admin privileges or Developer Mode. The `lutime` symlink test is expected to fail without elevation.
- **NTFS nanosecond precision is 100 ns**: FILETIME stores time in 100-nanosecond intervals. Nanosecond values not divisible by 100 are truncated (e.g., 123456789 ns → 123456700 ns).
- **UDP sendto/recvfrom are synchronous**: Unlike TCP send/recv (IOCP), UDP uses blocking Winsock calls (datagrams complete instantly in practice).

---

## References

### Linux (io_uring)

- [io_uring documentation](https://kernel.dk/io_uring.pdf)
- [liburing](https://github.com/axboe/liburing)
- [io_uring man pages](https://man7.org/linux/man-pages/man7/io_uring.7.html)

### macOS (kqueue)

- [kqueue(2) man page](https://www.freebsd.org/cgi/man.cgi?query=kqueue&sektion=2)
- [Apple kqueue documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html)

### Windows (IOCP)

- [I/O Completion Ports (MSDN)](https://learn.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Winsock 2 reference](https://learn.microsoft.com/en-us/windows/win32/winsock/winsock-reference)
