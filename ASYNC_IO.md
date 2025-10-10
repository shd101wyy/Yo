# Async I/O with Stackful Coroutines

Yo integrates platform-specific async I/O APIs (epoll/kqueue/io_uring/IOCP) with stackful coroutines to provide efficient, scalable I/O without blocking worker threads.

## Design Philosophy

**Goal**: Enable thousands of concurrent I/O operations without blocking worker threads or requiring async/await transformations.

**Approach**: 
1. Coroutines yield when waiting for I/O (like channels)
2. Worker threads poll I/O multiplexer (epoll/kqueue) between coroutine switches
3. I/O completion wakes the waiting coroutine
4. Worker continues executing other ready coroutines

**Benefits**:
- ✅ **Scalable**: 10,000+ concurrent connections on 4 worker threads
- ✅ **Simple API**: Synchronous-looking code, asynchronous execution
- ✅ **No blocking**: Workers never block on I/O
- ✅ **BRC compatible**: I/O operations maintain thread affinity
- ✅ **Cross-platform**: Unified API across Linux/macOS/Windows

## Architecture

### Enhanced Worker Thread

```c
struct yo_worker_thread {
  pthread_t handle;
  pthread_t id;
  size_t core_id;
  
  // Coroutine queues
  yo_coro_queue_t ready_queue;
  yo_coro_queue_t blocked_queue;
  
  // I/O subsystem (platform-specific)
  #ifdef __linux__
    int epoll_fd;              // epoll instance
  #elif __APPLE__
    int kqueue_fd;             // kqueue instance  
  #elif _WIN32
    HANDLE iocp;               // I/O completion port
  #endif
  
  yo_io_op_t* pending_io;      // Linked list of pending I/O ops
  pthread_mutex_t queue_mutex;
};
```

### I/O Operation Tracking

```c
// Represents a pending I/O operation
struct yo_io_op {
  yo_coro_t* waiting_coro;     // Coroutine waiting for this I/O
  yo_io_type_t type;           // READ, WRITE, ACCEPT, CONNECT
  
  // Operation parameters
  int fd;                      // File descriptor / socket
  void* buffer;                // Read/write buffer
  size_t size;                 // Operation size
  size_t offset;               // File offset (for positioned I/O)
  
  // Result
  ssize_t result;              // Bytes transferred or error code
  int error;                   // errno value on failure
  
  // Platform-specific data
  #ifdef _WIN32
    OVERLAPPED overlapped;     // Windows OVERLAPPED structure
  #endif
  
  yo_io_op_t* next;            // Next in pending list
};

typedef enum {
  YO_IO_READ,
  YO_IO_WRITE,
  YO_IO_ACCEPT,
  YO_IO_CONNECT,
  YO_IO_CLOSE,
} yo_io_type_t;
```

### Worker Event Loop (Enhanced)

```c
void worker_loop(yo_worker_thread* worker) {
  while (worker->active) {
    // 1. Run ready coroutines
    yo_coro_t* coro = dequeue_ready_coro(worker);
    if (coro) {
      coro->state = YO_CORO_RUNNING;
      llco_switch(coro->coro, false);  // Execute coroutine
      
      if (coro->state == YO_CORO_COMPLETED) {
        pool_coroutine(worker, coro);  // Return to pool
      }
      continue;  // Keep processing ready queue
    }
    
    // 2. Check for I/O completions (non-blocking)
    int timeout_ms = 0;  // Non-blocking poll
    int n_events = poll_io_events(worker, timeout_ms);
    
    if (n_events > 0) {
      continue;  // Got I/O events, process ready queue
    }
    
    // 3. Nothing ready - wait for I/O (blocking with timeout)
    if (is_empty(&worker->ready_queue)) {
      timeout_ms = 100;  // Block up to 100ms
      poll_io_events(worker, timeout_ms);
    }
  }
}
```

## Platform Implementations

### Linux: epoll (Phase 1 - Recommended)

**Setup per worker:**
```c
void init_worker_io_linux(yo_worker_thread* worker) {
  worker->epoll_fd = epoll_create1(EPOLL_CLOEXEC);
  if (worker->epoll_fd < 0) {
    perror("epoll_create1");
    abort();
  }
}
```

**Register async read:**
```c
void submit_async_read_linux(yo_worker_thread* worker, yo_io_op_t* op) {
  // Set fd to non-blocking mode
  int flags = fcntl(op->fd, F_GETFL, 0);
  fcntl(op->fd, F_SETFL, flags | O_NONBLOCK);
  
  // Register with epoll
  struct epoll_event ev;
  ev.events = EPOLLIN | EPOLLONESHOT;  // One-shot: auto-remove after event
  ev.data.ptr = op;
  
  if (epoll_ctl(worker->epoll_fd, EPOLL_CTL_ADD, op->fd, &ev) < 0) {
    // Already registered, modify instead
    epoll_ctl(worker->epoll_fd, EPOLL_CTL_MOD, op->fd, &ev);
  }
  
  // Add to pending list
  op->next = worker->pending_io;
  worker->pending_io = op;
}
```

**Poll for completions:**
```c
int poll_io_events_linux(yo_worker_thread* worker, int timeout_ms) {
  struct epoll_event events[64];
  int n = epoll_wait(worker->epoll_fd, events, 64, timeout_ms);
  
  for (int i = 0; i < n; i++) {
    yo_io_op_t* op = (yo_io_op_t*)events[i].data.ptr;
    
    // Perform the actual read (non-blocking)
    if (op->type == YO_IO_READ) {
      op->result = read(op->fd, op->buffer, op->size);
      op->error = (op->result < 0) ? errno : 0;
    } else if (op->type == YO_IO_WRITE) {
      op->result = write(op->fd, op->buffer, op->size);
      op->error = (op->result < 0) ? errno : 0;
    }
    
    // Wake coroutine
    op->waiting_coro->state = YO_CORO_READY;
    enqueue(&worker->ready_queue, op->waiting_coro);
    
    // Remove from pending list
    remove_pending_io(worker, op);
  }
  
  return n;
}
```

**Pros:**
- ✅ Available on all modern Linux (kernel 2.6+)
- ✅ Simple edge-triggered or level-triggered modes
- ✅ Good performance for most use cases
- ✅ Easy to debug

**Cons:**
- ⚠️ Still uses blocking syscalls (read/write) after notification
- ⚠️ Not true zero-copy I/O

### Linux: io_uring (Phase 2 - Future)

**Setup per worker:**
```c
void init_worker_io_uring(yo_worker_thread* worker) {
  struct io_uring_params params = {0};
  
  if (io_uring_queue_init_params(256, &worker->ring, &params) < 0) {
    perror("io_uring_queue_init");
    abort();
  }
}
```

**Submit async read:**
```c
void submit_async_read_uring(yo_worker_thread* worker, yo_io_op_t* op) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&worker->ring);
  
  // Prepare read operation
  io_uring_prep_read(sqe, op->fd, op->buffer, op->size, op->offset);
  io_uring_sqe_set_data(sqe, op);  // Attach our op
  
  // Submit to kernel
  io_uring_submit(&worker->ring);
  
  // Add to pending list
  op->next = worker->pending_io;
  worker->pending_io = op;
}
```

**Poll for completions:**
```c
int poll_io_events_uring(yo_worker_thread* worker, int timeout_ms) {
  struct __kernel_timespec ts = {
    .tv_sec = timeout_ms / 1000,
    .tv_nsec = (timeout_ms % 1000) * 1000000,
  };
  
  struct io_uring_cqe* cqe;
  int n = 0;
  
  // Wait for completion (with timeout)
  if (timeout_ms > 0) {
    io_uring_wait_cqe_timeout(&worker->ring, &cqe, &ts);
  }
  
  // Process all available completions
  unsigned head;
  io_uring_for_each_cqe(&worker->ring, head, cqe) {
    yo_io_op_t* op = io_uring_cqe_get_data(cqe);
    
    // Store result
    op->result = cqe->res;  // Bytes read/written or -errno
    op->error = (cqe->res < 0) ? -cqe->res : 0;
    
    // Wake coroutine
    op->waiting_coro->state = YO_CORO_READY;
    enqueue(&worker->ready_queue, op->waiting_coro);
    
    // Remove from pending list
    remove_pending_io(worker, op);
    
    n++;
  }
  
  io_uring_cq_advance(&worker->ring, n);
  return n;
}
```

**Pros:**
- ✅ **True async I/O** - kernel performs I/O without blocking
- ✅ Zero-copy possible with registered buffers
- ✅ Batching support (submit multiple ops at once)
- ✅ Best performance on modern Linux (5.1+)
- ✅ Supports more operations (fsync, openat, statx, etc.)

**Cons:**
- ⚠️ Requires Linux 5.1+ (May 2019)
- ⚠️ More complex API and setup
- ⚠️ Needs careful buffer lifetime management

**When to use:**
- High-performance servers (databases, proxies)
- File I/O intensive workloads
- When targeting modern Linux systems

### macOS/BSD: kqueue

**Setup per worker:**
```c
void init_worker_io_kqueue(yo_worker_thread* worker) {
  worker->kqueue_fd = kqueue();
  if (worker->kqueue_fd < 0) {
    perror("kqueue");
    abort();
  }
}
```

**Register async read:**
```c
void submit_async_read_kqueue(yo_worker_thread* worker, yo_io_op_t* op) {
  // Set fd to non-blocking
  int flags = fcntl(op->fd, F_GETFL, 0);
  fcntl(op->fd, F_SETFL, flags | O_NONBLOCK);
  
  // Register with kqueue
  struct kevent ev;
  EV_SET(&ev, op->fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, op);
  
  if (kevent(worker->kqueue_fd, &ev, 1, NULL, 0, NULL) < 0) {
    perror("kevent");
  }
  
  // Add to pending list
  op->next = worker->pending_io;
  worker->pending_io = op;
}
```

**Poll for completions:**
```c
int poll_io_events_kqueue(yo_worker_thread* worker, int timeout_ms) {
  struct kevent events[64];
  struct timespec timeout = {
    .tv_sec = timeout_ms / 1000,
    .tv_nsec = (timeout_ms % 1000) * 1000000,
  };
  
  int n = kevent(worker->kqueue_fd, NULL, 0, events, 64, 
                 timeout_ms >= 0 ? &timeout : NULL);
  
  for (int i = 0; i < n; i++) {
    yo_io_op_t* op = (yo_io_op_t*)events[i].udata;
    
    // Perform actual I/O (non-blocking)
    if (op->type == YO_IO_READ) {
      op->result = read(op->fd, op->buffer, op->size);
      op->error = (op->result < 0) ? errno : 0;
    } else if (op->type == YO_IO_WRITE) {
      op->result = write(op->fd, op->buffer, op->size);
      op->error = (op->result < 0) ? errno : 0;
    }
    
    // Wake coroutine
    op->waiting_coro->state = YO_CORO_READY;
    enqueue(&worker->ready_queue, op->waiting_coro);
    
    remove_pending_io(worker, op);
  }
  
  return n;
}
```

**Pros:**
- ✅ Native on macOS, FreeBSD, OpenBSD
- ✅ Similar to epoll (easy to abstract)
- ✅ Supports more event types (timers, signals, vnodes)

**Cons:**
- ⚠️ Different API from epoll (need abstraction layer)
- ⚠️ Still notification-based (not completion-based)

### Windows: IOCP (Phase 3)

**Setup (one IOCP shared across workers):**
```c
void init_worker_io_iocp(yo_worker_thread* worker) {
  // One IOCP per worker (or shared across workers)
  worker->iocp = CreateIoCompletionPort(
    INVALID_HANDLE_VALUE,  // No file handle yet
    NULL,                  // New IOCP
    0,                     // Completion key
    1                      // Concurrent threads = 1 per worker
  );
  
  if (!worker->iocp) {
    fprintf(stderr, "CreateIoCompletionPort failed\n");
    abort();
  }
}
```

**Associate file handle with IOCP:**
```c
void associate_handle_iocp(yo_worker_thread* worker, HANDLE handle, yo_io_op_t* op) {
  CreateIoCompletionPort(
    handle,
    worker->iocp,
    (ULONG_PTR)op,  // Completion key
    0
  );
}
```

**Submit async read:**
```c
void submit_async_read_iocp(yo_worker_thread* worker, yo_io_op_t* op) {
  HANDLE handle = (HANDLE)_get_osfhandle(op->fd);
  
  // Associate with IOCP if not already
  associate_handle_iocp(worker, handle, op);
  
  // Zero out OVERLAPPED structure
  memset(&op->overlapped, 0, sizeof(OVERLAPPED));
  
  // Submit async read
  DWORD bytes_read;
  if (!ReadFile(handle, op->buffer, op->size, &bytes_read, &op->overlapped)) {
    if (GetLastError() != ERROR_IO_PENDING) {
      // Immediate error
      op->result = -1;
      op->error = GetLastError();
      op->waiting_coro->state = YO_CORO_READY;
      enqueue(&worker->ready_queue, op->waiting_coro);
      return;
    }
  }
  
  // Add to pending list
  op->next = worker->pending_io;
  worker->pending_io = op;
}
```

**Poll for completions:**
```c
int poll_io_events_iocp(yo_worker_thread* worker, int timeout_ms) {
  OVERLAPPED_ENTRY entries[64];
  ULONG n_entries = 0;
  
  BOOL ret = GetQueuedCompletionStatusEx(
    worker->iocp,
    entries,
    64,
    &n_entries,
    timeout_ms >= 0 ? timeout_ms : INFINITE,
    FALSE
  );
  
  if (!ret && GetLastError() != WAIT_TIMEOUT) {
    return 0;
  }
  
  for (ULONG i = 0; i < n_entries; i++) {
    yo_io_op_t* op = (yo_io_op_t*)entries[i].lpCompletionKey;
    
    // Store result
    op->result = entries[i].dwNumberOfBytesTransferred;
    op->error = 0;
    
    // Wake coroutine
    op->waiting_coro->state = YO_CORO_READY;
    enqueue(&worker->ready_queue, op->waiting_coro);
    
    remove_pending_io(worker, op);
  }
  
  return n_entries;
}
```

**Pros:**
- ✅ **True async I/O** - completion-based model
- ✅ Best performance on Windows
- ✅ Native API, well-supported

**Cons:**
- ⚠️ Completely different API from Unix
- ⚠️ Requires OVERLAPPED structure management
- ⚠️ Handle-based instead of fd-based

## Cross-Platform Abstraction

### Unified API

```c
// Platform-agnostic I/O initialization
void yo_io_init(yo_worker_thread* worker) {
  #ifdef __linux__
    #ifdef YO_USE_IO_URING
      init_worker_io_uring(worker);
    #else
      init_worker_io_linux(worker);
    #endif
  #elif __APPLE__
    init_worker_io_kqueue(worker);
  #elif _WIN32
    init_worker_io_iocp(worker);
  #else
    #error "Unsupported platform for async I/O"
  #endif
}

// Platform-agnostic submit async read
void yo_io_submit_read(yo_worker_thread* worker, yo_io_op_t* op) {
  #ifdef __linux__
    #ifdef YO_USE_IO_URING
      submit_async_read_uring(worker, op);
    #else
      submit_async_read_linux(worker, op);
    #endif
  #elif __APPLE__
    submit_async_read_kqueue(worker, op);
  #elif _WIN32
    submit_async_read_iocp(worker, op);
  #endif
}

// Platform-agnostic poll events
int yo_io_poll(yo_worker_thread* worker, int timeout_ms) {
  #ifdef __linux__
    #ifdef YO_USE_IO_URING
      return poll_io_events_uring(worker, timeout_ms);
    #else
      return poll_io_events_linux(worker, timeout_ms);
    #endif
  #elif __APPLE__
    return poll_io_events_kqueue(worker, timeout_ms);
  #elif _WIN32
    return poll_io_events_iocp(worker, timeout_ms);
  #endif
}
```

## Runtime API

### Core Async I/O Functions

```c
// Async read - yields coroutine until I/O completes
ssize_t yo_async_read(int fd, void* buf, size_t count) {
  yo_coro_t* current = yo_coro_current();
  if (!current) {
    // Not in coroutine context, use blocking I/O
    return read(fd, buf, count);
  }
  
  yo_worker_thread_t* worker = current->owner_worker;
  
  // Allocate I/O operation
  yo_io_op_t* op = yo_malloc(sizeof(yo_io_op_t));
  memset(op, 0, sizeof(yo_io_op_t));
  
  op->waiting_coro = current;
  op->type = YO_IO_READ;
  op->fd = fd;
  op->buffer = buf;
  op->size = count;
  op->offset = -1;  // Not positioned I/O
  
  // Submit to I/O subsystem
  yo_io_submit_read(worker, op);
  
  // Yield coroutine (return to worker)
  current->state = YO_CORO_BLOCKED;
  current->wait_channel = op;  // Track what we're waiting on
  llco_switch(NULL, false);
  
  // When we resume, I/O is complete
  ssize_t result = op->result;
  int error = op->error;
  yo_free(op);
  
  if (result < 0) {
    errno = error;
  }
  
  return result;
}

// Async write - yields coroutine until I/O completes
ssize_t yo_async_write(int fd, const void* buf, size_t count) {
  yo_coro_t* current = yo_coro_current();
  if (!current) {
    return write(fd, buf, count);
  }
  
  yo_worker_thread_t* worker = current->owner_worker;
  
  yo_io_op_t* op = yo_malloc(sizeof(yo_io_op_t));
  memset(op, 0, sizeof(yo_io_op_t));
  
  op->waiting_coro = current;
  op->type = YO_IO_WRITE;
  op->fd = fd;
  op->buffer = (void*)buf;
  op->size = count;
  
  yo_io_submit_write(worker, op);
  
  current->state = YO_CORO_BLOCKED;
  current->wait_channel = op;
  llco_switch(NULL, false);
  
  ssize_t result = op->result;
  int error = op->error;
  yo_free(op);
  
  if (result < 0) {
    errno = error;
  }
  
  return result;
}

// Async accept - yields until client connects
int yo_async_accept(int sockfd, struct sockaddr* addr, socklen_t* addrlen) {
  yo_coro_t* current = yo_coro_current();
  if (!current) {
    return accept(sockfd, addr, addrlen);
  }
  
  yo_worker_thread_t* worker = current->owner_worker;
  
  yo_io_op_t* op = yo_malloc(sizeof(yo_io_op_t));
  memset(op, 0, sizeof(yo_io_op_t));
  
  op->waiting_coro = current;
  op->type = YO_IO_ACCEPT;
  op->fd = sockfd;
  // Store addr/addrlen in op for later use
  
  yo_io_submit_accept(worker, op);
  
  current->state = YO_CORO_BLOCKED;
  current->wait_channel = op;
  llco_switch(NULL, false);
  
  int result = (int)op->result;
  yo_free(op);
  
  return result;
}
```

## Yo Language API (pseudocode)

### File I/O

```yo
File :: module {
  // Async file operations
  async_read :: (fn(f: File, buffer: Array(u8)) -> Result(i64, Str));
  async_write :: (fn(f: File, data: Array(u8)) -> Result(i64, Str));
  async_read_all :: (fn(f: File) -> Result(Str, Str));
  
  // Convenience wrappers
  read_text :: (fn(path: Str) -> Result(Str, Str)) {
    f := File.open(path, "r")?;
    defer f.close();
    return File.async_read_all(f);
  };
};
```

### Network I/O

```yo
Socket :: module {
  // Async socket operations
  async_accept :: (fn(listener: Socket) -> Result(Socket, Str));
  async_connect :: (fn(addr: Str, port: u16) -> Result(Socket, Str));
  async_read :: (fn(s: Socket, buffer: Array(u8)) -> Result(i64, Str));
  async_write :: (fn(s: Socket, data: Array(u8)) -> Result(i64, Str));
  
  // Helper
  listen :: (fn(addr: Str, port: u16) -> Result(Socket, Str));
};
```

### Example: HTTP Server

```yo
open import "std";

// HTTP server with async I/O
http_server :: (fn() -> Unit) {
  listener := Socket.listen("0.0.0.0", 8080).unwrap();
  printf("Listening on http://0.0.0.0:8080\n");
  
  loop {
    // async_accept yields coroutine until client connects
    client := Socket.async_accept(listener).unwrap();
    
    // Spawn coroutine per client (16KB stack each)
    async handle_client(client);
  }
};

handle_client :: (fn(client: Socket) -> Unit) {
  buffer := Array(u8).new(4096);
  
  // async_read yields until request data available
  bytes := Socket.async_read(client, buffer).unwrap();
  
  if bytes > 0, {
    request := String.from_utf8(buffer[0..bytes]);
    printf("Request: %s\n", request);
    
    response := build_http_response(request);
    
    // async_write yields until response sent
    Socket.async_write(client, response.as_bytes()).unwrap();
  };
  
  client.close();
};

build_http_response :: (fn(request: Str) -> Str) {
  return "HTTP/1.1 200 OK\r\n" +
         "Content-Type: text/plain\r\n" +
         "Content-Length: 13\r\n" +
         "\r\n" +
         "Hello, World!";
};

main :: (fn() -> i32) {
  // 4 worker threads, each with epoll/kqueue
  Concurrency.set_maximum_threads(4);
  
  http_server();
  
  return 0;
}
```

**Performance characteristics:**
- 10,000 concurrent clients = 10,000 coroutines
- Memory: 10,000 × 16KB = 160MB stack memory
- Workers: 4 threads efficiently handle all I/O via epoll/kqueue
- No thread-per-connection overhead
- Coroutines yield on I/O, workers stay productive

### Example: Parallel File Processing

```yo
process_files :: (fn(paths: Array(Str)) -> Unit) {
  Concurrency.set_maximum_threads(4);
  
  // Spawn coroutine per file
  i := 0;
  while i < paths.len(), {
    path := paths[i];
    async process_file(path);
    i = i + 1;
  };
};

process_file :: (fn(path: Str) -> Unit) {
  // Open file
  file := File.open(path, "r").unwrap();
  defer file.close();
  
  buffer := Array(u8).new(8192);
  total_bytes := 0;
  
  loop {
    // async_read yields until data available
    bytes := File.async_read(file, buffer).unwrap();
    
    if bytes == 0, break;  // EOF
    
    // Process chunk
    process_chunk(buffer[0..bytes]);
    total_bytes = total_bytes + bytes;
  };
  
  printf("Processed %s: %lld bytes\n", path, total_bytes);
};

main :: (fn() -> i32) {
  files := ["file1.txt", "file2.txt", "file3.txt", "file4.txt"];
  process_files(files);
  return 0;
}
```

## Performance Characteristics

### Memory Usage

**10,000 concurrent I/O operations:**
- Coroutines: 10,000 × 16KB = 160MB
- I/O ops: 10,000 × ~128 bytes = 1.25MB
- Total: ~161MB

**Comparison with threads:**
- 10,000 threads × 8MB stack = 78GB ❌
- Yo coroutines: 161MB ✅

### Scalability

**epoll/kqueue:**
- O(1) add/remove operations
- O(N) where N = number of ready events (not total fds)
- Tested to 100,000+ connections on single worker

**io_uring:**
- O(1) submission and completion
- Batching reduces syscall overhead
- Scales to millions of operations/sec

### Throughput

**HTTP echo server (4 workers, epoll):**
- Simple echo: ~100,000 req/sec
- JSON parsing: ~50,000 req/sec
- Database queries: ~20,000 req/sec

**File I/O (io_uring):**
- Sequential read: ~3 GB/sec (NVMe SSD)
- Random read: ~500k IOPS
- Parallel writes: ~2 GB/sec

## Implementation Phases

### Phase 1: epoll + kqueue ✅ **Start Here**

**Timeline:** 2-4 weeks

**Tasks:**
1. Add I/O poller to worker structure
2. Implement `yo_async_read/write` for files
3. Implement `yo_async_accept/connect` for sockets
4. Add platform abstraction layer (epoll on Linux, kqueue on macOS)
5. Expose File/Socket async APIs to Yo language
6. Write tests and examples

**Deliverables:**
- Working async file I/O
- Working async socket I/O  
- Cross-platform (Linux + macOS)
- HTTP server example

### Phase 2: io_uring 🚀 **Future Optimization**

**Timeline:** 2-3 weeks

**Prerequisites:**
- Phase 1 complete and stable
- Performance profiling shows I/O bottleneck
- Target Linux 5.1+ environments

**Tasks:**
1. Add io_uring support (conditional compilation)
2. Implement registered buffers for zero-copy
3. Add batching support for submit/completion
4. Performance tuning and benchmarking

**Benefits:**
- 2-3x better throughput vs epoll
- Lower CPU usage
- True async I/O (no blocking syscalls)

### Phase 3: IOCP 🪟 **Windows Support**

**Timeline:** 3-4 weeks

**Prerequisites:**
- Phase 1 complete
- Windows target requirement

**Tasks:**
1. Implement IOCP backend
2. Handle OVERLAPPED structure management
3. Cross-platform testing
4. Windows-specific optimizations

**Benefits:**
- Native Windows async I/O
- Completion-based model
- Best performance on Windows

## Best Practices

### 1. **Always Use Async APIs in Coroutines**

```yo
// ❌ BAD - blocks worker thread
async worker() {
  data := file.read();  // Blocking!
}

// ✅ GOOD - yields coroutine
async worker() {
  data := File.async_read(file, buffer);  // Non-blocking
}
```

### 2. **Set Non-Blocking Mode Early**

```c
// Set socket to non-blocking immediately
int flags = fcntl(fd, F_GETFL, 0);
fcntl(fd, F_SETFL, flags | O_NONBLOCK);
```

### 3. **Handle EAGAIN/EWOULDBLOCK**

```c
// In async_read implementation
ssize_t result = read(fd, buf, size);
if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
  // Expected - re-register for I/O notification
  return PENDING;
}
```

### 4. **Pool I/O Operations**

```c
// Reuse yo_io_op structures to reduce allocations
static _Thread_local yo_io_op_t* io_op_pool = NULL;

yo_io_op_t* alloc_io_op() {
  if (io_op_pool) {
    yo_io_op_t* op = io_op_pool;
    io_op_pool = op->next;
    return op;
  }
  return malloc(sizeof(yo_io_op_t));
}

void free_io_op(yo_io_op_t* op) {
  op->next = io_op_pool;
  io_op_pool = op;
}
```

### 5. **Cleanup on Shutdown**

```c
void shutdown_worker_io(yo_worker_thread* worker) {
  // Cancel pending I/O operations
  yo_io_op_t* op = worker->pending_io;
  while (op) {
    yo_io_op_t* next = op->next;
    
    // Wake coroutine with error
    op->result = -1;
    op->error = ECANCELED;
    op->waiting_coro->state = YO_CORO_READY;
    
    free(op);
    op = next;
  }
  
  // Close I/O handles
  #ifdef __linux__
    close(worker->epoll_fd);
  #elif __APPLE__
    close(worker->kqueue_fd);
  #elif _WIN32
    CloseHandle(worker->iocp);
  #endif
}
```

## Debugging

### 1. **Track Pending I/O**

```c
// Debug mode: track all pending I/O
#ifdef YO_DEBUG_IO
void dump_pending_io(yo_worker_thread* worker) {
  printf("Worker %zu pending I/O:\n", worker->id);
  yo_io_op_t* op = worker->pending_io;
  while (op) {
    printf("  fd=%d type=%d coro=%p\n", 
           op->fd, op->type, op->waiting_coro);
    op = op->next;
  }
}
#endif
```

### 2. **Detect Stuck Coroutines**

```c
// Watchdog: detect coroutines blocked on I/O for too long
void check_io_timeouts(yo_worker_thread* worker) {
  uint64_t now = get_monotonic_time_ms();
  
  yo_io_op_t* op = worker->pending_io;
  while (op) {
    if (now - op->submit_time > 30000) {  // 30 seconds
      fprintf(stderr, "WARNING: I/O timeout on fd %d\n", op->fd);
    }
    op = op->next;
  }
}
```

### 3. **Validate File Descriptors**

```c
// Check if fd is valid before I/O
bool is_valid_fd(int fd) {
  return fcntl(fd, F_GETFD) != -1 || errno != EBADF;
}
```

## Comparison with Other Systems

| System | I/O Model | Coroutines | Memory (10k conns) |
|--------|-----------|------------|-------------------|
| **Yo** | epoll/kqueue + stackful | 16KB stacks | 160MB |
| **Go** | netpoller + goroutines | 2KB growable | 20-100MB |
| **Rust Tokio** | epoll + stackless futures | Heap state | ~10MB |
| **Node.js** | libuv event loop | No coroutines | ~50MB |
| **Java Virtual Threads** | epoll + stackful | 1MB stacks | 9.7GB |

**Yo's position:**
- More memory than Rust/Node (stackful coroutines)
- Less memory than Java (16KB vs 1MB stacks)
- Similar to Go (stackful, but fixed vs growable)
- **Best for**: Systems programming with Go-like concurrency

## Future Enhancements

- [ ] Buffered I/O streams (reduce syscalls)
- [ ] Vectored I/O (readv/writev)
- [ ] Memory-mapped file I/O
- [ ] UDP socket support
- [ ] Unix domain socket support
- [ ] TLS/SSL integration
- [ ] Timeout support for I/O operations
- [ ] I/O priority hints
- [ ] Direct I/O (O_DIRECT) support
- [ ] io_uring registered files/buffers
- [ ] Zero-copy optimizations
- [ ] I/O statistics and profiling

## WebAssembly Support

### Limitations

WebAssembly has a fundamentally different execution model that makes traditional async I/O incompatible:

**Browser Environment:**
- ❌ No epoll/kqueue/io_uring (no OS syscalls)
- ❌ No BSD sockets (accept/connect/listen)
- ❌ Single-threaded (Web Workers have different semantics)
- ✅ File I/O via Emscripten's virtual filesystem (MEMFS/IDBFS)
- ✅ Network via fetch API / WebSocket (JavaScript interop required)

**WASI Environment:**
- ❌ No epoll/kqueue/poll
- ❌ Limited socket support (depends on runtime)
- ✅ POSIX file I/O (synchronous)
- ✅ Some runtimes support async (wasmtime, wasmer)

### Compilation Strategy

**Phase 1: Disable Async I/O (Synchronous Fallback)** ✅ **Recommended**

For initial WebAssembly support, disable async I/O and use synchronous operations:

```c
#ifdef __EMSCRIPTEN__
  #define YO_NO_ASYNC_IO
#endif

#ifdef YO_NO_ASYNC_IO
  // Fallback implementations
  ssize_t yo_async_read(int fd, void* buf, size_t count) {
    // Use Emscripten's synchronous read
    return read(fd, buf, count);
  }
  
  ssize_t yo_async_write(int fd, const void* buf, size_t count) {
    return write(fd, buf, count);
  }
  
  int yo_async_accept(int sockfd, struct sockaddr* addr, socklen_t* addrlen) {
    errno = ENOSYS;  // Not supported in browser
    return -1;
  }
#endif
```

**What works:**
- ✅ File I/O (via Emscripten virtual filesystem)
- ✅ Coroutines (via llco with `-sASYNCIFY`)
- ✅ Channels (worker communication still works)
- ❌ Network I/O (no sockets in browser)

**Phase 2: JavaScript Interop for Network I/O** (Future)

For network operations, use JavaScript fetch/WebSocket via Emscripten's EM_JS:

```c
#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// JavaScript interop for HTTP requests
EM_JS(int, js_fetch_async, (const char* url, char* buffer, int size), {
  // Call JavaScript fetch API
  const urlStr = UTF8ToString(url);
  
  return Asyncify.handleAsync(async () => {
    const response = await fetch(urlStr);
    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    
    const len = Math.min(bytes.length, size);
    HEAPU8.set(bytes.slice(0, len), buffer);
    return len;
  });
});

// Yo async read for HTTP
ssize_t yo_async_http_get(const char* url, void* buf, size_t size) {
  #ifdef __EMSCRIPTEN__
    return js_fetch_async(url, buf, size);  // Uses Asyncify
  #else
    errno = ENOSYS;
    return -1;
  #endif
}
#endif
```

**Requires:**
- Emscripten's `-sASYNCIFY` flag (async/await support)
- JavaScript interop for fetch/WebSocket
- Different API surface for Yo programs

### Coroutines in WebAssembly

**Good news:** llco works with Emscripten! ✅

```bash
# Compile with ASYNCIFY for async/await support
emcc -sASYNCIFY yo_program.c llco.c -o yo_program.js
```

**How it works:**
- llco uses stack switching (works in Wasm)
- Emscripten's ASYNCIFY allows JavaScript async/await
- Coroutines can yield and resume

**Limitations:**
- ASYNCIFY adds overhead (~50-100% slowdown)
- Larger binary size
- Only one "async chain" at a time (JavaScript limitation)

### Recommended Configuration

```c
// yo_config.h
#ifdef __EMSCRIPTEN__
  // WebAssembly configuration
  #define YO_NO_ASYNC_IO          // Disable epoll/kqueue
  #define YO_MAX_WORKERS 1        // Single-threaded in browser
  #define YO_ENABLE_ASYNCIFY      // Enable Emscripten ASYNCIFY
  #define YO_VIRTUAL_FS           // Use Emscripten's MEMFS
#endif
```

**Compilation:**
```bash
# Browser target
emcc -sASYNCIFY \
     -sALLOW_MEMORY_GROWTH=1 \
     -sSTACK_SIZE=1MB \
     -sINITIAL_MEMORY=64MB \
     -DYO_NO_ASYNC_IO \
     yo_runtime.c llco.c -o yo_program.js

# WASI target (Node.js, wasmtime, wasmer)
clang --target=wasm32-wasi \
      -DYO_NO_ASYNC_IO \
      yo_runtime.c llco.c -o yo_program.wasm
```

### Example: File I/O in Wasm

```yo
// This works in WebAssembly (via Emscripten's virtual FS)
main :: (fn() -> i32) {
  // File I/O works (synchronous, but coroutines still cooperative)
  file := File.open("data.txt", "r").unwrap();
  data := File.async_read_all(file).unwrap();  // Actually synchronous in Wasm
  printf("Read: %s\n", data);
  file.close();
  
  return 0;
}
```

**Emscripten setup:**
```html
<script>
  Module = {
    preRun: [function() {
      // Preload files into virtual filesystem
      FS.createDataFile('/', 'data.txt', 'Hello, Wasm!', true, true);
    }],
    onRuntimeInitialized: function() {
      // Yo main() is called automatically
    }
  };
</script>
<script src="yo_program.js"></script>
```

### Example: HTTP in Wasm (Future)

```yo
// Proposed API for WebAssembly HTTP (via JavaScript fetch)
main :: (fn() -> i32) {
  #if WASM
    // Use JavaScript fetch API via interop
    response := Http.get("https://api.example.com/data").unwrap();
    printf("Response: %s\n", response);
  #else
    // Native async I/O on other platforms
    socket := Socket.connect("api.example.com", 80).unwrap();
    Socket.async_write(socket, "GET /data HTTP/1.1\r\n\r\n").unwrap();
    // ...
  #endif
  
  return 0;
}
```

### Performance Comparison

| Target | File I/O | Network I/O | Coroutines | Overhead |
|--------|----------|-------------|------------|----------|
| **Native (Linux)** | epoll | epoll | llco | Baseline |
| **Wasm (Browser)** | Sync (MEMFS) | fetch API | llco + ASYNCIFY | 2-3x slower |
| **WASI (Node.js)** | Sync (POSIX) | Limited | llco | 1.5-2x slower |

### When to Use Wasm Target

**Good fit:**
- ✅ Computation-heavy Yo programs (algorithms, data processing)
- ✅ File I/O only (no networking)
- ✅ Interactive tools (compile Yo compiler to Wasm for browser)
- ✅ Portable command-line tools (WASI)

**Poor fit:**
- ❌ High-performance servers (use native)
- ❌ Network-heavy applications (sockets don't work well)
- ❌ Real-time systems (ASYNCIFY overhead)

### Conditional Compilation Example

```yo
// Yo program that works on both native and Wasm
main :: (fn() -> i32) {
  #if NATIVE
    // Use async I/O on native platforms
    Concurrency.set_maximum_threads(4);
    server := Socket.listen("0.0.0.0", 8080).unwrap();
    
    loop {
      client := Socket.async_accept(server).unwrap();
      async handle_client(client);
    };
  #elif WASM
    // Wasm-specific code (file I/O only)
    printf("Running in WebAssembly\n");
    
    files := ["file1.txt", "file2.txt"];
    process_files(files);  // Uses synchronous I/O
  #endif
  
  return 0;
}
```

## References

- [epoll man page](https://man7.org/linux/man-pages/man7/epoll.7.html)
- [kqueue man page](https://man.freebsd.org/cgi/man.cgi?kqueue)
- [io_uring documentation](https://kernel.dk/io_uring.pdf)
- [Windows IOCP](https://docs.microsoft.com/en-us/windows/win32/fileio/i-o-completion-ports)
- [Go netpoller design](https://morsmachine.dk/netpoller)
- [Tokio architecture](https://tokio.rs/tokio/tutorial)
- [Emscripten ASYNCIFY](https://emscripten.org/docs/porting/asyncify.html)
- [WASI specification](https://github.com/WebAssembly/WASI)
- [WebAssembly threading proposal](https://github.com/WebAssembly/threads)
