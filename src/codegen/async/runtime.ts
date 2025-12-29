/**
 * runtime.ts
 *
 * Generates the async runtime code for single-threaded cooperative scheduling.
 * This implements a simple event loop for async/await concurrency.
 *
 * NOTE: This is for async/await (concurrency on single thread).
 * For spawn (parallelism with multiple threads), see PARALLELISM.md.
 */

import { Emitter } from "../../emitter";

/**
 * Generates the async runtime code with a single-threaded event loop.
 * Async tasks run cooperatively on the same thread - no multi-threading.
 */
export function generateAsyncRuntime(
  emitter: Emitter,
  _debugAsyncAwait: boolean
): void {
  emitter.emitLine(`
// ============================================================================
// Async/Await Runtime - Single-Threaded Cooperative Scheduler
// ============================================================================
// This implements a cooperative async runtime for single-threaded concurrency.
// All async tasks run on the SAME thread - no parallelism, just interleaving.
// Uses non-atomic reference counting (everything is thread-local).
//
// LIFETIME MODEL: Event loop holds references to running tasks
// - When a task is spawned/queued, the event loop increments its refcount
// - When a task completes, the event loop decrements its refcount
// - Tasks stay alive as long as they're running, even if user code drops them
// - Standard RC drop semantics: freed when refcount hits 0

// Continuation - represents a suspended async task waiting to be resumed
typedef struct yo_continuation_t {
  void (*resume_fn)(void* state_machine);  // Function to call to resume
  void* state_machine;                      // State machine to resume
  struct yo_continuation_t* next;           // Next in linked list
} yo_continuation_t;

// Per-thread async task queue (thread-local for future spawn support)
typedef struct {
  yo_continuation_t* head;  // Head of continuation queue
  yo_continuation_t* tail;  // Tail of continuation queue
  size_t count;             // Number of pending continuations
} yo_async_task_queue_t;

// Thread-local async runtime state
#if defined(_WIN32)
  static __declspec(thread) yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
#else
  static __thread yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
#endif

// Async scheduler initialized flag
static bool yo_async_scheduler_initialized = false;

// Forward declarations for I/O functions (defined later, may be stubs if liburing unavailable)
#if defined(__linux__)
static void __yo_io_init(void);
static void __yo_io_cleanup(void);
static bool __yo_has_pending_io(void);
static int __yo_io_poll(void);
static int __yo_io_wait(void);
#endif

// Initialize async scheduler (lightweight - just sets flag)
static void __yo_async_scheduler_init(void) {
  if (yo_async_scheduler_initialized) {
    return;
  }
  yo_async_scheduler_initialized = true;
  ASYNC_DEBUG("[ASYNC] Scheduler initialized\\n");
}

// Enqueue a continuation to be executed on the current thread's event loop
// NOTE: This is a low-level function that does NOT manage refcounts.
// Use yo_async_spawn_task for spawning tasks with proper lifetime management.
static void yo_async_enqueue_continuation(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("[ASYNC] Enqueueing continuation: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
  
  yo_continuation_t* cont = (yo_continuation_t*)__yo_malloc(sizeof(yo_continuation_t));
  cont->resume_fn = resume_fn;
  cont->state_machine = state_machine;
  cont->next = NULL;
  
  if (yo_thread_async_queue.tail) {
    yo_thread_async_queue.tail->next = cont;
    yo_thread_async_queue.tail = cont;
  } else {
    yo_thread_async_queue.head = cont;
    yo_thread_async_queue.tail = cont;
  }
  
  yo_thread_async_queue.count++;
  ASYNC_DEBUG("[ASYNC] Queue count: %zu\\n", yo_thread_async_queue.count);
}

// Spawn an async task by enqueueing it to the current thread's event loop
// This is for EAGER execution - task starts running immediately until first await
// NOTE: This does NOT increment refcount. The task lifetime is managed by:
// - Constructor: starts with refcount = 2 (user ref + running task ref)
// - Completion: decrements refcount (releases running task ref)
// - User drop: decrements refcount (releases user ref)
void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("[ASYNC] Spawning task: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
  yo_async_enqueue_continuation(resume_fn, state_machine);
}

// Run event loop until a specific Future completes (for async main)
// The Future must have an '_Atomic int state' field at offset 0
// State -1 means completed
void __yo_async_run_until_complete(void* future_ptr) {
  if (!yo_async_scheduler_initialized) {
    __yo_async_scheduler_init();
  }
  
#if defined(__linux__)
  __yo_io_init();  // Initialize io_uring on Linux
#endif
  
  ASYNC_DEBUG("[ASYNC] Starting event loop for future=%p\\n", future_ptr);
  
  // future_ptr points to a heap-backed Future/state-machine struct.
  // It must have _Atomic int state at offset 0.
  typedef struct { _Atomic int state; } generic_future_t;
  generic_future_t* future = (generic_future_t*)future_ptr;
  
  // Run the event loop until the future completes
  while (atomic_load(&future->state) != -1) {
    // 1. Process ready tasks (up to 100 per iteration)
    int tasks_run = 0;
    while (tasks_run < 100) {
      yo_continuation_t* cont = yo_thread_async_queue.head;
      if (!cont) break;
      
      // Dequeue
      yo_thread_async_queue.head = cont->next;
      if (!yo_thread_async_queue.head) {
        yo_thread_async_queue.tail = NULL;
      }
      yo_thread_async_queue.count--;
      
      ASYNC_DEBUG("[ASYNC] Executing continuation: resume_fn=%p, sm=%p (queue_count=%zu)\\n",
                  (void*)cont->resume_fn, cont->state_machine, yo_thread_async_queue.count);
      
      // Execute the continuation
      cont->resume_fn(cont->state_machine);
      
      // Free the continuation
      __yo_free(cont);
      tasks_run++;
    }
    
#if defined(__linux__)
    // 2. Poll io_uring completions (non-blocking)
    __yo_io_poll();
    
    // 3. If no ready tasks but pending I/O, block until completion
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\\n");
      __yo_io_wait();
      continue;
    }
#endif
    
    // 4. If no tasks and no I/O, check if future is complete
    if (!yo_thread_async_queue.head) {
#if defined(__linux__)
      if (!__yo_has_pending_io()) {
        // No tasks, no I/O - future must be waiting on something else or complete
        ASYNC_DEBUG("[ASYNC] No tasks or I/O, future state=%d\\n",
                    atomic_load(&future->state));
        if (atomic_load(&future->state) != -1) {
          // Future not complete but nothing to do - this shouldn't happen
          ASYNC_DEBUG("[ASYNC] WARNING: No tasks/IO but future not complete\\n");
          break;
        }
      }
#else
      // No async I/O support on this platform
      ASYNC_DEBUG("[ASYNC] WARNING: Queue empty but future not complete (state=%d)\\n",
                  atomic_load(&future->state));
      break;
#endif
    }
  }
  
#if defined(__linux__)
  __yo_io_cleanup();
#endif
  
  ASYNC_DEBUG("[ASYNC] Event loop finished, future completed (state=%d)\\n", atomic_load(&future->state));
}

// Wait for all async tasks to complete (drains the queue)
void __yo_async_wait_all(void) {
  if (!yo_async_scheduler_initialized) {
    return;
  }
  
  ASYNC_DEBUG("[ASYNC] Waiting for all tasks to complete (queue_count=%zu)\\n", yo_thread_async_queue.count);
  
  // Process all tasks in the queue
  while (yo_thread_async_queue.head) {
    yo_continuation_t* cont = yo_thread_async_queue.head;
    yo_thread_async_queue.head = cont->next;
    if (!yo_thread_async_queue.head) {
      yo_thread_async_queue.tail = NULL;
    }
    yo_thread_async_queue.count--;
    
    ASYNC_DEBUG("[ASYNC] Executing continuation: resume_fn=%p, sm=%p\\n",
                (void*)cont->resume_fn, cont->state_machine);
    
    cont->resume_fn(cont->state_machine);
    __yo_free(cont);
  }
  
  ASYNC_DEBUG("[ASYNC] All tasks completed\\n");
}

// Register a continuation to be called when a Future completes
// Called by await when the Future is not yet ready
void yo_async_register_continuation(
    void* future_ptr,
    void (*resume_fn)(void*),
    void* state_machine) {
  
  ASYNC_DEBUG("[ASYNC] Registering continuation for future=%p: resume_fn=%p, sm=%p\\n",
              future_ptr, (void*)resume_fn, state_machine);
  
  // All generated Future/state-machine structs start with:
  //   _Atomic int state;
  //   _Atomic(void (*)(void*)) continuation_fn;
  //   _Atomic(void*) continuation_sm;
  typedef struct {
    _Atomic int state;
    _Atomic(void (*)(void*)) continuation_fn;
    _Atomic(void*) continuation_sm;
  } yo_future_cont_base_t;

  yo_future_cont_base_t* f = (yo_future_cont_base_t*)future_ptr;

  // If already completed, schedule the continuation immediately.
  int st = atomic_load_explicit(&f->state, memory_order_acquire);
  if (st == -1) {
    yo_async_enqueue_continuation(resume_fn, state_machine);
    return;
  }

  // Store continuation; it will be spawned when the future reaches completion.
  atomic_store_explicit(&f->continuation_fn, (void (*)(void*))resume_fn, memory_order_release);
  atomic_store_explicit(&f->continuation_sm, state_machine, memory_order_release);
}

// ============================================================================
// Concurrency Helper Functions (from std/concurrency.yo)
// ============================================================================
// These are helper functions for querying system info and thread control.
// Note: These are for future parallelism support (spawn), not for async/await.

// Get the number of hardware threads (CPU cores)
size_t __yo_thread_get_hardware_threads(void) {
#ifdef _WIN32
  SYSTEM_INFO sysinfo;
  GetSystemInfo(&sysinfo);
  return (size_t)sysinfo.dwNumberOfProcessors;
#elif defined(__APPLE__)
  int count;
  size_t size = sizeof(count);
  if (sysctlbyname("hw.ncpu", &count, &size, NULL, 0) == 0) {
    return (size_t)count;
  }
  return 1;
#else
  long count = sysconf(_SC_NPROCESSORS_ONLN);
  return count > 0 ? (size_t)count : 1;
#endif
}

// Set maximum threads (placeholder for future spawn support)
// Currently a no-op since async/await is single-threaded
void __yo_thread_set_maximum_threads(size_t num) {
  ASYNC_DEBUG("[CONCURRENCY] set_maximum_threads(%zu) - currently no-op for async/await\\n", num);
  (void)num; // Unused for now
}

// Get current thread ID (useful for debugging)
size_t __yo_get_thread_id(void) {
#ifdef _WIN32
  return (size_t)GetCurrentThreadId();
#elif defined(__APPLE__)
  uint64_t tid;
  pthread_threadid_np(NULL, &tid);
  return (size_t)tid;
#else
  return (size_t)syscall(SYS_gettid);
#endif
}

// Yield execution (allows other tasks to run)
void __yo_thread_yield(void) {
#ifdef _WIN32
  SwitchToThread();
#else
  sched_yield();
#endif
}

// Async yield - creates an immediately-ready Future for cooperative yielding
// This allows the current async task to suspend and give other tasks a chance to run
// Usage: await Concurrency.yield();
typedef struct __yo_yield_future_t {
  _Atomic int state;                            // Future state (0 = running, -1 = completed)
  _Atomic(void (*)(void*)) continuation_fn;     // Continuation (if awaited)
  _Atomic(void*) continuation_sm;               // Continuation state machine
} __yo_yield_future_t;

__yo_yield_future_t __yo_async_yield(void) {
  __yo_yield_future_t future;
  // Initialize as completed (state = -1) so await will not actually suspend
  // The suspension happens because await checks the queue and processes other tasks
  atomic_init(&future.state, -1);
  atomic_init(&future.continuation_fn, NULL);
  atomic_init(&future.continuation_sm, NULL);
  return future;
}

// ============================================================================
// Async I/O Runtime (Linux - io_uring via liburing)
// ============================================================================

#if defined(__linux__)
// Try to include liburing.h - if not available, disable I/O features
#if __has_include(<liburing.h>)
#define YO_HAS_LIBURING 1
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

// I/O Future types - these are awaitable futures that complete when I/O finishes
// They follow the same structure as async block state machines
typedef struct yo_io_read_future_t {
  yo_ref_header_t header;                       // Reference counting (must be first)
  _Atomic int state;                            // Future state (0 = pending, -1 = completed)
  int32_t result;                               // Bytes read or -errno
  _Atomic(void (*)(void*)) continuation_fn;     // Continuation function
  _Atomic(void*) continuation_sm;               // Continuation state machine
  yo_io_state_t io_state;                       // I/O state for io_uring
  void* buffer;                                 // Buffer to read into (kept alive by refcount)
} yo_io_read_future_t;

typedef struct yo_io_write_future_t {
  yo_ref_header_t header;                       // Reference counting (must be first)
  _Atomic int state;                            // Future state (0 = pending, -1 = completed)
  int32_t result;                               // Bytes written or -errno
  _Atomic(void (*)(void*)) continuation_fn;     // Continuation function
  _Atomic(void*) continuation_sm;               // Continuation state machine
  yo_io_state_t io_state;                       // I/O state for io_uring
  const void* buffer;                           // Buffer to write from (kept alive by refcount)
} yo_io_write_future_t;

// Initialize io_uring (called once at event loop start)
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  int ret = io_uring_queue_init(256, &__yo_io_ring, 0);
  if (ret < 0) {
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\\n", strerror(-ret));
    exit(1);
  }
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] io_uring initialized with 256 entries\\n");
}

// Cleanup io_uring
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  io_uring_queue_exit(&__yo_io_ring);
  __yo_io_initialized = false;
  ASYNC_DEBUG("[IO] io_uring cleaned up\\n");
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
    // Queue full - should not happen with proper sizing
    io_state->result = -EAGAIN;
    io_state->completed = true;
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return;
  }

  io_uring_prep_read(sqe, fd, buffer, (unsigned)size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Submitted read: fd=%d size=%zu offset=%lld (pending=%zu)\\n",
              fd, size, (long long)offset, __yo_pending_io_count);
}

// Submit async write to io_uring
static void __yo_async_write_submit(int32_t fd, const void* buffer, size_t size,
                                    int64_t offset, yo_io_state_t* io_state) {
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    io_state->result = -EAGAIN;
    io_state->completed = true;
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return;
  }

  io_uring_prep_write(sqe, fd, buffer, (unsigned)size, offset);
  io_uring_sqe_set_data(sqe, io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Submitted write: fd=%d size=%zu offset=%lld (pending=%zu)\\n",
              fd, size, (long long)offset, __yo_pending_io_count);
}

// Process completions from CQ
static void __yo_io_process_cqe(struct io_uring_cqe* cqe) {
  yo_io_state_t* io_state = (yo_io_state_t*)io_uring_cqe_get_data(cqe);
  io_state->result = cqe->res;
  io_state->completed = true;
  __yo_pending_io_count--;

  ASYNC_DEBUG("[IO] Completed I/O: result=%d (pending=%zu)\\n",
              io_state->result, __yo_pending_io_count);

  // The io_state is embedded in an IOReadFuture or IOWriteFuture
  // We need to mark the future as complete and wake awaiters
  
  // Calculate the future pointer from the io_state offset
  // io_state is the 6th field in yo_io_read_future_t/yo_io_write_future_t
  yo_io_read_future_t* future = (yo_io_read_future_t*)((char*)io_state - offsetof(yo_io_read_future_t, io_state));
  
  // Set the result
  future->result = io_state->result;
  
  // Mark as completed
  atomic_store_explicit(&future->state, -1, memory_order_release);
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);
  
  if (cont_fn && cont_sm) {
    yo_async_spawn_task(cont_fn, cont_sm);
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
  
  if (count > 0) {
    ASYNC_DEBUG("[IO] Polled %d completions\\n", count);
  }
  return count;
}

// Wait for at least one I/O completion (blocking)
static int __yo_io_wait(void) {
  struct io_uring_cqe* cqe;
  int ret = io_uring_wait_cqe(&__yo_io_ring, &cqe);
  if (ret < 0) {
    ASYNC_DEBUG("[IO] WARNING: io_uring_wait_cqe failed: %d\\n", ret);
    return 0;
  }
  
  ASYNC_DEBUG("[IO] Waiting for I/O completion...\\n");
  __yo_io_process_cqe(cqe);
  return 1 + __yo_io_poll();  // Process any additional completions
}

// Create and start an async read operation
// Returns a Future that completes when the read finishes
static yo_io_read_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  yo_io_read_future_t* future = (yo_io_read_future_t*)__yo_malloc(sizeof(yo_io_read_future_t));
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  atomic_init(&future->state, 0);  // 0 = pending
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Store buffer reference
  future->buffer = buffer;
  
  // Initialize io_state
  future->io_state.state_machine = NULL;  // Not used with new approach
  future->io_state.resume_fn = NULL;      // Not used with new approach
  future->io_state.result = 0;
  future->io_state.completed = false;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return future;
  }
  
  io_uring_prep_read(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, &future->io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Create and start an async write operation
// Returns a Future that completes when the write finishes
static yo_io_write_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  yo_io_write_future_t* future = (yo_io_write_future_t*)__yo_malloc(sizeof(yo_io_write_future_t));
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  atomic_init(&future->state, 0);  // 0 = pending
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Store buffer reference
  future->buffer = buffer;
  
  // Initialize io_state
  future->io_state.state_machine = NULL;  // Not used with new approach
  future->io_state.resume_fn = NULL;      // Not used with new approach
  future->io_state.result = 0;
  future->io_state.completed = false;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\\n");
    return future;
  }
  
  io_uring_prep_write(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, &future->io_state);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, (void*)buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Synchronous file operations
static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  int fd = open(path, flags, mode);
  int result = fd >= 0 ? fd : -errno;
  ASYNC_DEBUG("[IO] open(%s, 0x%x, 0%o) = %d\\n", path, flags, mode, result);
  return result;
}

static void __yo_file_close(int32_t fd) {
  ASYNC_DEBUG("[IO] close(%d)\\n", fd);
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) {
    int result = -errno;
    ASYNC_DEBUG("[IO] fstat(%d) failed: %d\\n", fd, result);
    return result;
  }
  ASYNC_DEBUG("[IO] fstat(%d) = %lld bytes\\n", fd, (long long)st.st_size);
  return st.st_size;
}

#else // !YO_HAS_LIBURING

// Stub functions when liburing is not available
static inline void __yo_io_init(void) {
  fprintf(stderr, "[Yo] Warning: liburing not available, async I/O disabled\\n");
}

static inline void __yo_io_cleanup(void) {}

static inline bool __yo_has_pending_io(void) {
  return false;
}

static inline void __yo_io_poll(void) {}

static inline void __yo_io_wait(void) {}

static inline void* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  fprintf(stderr, "[Yo] Error: async read not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  fprintf(stderr, "[Yo] Error: async write not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void __yo_async_read_submit(void* io_state, int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  fprintf(stderr, "[Yo] Error: async read not supported without liburing\\n");
  abort();
}

static inline void __yo_async_write_submit(void* io_state, int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  fprintf(stderr, "[Yo] Error: async write not supported without liburing\\n");
  abort();
}

static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\\n");
  return -1;
}

static void __yo_file_close(int32_t fd) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\\n");
}

static int64_t __yo_file_size(int32_t fd) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\\n");
  return -1;
}

#endif // YO_HAS_LIBURING

#endif // __linux__
`);
}
