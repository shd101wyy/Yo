# Async I/O Implementation Plan

## Overview

This document outlines the implementation plan for Yo's async I/O system:

| Platform    | Backend     | Status      | Description                      |
| ----------- | ----------- | ----------- | -------------------------------- |
| **Linux**   | io_uring    | ✅ Complete | True async I/O via liburing      |
| **macOS**   | dispatch_io | ✅ Complete | GCD for async file I/O           |
| **Windows** | IOCP        | 🔜 Planned  | I/O Completion Ports             |
| **FreeBSD** | kqueue      | 🔜 Planned  | Event notification + thread pool |

All platforms share a unified Yo API (`std/io.yo`) with platform-specific C implementations in `src/codegen/async/runtime.ts`.

## Architecture Decision: Manual vs libuv

We chose **manual platform-specific implementations** over libuv because:

1. **Event loop integration**: Yo's async/await compiles to state machines with its own scheduler. libuv's callback-based event loop would require a bridge layer.

2. **No runtime dependency**: Yo programs are self-contained with no runtime dependencies.

3. **Maximum performance**: Direct use of io_uring/dispatch_io/IOCP without abstraction overhead.

4. **Clean model**: I/O completions wake state machines directly - perfect fit for Yo's design.

## Implementation Status

### Phase 1: Linux (io_uring) ✅ COMPLETE

| Component                 | Status | Notes                           |
| ------------------------- | ------ | ------------------------------- |
| io_uring initialization   | ✅     | Lazy init on first I/O op       |
| Async read/write          | ✅     | `__yo_async_read/write_start`   |
| Async open/close          | ✅     | `__yo_async_openat/close_start` |
| Async stat (statx)        | ✅     | `__yo_async_statx_start`        |
| Async mkdir/unlink/rename | ✅     | Directory operations            |
| Async symlink/link        | ✅     | Link operations                 |
| Async fsync/fdatasync     | ✅     | Data integrity                  |
| Async ftruncate           | ✅     | File truncation                 |
| Event loop integration    | ✅     | `__yo_io_poll/wait`             |

### Phase 2: macOS (dispatch_io) ✅ COMPLETE

| Component                  | Status | Notes                                    |
| -------------------------- | ------ | ---------------------------------------- |
| dispatch_io initialization | ✅     | Serial queue for completions             |
| Async read/write           | ✅     | True async via dispatch_io               |
| Async open/close           | ✅     | Sync wrapper (dispatch_io needs open fd) |
| Async stat                 | ✅     | Uses struct stat (not statx)             |
| Async mkdir/unlink/rename  | ✅     | Sync wrappers in completed futures       |
| Async symlink/link         | ✅     | Sync wrappers                            |
| Async fsync                | ✅     | Sync wrapper                             |
| Async ftruncate            | ✅     | Sync wrapper                             |
| Event loop integration     | ✅     | Semaphore-based wait                     |

**macOS Note**: Only read/write use true async I/O via dispatch_io. Other operations (open, stat, mkdir, etc.) complete synchronously but return futures for API consistency.

### Phase 3: Windows (IOCP) 🔜 PLANNED

| Component              | Status | Notes                      |
| ---------------------- | ------ | -------------------------- |
| IOCP initialization    | 🔜     | CreateIoCompletionPort     |
| Async read/write       | 🔜     | Overlapped I/O             |
| Async open/close       | 🔜     | CreateFile + IOCP          |
| File metadata          | 🔜     | GetFileInformationByHandle |
| Directory operations   | 🔜     | Win32 API wrappers         |
| Event loop integration | 🔜     | GetQueuedCompletionStatus  |

## API Implementation Status

### std/io.yo Declared APIs vs C Runtime Implementation

| API Category       | Function                      | io.yo | Linux | macOS | Notes               |
| ------------------ | ----------------------------- | ----- | ----- | ----- | ------------------- |
| **File I/O**       | `__yo_async_read_start`       | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_write_start`      | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_openat_start`     | ✅    | ✅    | ✅    | macOS: sync wrapper |
|                    | `__yo_async_close_start`      | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_statx_start`      | ✅    | ✅    | ✅    | macOS: uses stat    |
|                    | `__yo_async_fsync_start`      | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_fdatasync_start`  | ✅    | ✅    | ✅    | macOS: uses fsync   |
|                    | `__yo_async_ftruncate_start`  | ✅    | ✅    | ✅    |                     |
| **Directory Ops**  | `__yo_async_mkdirat_start`    | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_unlinkat_start`   | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_renameat_start`   | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_symlinkat_start`  | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_linkat_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_getdents_start`   | ✅    | ❌    | ❌    | TODO: implement     |
| **Permissions**    | `__yo_async_fchmod_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_fchmodat_start`   | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_fchown_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_fchownat_start`   | ✅    | ✅    | ✅    |                     |
| **Links**          | `__yo_async_readlinkat_start` | ✅    | ✅    | ✅    |                     |
| **FD Ops**         | `__yo_async_dup_start`        | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_dup2_start`       | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_pipe_start`       | ✅    | ✅    | ✅    |                     |
| **Socket Ops**     | `__yo_async_socket_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_bind_start`       | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_listen_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_accept_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_connect_start`    | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_send_start`       | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_recv_start`       | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_sendto_start`     | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_recvfrom_start`   | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_shutdown_start`   | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_setsockopt_start` | ✅    | ✅    | ✅    |                     |
|                    | `__yo_async_getsockopt_start` | ✅    | ✅    | ✅    |                     |
| **Dirent Helpers** | `__yo_dirent_size`            | ✅    | ❌    | ❌    | TODO: implement     |
|                    | `__yo_dirent_reclen`          | ✅    | ❌    | ❌    | TODO: implement     |
|                    | `__yo_dirent_type`            | ✅    | ✅    | ✅    | Existing helper     |
|                    | `__yo_dirent_name`            | ✅    | ✅    | ✅    | Existing helper     |
|                    | `__yo_dirent_ino`             | ✅    | ❌    | ❌    | TODO: implement     |

### Pending Implementation Tasks

1. **Directory listing (getdents)**: Need to implement `__yo_async_getdents_start` and dirent helpers for reading directory contents.

2. **Windows IOCP backend**: Full implementation needed for Windows support.

---

## liburing Dependency (Linux)

**All platforms:**

- Working async/await codegen with state machines

## Phase 1: Linux Implementation

### Task 1.1: Verify liburing Installation ✓

**Status:** COMPLETED. System-wide liburing is detected via `pkg-config` in the Yo compiler.

**Verification:**

```bash
pkg-config liburing --cflags --libs
```

---

### Task 1.2: C Runtime - I/O Header ✓

**Status:** COMPLETED. C runtime for io_uring async I/O has been implemented in `src/codegen/async/runtime.ts`.

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

---

### Task 1.3: Update Event Loop ✓

**Status:** COMPLETED. Event loop has been updated to integrate io_uring polling.

**Recent Fixes (2025-12-30):**

- ✅ **Critical**: Fixed branch info pollution between nested async blocks
  - Problem: `context.condBranchInfo` was shared across all async blocks in a function, causing nested async blocks to generate code for branches from parent async blocks
  - Solution: Clear `context.condBranchInfo = new Map()` at start of `generateAsyncBlockResumeFunction()` to isolate each async block's branch tracking
  - Result: Nested async blocks (like `write_bytes_async`) no longer try to reference variables from outer async blocks (like `write_file` from main)
  - File: [src/codegen/async/state-machine.ts](src/codegen/async/state-machine.ts#L130-L133)

**Previously Fixed:**

- ✅ Lazy io_uring initialization in `__yo_async_read_start()` and `__yo_async_write_start()` to support eager async block execution
- ✅ Updated `__yo_async_wait_all()` to poll I/O events and wait for pending I/O completions
- ✅ Fixed async block capture to properly dup borrowed variables from match destructuring
- ✅ Fixed async block codegen to handle method-call style dup expressions `(varName.___dup)()`

**Test Results:**

```bash
$ ./yo-cli compile src/tests/examples/fixme.yo --release && ./a.out
# Success! Program completes without errors
$ cat /tmp/yo_async_test.txt
Hello async write!
```

The async I/O implementation now correctly handles:

- ✅ File write with async I/O
- ✅ File read with async I/O
- ✅ Match expressions with await inside branches
- ✅ Nested async blocks (write_string_async → write_bytes_async)
- ✅ Variable scoping across await boundaries
- ✅ Proper reference counting for File handles
- ✅ Content verification (length and data validation)

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

### Task 1.4: Codegen - Async I/O Await Pattern (IN PROGRESS)

**Status:** IN PROGRESS. Basic async I/O works for simple cases. Complex cases with nested async blocks in match expressions have issues.

**Completed:**

- ✅ `Concrete(T)` builtin trait for explicit extern type resolution
- ✅ `IOReadFuture` and `IOWriteFuture` types using `Impl(Concrete(yo_io_future_t), Future(i32))`
- ✅ Fixed `getTypeString` to handle extern types vs async block capture structs
- ✅ Added `localShadowedVariables` for match destructuring in state machines
- ✅ Fixed match expression codegen for early returns and local variable bindings
- ✅ Lazy io_uring initialization for eager async execution
- ✅ Async block ownership model: proper duping of borrowed variables
- ✅ Event loop I/O polling integration

**Current Issues (blocking fixme.yo):**

- ❌ **Critical**: Variables from match case destructuring (e.g., `write_file` from `.Ok(write_file)`) not stored in state machine when used after await points
- ❌ **Critical**: Variables assigned in match cases (e.g., `write_result := await ...`) not stored in state machine across await boundaries
- ❌ **Critical**: Missing `cond_branch_0` field in state machine structs - conditional branches inside async blocks after await points don't generate state machine fields
- ❌ Match case variables need to be added to state machine's captured/local variables when they cross await boundaries

**Root Cause:**
The await analysis and state machine variable tracking doesn't properly handle variables that are:

1. Declared inside match cases via destructuring (`.Ok(file) => ...`)
2. Assigned inside match cases before an await
3. Used after the await point in subsequent code

The state machine needs to store these variables as `var_*` fields, but currently they're being treated as local C variables that don't persist across state transitions.

**Current Approach:**c_read(...)` and generate special state machine code.

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

---

### Task 1.5: Yo Standard Library - File API ✓

**Status:** COMPLETED. `std/io/file.yo` implemented with:
- ✅ Synchronous operations: `File.open()`, `File.close()`, `File.size()`
- ✅ Async operations: `read_bytes_async()`, `read_string_async()`, `write_bytes_async()`, `write_string_async()`
- ✅ `IOError` enum with error code mapping
- ✅ Proper extern type declarations for io_uring futures
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
---

**Working Test Cases:**
- ✅ Simple async block with single await (reading file)
- ✅ Match destructuring with borrowed variable captured by async block
- ✅ File read operations with io_uring

**Failing Test Cases:**
- ❌ Nested async blocks inside match cases (variable scoping issues)
- ❌ Multiple sequential async operations in same async block
- ❌ Complex control flow with conditionals inside async blocks

### Task 1.6: Tests (BLOCKED)

**Status:** BLOCKED by Task 1.4 codegen issues.
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

| Day | Task                              |
| --- | --------------------------------- |
| 1   | Task 1.1: Vendor liburing         |
| 2   | Task 1.2: C Runtime I/O header    |
| 3   | Task 1.3: Update event loop       |
| 4-5 | Task 1.4: Codegen async I/O await |

### Week 2 (Phase 1 - Continued)

| Day | Task                                   |
| --- | -------------------------------------- |
| 6   | Task 1.5: Yo standard library File API |
| 7   | Task 1.6: Tests                        |
| 8-9 | Bug fixes, refinements                 |
| 10  | Documentation                          |

### Week 3-4 (Phase 2 - Windows, Optional)

| Day   | Task                   |
| ----- | ---------------------- |
| 11-13 | Task 2.1: IOCP backend |
| 14-15 | Testing on Windows     |

### Week 5-6 (Phase 3 - macOS, Optional)

| Day   | Task                     |
| ----- | ------------------------ |
| 16-18 | Task 3.1: kqueue backend |
| 19-20 | Testing on macOS         |

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

src/
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

- [x] liburing added as git submodule in `vendor/liburing/`
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

| Risk                                | Impact | Mitigation                                             |
| ----------------------------------- | ------ | ------------------------------------------------------ |
| io_uring not available (old kernel) | Medium | Check kernel version at init, fallback to blocking I/O |
| liburing vendoring issues           | Low    | liburing is header-heavy, minimal source files         |
| Complex codegen changes             | Medium | Start with hardcoded C test before full codegen        |
| State machine memory leaks          | Medium | Test with AddressSanitizer                             |
| Windows HANDLE vs fd conversion     | Medium | Use \_get_osfhandle()                                  |

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

---

## Changelog

### 2025-12-30: Branch Info Isolation Fix

**Problem:** Nested async blocks were generating incorrect code because `context.condBranchInfo` was shared across all async blocks within a function. When the outer async block (e.g., in `main`) was generated first, it populated the branch tracking map. Then when nested async blocks (e.g., `write_bytes_async`) were generated, they reused the same map and tried to generate code for branches from the OUTER async block.

**Example Error:**

```c
// Inside write_bytes_async's state machine resume function:
switch (sm->cond_branch_0) {  // ERROR: cond_branch_0 field doesn't exist!
  case 0: {
    fn_id47119_close(write_file);  // ERROR: write_file is from outer async block!
```

**Root Cause:** The codegen in `generateAsyncBlockResumeFunction()` directly used the shared `context.condBranchInfo` without clearing it first. Each async block accumulated branch info from all previously generated async blocks.

**Solution:** Clear `context.condBranchInfo = new Map()` at the start of `generateAsyncBlockResumeFunction()` to isolate each async block's branch tracking. This ensures:

- Each async block only sees its own conditional branches
- State machine structs only include fields for their own branches
- Generated code only references variables from the correct scope

**Files Changed:**

- [src/codegen/async/state-machine.ts](src/codegen/async/state-machine.ts#L130-L133) - Added `context.condBranchInfo = new Map()` isolation

**Test Case:** [src/tests/examples/fixme.yo](src/tests/examples/fixme.yo) - Nested async blocks with match expressions and await

- Outer async: `main()` with File.open → await write → File.open → await read
- Nested async: `write_bytes_async()` with buffer ptr match → await io_uring → cond result check
- Result: Both compile and run correctly without branch info pollution

**Memory Safety:**

- ✅ No use-after-free errors
- ✅ No invalid memory access
- ✅ All async operations complete successfully
- ⚠️ Known issue: State machines aren't freed at program exit (expected behavior, async runtime cleanup not yet implemented)
- AddressSanitizer report: 794 bytes leaked from async state machines and their contents (File handles, Strings, Result wrappers)
