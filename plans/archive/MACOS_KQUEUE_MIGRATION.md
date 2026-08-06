# macOS: Migrate from GCD to kqueue

## Problem

The macOS async runtime uses GCD (`dispatch_io`, `dispatch_source`) which dispatches I/O completion callbacks on its own thread pool — not on the event loop thread. This introduces multi-threading concerns:

- `__yo_pending_io_count` requires `_Atomic` on macOS (unnecessary on Linux/Windows)
- A cross-thread continuation queue with `pthread_mutex` + `dispatch_semaphore` is needed
- Extra thread context switches per I/O completion (GCD thread → event loop thread)

Linux (`io_uring`) and Windows (IOCP) are both pull-based: the event loop thread calls a blocking function and processes completions inline. macOS should follow the same pattern using `kqueue`.

## Goal

Replace GCD with `kqueue` so the macOS async runtime matches the single-threaded event loop model of Linux and Windows. This eliminates:

- `_Atomic` on `__yo_pending_io_count`
- The `pthread_mutex`-protected continuation queue (`__yo_io_ready_head/tail`)
- The `dispatch_semaphore` coordination mechanism
- GCD thread pool overhead

## Current GCD Usage (8 operations to migrate)

Only 8 of ~25 async operations actually use GCD. The rest are synchronous wrappers.

### File I/O (dispatch_io)

| Operation | GCD API               | Lines   | kqueue replacement                              |
| --------- | --------------------- | ------- | ----------------------------------------------- |
| Read      | `dispatch_io_read()`  | 762-881 | `kevent(EVFILT_READ)` + `pread()` / `read()`    |
| Write     | `dispatch_io_write()` | 884-979 | `kevent(EVFILT_WRITE)` + `pwrite()` / `write()` |

### Socket I/O (dispatch_source)

| Operation | GCD API                  | Lines     | kqueue replacement                            |
| --------- | ------------------------ | --------- | --------------------------------------------- |
| Accept    | `dispatch_source(READ)`  | 1329-1396 | `kevent(EVFILT_READ)` on listening socket     |
| Connect   | `dispatch_source(WRITE)` | 1399-1454 | `kevent(EVFILT_WRITE)` for connect completion |
| Send      | `dispatch_source(WRITE)` | 1457-1516 | `kevent(EVFILT_WRITE)` + `send()`             |
| Recv      | `dispatch_source(READ)`  | 1519-1578 | `kevent(EVFILT_READ)` + `recv()`              |
| Sendto    | `dispatch_source(WRITE)` | 1581-1643 | `kevent(EVFILT_WRITE)` + `sendto()`           |
| Recvfrom  | `dispatch_source(READ)`  | 1645-1708 | `kevent(EVFILT_READ)` + `recvfrom()`          |

### Operations that DON'T need migration (already synchronous)

Open, close, stat, mkdir, unlink, rename, symlink, link, ftruncate, fsync, fdatasync, socket, bind, listen, shutdown, setsockopt, getsockopt — all are synchronous wrappers returning immediately-completed futures.

### Special case: O_APPEND writes

O_APPEND writes already bypass GCD (lines 896-909) and use synchronous `write()`. No migration needed for this path.

## Architecture

### kqueue event loop

```c
static int __yo_io_kq = -1;
static size_t __yo_pending_io_count = 0;  // no _Atomic needed

static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  __yo_io_kq = kqueue();
  if (__yo_io_kq < 0) { /* error handling */ }
  __yo_io_initialized = true;
}

static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  close(__yo_io_kq);
  __yo_io_kq = -1;
  __yo_io_initialized = false;
}
```

### Registering interest

Each async operation that needs to wait (non-blocking call returned EAGAIN) registers a kevent:

```c
// For socket recv (example):
struct kevent ev;
EV_SET(&ev, sockfd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, (void*)future);
kevent(__yo_io_kq, &ev, 1, NULL, 0, NULL);
__yo_pending_io_count++;
```

`EV_ONESHOT` ensures each event fires once, matching the "submit once, complete once" semantic of io_uring SQEs.

### Processing completions (in **yo_io_poll / **yo_io_wait)

```c
static int __yo_io_poll(void) {
  struct kevent events[64];
  struct timespec ts = {0, 0};  // non-blocking poll
  int n = kevent(__yo_io_kq, NULL, 0, events, 64, &ts);

  for (int i = 0; i < n; i++) {
    __yo_io_future_t* future = (__yo_io_future_t*)events[i].udata;
    // Retry the non-blocking operation (read/write/accept/etc.)
    // Set future->result, wake continuation
    __yo_pending_io_count--;
  }
  return n;
}

static int __yo_io_wait(void) {
  if (__yo_pending_io_count == 0 && __yo_active_watch_count > 0) {
    struct timespec ts = {0, 10 * 1000 * 1000};  // 10ms
    nanosleep(&ts, NULL);
    return __yo_poll_and_fs_event_tick();
  }
  if (__yo_pending_io_count == 0) return 0;

  struct kevent events[64];
  struct timespec* timeout = NULL;  // block indefinitely
  // (or compute timeout from timer list)
  int n = kevent(__yo_io_kq, NULL, 0, events, 64, timeout);
  // process events...
  return n;
}
```

### File read/write with kqueue

Unlike socket I/O where kqueue notifies when data is available, **regular file reads on kqueue always return immediately as "ready"** (files are always readable/writable from kqueue's perspective). Two approaches:

#### Option A: Non-blocking I/O on all fds (recommended)

For regular files, `pread()`/`pwrite()` don't block significantly on modern macOS (backed by unified buffer cache). Just do them synchronously like open/close/stat:

```c
static __yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, int64_t offset) {
  __yo_io_future_t* future = /* allocate */;

  if (is_regular_file(fd)) {
    // Regular files: synchronous pread (fast, buffer cache)
    ssize_t result = pread(fd, buffer, size, offset);
    future->result = (result < 0) ? -errno : (int32_t)result;
    future->state = -1;  // completed
  } else {
    // Pipes/sockets: non-blocking read, fall back to kqueue if EAGAIN
    ssize_t result = read(fd, buffer, size);
    if (result >= 0 || errno != EAGAIN) {
      future->result = (result < 0) ? -errno : (int32_t)result;
      future->state = -1;
    } else {
      // Store operation context, register kevent(EVFILT_READ)
      future->__read_ctx = (struct read_ctx){fd, buffer, size};
      struct kevent ev;
      EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, future);
      kevent(__yo_io_kq, &ev, 1, NULL, 0, NULL);
      __yo_pending_io_count++;
    }
  }
  return future;
}
```

#### Option B: Thread pool for blocking file I/O

Use a small thread pool (like libuv) for operations that might block (e.g., network file systems). More complex but handles edge cases better. **Not recommended for initial migration** — keep it simple.

### Completion handler dispatch

When kevent fires, the event loop needs to know what operation to retry. Store operation type + context in the future:

```c
typedef enum {
  IO_OP_READ,
  IO_OP_WRITE,
  IO_OP_ACCEPT,
  IO_OP_CONNECT,
  IO_OP_SEND,
  IO_OP_RECV,
  IO_OP_SENDTO,
  IO_OP_RECVFROM,
} __yo_io_op_type;

// Add to __yo_io_future_t or use a separate context struct
typedef struct {
  __yo_io_op_type op;
  union {
    struct { int fd; void* buf; uint32_t size; int64_t offset; } read;
    struct { int fd; const void* buf; uint32_t size; int64_t offset; } write;
    struct { int fd; void* addr; uint32_t* addrlen; } accept;
    struct { int fd; } connect;
    struct { int fd; const void* buf; size_t len; int flags; } send;
    struct { int fd; void* buf; size_t len; int flags; } recv;
    struct { int fd; const void* buf; size_t len; int flags; const void* addr; uint32_t addrlen; } sendto;
    struct { int fd; void* buf; size_t len; int flags; void* addr; uint32_t* addrlen; } recvfrom;
  };
} __yo_io_pending_op_t;
```

### Timer support

kqueue has native timer support via `EVFILT_TIMER`:

```c
struct kevent ev;
EV_SET(&ev, timer_id, EVFILT_TIMER, EV_ADD | EV_ONESHOT, NOTE_MSECONDS, milliseconds, future);
kevent(__yo_io_kq, &ev, 1, NULL, 0, NULL);
```

This replaces the manual timer linked list (`__yo_win_timer_head` pattern that was also used on macOS via `dispatch_after` or manual timing).

## What gets removed

After migration, these GCD-specific constructs are eliminated:

- `dispatch_queue_t __yo_io_queue` — replaced by `int __yo_io_kq`
- `dispatch_semaphore_t __yo_io_semaphore` — not needed (kevent blocks directly)
- `pthread_mutex_t __yo_io_ready_mutex` — not needed (single-threaded)
- `__yo_io_continuation_t` linked list — not needed (wake inline)
- `_Atomic` on `__yo_pending_io_count` — plain `size_t` like Linux
- `dispatch_io_create/read/write/close` calls
- `dispatch_source_create/set_event_handler/cancel/resume` calls
- `#include <dispatch/dispatch.h>`

## What gets added

- `#include <sys/event.h>` (kqueue)
- `__yo_io_pending_op_t` context struct for deferred operations
- Event dispatch table in `__yo_io_poll()` / `__yo_io_wait()`

## Migration steps

1. Add kqueue init/cleanup (`__yo_io_init`, `__yo_io_cleanup`)
2. Migrate socket operations (accept, connect, send, recv, sendto, recvfrom) — these are the simplest since they already try non-blocking first and only use `dispatch_source` as fallback
3. Migrate file read/write — use synchronous pread/pwrite for regular files, kqueue for pipes/sockets
4. Remove GCD imports, queue, semaphore, mutex, continuation queue
5. Make `__yo_pending_io_count` non-atomic
6. Test all async operations (TCP, UDP, file I/O, pipe I/O)

## Testing strategy

- `./yo-cli test ./tests/net_tcp.test.yo` — TCP socket operations
- `./yo-cli test ./tests/net_udp.test.yo` — UDP socket operations
- `./yo-cli test ./tests/file.test.yo` — File read/write
- `./yo-cli test ./tests/pipe.test.yo` — Pipe I/O
- `./yo-cli test ./tests/timer.test.yo` — Timer operations
- `./yo-cli test ./tests/dir.test.yo` — Directory operations (should be unaffected)

## Notes

- This migration only affects `runtime-io-macos.ts`. No changes to Linux or Windows runtimes.
- The common runtime (`runtime-io-common.ts`) and core runtime (`runtime-core.ts`) should not need changes since they use the same `__yo_has_pending_io()` / `__yo_io_poll()` / `__yo_io_wait()` interface.
- Windows `_Atomic` on `__yo_pending_io_count` is also technically unnecessary (IOCP is single-threaded) but harmless on x86_64. Can be cleaned up separately if desired.
