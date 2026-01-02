# Async I/O for Yo

## Philosophy

Yo integrates platform-native async I/O APIs with the single-threaded async/await event loop:

| Platform      | Backend  | Priority | Description                                                   |
| ------------- | -------- | -------- | ------------------------------------------------------------- |
| **Linux**     | io_uring | Phase 1  | True async I/O with kernel-performed operations (kernel 5.1+) |
| **Windows**   | IOCP     | Phase 2  | I/O Completion Ports with overlapped I/O                      |
| **macOS/BSD** | kqueue   | Phase 3  | Event notification + non-blocking I/O                         |

All async I/O operations run on the **same thread** as other async tasks - no worker threads involved.

**Key Insight**: Async I/O provides **non-blocking** operations, not parallelism. The event loop polls for I/O completion between task executions, enabling efficient handling of many concurrent I/O operations without blocking.

```yo
// All I/O runs on the SAME thread as the event loop
main :: (fn() -> unit) {
  async {
    // Start two file reads concurrently
    f1 := File.read_bytes_async("data1.txt");  // Returns immediately
    f2 := File.read_bytes_async("data2.txt");  // Returns immediately

    // Both I/O operations in flight on THIS thread
    data1 := await f1;  // Suspend until ready, returns Result([u8], IOError)
    data2 := await f2;  // Suspend until ready, returns Result([u8], IOError)

    // Or use read_string_async for text files
    text := await File.read_string_async("text.txt");  // Returns Result(String, IOError)
  };
};
```

## liburing Dependency

Yo uses **liburing** for io_uring operations rather than direct syscalls:

**Why liburing (not raw syscalls):**
- liburing is a thin wrapper (~5KB code) maintained by io_uring author Jens Axboe
- Handles ring buffer memory mapping correctly
- Well-tested and actively maintained
- Raw syscalls require managing mmap'd ring buffers manually - error-prone

**System Dependency:**

liburing must be installed system-wide. The Yo compiler detects it via `pkg-config`.

**Installation:**

```bash
# Arch Linux / Manjaro / SteamOS
sudo pacman -S liburing

# Ubuntu / Debian
sudo apt-get install liburing-dev

# Fedora / RHEL
sudo dnf install liburing-devel

# From source
git clone https://github.com/axboe/liburing.git
cd liburing
./configure
make
sudo make install
```

**Detection:**
The Yo compiler will check for liburing using `pkg-config liburing --cflags --libs`. If not found, async file I/O will not be available.

**Fallback for older kernels:**
- On Linux kernel < 5.1: Falls back to blocking I/O with thread pool (future)
- On other platforms: Uses native backend (IOCP/kqueue)

## Design Goals

1. **Single-threaded**: All async I/O runs on the event loop thread
2. **Non-atomic RC**: No synchronization overhead (single thread)
3. **Cross-platform**: Unified API across Linux/macOS/Windows
4. **Efficient**: Platform-native backends (io_uring/kqueue/IOCP)
5. **Simple API**: async/await syntax, no callbacks
6. **Memory efficient**: State machines (~200 bytes) per operation

## Architecture

### Event Loop with io_uring Integration

```
┌────────────────────────────────────────────────────────────────┐
│                    Event Loop (Main Thread)                    │
│                                                                │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Ready Queue                          │   │
│  │  ┌─────┐ ┌─────┐ ┌─────┐                                │   │
│  │  │Task1│ │Task2│ │Task3│  ...                           │   │
│  │  └─────┘ └─────┘ └─────┘                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Poll next ready task                       │   │
│  │    - Run until await                                    │   │
│  │    - If I/O await, submit to io_uring                   │   │
│  │    - If ready, continue                                 │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              io_uring Completion Check                  │   │
│  │    - io_uring_peek_cqe() - non-blocking check           │   │
│  │    - For each completion:                               │   │
│  │      - Extract result (bytes read/written, error)       │   │
│  │      - Wake waiting state machine                       │   │
│  │      - Add to ready queue                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                         │                                      │
│                         ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              If no ready tasks, block on io_uring       │   │
│  │    - io_uring_wait_cqe() - blocks until I/O completes   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Platform Backends

### Linux: io_uring

io_uring is Linux's modern async I/O interface (kernel 5.1+):

- **Submission Queue (SQ)**: Ring buffer for submitting I/O requests
- **Completion Queue (CQ)**: Ring buffer for completed I/O results
- **Zero-copy**: Shared memory between user space and kernel
- **Batching**: Multiple I/O operations per syscall
- **True async**: Kernel performs I/O, not just notification

```c
// io_uring setup (once per event loop)
struct io_uring ring;
io_uring_queue_init(256, &ring, 0);  // 256 entries

// Submit async read
struct io_uring_sqe* sqe = io_uring_get_sqe(&ring);
io_uring_prep_read(sqe, fd, buffer, size, offset);
io_uring_sqe_set_data(sqe, state_machine);  // User data = state machine ptr
io_uring_submit(&ring);

// Check for completions (non-blocking)
struct io_uring_cqe* cqe;
while (io_uring_peek_cqe(&ring, &cqe) == 0) {
  void* state_machine = io_uring_cqe_get_data(cqe);
  int result = cqe->res;  // Bytes read or error
  io_uring_cqe_seen(&ring, cqe);
  // Wake state machine with result
}
```

### macOS/BSD: kqueue

kqueue provides efficient event notification for BSD-based systems:

- **Event-based**: Notifies when fd is ready for I/O
- **Efficient**: O(1) event registration and retrieval
- **Versatile**: Supports files, sockets, signals, timers
- **Non-blocking**: Combines with non-blocking syscalls

```c
// kqueue setup (once per event loop)
int kq = kqueue();

// Register interest in fd readability
struct kevent ev;
EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, state_machine);
kevent(kq, &ev, 1, NULL, 0, NULL);

// Poll for events (non-blocking)
struct kevent events[64];
struct timespec timeout = {0, 0};  // Non-blocking
int n = kevent(kq, NULL, 0, events, 64, &timeout);

for (int i = 0; i < n; i++) {
  void* state_machine = events[i].udata;
  // fd is ready - perform non-blocking read
  ssize_t result = read(events[i].ident, buffer, size);
  // Wake state machine with result
}
```

**Note**: Unlike io*uring, kqueue only provides \_notification* that I/O is ready. The actual read/write syscall happens in user space with non-blocking mode.

### Windows: IOCP (I/O Completion Ports)

IOCP is Windows' native async I/O mechanism:

- **Completion-based**: Notifies when I/O operation completes
- **True async**: Kernel performs the I/O operation
- **Overlapped I/O**: Uses OVERLAPPED structures for async state
- **Scalable**: Designed for high-concurrency servers

```c
// IOCP setup (once per event loop)
HANDLE iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);

// Associate file handle with IOCP
CreateIoCompletionPort(file_handle, iocp, (ULONG_PTR)state_machine, 0);

// Submit async read
OVERLAPPED overlapped = {0};
overlapped.hEvent = (HANDLE)io_state;  // Store our state
ReadFile(file_handle, buffer, size, NULL, &overlapped);

// Poll for completions
OVERLAPPED_ENTRY entries[64];
ULONG count;
GetQueuedCompletionStatusEx(iocp, entries, 64, &count, 0, FALSE);

for (ULONG i = 0; i < count; i++) {
  yo_io_state_t* io_state = (yo_io_state_t*)entries[i].lpOverlapped->hEvent;
  DWORD bytes = entries[i].dwNumberOfBytesTransferred;
  // Wake state machine with result
}
```

### C Runtime Structures

```c
// Platform-specific backend handle
#if defined(__linux__)
  #include <liburing.h>
  struct io_uring __yo_io_ring;
#elif defined(__APPLE__) || defined(__FreeBSD__)
  int __yo_kqueue_fd;
#elif defined(_WIN32)
  #include <windows.h>
  HANDLE __yo_iocp;
#endif

// I/O operation state (stored in state machine) - cross-platform
typedef struct yo_io_state {
  void* state_machine;       // Owning state machine
  void (*resume_fn)(void*);  // Resume function
  int32_t result;            // Result: bytes or -errno (negative on error)
  bool completed;            // Completion flag
#if defined(_WIN32)
  OVERLAPPED overlapped;     // Windows overlapped I/O state
#endif
} yo_io_state_t;
```

### Event Loop Integration

The event loop uses a platform abstraction layer:

```c
// Platform-agnostic event loop
void __yo_event_loop_run(void) {
  __yo_io_init();  // Initialize platform backend

  while (__yo_has_pending_tasks() || __yo_has_pending_io()) {
    // 1. Process ready async tasks (up to 100 per iteration)
    int tasks_run = 0;
    while (tasks_run < 100) {
      yo_continuation_t* task = __yo_dequeue_ready_task();
      if (!task) break;

      task->resume_fn(task->state_machine);
      tasks_run++;
    }

    // 2. Poll I/O completions (non-blocking)
    __yo_io_poll();

    // 3. If no ready tasks but pending I/O, block until completion
    if (!__yo_has_ready_tasks() && __yo_has_pending_io()) {
      __yo_io_wait();
    }
  }

  __yo_io_cleanup();
}
```

### Platform Abstraction Layer

```c
// yo_io.h - Cross-platform async I/O API

// Initialize platform backend
void __yo_io_init(void);
void __yo_io_cleanup(void);

// Check pending I/O
bool __yo_has_pending_io(void);

// Submit async operations
void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state);
void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                             int64_t offset, yo_io_state_t* io_state);

// Poll/wait for completions
int __yo_io_poll(void);   // Non-blocking, returns completion count
int __yo_io_wait(void);   // Blocking, waits for at least one completion
```

#### Linux Implementation (io_uring)

```c
void __yo_io_init(void) {
  io_uring_queue_init(256, &__yo_io_ring, 0);
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  io_uring_prep_read(sqe, fd, buffer, size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
}

int __yo_io_poll(void) {
  struct io_uring_cqe* cqe;
  int count = 0;
  while (io_uring_peek_cqe(&__yo_io_ring, &cqe) == 0) {
    yo_io_state_t* io_state = io_uring_cqe_get_data(cqe);
    io_state->result = cqe->res;
    io_state->completed = true;
    __yo_enqueue_ready_task(io_state->resume_fn, io_state->state_machine);
    io_uring_cqe_seen(&__yo_io_ring, cqe);
    __yo_pending_io_count--;
    count++;
  }
  return count;
}
```

#### macOS Implementation (kqueue)

```c
void __yo_io_init(void) {
  __yo_kqueue_fd = kqueue();
}

void __yo_async_read_submit(int32_t fd, void* buffer, size_t size,
                            int64_t offset, yo_io_state_t* io_state) {
  // Store operation details in io_state for later
  io_state->__fd = fd;
  io_state->__buffer = buffer;
  io_state->__size = size;
  io_state->__offset = offset;

  // Set fd to non-blocking
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);

  // Register for read readiness
  struct kevent ev;
  EV_SET(&ev, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, io_state);
  kevent(__yo_kqueue_fd, &ev, 1, NULL, 0, NULL);
  __yo_pending_io_count++;
}

int __yo_io_poll(void) {
  struct kevent events[64];
  struct timespec timeout = {0, 0};
  int n = kevent(__yo_kqueue_fd, NULL, 0, events, 64, &timeout);

  for (int i = 0; i < n; i++) {
    yo_io_state_t* io_state = events[i].udata;
    // Perform the actual I/O (non-blocking)
    if (io_state->__offset >= 0) {
      lseek(io_state->__fd, io_state->__offset, SEEK_SET);
    }
    ssize_t result = read(io_state->__fd, io_state->__buffer, io_state->__size);
    io_state->result = (result >= 0) ? result : -errno;
    io_state->completed = true;
    __yo_enqueue_ready_task(io_state->resume_fn, io_state->state_machine);
    __yo_pending_io_count--;
  }
  return n;
}
```

#### Windows Implementation (IOCP)

```c
void __yo_io_init(void) {
  __yo_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
}

void __yo_async_read_submit(HANDLE file, void* buffer, DWORD size,
                            int64_t offset, yo_io_state_t* io_state) {
  // Associate file with IOCP
  CreateIoCompletionPort(file, __yo_iocp, (ULONG_PTR)io_state, 0);

  // Setup overlapped structure
  memset(&io_state->overlapped, 0, sizeof(OVERLAPPED));
  io_state->overlapped.Offset = (DWORD)(offset & 0xFFFFFFFF);
  io_state->overlapped.OffsetHigh = (DWORD)(offset >> 32);

  // Submit async read
  ReadFile(file, buffer, size, NULL, &io_state->overlapped);
  __yo_pending_io_count++;
}

int __yo_io_poll(void) {
  OVERLAPPED_ENTRY entries[64];
  ULONG count = 0;
  GetQueuedCompletionStatusEx(__yo_iocp, entries, 64, &count, 0, FALSE);

  for (ULONG i = 0; i < count; i++) {
    yo_io_state_t* io_state = (yo_io_state_t*)entries[i].lpCompletionKey;
    io_state->result = entries[i].dwNumberOfBytesTransferred;
    io_state->completed = true;
    __yo_enqueue_ready_task(io_state->resume_fn, io_state->state_machine);
    __yo_pending_io_count--;
  }
  return count;
}
```

## Async File I/O API

### Data Types

**Return types for file reads:**
- `[u8]` (slice) - Fat pointer with data pointer + length, for binary data
- `String` - UTF-8 validated string, for text files

**Buffer types:**
- `ArrayList(u8)` - Dynamic growable buffer (like Rust's `Vec<u8>`)
- `Array(u8, N)` - Fixed-size stack buffer (C array)

### Yo Interface

```yo
{ ArrayList } :: import "std/collections/array_list.yo";

// I/O Error type
IOError :: enum(
  NotFound,
  PermissionDenied,
  IsADirectory,
  NoSpaceLeft,
  InvalidUtf8,
  Other(code: i32, message: String)
);

// Core async file operations
File :: object(
  fd : i32,

  // Open file (synchronous - fast syscall)
  open :: (fn(path: String, flags: i32) -> Result(Self, IOError))({
    fd := __yo_file_open(path.as_cstr(), flags);
    cond(
      (fd >= 0) => .Ok(Self(fd)),
      true => .Err(IOError.from_errno((0 - fd) as i32))
    )
  }),

  // Get file size (synchronous)
  size :: (fn(self: Self) -> Result(i64, IOError))({
    result := __yo_file_size(self.fd);
    cond(
      (result >= 0) => .Ok(result),
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  }),

  // Async read into buffer - returns bytes read
  // buffer: ArrayList(u8) with pre-allocated capacity
  read_async :: (fn(self: Self, buffer: ArrayList(u8), offset: i64) -> Impl Future(Result(usize, IOError))) async {
    result := await __yo_async_read(self.fd, buffer.ptr(), buffer.capacity(), offset);
    cond(
      (result >= 0) => {
        buffer.set_len(result as usize);  // Update length to bytes read
        .Ok(result as usize)
      },
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  },

  // Async write from slice - returns bytes written
  write_async :: (fn(self: Self, data: [u8], offset: i64) -> Impl Future(Result(usize, IOError))) async {
    result := await __yo_async_write(self.fd, data.ptr(), data.len(), offset);
    cond(
      (result >= 0) => .Ok(result as usize),
      true => .Err(IOError.from_errno((0 - result) as i32))
    )
  },

  // Close file (synchronous)
  close :: (fn(self: Self) -> unit)({
    __yo_file_close(self.fd);
  })
);

// ============================================================================
// Convenience Functions
// ============================================================================

// Read entire file as bytes (returns slice backed by ArrayList)
File.read_bytes_async :: (fn(path: String) -> Impl Future(Result([u8], IOError))) async {
  file := match(File.open(path, O_RDONLY),
    .Ok(f) => f,
    .Err(e) => return .Err(e)
  );

  size := match(file.size(),
    .Ok(s) => s,
    .Err(e) => { file.close(); return .Err(e); }
  );

  buffer := ArrayList(u8).with_capacity(size as usize);
  result := await file.read_async(buffer, i64(0));
  file.close();

  match(result,
    .Ok(bytes_read) => .Ok(buffer.as_slice()),
    .Err(e) => .Err(e)
  )
};

// Read entire file as UTF-8 String
File.read_string_async :: (fn(path: String) -> Impl Future(Result(String, IOError))) async {
  bytes_result := await File.read_bytes_async(path);
  match(bytes_result,
    .Ok(bytes) => {
      // Validate UTF-8 and create String
      match(String.from_utf8_checked(bytes),
        .Ok(s) => .Ok(s),
        .Err(_) => .Err(.InvalidUtf8)
      )
    },
    .Err(e) => .Err(e)
  )
};

// Write string to file
File.write_string_async :: (fn(path: String, data: String) -> Impl Future(Result(unit, IOError))) async {
  file := match(File.open(path, ((O_WRONLY | O_CREAT) | O_TRUNC)),
    .Ok(f) => f,
    .Err(e) => return .Err(e)
  );

  bytes := data.as_bytes();  // Returns ArrayList(u8)
  result := await file.write_async(bytes.as_slice(), i64(0));
  file.close();

  match(result,
    .Ok(_) => .Ok(()),
    .Err(e) => .Err(e)
  )
};

// Write bytes to file
File.write_bytes_async :: (fn(path: String, data: [u8]) -> Impl Future(Result(unit, IOError))) async {
  file := match(File.open(path, ((O_WRONLY | O_CREAT) | O_TRUNC)),
    .Ok(f) => f,
    .Err(e) => return .Err(e)
  );

  result := await file.write_async(data, i64(0));
  file.close();

  match(result,
    .Ok(_) => .Ok(()),
    .Err(e) => .Err(e)
  )
};
```

### C Runtime Implementation

```c
// Initialize io_uring (called once at event loop start)
void __yo_io_init(void) {
  int ret = io_uring_queue_init(256, &__yo_io_ring, 0);
  if (ret < 0) {
    fprintf(stderr, "io_uring_queue_init failed: %s\n", strerror(-ret));
    exit(1);
  }
}

// Cleanup io_uring
void __yo_io_cleanup(void) {
  io_uring_queue_exit(&__yo_io_ring);
}

// File open (synchronous - typically fast)
int32_t __yo_file_open(const char* path, int32_t flags) {
  int fd = open(path, flags, 0644);
  return fd >= 0 ? fd : -errno;
}

// File close (synchronous)
void __yo_file_close(int32_t fd) {
  close(fd);
}

// Submit async read to io_uring
// Returns immediately, completion delivered via state machine
void __yo_async_read_submit(int32_t fd, void* buffer, size_t size, int64_t offset,
                            yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full - should not happen with proper sizing
    io_state->result = -EAGAIN;
    io_state->completed = true;
    return;
  }

  io_uring_prep_read(sqe, fd, buffer, size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
}

// Submit async write to io_uring
void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size, int64_t offset,
                             yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    io_state->result = -EAGAIN;
    io_state->completed = true;
    return;
  }

  io_uring_prep_write(sqe, fd, buffer, size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
}
```

### State Machine Integration

When codegen encounters `await __yo_async_read(...)`, it generates:

```c
// State machine for: result := await __yo_async_read(fd, buf, size, offset)
case STATE_AWAIT_READ:
  // First entry: submit I/O and suspend
  if (!sm->io_state.completed) {
    sm->io_state.state_machine = sm;
    sm->io_state.resume_fn = (void(*)(void*))this_resume_fn;
    sm->io_state.completed = false;

    __yo_async_read_submit(sm->fd, sm->buffer, sm->size, sm->offset, &sm->io_state);

    // Suspend - do NOT add to ready queue yet
    // io_uring completion will wake us
    return;
  }

  // Resumed after I/O completion
  sm->result = sm->io_state.result;
  sm->io_state.completed = false;  // Reset for potential reuse
  sm->state = STATE_NEXT;
  // Fall through to next state...
```

## Example: Concurrent File Processing

```yo
{ ArrayList } :: import "std/collections/array_list.yo";

process_files :: (fn(paths: ArrayList(String)) -> Impl Future(ArrayList(String))) async {
  // Start all reads concurrently (all on same thread!)
  // Note: In production, we'd use a proper Future collection type
  results := ArrayList(String).new();
  
  i := usize(0);
  while ((i < paths.len())), (i = (i + usize(1))), {
    path := paths.get(i).unwrap();
    result := await File.read_string_async(path);
    match(result,
      .Ok(content) => { results.push(content); },
      .Err(e) => println("Error reading file")
    );
  };

  results
};

main :: (fn() -> unit) {
  async {
    paths := ArrayList(String).new();
    paths.push("file1.txt");
    paths.push("file2.txt");
    paths.push("file3.txt");
    
    contents := await process_files(paths);

    i := usize(0);
    while ((i < contents.len())), (i = (i + usize(1))), {
      content := contents.get(i).unwrap();
      println("Content length: ");
      println(content.len().to_string());
    };
  };
};

export main;
```

## Performance Characteristics

### Memory Usage

**10,000 concurrent file I/O operations:**

- State machines: 10,000 × ~200 bytes = 2MB
- io_uring SQEs: 256 × 64 bytes = 16KB (ring buffer, reused)
- Total: ~2MB

**Comparison:**

- Synchronous blocking: 10,000 threads × 1MB stack = 10GB ❌
- Yo async I/O: ~2MB ✅

### Throughput

- io_uring batches submissions: fewer syscalls
- Zero-copy for many operations
- No thread context switching (single-threaded)
- State machine poll: ~10-50ns

### Latency

- Submission: ~50-100ns (user space ring buffer write)
- Completion: ~100-200ns (user space ring buffer read)
- No syscall for submission if SQE available
- io_uring_submit() only when kernel needs notification

## Error Handling

io_uring returns negative errno values on error:

```yo
{ ArrayList } :: import "std/collections/array_list.yo";

read_with_retry :: (fn(file: File, size: usize, offset: i64) -> Impl Future(Result([u8], IOError))) async {
  max_retries := 3;
  retry := 0;
  buffer := ArrayList(u8).with_capacity(size);

  while ((retry < max_retries)), (retry = (retry + 1)), {
    result := await file.read_async(buffer, offset);
    match(result,
      .Ok(bytes) => return .Ok(buffer.as_slice()),
      .Err(e) => {
        match(e,
          .Other(code, _) => {
            // EINTR (4) or EAGAIN (11) - retry
            cond(
              ((code == 4) || (code == 11)) => (),  // Continue retry loop
              true => return .Err(e)  // Non-retryable error
            );
          },
          _ => return .Err(e)  // Non-retryable error
        );
      }
    );
  };

  .Err(.Other(0, "Max retries exceeded"))
};
```

## Platform Support

### Linux (io_uring)

| Kernel Version | Features                              |
| -------------- | ------------------------------------- |
| **5.1+**       | Basic io_uring (read, write, fsync)   |
| **5.6+**       | Registered buffers, linked operations |
| **5.11+**      | Better performance, more operations   |
| **5.19+**      | io_uring_prep_read_multishot          |

**Requirements:**

- liburing library
- Kernel 5.1 or newer

### macOS/BSD (kqueue)

| OS               | Support             |
| ---------------- | ------------------- |
| **macOS 10.6+**  | Full kqueue support |
| **FreeBSD 4.1+** | Full kqueue support |
| **OpenBSD 2.9+** | Full kqueue support |

**Characteristics:**

- Event notification only (not true async I/O)
- Requires non-blocking mode + retry on EAGAIN
- Slightly higher latency than io_uring

### Windows (IOCP)

| OS                 | Support                                  |
| ------------------ | ---------------------------------------- |
| **Windows Vista+** | GetQueuedCompletionStatusEx              |
| **Windows XP**     | GetQueuedCompletionStatus (single event) |

**Characteristics:**

- True async I/O (kernel performs operation)
- Uses OVERLAPPED structures
- Requires HANDLE instead of fd

### Platform Comparison

| Feature         | io_uring (Linux) | kqueue (macOS)         | IOCP (Windows) |
| --------------- | ---------------- | ---------------------- | -------------- |
| True async I/O  | ✅               | ❌ (notification only) | ✅             |
| Zero-copy       | ✅               | ❌                     | Partial        |
| Batching        | ✅               | ✅                     | ✅             |
| Min syscalls    | 0 (SQ polling)   | 1 per batch            | 1 per batch    |
| Memory overhead | ~64 bytes/op     | ~32 bytes/op           | ~48 bytes/op   |

## Debugging

### Debug Mode Flags

```c
#ifdef YO_DEBUG_ASYNC_IO
#define YO_IO_DEBUG(...) fprintf(stderr, "[IO] " __VA_ARGS__)
#else
#define YO_IO_DEBUG(...)
#endif

// Track pending I/O count
static size_t __yo_pending_io_count = 0;

void __yo_async_read_submit(...) {
  YO_IO_DEBUG("submit read: fd=%d size=%zu offset=%lld\n", fd, size, offset);
  __yo_pending_io_count++;
  // ...
}
```

### io_uring Profiling

```c
// Get io_uring statistics
void __yo_io_dump_stats(void) {
  fprintf(stderr, "io_uring stats:\n");
  fprintf(stderr, "  Pending I/O: %zu\n", __yo_pending_io_count);
  fprintf(stderr, "  SQ entries: %u\n", io_uring_sq_ready(&__yo_io_ring));
  fprintf(stderr, "  CQ entries: %u\n", io_uring_cq_ready(&__yo_io_ring));
}
```

## Summary

Yo's async I/O provides:

1. ✅ **Single-threaded** - all I/O on event loop thread
2. ✅ **Non-atomic RC** - no synchronization overhead
3. ✅ **Cross-platform** - Linux (io_uring), macOS (kqueue), Windows (IOCP)
4. ✅ **Unified API** - same Yo code works on all platforms
5. ✅ **async/await syntax** - no callbacks
6. ✅ **Memory efficient** - ~200 bytes per concurrent operation
7. ✅ **Platform-optimized** - uses best backend for each OS
8. ✅ **Eager execution** - I/O submitted immediately

### Quick Reference

```yo
{ ArrayList } :: import "std/collections/array_list.yo";

// Async file read (returns bytes as slice)
bytes := await File.read_bytes_async("input.bin")?;  // Result([u8], IOError)

// Async file read (returns UTF-8 String)
text := await File.read_string_async("input.txt")?;  // Result(String, IOError)

// Async file write (from String)
await File.write_string_async("output.txt", text)?;

// Async file write (from bytes)
await File.write_bytes_async("output.bin", bytes)?;

// Concurrent I/O (same thread!)
f1 := File.read_string_async("a.txt");
f2 := File.read_string_async("b.txt");
data1 := await f1?;
data2 := await f2?;

// Low-level file handle operations
file := File.open("data.bin", O_RDONLY)?;
buffer := ArrayList(u8).with_capacity(usize(4096));
bytes_read := await file.read_async(buffer, i64(0))?;
file.close();
// buffer now contains bytes_read bytes of data
```

## Future Enhancements

**Phase 1 (Linux):**

- [ ] Async file read/write
- [ ] Linux io_uring backend (via liburing)
- [ ] Vendor liburing in `vendor/liburing/`

**Phase 2 (Windows):**

- [ ] Windows IOCP backend
- [ ] Cross-platform File API

**Phase 3 (macOS):**

- [ ] macOS kqueue backend

**Phase 4 (Networking):**

- [ ] Async socket operations (accept, connect, send, recv)
- [ ] TCP/UDP support
- [ ] HTTP server example

**Phase 5 (Optimizations):**

- [ ] Buffered I/O streams (reduce syscalls)
- [ ] Vectored I/O (readv/writev)
- [ ] io_uring registered files/buffers
- [ ] Memory-mapped file I/O

**Phase 6 (Advanced):**

- [ ] Timeout support for I/O operations
- [ ] Cancellation support
- [ ] I/O priority hints

## References

### Linux (io_uring)

- [io_uring documentation](https://kernel.dk/io_uring.pdf)
- [liburing](https://github.com/axboe/liburing)
- [io_uring man pages](https://man7.org/linux/man-pages/man7/io_uring.7.html)

### macOS/BSD (kqueue)

- [kqueue man page](https://www.freebsd.org/cgi/man.cgi?kqueue)
- [macOS kqueue documentation](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kqueue.2.html)
- [libevent kqueue backend](https://libevent.org/)

### Windows (IOCP)

- [I/O Completion Ports](https://docs.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Overlapped I/O](https://docs.microsoft.com/en-us/windows/win32/fileio/synchronous-and-asynchronous-i-o)
- [GetQueuedCompletionStatusEx](https://docs.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-getqueuedcompletionstatusex)
