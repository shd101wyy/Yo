# std/sys Module

## Philosophy

Yo integrates platform-native async I/O APIs with the single-threaded async/await event loop:

| Platform    | Backend  | Status      | Description                                                                                    |
| ----------- | -------- | ----------- | ---------------------------------------------------------------------------------------------- |
| **Linux**   | io_uring | ✅ Complete | True async I/O with kernel-performed operations (kernel 5.1+)                                  |
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
├── errors.yo       — IoError enum with errno mapping, ToString impl
├── events.yo       — TTY/poll/FS event constants + FS-event / poll wrappers
├── externs.yo      — All C extern function declarations
├── fallocate.yo    — fallocate (pre-allocate file space)
├── fcntl.yo        — getfl/setfl/getfd/setfd (file descriptor flags)
├── file.yo         — Async + sync file ops (openat, read, write, stat, fsync, etc.)
├── future.yo       — IoFuture extern type wrapping __yo_io_future_t
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

```rust
file   :: import "std/sys/file";
dir    :: import "std/sys/dir";
tcp    :: import "std/sys/tcp";
timer  :: import "std/sys/timer";
```

---

## Component Status

### Yo Modules (`std/sys/`)

| Component        | File            | Status      | Notes                                                    |
| ---------------- | --------------- | ----------- | -------------------------------------------------------- |
| Constants        | `constants.yo`  | ✅ Complete | File mode, permissions, AT*\*, DT*\*, open flags         |
| Socket Constants | `socket.yo`     | ✅ Complete | Platform-aware AF*\*, SOCK*\_, SO\_\_, TCP*\*, NI*\*     |
| Signals          | `signals.yo`    | ✅ Complete | Platform-aware POSIX signal numbers                      |
| Events           | `events.yo`     | ✅ Complete | TTY/poll/FS event constants + FS/poll wrappers           |
| IoError          | `errors.yo`     | ✅ Complete | Enum with errno mapping, ToString impl                   |
| IoFuture         | `future.yo`     | ✅ Complete | Extern type wrapping `__yo_io_future_t`                  |
| Externs          | `externs.yo`    | ✅ Complete | All C extern function declarations                       |
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
| `runtime_core.yo`       | Core scheduler: continuation queue, spawn, wait, concurrency helpers                     |
| `runtime_io_linux.yo`   | Linux io_uring async I/O                                                                 |
| `runtime_io_macos.yo`   | macOS kqueue async I/O (non-blocking sockets/pipes, sync pread/pwrite for regular files) |
| `runtime_io_windows.yo` | Windows IOCP async I/O                                                                   |
| `runtime_io_common.yo`  | Cross-platform: stat helpers, timer, file extras, DNS, signals, TTY, FS events, poll     |

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
| **readlink**                | ✅ (sync)             | ✅ (sync)              | ✅ (GetFinalPathNameByHandleW)                        |
| **dup/dup2/pipe**           | ✅ (sync)             | ✅ (sync)              | ✅ (sync)                                             |
| **Socket ops**              | ✅                    | ✅ (kqueue readiness)  | ✅ (IOCP WSASend/WSARecv)                             |
| **Timer (sleep)**           | ✅ (timerfd+io_uring) | ✅ (EVFILT_TIMER)      | ✅ (IOCP wait timeout)                                |
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

io_uring is Linux's modern async I/O interface (kernel 5.1+):

- **Submission Queue (SQ)**: Ring buffer for submitting I/O requests
- **Completion Queue (CQ)**: Ring buffer for completed I/O results
- **Zero-copy**: Shared memory between user space and kernel
- **Batching**: Multiple I/O operations per syscall
- **True async**: Kernel performs I/O, not just notification

**liburing dependency**: Yo uses liburing (a thin ~5KB wrapper maintained by Jens Axboe) rather than raw io_uring syscalls. Install it via your package manager:

```bash
# Arch Linux / Manjaro
sudo pacman -S liburing

# Ubuntu / Debian
sudo apt-get install liburing-dev

# Fedora / RHEL
sudo dnf install liburing-devel
```

The Yo compiler detects liburing via `pkg-config liburing --cflags --libs`. Link with `-luring` when using async I/O on Linux.

**Kernel version requirements:**

| Kernel Version | Features                              |
| -------------- | ------------------------------------- |
| **5.1+**       | Basic io_uring (read, write, fsync)   |
| **5.6+**       | Registered buffers, linked operations |
| **5.11+**      | Better performance, more operations   |

### macOS: kqueue

macOS uses `kqueue` for async I/O — a single-threaded, pull-based event notification mechanism similar to Linux's io_uring.

For **file I/O**, macOS uses synchronous `pread`/`pwrite` for regular files (fast on macOS with the unified buffer cache). For pipes, sockets, and TTYs, non-blocking I/O with `EVFILT_READ`/`EVFILT_WRITE` readiness notifications is used.

For **socket I/O**, all sockets are set to `O_NONBLOCK`:

- Each `accept`/`recv`/`recvfrom` first attempts a non-blocking call; if `EAGAIN`/`EWOULDBLOCK` occurs, a `EVFILT_READ` kevent with `EV_ONESHOT` is registered
- `connect`/`send`/`sendto` use `EVFILT_WRITE` with `EV_ONESHOT`; connect completion checks `SO_ERROR`
- All completions are harvested on the event loop thread via `kevent()` — no cross-thread synchronization needed

**Timer**: `EVFILT_TIMER` with `EV_ONESHOT` and `NOTE_USECONDS` provides one-shot timer delivery.

### Windows: IOCP

IOCP is Windows' native async I/O mechanism:

- **Completion-based**: Notifies when I/O operation completes
- **True async**: Kernel performs the I/O operation
- **Overlapped I/O**: Uses OVERLAPPED structures for async state
- Sockets are associated with IOCP at creation/accept time
- TCP send/recv use `WSASend`/`WSARecv` with OVERLAPPED
- File handles are associated via `CreateIoCompletionPort` at open time; duplicate association is tolerated (`ERROR_INVALID_PARAMETER` on second call is ignored)
- Winsock is initialized lazily via `WSAStartup` in `__yo_io_init()`

**Header conflict guard**: Every generated C file on Windows emits `WIN32_LEAN_AND_MEAN` and `_WINSOCKAPI_` to prevent `winsock.h`/`winsock2.h` redefinition errors.

### State Machine Integration

When codegen encounters `await __yo_async_read(...)`, the generated C state machine:

```c
case STATE_AWAIT_READ:
  // First entry: submit I/O and suspend
  if (!sm->io_state.completed) {
    sm->io_state.state_machine = sm;
    sm->io_state.resume_fn = (void(*)(void*))this_resume_fn;
    sm->io_state.completed = false;

    __yo_async_read_start(sm->fd, sm->buffer, sm->size, sm->offset, &sm->io_state);

    // Suspend — do NOT add to ready queue yet
    // Platform backend completion will wake us
    return;
  }

  // Resumed after I/O completion
  sm->result = sm->io_state.result;
  sm->io_state.completed = false;
  sm->state = STATE_NEXT;
  // Fall through to next state...
```

---

## Performance Characteristics

### Memory Usage

**10,000 concurrent async I/O operations:**

| Resource                     | Cost                            |
| ---------------------------- | ------------------------------- |
| State machines               | 10,000 × ~200 bytes = **~2 MB** |
| io_uring SQEs (ring, reused) | 256 × 64 bytes = **16 KB**      |
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
| kqueue kevent()     | ~200–500 ns      |
| IOCP completion     | ~100–300 ns      |

---

## Known Windows Limitations

- **Symlinks require elevated privileges**: `CreateSymbolicLinkW` requires admin privileges or Developer Mode. The `lutime` symlink test is expected to fail without elevation.
- **NTFS nanosecond precision is 100 ns**: FILETIME stores time in 100-nanosecond intervals. Nanosecond values not divisible by 100 are truncated (e.g., 123456789 ns → 123456700 ns).
- **UDP sendto/recvfrom are synchronous**: Unlike TCP send/recv (IOCP), UDP uses blocking Winsock calls (datagrams complete instantly in practice).

---

## Known Issues Fixed

- **errno naming conflict**: Enum variant destructuring (`.Other(errno)`) now sanitizes variable names in C codegen to avoid conflicts with C's `errno` macro.
- **Timer resource leak (Linux)**: timerfd and read buffer are properly tracked and cleaned up via `dispose_fn` on an extended future struct.
- **Bitwise OR on c_include constants**: `c_include` constants (O_WRONLY, O_CREAT, etc.) had `UnknownValue`, causing `ComptimeBitOr` to be selected. Fixed in `identifer-and-operator.ts` to treat extern "c" unknowns as runtime values.
- **Imported namespace constant access in C codegen**: Expressions like `fcntl_io.O_NONBLOCK` emitted invalid C (`/* skip generating: namespace */.FIELD`) because imported comptime namespace values are not emitted as runtime expressions. Fixed in `src/codegen/exprs/property-access.ts`.
- **Barrel re-export removed**: `std/sys/index.yo` removed to avoid naming conflicts. Users import submodules directly.
- **SSA variable mutation in async loops**: Variable reassignment inside loops created new SSA variable IDs (e.g., `offset` → `offset_1`) but the loop condition always read the original ID, causing infinite loops. Fixed by adding `variableIdRemapping` in the await analysis. Also fixed `break` inside async while loops breaking the C `switch` instead of the loop.
- **macOS async continuation threading**: Migrated from GCD to kqueue. All I/O completions are now processed on the event loop thread — no cross-thread continuation queue needed.
- **macOS getdents linker fix**: Replaced unavailable `getdirentries` with a `readdir`-based emulation using `dup(fd)` + `fdopendir` to avoid 64-bit inode stub symbols on arm64.
- **Windows test runner missing ws2_32**: The test runner did not link `-lws2_32` on Windows. Fixed in `src/test-runner.ts`.
- **Windows tty test unistd header**: `tests/io/tty.test.yo` imported `std/libc/unistd` unconditionally, including `<unistd.h>` on Windows. Fixed by moving the import into the non-Windows branch.
- **Windows temp directory open requires `O_DIRECTORY`**: `openat` enables `FILE_FLAG_BACKUP_SEMANTICS` (required for directories) only when `O_DIRECTORY` is set. Fixed `tests/io/temp.test.yo` to open mkdtemp results with `(O_RDONLY | O_DIRECTORY)`.
- **Windows signal support**: Replaced stubs with handler registration and local signal delivery. `kill(pid=0, signum)` delivers to current process; `kill(pid, 0)` probes process existence; `kill(pid, SIGKILL)` uses `OpenProcess(PROCESS_TERMINATE)`.
- **Windows AT_FDCWD**: Added `#ifndef AT_FDCWD / #define AT_FDCWD -100 / #endif` to the Windows IOCP runtime.
- **Windows IOCP double handle association**: `__yo_win_associate_handle` now tolerates already-associated handles (`ERROR_INVALID_PARAMETER` → return true).
- **Windows winsock header conflict**: `WIN32_LEAN_AND_MEAN` and `_WINSOCKAPI_` are emitted at the top of every generated C file on Windows.
- **Windows file test path**: Replaced hardcoded `/tmp/` with cross-platform `temp_dir()` + `path_join()`.
- **Comptime constant C macro name collision**: Compile-time-only constants (e.g., `AF_INET`) passed as function arguments created local C variables conflicting with header macros. Fixed in `src/codegen/exprs/other-fn-call.ts` by inlining the literal directly.
- **Pointer-to-nullable-pointer codegen bug**: `*(?*(T))` generated `uint8_t*` instead of `uint8_t**`. Fixed in `src/codegen/utils/index.ts` `getTypeString()`.
- **Async state machine dangling reassignment temps**: Reassignment inside begin blocks emitted undeclared temp variable references. Fixed in `src/codegen/exprs/assignment.ts` to return `""` when `skippedTempVar` is true.
- **macOS socket ops async**: `accept`, `connect`, `send`, `recv`, `sendto`, `recvfrom` use kqueue `EVFILT_READ`/`EVFILT_WRITE` with `EV_ONESHOT` for readiness notifications.
- **macOS getnameinfo NI_NUMERICHOST wrong value**: Added platform-aware `NI__*` constants to `std/sys/socket.yo`.
- **Compile-time constants not inlined in async state machines**: Two bugs: (1) atom.ts state machine variable lookup fallback did not check `isCompileTimeOnly`; (2) inlined literals were erroneously sanitized via `sanitizeForCIdentifier`. Both fixed.
- **Windows socket close used `_close()` instead of `closesocket()`**: Fixed in `__yo_async_close_start`.
- **Windows socket constants used Linux values**: Added `Platform.Win32` branches to all platform-aware socket constant conditions.
- **Windows double `htonl` in `__yo_sockaddr_in_set_addr`**: Removed the extra `htonl` call (Yo code already byte-swaps before passing to the extern).
- **Windows TCP send/recv now truly async**: Use `WSASend`/`WSARecv` with OVERLAPPED I/O through IOCP.
- **Windows DNS `WSANOTINITIALISED`**: `__yo_async_getaddrinfo_start` and `__yo_async_getnameinfo_start` now call `__yo_io_init()` early.
- **Windows `_waccess` does not support `X_OK`**: X_OK is stripped before calling `_waccess` (Windows has no executable bit).
- **Windows `fchown(-1,-1)` returned `-ENOSYS`**: Now returns 0 for no-change sentinels.
- **Windows `futime` failed on read-only fd**: Now reopens the file path with `FILE_WRITE_ATTRIBUTES` via `GetFinalPathNameByHandleW`.
- **Windows statx nanosecond timestamps always 0**: Introduced `__yo_win_stat_t` with nsec fields from `GetFileAttributesExW` (100 ns FILETIME precision, including birth time).
- **Windows Win32 error codes not mapped to POSIX errno**: Added proper mapping in `__yo_win_last_error_to_errno` (e.g., `ERROR_FILE_NOT_FOUND` → `ENOENT`).
- **Path test canonicalization on macOS (`/tmp` vs `/private/tmp`)**: `tests/io/path.test.yo` now compares `realpath(input)` with `realpath(expected_target)`.
- **macOS FS event directory modification/delete detection**: Added snapshot-based diffing for directory watches alongside kqueue flags, reporting `FS_EVENT_CHANGE` for content updates and `FS_EVENT_RENAME` for create/delete.
- **`flock` EWOULDBLOCK errno on macOS**: `EWOULDBLOCK` is 35 on macOS vs 11 on Linux. Updated `tests/io/lock.test.yo` to use a platform-aware expected errno.
- **Windows directory scanning**: Replaced `-ENOSYS` stubs with `FindFirstFileW`/`FindNextFileW` in `opendir`/`readdir`/`closedir`/`scandir`.
- **Windows TTY operations**: Replaced `-ENOSYS` stubs with Console API (`SetConsoleMode`, `GetConsoleScreenBufferInfo`, `ENABLE_VIRTUAL_TERMINAL_INPUT`).
- **Windows FS event operations**: Replaced `-ENOSYS` stubs with `ReadDirectoryChangesW` (directory) and `FindFirstChangeNotificationW` (file), polled in `__yo_io_poll`/`__yo_io_wait`.
- **Windows poll operations**: Replaced `-ENOSYS` stubs with `select()` for sockets and `PeekNamedPipe`/`WaitForSingleObject` for pipes. `__yo_poll_and_fs_event_tick` is called from both `__yo_io_poll` (non-blocking) and `__yo_io_wait` (50 ms cap when watches are active).

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
