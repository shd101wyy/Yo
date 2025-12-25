# Async I/O Implementation Plan

## Overview

This document outlines the implementation plan for Yo's cross-platform async I/O:

| Platform    | Backend  | Priority |
| ----------- | -------- | -------- |
| **Linux**   | io_uring | Phase 1  |
| **macOS**   | kqueue   | Phase 1  |
| **Windows** | IOCP     | Phase 1  |

All platforms share a unified Yo API (`File.read_async`, `File.write_async`) with platform-specific C implementations.

## Goals

**Phase 1 (This Plan):** Async file read/write on all platforms

- Linux: io_uring backend
- macOS: kqueue backend
- Windows: IOCP backend
- Unified Yo API
- Integration with single-threaded event loop

**Future Phases:**

- Phase 2: Async socket operations
- Phase 3: Advanced optimizations

## Prerequisites

**Linux:**

- Kernel 5.1+ (io_uring support)
- liburing library

**macOS:**

- macOS 10.6+ (kqueue support)
- No additional libraries needed

**Windows:**

- Windows Vista+ (GetQueuedCompletionStatusEx)
- Windows SDK

**All platforms:**

- Working async/await codegen with state machines

## Architecture

### Single-Threaded Design

All async I/O runs on the **same thread** as the event loop:

```
┌─────────────────────────────────────────────────────────┐
│                   Main Thread                           │
│                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌────────────┐  │
│  │ Ready Queue │───▶│  Run Task   │───▶│  io_uring  │  │
│  │             │◀───│             │◀───│  poll      │  │
│  └─────────────┘    └─────────────┘    └────────────┘  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Key Insight

Since everything runs on one thread:

- No atomic operations needed for reference counting
- No thread synchronization for I/O state
- Simple event loop integration

## Implementation Tasks

### Task 1: C Runtime - Cross-Platform I/O Header

**File:** `src/codegen/runtime/yo_io.h` (new file)

```c
#ifndef YO_IO_H
#define YO_IO_H

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

// Platform detection
#if defined(__linux__)
  #define YO_IO_BACKEND_IOURING 1
#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__)
  #define YO_IO_BACKEND_KQUEUE 1
#elif defined(_WIN32)
  #define YO_IO_BACKEND_IOCP 1
#else
  #error "Unsupported platform for async I/O"
#endif

// Platform-specific includes
#if YO_IO_BACKEND_IOURING
  #include <liburing.h>
#elif YO_IO_BACKEND_KQUEUE
  #include <sys/event.h>
  #include <fcntl.h>
#elif YO_IO_BACKEND_IOCP
  #include <windows.h>
#endif

// Forward declarations
extern size_t __yo_pending_io_count;

// I/O operation state (cross-platform, embedded in state machines)
typedef struct yo_io_state {
  void* state_machine;       // Owning state machine
  void (*resume_fn)(void*);  // Resume function when I/O completes
  int32_t result;            // Result: bytes or -errno
  bool completed;            // Set to true when I/O completes

#if YO_IO_BACKEND_KQUEUE
  // kqueue needs to store operation details for deferred execution
  int32_t __fd;
  void* __buffer;
  size_t __size;
  int64_t __offset;
  bool __is_write;
#elif YO_IO_BACKEND_IOCP
  OVERLAPPED overlapped;     // Windows overlapped I/O state
#endif
} yo_io_state_t;

// Cross-platform API
void __yo_io_init(void);
void __yo_io_cleanup(void);

static inline bool __yo_has_pending_io(void) {
  return __yo_pending_io_count > 0;
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state);
void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                             int64_t offset, yo_io_state_t* io_state);

int __yo_io_poll(void);   // Non-blocking, returns completion count
int __yo_io_wait(void);   // Blocking, waits for at least one

// Synchronous file operations (all platforms)
int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode);
void __yo_file_close(int32_t fd);
int64_t __yo_file_size(int32_t fd);

#endif // YO_IO_H
```

**Estimated Time:** 0.5 days

---

### Task 1b: Linux Backend (io_uring)

**File:** `src/codegen/runtime/yo_io_linux.c`

```c
#if defined(__linux__)

#include "yo_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

static struct io_uring __yo_io_ring;
static bool __yo_io_initialized = false;
size_t __yo_pending_io_count = 0;

void __yo_io_init(void) {
  if (__yo_io_initialized) return;

  int ret = io_uring_queue_init(256, &__yo_io_ring, 0);
  if (ret < 0) {
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\n", strerror(-ret));
    exit(1);
  }
  __yo_io_initialized = true;
}

void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  io_uring_queue_exit(&__yo_io_ring);
  __yo_io_initialized = false;
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    io_state->result = -EAGAIN;
    io_state->completed = true;
    return;
  }

  io_uring_prep_read(sqe, fd, buffer, (unsigned)size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
}

void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                             int64_t offset, yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    io_state->result = -EAGAIN;
    io_state->completed = true;
    return;
  }

  io_uring_prep_write(sqe, fd, buffer, (unsigned)size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
}

static void process_cqe(struct io_uring_cqe* cqe) {
  yo_io_state_t* io_state = io_uring_cqe_get_data(cqe);
  io_state->result = cqe->res;
  io_state->completed = true;
  __yo_pending_io_count--;

  if (io_state->resume_fn && io_state->state_machine) {
    __yo_async_spawn_task(io_state->resume_fn, io_state->state_machine);
  }

  io_uring_cqe_seen(&__yo_io_ring, cqe);
}

int __yo_io_poll(void) {
  struct io_uring_cqe* cqe;
  int count = 0;
  while (io_uring_peek_cqe(&__yo_io_ring, &cqe) == 0) {
    process_cqe(cqe);
    count++;
  }
  return count;
}

int __yo_io_wait(void) {
  struct io_uring_cqe* cqe;
  int ret = io_uring_wait_cqe(&__yo_io_ring, &cqe);
  if (ret < 0) return 0;
  process_cqe(cqe);
  return 1 + __yo_io_poll();
}

// Common file operations
int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  return fd >= 0 ? fd : -errno;
}

void __yo_file_close(int32_t fd) { close(fd); }

int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -errno;
  return st.st_size;
}

#endif // __linux__
```

**Estimated Time:** 1 day

---

### Task 1c: macOS Backend (kqueue)

**File:** `src/codegen/runtime/yo_io_macos.c`

```c
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__OpenBSD__)

#include "yo_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/event.h>
#include <sys/time.h>

static int __yo_kqueue_fd = -1;
size_t __yo_pending_io_count = 0;

void __yo_io_init(void) {
  if (__yo_kqueue_fd >= 0) return;
  __yo_kqueue_fd = kqueue();
  if (__yo_kqueue_fd < 0) {
    fprintf(stderr, "[Yo] kqueue() failed: %s\n", strerror(errno));
    exit(1);
  }
}

void __yo_io_cleanup(void) {
  if (__yo_kqueue_fd >= 0) {
    close(__yo_kqueue_fd);
    __yo_kqueue_fd = -1;
  }
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state) {
  // Store operation details for deferred execution
  io_state->__fd = fd;
  io_state->__buffer = buffer;
  io_state->__size = size;
  io_state->__offset = offset;
  io_state->__is_write = false;

  // Set non-blocking mode
  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  // Register for read readiness
  struct kevent ev;
  EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, io_state);
  kevent(__yo_kqueue_fd, &ev, 1, NULL, 0, NULL);
  __yo_pending_io_count++;
}

void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                             int64_t offset, yo_io_state_t* io_state) {
  io_state->__fd = fd;
  io_state->__buffer = (void*)buffer;
  io_state->__size = size;
  io_state->__offset = offset;
  io_state->__is_write = true;

  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags | O_NONBLOCK);

  struct kevent ev;
  EV_SET(&ev, fd, EVFILT_WRITE, EV_ADD | EV_ONESHOT, 0, 0, io_state);
  kevent(__yo_kqueue_fd, &ev, 1, NULL, 0, NULL);
  __yo_pending_io_count++;
}

static void process_event(struct kevent* ev) {
  yo_io_state_t* io_state = ev->udata;

  // Perform the actual I/O now that fd is ready
  if (io_state->__offset >= 0) {
    lseek(io_state->__fd, io_state->__offset, SEEK_SET);
  }

  ssize_t result;
  if (io_state->__is_write) {
    result = write(io_state->__fd, io_state->__buffer, io_state->__size);
  } else {
    result = read(io_state->__fd, io_state->__buffer, io_state->__size);
  }

  io_state->result = (result >= 0) ? (int32_t)result : -errno;
  io_state->completed = true;
  __yo_pending_io_count--;

  if (io_state->resume_fn && io_state->state_machine) {
    __yo_async_spawn_task(io_state->resume_fn, io_state->state_machine);
  }
}

int __yo_io_poll(void) {
  struct kevent events[64];
  struct timespec timeout = {0, 0};  // Non-blocking

  int n = kevent(__yo_kqueue_fd, NULL, 0, events, 64, &timeout);
  for (int i = 0; i < n; i++) {
    process_event(&events[i]);
  }
  return n;
}

int __yo_io_wait(void) {
  struct kevent events[64];
  // Blocking wait for at least one event
  int n = kevent(__yo_kqueue_fd, NULL, 0, events, 64, NULL);
  for (int i = 0; i < n; i++) {
    process_event(&events[i]);
  }
  return n;
}

// Common file operations
int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  return fd >= 0 ? fd : -errno;
}

void __yo_file_close(int32_t fd) { close(fd); }

int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -errno;
  return st.st_size;
}

#endif // __APPLE__ || __FreeBSD__ || __OpenBSD__
```

**Estimated Time:** 1 day

---

### Task 1d: Windows Backend (IOCP)

**File:** `src/codegen/runtime/yo_io_windows.c`

```c
#if defined(_WIN32)

#include "yo_io.h"
#include <stdio.h>
#include <stdlib.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>

static HANDLE __yo_iocp = NULL;
size_t __yo_pending_io_count = 0;

void __yo_io_init(void) {
  if (__yo_iocp != NULL) return;
  __yo_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (__yo_iocp == NULL) {
    fprintf(stderr, "[Yo] CreateIoCompletionPort failed: %lu\n", GetLastError());
    exit(1);
  }
}

void __yo_io_cleanup(void) {
  if (__yo_iocp != NULL) {
    CloseHandle(__yo_iocp);
    __yo_iocp = NULL;
  }
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state) {
  // Convert fd to HANDLE
  HANDLE hFile = (HANDLE)_get_osfhandle(fd);

  // Associate with IOCP
  CreateIoCompletionPort(hFile, __yo_iocp, (ULONG_PTR)io_state, 0);

  // Setup OVERLAPPED
  memset(&io_state->overlapped, 0, sizeof(OVERLAPPED));
  io_state->overlapped.Offset = (DWORD)(offset & 0xFFFFFFFF);
  io_state->overlapped.OffsetHigh = (DWORD)(offset >> 32);

  // Submit async read
  BOOL ok = ReadFile(hFile, buffer, (DWORD)size, NULL, &io_state->overlapped);
  if (!ok && GetLastError() != ERROR_IO_PENDING) {
    io_state->result = -(int32_t)GetLastError();
    io_state->completed = true;
    return;
  }
  __yo_pending_io_count++;
}

void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                             int64_t offset, yo_io_state_t* io_state) {
  HANDLE hFile = (HANDLE)_get_osfhandle(fd);

  CreateIoCompletionPort(hFile, __yo_iocp, (ULONG_PTR)io_state, 0);

  memset(&io_state->overlapped, 0, sizeof(OVERLAPPED));
  io_state->overlapped.Offset = (DWORD)(offset & 0xFFFFFFFF);
  io_state->overlapped.OffsetHigh = (DWORD)(offset >> 32);

  BOOL ok = WriteFile(hFile, buffer, (DWORD)size, NULL, &io_state->overlapped);
  if (!ok && GetLastError() != ERROR_IO_PENDING) {
    io_state->result = -(int32_t)GetLastError();
    io_state->completed = true;
    return;
  }
  __yo_pending_io_count++;
}

static int process_completions(DWORD timeout_ms) {
  OVERLAPPED_ENTRY entries[64];
  ULONG count = 0;

  BOOL ok = GetQueuedCompletionStatusEx(__yo_iocp, entries, 64, &count, timeout_ms, FALSE);
  if (!ok) return 0;

  for (ULONG i = 0; i < count; i++) {
    yo_io_state_t* io_state = (yo_io_state_t*)entries[i].lpCompletionKey;
    io_state->result = (int32_t)entries[i].dwNumberOfBytesTransferred;
    io_state->completed = true;
    __yo_pending_io_count--;

    if (io_state->resume_fn && io_state->state_machine) {
      __yo_async_spawn_task(io_state->resume_fn, io_state->state_machine);
    }
  }
  return (int)count;
}

int __yo_io_poll(void) {
  return process_completions(0);  // Non-blocking
}

int __yo_io_wait(void) {
  return process_completions(INFINITE);  // Blocking
}

// File operations for Windows
int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = _open(path, flags | _O_BINARY, mode);
  return fd >= 0 ? fd : -errno;
}

void __yo_file_close(int32_t fd) { _close(fd); }

int64_t __yo_file_size(int32_t fd) {
  struct _stat64 st;
  if (_fstat64(fd, &st) < 0) return -errno;
  return st.st_size;
}

#endif // _WIN32
```

**Estimated Time:** 1 day

---

### Task 2: Update Event Loop

**File:** Modify existing event loop code to integrate io_uring polling

The event loop needs to:

1. Initialize io_uring at startup
2. Poll io_uring completions between task executions
3. Block on io_uring when no ready tasks but pending I/O

```c
void __yo_event_loop_run(void) {
  // Initialize io_uring
  __yo_io_init();

  while (__yo_has_pending_tasks() || __yo_has_pending_io()) {
    // 1. Process ready tasks (up to 100 per iteration)
    int tasks_run = 0;
    while (tasks_run < 100) {
      yo_continuation_t* task = __yo_dequeue_ready_task();
      if (!task) break;
      task->resume_fn(task->state_machine);
      tasks_run++;
    }

    // 2. Poll io_uring completions (non-blocking)
    __yo_io_poll();

    // 3. If no ready tasks but pending I/O, block until completion
    if (!__yo_has_ready_tasks() && __yo_has_pending_io()) {
      __yo_io_wait();
    }
  }

  // Cleanup
  __yo_io_cleanup();
}
```

**Estimated Time:** 0.5 days

---

### Task 3: Yo Standard Library - File Type

**File:** `std/io/file.yo` (new file)

```yo
// File I/O constants (from fcntl.h)
extern "C",
  O_RDONLY : i32,
  O_WRONLY : i32,
  O_RDWR : i32,
  O_CREAT : i32,
  O_TRUNC : i32,
  O_APPEND : i32
;

// C runtime functions
extern "Yo",
  __yo_file_open : (fn(path: *(u8), flags: i32, mode: i32) -> i32),
  __yo_file_close : (fn(fd: i32) -> unit),
  __yo_file_size : (fn(fd: i32) -> i64),
  __yo_async_read_submit : (fn(fd: i32, buffer: *(u8), size: usize, offset: i64, io_state: *(u8)) -> unit),
  __yo_async_write_submit : (fn(fd: i32, buffer: *(u8), size: usize, offset: i64, io_state: *(u8)) -> unit)
;

// Error type
IOError :: struct(
  code : i32,
  message : String,

  from_errno :: (fn(errno: i32) -> Self)({
    // Map common errno values to messages
    msg := cond(
      (errno == 2) => "No such file or directory",
      (errno == 13) => "Permission denied",
      (errno == 21) => "Is a directory",
      (errno == 28) => "No space left on device",
      true => "I/O error"
    );
    Self(errno, msg)
  })
);

// File handle
File :: struct(
  fd : i32,

  // Open file
  open :: (fn(path: String, flags: i32) -> Result(Self, IOError))({
    fd := __yo_file_open(path.as_ptr(), flags, 0o644);
    cond(
      (fd >= 0) => .Ok(Self(fd)),
      true => .Err(IOError.from_errno((0 - fd) as i32))
    )
  }),

  // Get file size
  size :: (fn(self: Self) -> Result(i64, IOError))({
    result := __yo_file_size(self.fd);
    cond(
      (result >= 0) => .Ok(result),
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  }),

  // Close file
  close :: (fn(self: Self) -> unit)({
    __yo_file_close(self.fd);
  }),

  // Async read
  read_async :: (fn(self: Self, buffer: Array(u8), offset: i64) -> Impl Future(Result(usize, IOError))) async {
    // This will be transformed by codegen into:
    // 1. Submit I/O to io_uring
    // 2. Suspend state machine
    // 3. Resume when I/O completes
    // 4. Return result
    result := await __yo_async_read(self.fd, buffer.ptr(), buffer.len(), offset);
    cond(
      (result >= 0) => .Ok(result as usize),
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  },

  // Async write
  write_async :: (fn(self: Self, data: Array(u8), offset: i64) -> Impl Future(Result(usize, IOError))) async {
    result := await __yo_async_write(self.fd, data.ptr(), data.len(), offset);
    cond(
      (result >= 0) => .Ok(result as usize),
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  }
);

// Convenience functions
File.read_all :: (fn(path: String) -> Impl Future(Result(String, IOError))) async {
  file := match(File.open(path, O_RDONLY),
    .Ok(f) => f,
    .Err(e) => return .Err(e)
  );

  size := match(file.size(),
    .Ok(s) => s,
    .Err(e) => { file.close(); return .Err(e); }
  );

  buffer := Array(u8).new(size as usize);
  result := await file.read_async(buffer, 0);
  file.close();

  match(result,
    .Ok(bytes) => .Ok(String.from_utf8(buffer)),
    .Err(e) => .Err(e)
  )
};

File.write_all :: (fn(path: String, data: String) -> Impl Future(Result(unit, IOError))) async {
  file := match(File.open(path, ((O_WRONLY | O_CREAT) | O_TRUNC)),
    .Ok(f) => f,
    .Err(e) => return .Err(e)
  );

  bytes := data.as_bytes();
  result := await file.write_async(bytes, 0);
  file.close();

  match(result,
    .Ok(_) => .Ok(()),
    .Err(e) => .Err(e)
  )
};
```

**Estimated Time:** 1 day

---

### Task 4: Codegen - Async I/O Await Pattern

The codegen needs to recognize `await __yo_async_read(...)` and `await __yo_async_write(...)` and generate special state machine code that:

1. Embeds `yo_io_state_t` in the state machine struct
2. On first entry to await state: submit I/O and suspend (don't add to ready queue)
3. On resume: extract result and continue

**State Machine Generation:**

```c
// Generated state machine struct
typedef struct task_state_t {
  yo_ref_header_t header;
  int state;

  // Captured variables...
  int32_t fd;
  uint8_t* buffer;
  size_t size;
  int64_t offset;

  // I/O state (for await __yo_async_read/write)
  yo_io_state_t io_state;

  // Result
  int32_t result;
} task_state_t;

// Generated resume function
void task_resume(task_state_t* sm) {
  switch (sm->state) {
    case 0:
      // ... setup code ...
      sm->state = 1;
      // Fall through

    case 1:  // await __yo_async_read
      if (!sm->io_state.completed) {
        // First entry: submit I/O
        sm->io_state.state_machine = sm;
        sm->io_state.resume_fn = (void(*)(void*))task_resume;
        sm->io_state.completed = false;
        __yo_async_read_submit(sm->fd, sm->buffer, sm->size, sm->offset, &sm->io_state);
        // Suspend - DO NOT add to ready queue
        // io_uring completion will call __yo_async_spawn_task
        return;
      }
      // Resumed after I/O completion
      sm->result = sm->io_state.result;
      sm->io_state.completed = false;  // Reset
      sm->state = 2;
      // Fall through

    case 2:
      // ... rest of function ...
  }
}
```

**Key Changes to Codegen:**

1. **Detect I/O await:** Check if awaited expression is `__yo_async_read` or `__yo_async_write`
2. **Add io_state field:** Include `yo_io_state_t` in state machine struct
3. **Generate special await code:** Submit I/O and suspend without adding to ready queue
4. **Handle resume:** Check `completed` flag and extract result

**Estimated Time:** 2-3 days

---

### Task 5: Build System Integration

**Platform-specific linking:**

```bash
# Linux
clang -std=c11 a.out.c -luring -o a.out

# macOS (no extra libs needed)
clang -std=c11 a.out.c -o a.out

# Windows (MSVC)
cl /std:c11 a.out.c /link ws2_32.lib /out:a.out.exe
```

**Conditional compilation in codegen:**

```typescript
// In emitter.ts - emit platform detection
function emitIORuntime(emitter: Emitter) {
  emitter.emitLine(`
#if defined(__linux__)
  // Linux: link with -luring
  #include "yo_io_linux.c"
#elif defined(__APPLE__) || defined(__FreeBSD__)
  // macOS/BSD: no extra libs
  #include "yo_io_macos.c"
#elif defined(_WIN32)
  // Windows: link with ws2_32.lib
  #include "yo_io_windows.c"
#endif
`);
}
```

**Update flake.nix for Linux:**

```nix
buildInputs = [ liburing ];
```

**Estimated Time:** 0.5 days

---

### Task 6: Tests

**File:** `tests/async_io.test.yo`

```yo
// Test async file read
test "async file read" {
  async {
    // Write test file
    test_data := "Hello, async I/O!";
    write_result := await File.write_all("/tmp/yo_test_read.txt", test_data);
    assert(write_result.is_ok());

    // Read it back
    read_result := await File.read_all("/tmp/yo_test_read.txt");
    assert(read_result.is_ok());
    assert(read_result.unwrap() == test_data);
  };
};

// Test async file write
test "async file write" {
  async {
    data := "Test write data\n";
    result := await File.write_all("/tmp/yo_test_write.txt", data);
    assert(result.is_ok());

    // Verify by reading
    read_result := await File.read_all("/tmp/yo_test_write.txt");
    assert(read_result.is_ok());
    assert(read_result.unwrap() == data);
  };
};

// Test concurrent I/O
test "concurrent file I/O" {
  async {
    // Write two files
    _ := await File.write_all("/tmp/yo_test_a.txt", "File A content");
    _ := await File.write_all("/tmp/yo_test_b.txt", "File B content");

    // Read both concurrently (same thread, interleaved)
    f1 := File.read_all("/tmp/yo_test_a.txt");
    f2 := File.read_all("/tmp/yo_test_b.txt");

    data1 := await f1;
    data2 := await f2;

    assert(data1.is_ok());
    assert(data2.is_ok());
    assert(data1.unwrap() == "File A content");
    assert(data2.unwrap() == "File B content");
  };
};

// Test error handling
test "file not found error" {
  async {
    result := await File.read_all("/nonexistent/path/file.txt");
    assert(result.is_err());
    assert(result.unwrap_err().code == 2);  // ENOENT
  };
};

// Test large file
test "large file I/O" {
  async {
    // Generate 1MB of data
    size := (1024 * 1024);
    data := String.repeat("x", size);

    write_result := await File.write_all("/tmp/yo_test_large.txt", data);
    assert(write_result.is_ok());

    read_result := await File.read_all("/tmp/yo_test_large.txt");
    assert(read_result.is_ok());
    assert(read_result.unwrap().len() == size);
  };
};
```

**Estimated Time:** 1 day

---

## Implementation Order

```
Week 1:
├── Task 1: Cross-platform header (0.5 days)
├── Task 1b: Linux io_uring backend (1 day)
├── Task 1c: macOS kqueue backend (1 day)
├── Task 1d: Windows IOCP backend (1 day)
└── Task 2: Update Event Loop (0.5 days)

Week 2:
├── Task 4: Codegen - Async I/O await pattern (2-3 days)
└── Task 3: Yo Standard Library - File type (1 day)

Week 3:
├── Task 5: Build System Integration (0.5 days)
├── Task 6: Tests on all platforms (1.5 days)
├── Bug fixes and refinements (2 days)
└── Documentation updates
```

## Success Criteria

1. ✅ `File.read_async()` works on Linux (io_uring)
2. ✅ `File.read_async()` works on macOS (kqueue)
3. ✅ `File.read_async()` works on Windows (IOCP)
4. ✅ `File.write_async()` works on all platforms
5. ✅ Concurrent file I/O operations run on single thread
6. ✅ No atomic operations used (single-threaded)
7. ✅ Error handling works correctly
8. ✅ All tests pass on all platforms
9. ✅ Memory leak free (AddressSanitizer clean)

## Dependencies

**Linux:**

- liburing (io_uring wrapper library)
- Kernel 5.1 or newer

**macOS:**

- macOS 10.6+ (ships with kqueue)

**Windows:**

- Windows Vista+ (for GetQueuedCompletionStatusEx)
- Windows SDK

**All platforms:**

- Working async/await codegen with state machines

## Risks and Mitigations

| Risk                               | Impact | Mitigation                          |
| ---------------------------------- | ------ | ----------------------------------- |
| io_uring not available (old Linux) | Medium | Check kernel version, error message |
| kqueue file I/O limitations        | Medium | Use pread/pwrite for offset support |
| Windows HANDLE vs fd mismatch      | Medium | Use \_get_osfhandle conversion      |
| Complex codegen changes            | Medium | Start with hardcoded C test         |
| State machine memory leaks         | Medium | Test with AddressSanitizer          |
| Platform-specific bugs             | Medium | CI testing on all platforms         |

## Future Work

After Phase 1 is complete:

1. **Phase 2: Async Sockets**

   - `Socket.accept_async()`
   - `Socket.connect_async()`
   - `Socket.read_async()` / `Socket.write_async()`
   - HTTP server example

2. **Phase 3: macOS Support**

   - kqueue backend
   - Platform abstraction layer

3. **Phase 4: Windows Support**

   - IOCP backend

4. **Optimizations**
   - Registered buffers
   - Registered files
   - Batch submissions
   - Zero-copy operations

## References

### Linux (io_uring)

- [io_uring documentation](https://kernel.dk/io_uring.pdf)
- [liburing repository](https://github.com/axboe/liburing)
- [io_uring examples](https://github.com/axboe/liburing/tree/master/examples)

### macOS (kqueue)

- [kqueue man page](https://www.freebsd.org/cgi/man.cgi?kqueue)
- [Apple kqueue reference](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html)

### Windows (IOCP)

- [I/O Completion Ports](https://docs.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [GetQueuedCompletionStatusEx](https://docs.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-getqueuedcompletionstatusex)
- [Overlapped I/O](https://docs.microsoft.com/en-us/windows/win32/fileio/synchronous-and-asynchronous-i-o)
