# Async I/O Implementation Plan

## Overview

This document outlines the implementation plan for Yo's async I/O system:

| Platform    | Backend  | Priority |
| ----------- | -------- | -------- |
| **Linux**   | io_uring | Phase 1  |
| **Windows** | IOCP     | Phase 2  |
| **macOS**   | kqueue   | Phase 3  |

All platforms share a unified Yo API (`File.read_bytes_async`, `File.read_string_async`, etc.) with platform-specific C implementations.

## liburing Strategy

### Why liburing (not raw syscalls)

- **liburing** is a thin wrapper (~5KB code) maintained by Jens Axboe (io_uring author)
- Handles ring buffer memory mapping correctly
- Well-tested, actively maintained
- Raw io_uring syscalls require managing mmap'd ring buffers manually - error-prone

### NPM Packaging

**Strategy: Vendor liburing source** (like mimalloc)

```
vendor/
├── mimalloc/          # Already vendored
└── liburing/          # BSD-licensed, ~5KB of actual code
    ├── include/
    │   ├── liburing.h
    │   └── liburing/
    │       ├── io_uring.h
    │       ├── compat.h
    │       ├── barrier.h
    │       └── io_uring_version.h
    └── src/
        ├── setup.c
        ├── queue.c
        ├── register.c
        └── syscall.c
```

**Build integration:**
```bash
# Linux compilation includes vendored liburing
clang -std=c11 a.out.c \
  vendor/liburing/src/setup.c \
  vendor/liburing/src/queue.c \
  vendor/liburing/src/register.c \
  vendor/liburing/src/syscall.c \
  -Ivendor/liburing/include \
  vendor/mimalloc/src/static.c \
  -Ivendor/mimalloc/include \
  -o a.out
```

**Obtaining liburing:**
```bash
# Clone and extract needed files
git clone https://github.com/axboe/liburing.git
# Copy only: src/{setup.c, queue.c, register.c, syscall.c}
# Copy only: include/liburing.h, include/liburing/*.h
```

## File API Design

### Return Types

| Function | Return Type | Description |
|----------|-------------|-------------|
| `File.read_bytes_async` | `Result([u8], IOError)` | Binary data as slice |
| `File.read_string_async` | `Result(String, IOError)` | UTF-8 validated text |
| `File.write_bytes_async` | `Result(unit, IOError)` | Write from slice |
| `File.write_string_async` | `Result(unit, IOError)` | Write from String |

### Why `[u8]` slice over `*u8` pointer

- **`[u8]`** (slice) = fat pointer with data + length
- **`*u8`** = raw pointer, loses length information
- Slice is safer and matches `ArrayList.as_slice()` return type

### Why separate `read_bytes` and `read_string`

- `read_bytes_async`: Returns raw bytes, no UTF-8 validation
- `read_string_async`: Validates UTF-8, returns String or `IOError.InvalidUtf8`
- Similar to Rust's `std::fs::read()` vs `std::fs::read_to_string()`

## Prerequisites

**Linux:**
- Kernel 5.1+ (io_uring support)
- No external dependencies (liburing vendored)

**Windows:**
- Windows Vista+ (for GetQueuedCompletionStatusEx)
- Windows SDK

**macOS:**
- macOS 10.6+ (kqueue support)
- No external dependencies

**All platforms:**
- Working async/await codegen with state machines

## Phase 1: Linux Implementation

### Task 1.1: Vendor liburing

**Time Estimate:** 0.5 days

1. Clone liburing repository
2. Copy minimal required files to `vendor/liburing/`
3. Update build commands in `yo-cli`

**Files to vendor:**
```
vendor/liburing/
├── include/
│   ├── liburing.h
│   └── liburing/
│       ├── io_uring.h
│       ├── compat.h
│       ├── barrier.h
│       └── io_uring_version.h
└── src/
    ├── setup.c
    ├── queue.c
    ├── register.c
    └── syscall.c
```

---

### Task 1.2: C Runtime - I/O Header

**File:** Generate as part of C output in `src/codegen/async/runtime.ts`

```c
// ============================================================================
// Async I/O Runtime (Linux - io_uring via liburing)
// ============================================================================

#if defined(__linux__)
#include <liburing.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>

static struct io_uring __yo_io_ring;
static bool __yo_io_initialized = false;
static size_t __yo_pending_io_count = 0;

// I/O operation state (embedded in state machines)
typedef struct yo_io_state {
  void* state_machine;       // Owning state machine
  void (*resume_fn)(void*);  // Resume function when I/O completes
  int32_t result;            // Result: bytes or -errno
  bool completed;            // Set to true when I/O completes
} yo_io_state_t;

// Initialize io_uring (called once at event loop start)
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  int ret = io_uring_queue_init(256, &__yo_io_ring, 0);
  if (ret < 0) {
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\n", strerror(-ret));
    exit(1);
  }
  __yo_io_initialized = true;
}

// Cleanup io_uring
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  io_uring_queue_exit(&__yo_io_ring);
  __yo_io_initialized = false;
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return __yo_pending_io_count > 0;
}

// Submit async read to io_uring
static void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
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

// Submit async write to io_uring
static void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
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

// Process completions from CQ
static void __yo_io_process_cqe(struct io_uring_cqe* cqe) {
  yo_io_state_t* io_state = (yo_io_state_t*)io_uring_cqe_get_data(cqe);
  io_state->result = cqe->res;
  io_state->completed = true;
  __yo_pending_io_count--;

  // Wake the waiting task
  if (io_state->resume_fn && io_state->state_machine) {
    yo_async_spawn_task(io_state->resume_fn, io_state->state_machine);
  }

  io_uring_cqe_seen(&__yo_io_ring, cqe);
}

// Poll for I/O completions (non-blocking)
static int __yo_io_poll(void) {
  struct io_uring_cqe* cqe;
  int count = 0;
  
  while (io_uring_peek_cqe(&__yo_io_ring, &cqe) == 0) {
    __yo_io_process_cqe(cqe);
    count++;
  }
  return count;
}

// Wait for at least one I/O completion (blocking)
static int __yo_io_wait(void) {
  struct io_uring_cqe* cqe;
  int ret = io_uring_wait_cqe(&__yo_io_ring, &cqe);
  if (ret < 0) return 0;
  
  __yo_io_process_cqe(cqe);
  return 1 + __yo_io_poll();  // Process any additional completions
}

// Synchronous file operations
static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  return fd >= 0 ? fd : -errno;
}

static void __yo_file_close(int32_t fd) {
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) return -errno;
  return st.st_size;
}

#endif // __linux__
```

**Time Estimate:** 1 day

---

### Task 1.3: Update Event Loop

Modify the existing async runtime in `src/codegen/async/runtime.ts`:

```c
// Updated event loop with io_uring integration
void __yo_async_run_until_complete(void* future_ptr) {
  if (!yo_async_scheduler_initialized) {
    __yo_async_scheduler_init();
  }
  
#if defined(__linux__)
  __yo_io_init();  // Initialize io_uring
#endif

  typedef struct { _Atomic int state; } generic_future_t;
  generic_future_t* future = (generic_future_t*)future_ptr;
  
  while (atomic_load(&future->state) != -1) {
    // 1. Process ready tasks (up to 100 per iteration)
    int tasks_run = 0;
    while (tasks_run < 100) {
      yo_continuation_t* cont = yo_thread_async_queue.head;
      if (!cont) break;
      
      yo_thread_async_queue.head = cont->next;
      if (!yo_thread_async_queue.head) {
        yo_thread_async_queue.tail = NULL;
      }
      yo_thread_async_queue.count--;
      
      cont->resume_fn(cont->state_machine);
      __yo_free(cont);
      tasks_run++;
    }
    
#if defined(__linux__)
    // 2. Poll io_uring completions (non-blocking)
    __yo_io_poll();
    
    // 3. If no ready tasks but pending I/O, block until completion
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      __yo_io_wait();
    }
#endif
    
    // 4. If no tasks and no I/O, future must be waiting for something external
    if (!yo_thread_async_queue.head && !__yo_has_pending_io()) {
      break;
    }
  }
  
#if defined(__linux__)
  __yo_io_cleanup();
#endif
}
```

**Time Estimate:** 0.5 days

---

### Task 1.4: Codegen - Async I/O Await Pattern

The codegen needs to recognize `await __yo_async_read(...)` and generate special state machine code.

**State Machine Struct Addition:**

```c
typedef struct my_async_fn_state_t {
  yo_ref_header_t __header;
  _Atomic int state;
  _Atomic(void (*)(void*)) continuation_fn;
  _Atomic(void*) continuation_sm;
  
  // Captured variables...
  int32_t fd;
  uint8_t* buffer;
  size_t size;
  int64_t offset;
  
  // I/O state (for await __yo_async_read/write)
  yo_io_state_t io_state;
  
  // Result
  int32_t io_result;
} my_async_fn_state_t;
```

**Generated Await Code:**

```c
case STATE_AWAIT_IO_READ:
  if (!sm->io_state.completed) {
    // First entry: submit I/O and suspend
    sm->io_state.state_machine = sm;
    sm->io_state.resume_fn = (void(*)(void*))my_async_fn_resume;
    sm->io_state.completed = false;
    
    __yo_async_read_submit(sm->fd, sm->buffer, sm->size, sm->offset, &sm->io_state);
    
    // Suspend - DO NOT add to ready queue
    // io_uring completion will call yo_async_spawn_task
    return;
  }
  
  // Resumed after I/O completion
  sm->io_result = sm->io_state.result;
  sm->io_state.completed = false;  // Reset for potential reuse
  sm->state = STATE_AFTER_IO_READ;
  // Fall through...
```

**Time Estimate:** 2-3 days

---

### Task 1.5: Yo Standard Library - File API

**File:** `std/io/file.yo`

```yo
{ ArrayList } :: import "../collections/array_list.yo";

// File I/O constants
extern "C",
  O_RDONLY : i32,
  O_WRONLY : i32,
  O_RDWR : i32,
  O_CREAT : i32,
  O_TRUNC : i32,
  O_APPEND : i32
;

// C runtime functions (generated in codegen)
extern "Yo",
  __yo_file_open : (fn(path: *(u8), flags: i32, mode: i32) -> i32),
  __yo_file_close : (fn(fd: i32) -> unit),
  __yo_file_size : (fn(fd: i32) -> i64)
;

// I/O Error type
IOError :: enum(
  NotFound,
  PermissionDenied,
  IsADirectory,
  NoSpaceLeft,
  InvalidUtf8,
  Other(code: i32)
);

impl(IOError, {
  from_errno :: (fn(errno: i32) -> Self)(
    cond(
      (errno == 2) => .NotFound,                // ENOENT
      (errno == 13) => .PermissionDenied,       // EACCES
      (errno == 21) => .IsADirectory,           // EISDIR
      (errno == 28) => .NoSpaceLeft,            // ENOSPC
      true => .Other(errno)
    )
  );
  export from_errno;
});

// File handle (reference-counted object)
File :: object(
  _fd : i32,

  // Open file (synchronous - fast syscall)
  open :: (fn(path: String, flags: i32) -> Result(Self, IOError))({
    cstr := path.as_cstr();  // Get null-terminated C string
    fd := __yo_file_open(cstr, flags, i32(0o644));
    cond(
      (fd >= 0) => .Ok(Self(_fd: fd)),
      true => .Err(IOError.from_errno((i32(0) - fd)))
    )
  }),

  // Get file descriptor (for internal use)
  fd :: (fn(self: Self) -> i32)(
    self._fd
  ),

  // Get file size (synchronous)
  size :: (fn(self: Self) -> Result(i64, IOError))({
    result := __yo_file_size(self._fd);
    cond(
      (result >= i64(0)) => .Ok(result),
      true => .Err(IOError.from_errno((i32(0) - (result as i32))))
    )
  }),

  // Close file (synchronous)
  close :: (fn(self: Self) -> unit)({
    __yo_file_close(self._fd);
  })
);

export 
  IOError,
  File,
  O_RDONLY, O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND
;
```

**Time Estimate:** 1 day

---

### Task 1.6: Tests

**File:** `tests/async_io.test.yo`

```yo
{ File, IOError, O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC } :: import "std/io/file.yo";
{ ArrayList } :: import "std/collections/array_list.yo";

test "file open and close" {
  // This is a sync test - just test open/close work
  result := File.open("tests/fixtures/test.txt", O_RDONLY);
  match(result,
    .Ok(file) => {
      file.close();
      assert(true);
    },
    .Err(_) => {
      // Create the test fixture directory/file first
      assert(false, "File should exist");
    }
  );
};

test "file not found" {
  result := File.open("/nonexistent/path/file.txt", O_RDONLY);
  match(result,
    .Ok(_) => assert(false, "Should fail"),
    .Err(e) => {
      match(e,
        .NotFound => assert(true),
        _ => assert(false, "Should be NotFound")
      );
    }
  );
};

test "async file read" async {
  // TODO: Implement once async read codegen is complete
  // bytes := await File.read_bytes_async("tests/fixtures/test.txt");
  // assert(bytes.is_ok());
};

export;
```

**Time Estimate:** 1 day

---

## Phase 2: Windows Implementation (Future)

### Task 2.1: IOCP Backend

**Additions to runtime:**

```c
#if defined(_WIN32)
#include <windows.h>
#include <io.h>
#include <fcntl.h>

static HANDLE __yo_iocp = NULL;
static size_t __yo_pending_io_count = 0;

typedef struct yo_io_state {
  void* state_machine;
  void (*resume_fn)(void*);
  int32_t result;
  bool completed;
  OVERLAPPED overlapped;  // Windows-specific
} yo_io_state_t;

static void __yo_io_init(void) {
  if (__yo_iocp != NULL) return;
  __yo_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (__yo_iocp == NULL) {
    fprintf(stderr, "[Yo] CreateIoCompletionPort failed: %lu\n", GetLastError());
    exit(1);
  }
}

// ... rest of IOCP implementation
#endif // _WIN32
```

**Time Estimate:** 2-3 days

---

## Phase 3: macOS Implementation (Future)

### Task 3.1: kqueue Backend

```c
#if defined(__APPLE__) || defined(__FreeBSD__)
#include <sys/event.h>
#include <fcntl.h>

static int __yo_kqueue_fd = -1;
static size_t __yo_pending_io_count = 0;

typedef struct yo_io_state {
  void* state_machine;
  void (*resume_fn)(void*);
  int32_t result;
  bool completed;
  // kqueue needs to store operation for deferred execution
  int32_t __fd;
  void* __buffer;
  size_t __size;
  int64_t __offset;
  bool __is_write;
} yo_io_state_t;

// ... kqueue implementation
#endif // __APPLE__
```

**Time Estimate:** 2-3 days

---

## Implementation Schedule

### Week 1 (Phase 1 - Linux)

| Day | Task |
|-----|------|
| 1 | Task 1.1: Vendor liburing |
| 2 | Task 1.2: C Runtime I/O header |
| 3 | Task 1.3: Update event loop |
| 4-5 | Task 1.4: Codegen async I/O await |

### Week 2 (Phase 1 - Continued)

| Day | Task |
|-----|------|
| 6 | Task 1.5: Yo standard library File API |
| 7 | Task 1.6: Tests |
| 8-9 | Bug fixes, refinements |
| 10 | Documentation |

### Week 3-4 (Phase 2 - Windows, Optional)

| Day | Task |
|-----|------|
| 11-13 | Task 2.1: IOCP backend |
| 14-15 | Testing on Windows |

### Week 5-6 (Phase 3 - macOS, Optional)

| Day | Task |
|-----|------|
| 16-18 | Task 3.1: kqueue backend |
| 19-20 | Testing on macOS |

---

## Build System Changes

### yo-cli Updates

**Linux compilation:**
```bash
clang -std=c11 -Wall -Wextra \
  a.out.c \
  vendor/liburing/src/setup.c \
  vendor/liburing/src/queue.c \
  vendor/liburing/src/register.c \
  vendor/liburing/src/syscall.c \
  -Ivendor/liburing/include \
  vendor/mimalloc/src/static.c \
  -Ivendor/mimalloc/include \
  -o a.out
```

**Windows compilation:**
```bash
cl /std:c11 a.out.c /link ws2_32.lib kernel32.lib /out:a.out.exe
```

**macOS compilation:**
```bash
clang -std=c11 -Wall -Wextra \
  a.out.c \
  vendor/mimalloc/src/static.c \
  -Ivendor/mimalloc/include \
  -o a.out
```

---

## Success Criteria

### Phase 1 (Linux)
- [ ] liburing vendored in `vendor/liburing/`
- [ ] `File.open()`, `File.close()`, `File.size()` work synchronously
- [ ] `__yo_async_read_submit()` submits to io_uring
- [ ] Event loop polls io_uring completions
- [ ] Basic async read test passes
- [ ] No memory leaks (AddressSanitizer clean)

### Phase 2 (Windows)
- [ ] IOCP backend compiles and links
- [ ] Same Yo API works on Windows
- [ ] Tests pass on Windows

### Phase 3 (macOS)
- [ ] kqueue backend compiles and links
- [ ] Same Yo API works on macOS
- [ ] Tests pass on macOS

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| io_uring not available (old kernel) | Medium | Check kernel version at init, fallback to blocking I/O |
| liburing vendoring issues | Low | liburing is header-heavy, minimal source files |
| Complex codegen changes | Medium | Start with hardcoded C test before full codegen |
| State machine memory leaks | Medium | Test with AddressSanitizer |
| Windows HANDLE vs fd conversion | Medium | Use _get_osfhandle() |

---

## Testing Strategy

### Unit Tests
```bash
# Run specific test
./yo-cli test tests/async_io.test.yo -v

# Run with sanitizer
./yo-cli compile tests/async_io.test.yo --sanitize address -o test && ./test
```

### Manual Testing
```bash
# Compile and run async I/O example
./yo-cli compile src/tests/examples/async_file_read.yo --release -o test
./test
```

### Stress Testing
```bash
# Concurrent file reads
./yo-cli compile tests/stress/concurrent_reads.yo --release -o stress
./stress  # Should handle 1000+ concurrent file reads
```

---

## References

- [io_uring documentation (PDF)](https://kernel.dk/io_uring.pdf)
- [liburing repository](https://github.com/axboe/liburing)
- [io_uring man page](https://man7.org/linux/man-pages/man7/io_uring.7.html)
- [Windows IOCP documentation](https://docs.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [kqueue man page](https://www.freebsd.org/cgi/man.cgi?kqueue)
