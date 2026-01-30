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
#elif defined(__APPLE__)
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
  
#if defined(__linux__) || defined(__APPLE__)
  __yo_io_init();  // Initialize platform-specific async I/O
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
    
#if defined(__linux__) || defined(__APPLE__)
    // 2. Poll I/O completions (non-blocking)
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
#if defined(__linux__) || defined(__APPLE__)
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
  
#if defined(__linux__) || defined(__APPLE__)
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
  
#if defined(__linux__) || defined(__APPLE__)
  __yo_io_init();  // Ensure async I/O is initialized
#endif
  
  // Process all tasks in the queue and poll for I/O events until both are empty
  while (true) {
    // 1. Process ready tasks
    bool tasks_processed = false;
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
      tasks_processed = true;
    }
    
#if defined(__linux__) || defined(__APPLE__)
    // 2. Poll for I/O completions (non-blocking)
    __yo_io_poll();
    
    // 3. If no tasks were processed, no new tasks after polling, and there's pending I/O, wait for completion
    if (!tasks_processed && !yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\\n");
      __yo_io_wait();
      continue;
    }
    
    // 4. If no tasks and no pending I/O, we're done
    if (!yo_thread_async_queue.head && !__yo_has_pending_io()) {
      break;
    }
#else
    // No async I/O support - if no tasks, we're done
    if (!yo_thread_async_queue.head) {
      break;
    }
#endif
  }
  
  ASYNC_DEBUG("[ASYNC] All tasks completed\\n");
}

// NOTE: yo_async_register_continuation has been removed.
// Continuation registration is now done inline at each await site
// with direct field access to the specific future type.
// This avoids the generic pointer casting issues with variable-sized result fields.

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

// Compatibility: io_uring_prep_ftruncate was added in liburing 2.2
// Only define fallback if using older liburing that doesn't have IORING_OP_FTRUNCATE
#ifndef IORING_OP_FTRUNCATE
  #define IORING_OP_FTRUNCATE 46
  #define YO_NEED_FTRUNCATE_COMPAT 1
#endif

#ifdef YO_NEED_FTRUNCATE_COMPAT
  static inline void yo_io_uring_prep_ftruncate(struct io_uring_sqe *sqe, int fd, loff_t len) {
    io_uring_prep_rw(IORING_OP_FTRUNCATE, sqe, fd, NULL, len, 0);
  }
  #define io_uring_prep_ftruncate yo_io_uring_prep_ftruncate
#endif

static struct io_uring __yo_io_ring;
static bool __yo_io_initialized = false;
static size_t __yo_pending_io_count = 0;

// I/O Future types - yo_io_future_t is defined in types/generation.ts
// It has the same layout as async state machines (state, result, continuation_fn, continuation_sm)
// so the await codegen can access ->state and ->result uniformly.
// We store the future pointer directly in the SQE user data.

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

// Process completions from CQ
// The future pointer is stored directly in the SQE user data
static void __yo_io_process_cqe(struct io_uring_cqe* cqe) {
  yo_io_future_t* future = (yo_io_future_t*)io_uring_cqe_get_data(cqe);
  __yo_pending_io_count--;

  // Set the result
  future->result = cqe->res;
  
  ASYNC_DEBUG("[IO] Completed I/O: result=%d (pending=%zu)\\n",
              future->result, __yo_pending_io_count);
  
  // Mark as completed (state -1 = done)
  atomic_store_explicit(&future->state, -1, memory_order_release);
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);
  
  ASYNC_DEBUG("[IO] Continuation check: cont_fn=%p, cont_sm=%p\\n", (void*)cont_fn, cont_sm);
  
  if (cont_fn && cont_sm) {
    ASYNC_DEBUG("[IO] Spawning continuation for I/O completion\\n");
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
// Returns a yo_io_future_t* that completes when the read finishes
static yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  // Ensure io_uring is initialized (lazy initialization for eager async execution)
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));  // Zero-initialize to ensure dispose_fn etc. are NULL
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  atomic_init(&future->state, 0);  // 0 = pending
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
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
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Create and start an async write operation
// Returns a yo_io_future_t* that completes when the write finishes
static yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  // Ensure io_uring is initialized (lazy initialization for eager async execution)
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));  // Zero-initialize to ensure dispose_fn etc. are NULL
  
  // Initialize ref counting
  future->header.ref_count = 1;
  
  // Initialize future state
  atomic_init(&future->state, 0);  // 0 = pending
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
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
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, (void*)buffer, size, (unsigned long long)offset, __yo_pending_io_count);
  
  return future;
}

// Create and start an async openat operation
// Returns a yo_io_future_t* that completes with the fd or error
static yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_openat(sqe, dirfd, path, flags, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async openat: dirfd=%d path=%s flags=0x%x mode=0%o (pending=%zu)\\n",
              dirfd, path, flags, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async close operation
static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_close(sqe, fd);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async close: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async statx operation (for async stat)
// Uses statx which is the modern replacement for stat, supported by io_uring
static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_statx(sqe, dirfd, path, flags, mask, (struct statx*)statxbuf);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async statx: dirfd=%d path=%s flags=0x%x mask=0x%x (pending=%zu)\\n",
              dirfd, path, flags, mask, __yo_pending_io_count);
  
  return future;
}

// Create and start an async mkdirat operation
static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_mkdirat(sqe, dirfd, path, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async mkdirat: dirfd=%d path=%s mode=0%o (pending=%zu)\\n",
              dirfd, path, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async unlinkat operation
static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_unlinkat(sqe, dirfd, path, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async unlinkat: dirfd=%d path=%s flags=0x%x (pending=%zu)\\n",
              dirfd, path, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async renameat operation
static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_renameat(sqe, olddirfd, oldpath, newdirfd, newpath, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async renameat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s (pending=%zu)\\n",
              olddirfd, oldpath, newdirfd, newpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async symlinkat operation
static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_symlinkat(sqe, target, newdirfd, linkpath);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async symlinkat: target=%s newdirfd=%d linkpath=%s (pending=%zu)\\n",
              target, newdirfd, linkpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async linkat operation (hard link)
static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_linkat(sqe, olddirfd, oldpath, newdirfd, newpath, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async linkat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s flags=0x%x (pending=%zu)\\n",
              olddirfd, oldpath, newdirfd, newpath, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fsync operation
static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async fsync: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fdatasync operation
static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, IORING_FSYNC_DATASYNC);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async fdatasync: fd=%d (pending=%zu)\\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async ftruncate operation
static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_ftruncate(sqe, fd, (loff_t)length);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async ftruncate: fd=%d length=%lld (pending=%zu)\\n",
              fd, (long long)length, __yo_pending_io_count);
  
  return future;
}

// ============================================================================
// Permission Operations (Linux io_uring)
// ============================================================================

// Async fchmod - change file permissions by fd
static yo_io_future_t* __yo_async_fchmod_start(int32_t fd, uint32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // io_uring doesn't have direct fchmod support, use synchronous
  int result = fchmod(fd, (mode_t)mode);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmod completed: fd=%d mode=0%o result=%d\\n", fd, mode, future->result);
  
  return future;
}

// Async fchmodat - change file permissions by path
static yo_io_future_t* __yo_async_fchmodat_start(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchmodat(dirfd, path, (mode_t)mode, flags);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmodat completed: path=%s mode=0%o result=%d\\n", path, mode, future->result);
  
  return future;
}

// Async fchown - change file ownership by fd
static yo_io_future_t* __yo_async_fchown_start(int32_t fd, uint32_t uid, uint32_t gid) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchown completed: fd=%d uid=%u gid=%u result=%d\\n", fd, uid, gid, future->result);
  
  return future;
}

// Async fchownat - change file ownership by path
static yo_io_future_t* __yo_async_fchownat_start(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchownat completed: path=%s uid=%u gid=%u result=%d\\n", path, uid, gid, future->result);
  
  return future;
}

// ============================================================================
// Symbolic Link Operations (Linux io_uring)
// ============================================================================

// Async readlinkat - read symbolic link target
static yo_io_future_t* __yo_async_readlinkat_start(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // io_uring doesn't have direct readlinkat support
  ssize_t result = readlinkat(dirfd, path, buf, bufsize);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] readlinkat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// ============================================================================
// File Descriptor Operations (Linux io_uring)
// ============================================================================

// Async dup - duplicate file descriptor
static yo_io_future_t* __yo_async_dup_start(int32_t oldfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup(oldfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup completed: oldfd=%d result=%d\\n", oldfd, future->result);
  
  return future;
}

// Async dup2 - duplicate file descriptor to specific fd
static yo_io_future_t* __yo_async_dup2_start(int32_t oldfd, int32_t newfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup2(oldfd, newfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup2 completed: oldfd=%d newfd=%d result=%d\\n", oldfd, newfd, future->result);
  
  return future;
}

// Async pipe - create pipe
static yo_io_future_t* __yo_async_pipe_start(int32_t* pipefd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = pipe((int*)pipefd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] pipe completed: result=%d readfd=%d writefd=%d\\n",
              future->result, pipefd[0], pipefd[1]);
  
  return future;
}

// ============================================================================
// Socket Operations (Linux io_uring)
// ============================================================================
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// Async socket - create socket
static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = socket(domain, type, protocol);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\\n",
              domain, type, protocol, future->result);
  
  return future;
}

// Async bind - bind socket to address
static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = bind(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async listen - mark socket as listening
static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = listen(sockfd, backlog);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection (using io_uring)
static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_accept(sqe, sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async accept: sockfd=%d (pending=%zu)\\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async connect - connect to remote address (using io_uring)
static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_connect(sqe, sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async connect: sockfd=%d (pending=%zu)\\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async send - send data on socket (using io_uring)
static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_send(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async send: sockfd=%d len=%zu (pending=%zu)\\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async recv - receive data from socket (using io_uring)
static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  io_uring_prep_recv(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async recv: sockfd=%d len=%zu (pending=%zu)\\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async sendto - send data to specific address (UDP)
static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // io_uring doesn't have direct sendto, use synchronous
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] sendto completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async recvfrom - receive data with source address (UDP)
static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // io_uring doesn't have direct recvfrom, use synchronous
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] recvfrom completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async shutdown - shutdown socket
static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = shutdown(sockfd, how);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\\n", sockfd, how, future->result);
  
  return future;
}

// Async setsockopt - set socket option
static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Async getsockopt - get socket option
static yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    void* optval, uint32_t* optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = getsockopt(sockfd, level, optname, optval, (socklen_t*)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// ============================================================================
// Socket Address Helpers (Cross-platform)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return sizeof(struct sockaddr_un);
}

static size_t __yo_sockaddr_storage_size(void) {
  return sizeof(struct sockaddr_storage);
}

static void __yo_sockaddr_set_family(void* addr, uint16_t family) {
  ((struct sockaddr*)addr)->sa_family = family;
}

static uint16_t __yo_sockaddr_get_family(void* addr) {
  return ((struct sockaddr*)addr)->sa_family;
}

static void __yo_sockaddr_in_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in*)addr)->sin_port = htons(port);
}

static uint16_t __yo_sockaddr_in_get_port(void* addr) {
  return ntohs(((struct sockaddr_in*)addr)->sin_port);
}

static void __yo_sockaddr_in_set_addr(void* addr, uint32_t ip) {
  ((struct sockaddr_in*)addr)->sin_addr.s_addr = ip;
}

static uint32_t __yo_sockaddr_in_get_addr(void* addr) {
  return ((struct sockaddr_in*)addr)->sin_addr.s_addr;
}

static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in6*)addr)->sin6_port = htons(port);
}

static uint16_t __yo_sockaddr_in6_get_port(void* addr) {
  return ntohs(((struct sockaddr_in6*)addr)->sin6_port);
}

static void __yo_sockaddr_in6_set_addr(void* addr, const void* ip) {
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, 16);
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, 16);
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  strncpy(((struct sockaddr_un*)addr)->sun_path, path, sizeof(((struct sockaddr_un*)addr)->sun_path) - 1);
}

static char* __yo_sockaddr_un_get_path(void* addr) {
  return ((struct sockaddr_un*)addr)->sun_path;
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return inet_pton(af, src, dst);
}

static char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return (char*)inet_ntop(af, src, dst, (socklen_t)size);
}

static uint16_t __yo_htons(uint16_t hostshort) {
  return htons(hostshort);
}

static uint16_t __yo_ntohs(uint16_t netshort) {
  return ntohs(netshort);
}

static uint32_t __yo_htonl(uint32_t hostlong) {
  return htonl(hostlong);
}

static uint32_t __yo_ntohl(uint32_t netlong) {
  return ntohl(netlong);
}

// Synchronous file operations (kept for compatibility)
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

// Get size of statx buffer (for allocation)
static size_t __yo_statx_buf_size(void) {
  return sizeof(struct statx);
}

// Extract fields from struct statx
static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_mtime.tv_sec;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_mtime.tv_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_atime.tv_sec;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_atime.tv_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_ctime.tv_sec;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_ctime.tv_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return (int64_t)((struct statx*)statxbuf)->stx_btime.tv_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_btime.tv_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct statx*)statxbuf)->stx_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_dev_major;
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_dev_minor;
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_blksize;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  return (uint64_t)((struct statx*)statxbuf)->stx_blocks;
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

static inline int __yo_io_poll(void) { return 0; }

static inline int __yo_io_wait(void) { return 0; }

static inline void* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async read not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async write not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  (void)dirfd; (void)path; (void)flags; (void)mode;
  fprintf(stderr, "[Yo] Error: async openat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_close_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async close not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  (void)dirfd; (void)path; (void)flags; (void)mask; (void)statxbuf;
  fprintf(stderr, "[Yo] Error: async statx not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  (void)dirfd; (void)path; (void)mode;
  fprintf(stderr, "[Yo] Error: async mkdirat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  (void)dirfd; (void)path; (void)flags;
  fprintf(stderr, "[Yo] Error: async unlinkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath;
  fprintf(stderr, "[Yo] Error: async renameat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  (void)target; (void)newdirfd; (void)linkpath;
  fprintf(stderr, "[Yo] Error: async symlinkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath; (void)flags;
  fprintf(stderr, "[Yo] Error: async linkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fsync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fsync not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fdatasync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fdatasync not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  (void)fd; (void)length;
  fprintf(stderr, "[Yo] Error: async ftruncate not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fchmod_start(int32_t fd, uint32_t mode) {
  (void)fd; (void)mode;
  fprintf(stderr, "[Yo] Error: async fchmod not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fchmodat_start(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  (void)dirfd; (void)path; (void)mode; (void)flags;
  fprintf(stderr, "[Yo] Error: async fchmodat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fchown_start(int32_t fd, uint32_t uid, uint32_t gid) {
  (void)fd; (void)uid; (void)gid;
  fprintf(stderr, "[Yo] Error: async fchown not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fchownat_start(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  (void)dirfd; (void)path; (void)uid; (void)gid; (void)flags;
  fprintf(stderr, "[Yo] Error: async fchownat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_readlinkat_start(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  (void)dirfd; (void)path; (void)buf; (void)bufsize;
  fprintf(stderr, "[Yo] Error: async readlinkat not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_dup_start(int32_t oldfd) {
  (void)oldfd;
  fprintf(stderr, "[Yo] Error: async dup not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_dup2_start(int32_t oldfd, int32_t newfd) {
  (void)oldfd; (void)newfd;
  fprintf(stderr, "[Yo] Error: async dup2 not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_pipe_start(int32_t* pipefd) {
  (void)pipefd;
  fprintf(stderr, "[Yo] Error: async pipe not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  (void)domain; (void)type; (void)protocol;
  fprintf(stderr, "[Yo] Error: async socket not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async bind not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  (void)sockfd; (void)backlog;
  fprintf(stderr, "[Yo] Error: async listen not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async accept not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async connect not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async send not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async recv not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                             const void* dest_addr, uint32_t addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)dest_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async sendto not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                               void* src_addr, uint32_t* addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)src_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async recvfrom not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  (void)sockfd; (void)how;
  fprintf(stderr, "[Yo] Error: async shutdown not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 const void* optval, uint32_t optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async setsockopt not supported without liburing\\n");
  abort();
  return NULL;
}

static inline void* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 void* optval, uint32_t* optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async getsockopt not supported without liburing\\n");
  abort();
  return NULL;
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

// ============================================================================
// Async I/O Runtime (macOS - dispatch_io via Grand Central Dispatch)
// ============================================================================

#if defined(__APPLE__)
#include <dispatch/dispatch.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
#include <pthread.h>

// Global dispatch queue for I/O completions
static dispatch_queue_t __yo_io_queue = NULL;
static bool __yo_io_initialized = false;
static _Atomic size_t __yo_pending_io_count = 0;

// Semaphore for blocking wait
static dispatch_semaphore_t __yo_io_semaphore = NULL;

// Initialize dispatch_io subsystem
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  // Create a serial queue for I/O completions to ensure thread safety
  __yo_io_queue = dispatch_queue_create("yo.io.completion", DISPATCH_QUEUE_SERIAL);
  __yo_io_semaphore = dispatch_semaphore_create(0);
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] dispatch_io initialized\\n");
}

// Cleanup dispatch_io
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  
  // Wait for pending I/O to complete
  while (atomic_load(&__yo_pending_io_count) > 0) {
    dispatch_semaphore_wait(__yo_io_semaphore, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC));
  }
  
  // Note: ARC manages dispatch objects in modern macOS, but we use manual retain/release for C code
  // dispatch_release(__yo_io_queue);  // Commented out - let it leak on cleanup for simplicity
  __yo_io_initialized = false;
  ASYNC_DEBUG("[IO] dispatch_io cleaned up\\n");
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return atomic_load(&__yo_pending_io_count) > 0;
}

// Process completions - on macOS, GCD handles this automatically via callback
// This function processes any completions that have been queued
static int __yo_io_poll(void) {
  // dispatch_io delivers completions to our queue automatically
  // We need to process any pending continuations that were enqueued
  // This is handled by the main event loop processing the task queue
  return 0;
}

// Wait for at least one I/O completion
static int __yo_io_wait(void) {
  if (atomic_load(&__yo_pending_io_count) == 0) return 0;
  
  // Wait on semaphore with timeout
  dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC);
  dispatch_semaphore_wait(__yo_io_semaphore, timeout);
  return 1;
}

// Helper to wake continuation from I/O completion
static void __yo_io_wake_continuation(yo_io_future_t* future) {
  // Mark as completed
  atomic_store_explicit(&future->state, -1, memory_order_release);
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);
  
  ASYNC_DEBUG("[IO] Waking continuation: cont_fn=%p, cont_sm=%p, result=%d\\n",
              (void*)cont_fn, cont_sm, future->result);
  
  if (cont_fn && cont_sm) {
    yo_async_spawn_task(cont_fn, cont_sm);
  }
  
  // Signal semaphore for waiting threads
  dispatch_semaphore_signal(__yo_io_semaphore);
  
  // Decrement pending count
  atomic_fetch_sub(&__yo_pending_io_count, 1);
}

// Create and start an async read operation using dispatch_io
static yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  // Use dispatch_read for async file read
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)fd;
  
  // For files, we need to use pread-style positioning
  // dispatch_read reads from current position, so we use dispatch_io for positioned reads
  dispatch_io_t channel = dispatch_io_create(DISPATCH_IO_RANDOM, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\\n", error);
    }
  });
  
  if (!channel) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to create dispatch_io channel: %d\\n", errno);
    return future;
  }
  
  // Capture buffer pointer for the block
  void* buf = buffer;
  yo_io_future_t* fut = future;
  uint32_t sz = size;
  
  dispatch_io_read(channel, (off_t)offset, (size_t)size, __yo_io_queue,
    ^(bool done, dispatch_data_t data, int error) {
      if (error) {
        fut->result = -error;
        if (done) {
          dispatch_io_close(channel, DISPATCH_IO_STOP);
          __yo_io_wake_continuation(fut);
        }
        return;
      }
      
      if (data) {
        // Copy data to buffer
        __block size_t copied = 0;
        dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t region_offset, const void* region_buffer, size_t region_size) {
          (void)region;
          (void)region_offset;
          size_t to_copy = region_size;
          if (copied + to_copy > sz) {
            to_copy = sz - copied;
          }
          memcpy((char*)buf + copied, region_buffer, to_copy);
          copied += to_copy;
          return true;
        });
        fut->result = (int32_t)copied;
      }
      
      if (done) {
        dispatch_io_close(channel, 0);
        ASYNC_DEBUG("[IO] Read completed: %d bytes\\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, buffer, size, (unsigned long long)offset, atomic_load(&__yo_pending_io_count));
  
  return future;
}

// Create and start an async write operation
static yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)fd;
  
  dispatch_io_t channel = dispatch_io_create(DISPATCH_IO_RANDOM, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\\n", error);
    }
  });
  
  if (!channel) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    return future;
  }
  
  // Create dispatch_data from buffer
  dispatch_data_t data = dispatch_data_create(buffer, size, __yo_io_queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
  
  yo_io_future_t* fut = future;
  
  dispatch_io_write(channel, (off_t)offset, data, __yo_io_queue,
    ^(bool done, dispatch_data_t remaining, int error) {
      if (error) {
        fut->result = -error;
        if (done) {
          dispatch_io_close(channel, DISPATCH_IO_STOP);
          __yo_io_wake_continuation(fut);
        }
        return;
      }
      
      if (done) {
        fut->result = (int32_t)size;  // All bytes written
        dispatch_io_close(channel, 0);
        ASYNC_DEBUG("[IO] Write completed: %d bytes\\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  // dispatch_data is retained by the write operation
  dispatch_release(data);
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\\n",
              fd, (void*)buffer, size, (unsigned long long)offset, atomic_load(&__yo_pending_io_count));
  
  return future;
}

// Async openat - on macOS we use synchronous open wrapped in an immediately-completed future
// because dispatch_io requires an already-open fd
static yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Perform synchronous open
  int fd;
  if (dirfd == -100) {  // AT_FDCWD
    fd = open(path, flags, mode);
  } else {
    fd = openat(dirfd, path, flags, mode);
  }
  
  if (fd < 0) {
    future->result = -errno;
  } else {
    future->result = fd;
  }
  
  // Mark as immediately completed
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] openat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async close
static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = close(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] close completed: fd=%d result=%d\\n", fd, future->result);
  
  return future;
}

// Async stat - uses synchronous fstatat on macOS
static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();
  (void)mask;  // Unused on macOS
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // On macOS, we use fstatat instead of statx
  // The statxbuf is actually a struct stat on macOS
  int at_flags = 0;
  if (flags & 0x100) {  // AT_SYMLINK_NOFOLLOW
    at_flags |= AT_SYMLINK_NOFOLLOW;
  }
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    if (at_flags & AT_SYMLINK_NOFOLLOW) {
      result = lstat(path, (struct stat*)statxbuf);
    } else {
      result = stat(path, (struct stat*)statxbuf);
    }
  } else {
    result = fstatat(dirfd, path, (struct stat*)statxbuf, at_flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] stat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async mkdirat
static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {
    result = mkdir(path, (mode_t)mode);
  } else {
    result = mkdirat(dirfd, path, (mode_t)mode);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] mkdirat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async unlinkat
static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {
    if (flags & 0x200) {  // AT_REMOVEDIR
      result = rmdir(path);
    } else {
      result = unlink(path);
    }
  } else {
    result = unlinkat(dirfd, path, flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] unlinkat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async renameat
static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (olddirfd == -100 && newdirfd == -100) {
    result = rename(oldpath, newpath);
  } else {
    result = renameat(olddirfd, oldpath, newdirfd, newpath);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] renameat completed: %s -> %s result=%d\\n", oldpath, newpath, future->result);
  
  return future;
}

// Async symlinkat
static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (newdirfd == -100) {
    result = symlink(target, linkpath);
  } else {
    result = symlinkat(target, newdirfd, linkpath);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] symlinkat completed: %s -> %s result=%d\\n", target, linkpath, future->result);
  
  return future;
}

// Async linkat
static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (olddirfd == -100 && newdirfd == -100) {
    result = link(oldpath, newpath);
  } else {
    result = linkat(olddirfd, oldpath, newdirfd, newpath, flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] linkat completed: %s -> %s result=%d\\n", oldpath, newpath, future->result);
  
  return future;
}

// Async fsync
static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fsync(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fsync completed: fd=%d result=%d\\n", fd, future->result);
  
  return future;
}

// Async fdatasync - macOS doesn't have fdatasync, use fsync
static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  // macOS: fdatasync is not available, fall back to fsync
  // F_FULLFSYNC is even stronger than fsync on macOS
  return __yo_async_fsync_start(fd);
}

// Async ftruncate
static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = ftruncate(fd, (off_t)length);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] ftruncate completed: fd=%d length=%lld result=%d\\n",
              fd, (long long)length, future->result);
  
  return future;
}

// ============================================================================
// Permission Operations (macOS)
// ============================================================================

// Async fchmod - change file permissions by fd
static yo_io_future_t* __yo_async_fchmod_start(int32_t fd, uint32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchmod(fd, (mode_t)mode);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmod completed: fd=%d mode=0%o result=%d\\n", fd, mode, future->result);
  
  return future;
}

// Async fchmodat - change file permissions by path
static yo_io_future_t* __yo_async_fchmodat_start(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = chmod(path, (mode_t)mode);
  } else {
    result = fchmodat(dirfd, path, (mode_t)mode, flags);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchmodat completed: path=%s mode=0%o result=%d\\n", path, mode, future->result);
  
  return future;
}

// Async fchown - change file ownership by fd
static yo_io_future_t* __yo_async_fchown_start(int32_t fd, uint32_t uid, uint32_t gid) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchown completed: fd=%d uid=%u gid=%u result=%d\\n", fd, uid, gid, future->result);
  
  return future;
}

// Async fchownat - change file ownership by path
static yo_io_future_t* __yo_async_fchownat_start(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    if (flags & 0x100) {  // AT_SYMLINK_NOFOLLOW
      result = lchown(path, (uid_t)uid, (gid_t)gid);
    } else {
      result = chown(path, (uid_t)uid, (gid_t)gid);
    }
  } else {
    result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] fchownat completed: path=%s uid=%u gid=%u result=%d\\n", path, uid, gid, future->result);
  
  return future;
}

// ============================================================================
// Symbolic Link Operations (macOS)
// ============================================================================

// Async readlinkat - read symbolic link target
static yo_io_future_t* __yo_async_readlinkat_start(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  ssize_t result;
  if (dirfd == -100) {  // AT_FDCWD
    result = readlink(path, buf, bufsize);
  } else {
    result = readlinkat(dirfd, path, buf, bufsize);
  }
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] readlinkat completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// ============================================================================
// File Descriptor Operations (macOS)
// ============================================================================

// Async dup - duplicate file descriptor
static yo_io_future_t* __yo_async_dup_start(int32_t oldfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup(oldfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup completed: oldfd=%d result=%d\\n", oldfd, future->result);
  
  return future;
}

// Async dup2 - duplicate file descriptor to specific fd
static yo_io_future_t* __yo_async_dup2_start(int32_t oldfd, int32_t newfd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = dup2(oldfd, newfd);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] dup2 completed: oldfd=%d newfd=%d result=%d\\n", oldfd, newfd, future->result);
  
  return future;
}

// Async pipe - create pipe
static yo_io_future_t* __yo_async_pipe_start(int32_t* pipefd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = pipe((int*)pipefd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] pipe completed: result=%d readfd=%d writefd=%d\\n",
              future->result, pipefd[0], pipefd[1]);
  
  return future;
}

// ============================================================================
// Socket Operations (macOS)
// ============================================================================
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// Async socket - create socket
static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = socket(domain, type, protocol);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\\n",
              domain, type, protocol, future->result);
  
  return future;
}

// Async bind - bind socket to address
static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = bind(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async listen - mark socket as listening
static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = listen(sockfd, backlog);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection (using kqueue for true async)
static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, use synchronous accept - true async would use kqueue
  // TODO: Implement kqueue-based async accept for non-blocking sockets
  int result = accept(sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen);
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] accept completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async connect - connect to remote address
static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, use synchronous connect - true async would use kqueue
  // TODO: Implement kqueue-based async connect for non-blocking sockets
  int result = connect(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] connect completed: sockfd=%d result=%d\\n", sockfd, future->result);
  
  return future;
}

// Async send - send data on socket
static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, use synchronous send
  // TODO: Implement true async send using kqueue or dispatch_source
  ssize_t result = send(sockfd, buf, len, flags);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] send completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async recv - receive data from socket
static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, use synchronous recv
  // TODO: Implement true async recv using kqueue or dispatch_source
  ssize_t result = recv(sockfd, buf, len, flags);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] recv completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async sendto - send data to specific address (UDP)
static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] sendto completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async recvfrom - receive data with source address (UDP)
static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] recvfrom completed: sockfd=%d len=%zu result=%d\\n", sockfd, len, future->result);
  
  return future;
}

// Async shutdown - shutdown socket
static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = shutdown(sockfd, how);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\\n", sockfd, how, future->result);
  
  return future;
}

// Async setsockopt - set socket option
static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Async getsockopt - get socket option
static yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    void* optval, uint32_t* optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = getsockopt(sockfd, level, optname, optval, (socklen_t*)optlen);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// ============================================================================
// Socket Address Helpers (macOS)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return sizeof(struct sockaddr_un);
}

static size_t __yo_sockaddr_storage_size(void) {
  return sizeof(struct sockaddr_storage);
}

static void __yo_sockaddr_set_family(void* addr, uint16_t family) {
  ((struct sockaddr*)addr)->sa_family = family;
}

static uint16_t __yo_sockaddr_get_family(void* addr) {
  return ((struct sockaddr*)addr)->sa_family;
}

static void __yo_sockaddr_in_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in*)addr)->sin_port = htons(port);
}

static uint16_t __yo_sockaddr_in_get_port(void* addr) {
  return ntohs(((struct sockaddr_in*)addr)->sin_port);
}

static void __yo_sockaddr_in_set_addr(void* addr, uint32_t ip) {
  ((struct sockaddr_in*)addr)->sin_addr.s_addr = ip;
}

static uint32_t __yo_sockaddr_in_get_addr(void* addr) {
  return ((struct sockaddr_in*)addr)->sin_addr.s_addr;
}

static void __yo_sockaddr_in6_set_port(void* addr, uint16_t port) {
  ((struct sockaddr_in6*)addr)->sin6_port = htons(port);
}

static uint16_t __yo_sockaddr_in6_get_port(void* addr) {
  return ntohs(((struct sockaddr_in6*)addr)->sin6_port);
}

static void __yo_sockaddr_in6_set_addr(void* addr, const void* ip) {
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, 16);
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, 16);
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  strncpy(((struct sockaddr_un*)addr)->sun_path, path, sizeof(((struct sockaddr_un*)addr)->sun_path) - 1);
}

static char* __yo_sockaddr_un_get_path(void* addr) {
  return ((struct sockaddr_un*)addr)->sun_path;
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return inet_pton(af, src, dst);
}

static char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return (char*)inet_ntop(af, src, dst, (socklen_t)size);
}

static uint16_t __yo_htons(uint16_t hostshort) {
  return htons(hostshort);
}

static uint16_t __yo_ntohs(uint16_t netshort) {
  return ntohs(netshort);
}

static uint32_t __yo_htonl(uint32_t hostlong) {
  return htonl(hostlong);
}

static uint32_t __yo_ntohl(uint32_t netlong) {
  return ntohl(netlong);
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

// On macOS, we use struct stat instead of struct statx
// These functions wrap struct stat access to match the Linux statx API
static size_t __yo_statx_buf_size(void) {
  return sizeof(struct stat);
}

static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_mtimespec.tv_sec;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_mtimespec.tv_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_atimespec.tv_sec;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_atimespec.tv_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_ctimespec.tv_sec;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_ctimespec.tv_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return (int64_t)((struct stat*)statxbuf)->st_birthtimespec.tv_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_birthtimespec.tv_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((struct stat*)statxbuf)->st_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_ino;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)major(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  return (uint64_t)minor(((struct stat*)statxbuf)->st_dev);
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blksize;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  return (uint64_t)((struct stat*)statxbuf)->st_blocks;
}

#endif // __APPLE__

// ============================================================================
// File System Helper Functions
// ============================================================================
// These functions help extract fields from struct stat, which has platform-specific layout.

#include <sys/stat.h>
#include <dirent.h>

// Get size of stat buffer (for allocation)
static size_t __yo_stat_buf_size(void) {
  return sizeof(struct stat);
}

// Extract fields from struct stat
static int64_t __yo_stat_size(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_size;
}

static uint32_t __yo_stat_mode(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_mode;
}

static int64_t __yo_stat_mtime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_mtime;
}

static int64_t __yo_stat_atime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_atime;
}

static int64_t __yo_stat_ctime(void* statbuf) {
  return (int64_t)((struct stat*)statbuf)->st_ctime;
}

static uint32_t __yo_stat_uid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_uid;
}

static uint32_t __yo_stat_gid(void* statbuf) {
  return (uint32_t)((struct stat*)statbuf)->st_gid;
}

static uint64_t __yo_stat_ino(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_ino;
}

static uint64_t __yo_stat_dev(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_dev;
}

static uint64_t __yo_stat_nlink(void* statbuf) {
  return (uint64_t)((struct stat*)statbuf)->st_nlink;
}

// Extract fields from struct dirent
static const char* __yo_dirent_name(void* entry) {
  return ((struct dirent*)entry)->d_name;
}

static uint8_t __yo_dirent_type(void* entry) {
#ifdef _DIRENT_HAVE_D_TYPE
  return ((struct dirent*)entry)->d_type;
#else
  // d_type not available on some systems, return DT_UNKNOWN
  return 0;
#endif
}

// ============================================================================
// Timer Operations (cross-platform)
// ============================================================================

#if defined(__linux__)
#include <sys/timerfd.h>

// Async sleep using timerfd + io_uring
static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Create a timerfd
  int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
  if (tfd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Set timer to expire after milliseconds
  struct itimerspec its = {0};
  its.it_value.tv_sec = (time_t)(milliseconds / 1000);
  its.it_value.tv_nsec = (long)((milliseconds % 1000) * 1000000);
  
  if (timerfd_settime(tfd, 0, &its, NULL) < 0) {
    int err = errno;
    close(tfd);
    future->result = -err;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Use io_uring to read from timerfd (fires when timer expires)
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    close(tfd);
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Allocate buffer for timerfd read (8 bytes)
  uint64_t* buf = (uint64_t*)__yo_malloc(sizeof(uint64_t));
  io_uring_prep_read(sqe, tfd, buf, sizeof(uint64_t), 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\\n",
              (unsigned long long)milliseconds, __yo_pending_io_count);
  
  return future;
}

// Async timeout - same as sleep for now
static yo_io_future_t* __yo_async_timeout_start(uint64_t milliseconds) {
  return __yo_async_sleep_start(milliseconds);
}

#elif defined(__APPLE__)
// macOS timer using dispatch_after
static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  dispatch_after(
    dispatch_time(DISPATCH_TIME_NOW, (int64_t)(milliseconds * NSEC_PER_MSEC)),
    __yo_io_queue,
    ^{
      fut->result = 0;  // Success
      __yo_io_wake_continuation(fut);
    }
  );
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\\n",
              (unsigned long long)milliseconds, atomic_load(&__yo_pending_io_count));
  
  return future;
}

static yo_io_future_t* __yo_async_timeout_start(uint64_t milliseconds) {
  return __yo_async_sleep_start(milliseconds);
}
#endif

// ============================================================================
// File Extra Operations (POSIX-only)
// ============================================================================
#if !defined(_WIN32)

// Async access - check file accessibility
static yo_io_future_t* __yo_async_access_start(int32_t dirfd, const char* path, int32_t mode) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = access(path, mode);
  } else {
    result = faccessat(dirfd, path, mode, 0);
  }
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] access completed: path=%s mode=%d result=%d\\n", path, mode, future->result);
  
  return future;
}

// Async realpath - resolve canonical path
static yo_io_future_t* __yo_async_realpath_start(const char* path, char* resolved) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  char* result = realpath(path, resolved);
  future->result = result ? 0 : -errno;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] realpath completed: path=%s result=%d\\n", path, future->result);
  
  return future;
}

// Async utime - change file timestamps
static yo_io_future_t* __yo_async_utime_start(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                               int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = utimensat(AT_FDCWD, path, times, 0);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async futime - change file timestamps by fd
static yo_io_future_t* __yo_async_futime_start(int32_t fd, int64_t atime_sec, int64_t atime_nsec,
                                                int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = futimens(fd, times);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async lutime - change symlink timestamps
static yo_io_future_t* __yo_async_lutime_start(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                                int64_t mtime_sec, int64_t mtime_nsec) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  
  int result = utimensat(AT_FDCWD, path, times, AT_SYMLINK_NOFOLLOW);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async mkdtemp - create temporary directory
static yo_io_future_t* __yo_async_mkdtemp_start(char* template) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  char* result = mkdtemp(template);
  future->result = result ? 0 : -errno;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async mkstemp - create temporary file
static yo_io_future_t* __yo_async_mkstemp_start(char* template) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int fd = mkstemp(template);
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  
  return future;
}

// Async copyfile
#if defined(__linux__)
#include <sys/sendfile.h>

static yo_io_future_t* __yo_async_copyfile_start(const char* src, const char* dst, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Open source
  int src_fd = open(src, O_RDONLY);
  if (src_fd < 0) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Get source size
  struct stat st;
  if (fstat(src_fd, &st) < 0) {
    int err = errno;
    close(src_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Open/create destination
  int open_flags = O_WRONLY | O_CREAT | O_TRUNC;
  if (flags & 1) open_flags |= O_EXCL;  // COPYFILE_EXCL
  
  int dst_fd = open(dst, open_flags, st.st_mode);
  if (dst_fd < 0) {
    int err = errno;
    close(src_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }
  
  // Try copy_file_range first (supports clone), fall back to sendfile
  ssize_t copied = 0;
  off_t off_in = 0;
  
#ifdef __NR_copy_file_range
  copied = syscall(__NR_copy_file_range, src_fd, &off_in, dst_fd, NULL, (size_t)st.st_size, 0);
#endif
  
  if (copied < 0) {
    // Fall back to sendfile
    off_t offset = 0;
    copied = sendfile(dst_fd, src_fd, &offset, (size_t)st.st_size);
  }
  
  close(src_fd);
  close(dst_fd);
  
  future->result = (copied < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

#elif defined(__APPLE__)
#include <copyfile.h>

static yo_io_future_t* __yo_async_copyfile_start(const char* src, const char* dst, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;  // COPYFILE_EXCL
  if (flags & 2) cf_flags |= COPYFILE_CLONE;  // COPYFILE_FICLONE
  if (flags & 4) cf_flags |= COPYFILE_CLONE_FORCE;  // COPYFILE_FICLONE_FORCE
  
  int result = copyfile(src, dst, NULL, cf_flags);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}
#endif

// Async sendfile
static yo_io_future_t* __yo_async_sendfile_start(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
#if defined(__linux__)
  off_t off = (off_t)offset;
  ssize_t sent = sendfile(out_fd, in_fd, &off, count);
  future->result = (sent < 0) ? -errno : (int32_t)sent;
#elif defined(__APPLE__)
  off_t len = (off_t)count;
  int result = sendfile(in_fd, out_fd, (off_t)offset, &len, NULL, 0);
  future->result = (result < 0) ? -errno : (int32_t)len;
#endif
  
  atomic_init(&future->state, -1);
  return future;
}

// Statfs support
#include <sys/statvfs.h>

static yo_io_future_t* __yo_async_statfs_start(const char* path, void* buf) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = statvfs(path, (struct statvfs*)buf);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

static size_t __yo_statfs_buf_size(void) {
  return sizeof(struct statvfs);
}

static uint64_t __yo_statfs_type(void* buf) {
  // statvfs doesn't have type, return 0
  (void)buf;
  return 0;
}

static uint64_t __yo_statfs_bsize(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bsize;
}

static uint64_t __yo_statfs_blocks(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_blocks;
}

static uint64_t __yo_statfs_bfree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bfree;
}

static uint64_t __yo_statfs_bavail(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_bavail;
}

static uint64_t __yo_statfs_files(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_files;
}

static uint64_t __yo_statfs_ffree(void* buf) {
  return (uint64_t)((struct statvfs*)buf)->f_ffree;
}

// ============================================================================
// Directory Scanning Operations
// ============================================================================

static yo_io_future_t* __yo_async_scandir_start(int32_t dirfd, const char* path) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // For now, just open the directory - actual scanning happens via readdir
  int fd;
  if (dirfd == -100) {
    fd = open(path, O_RDONLY | O_DIRECTORY);
  } else {
    fd = openat(dirfd, path, O_RDONLY | O_DIRECTORY);
  }
  
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_opendir_start(const char* path) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  DIR* dir = opendir(path);
  future->result = dir ? (int32_t)(intptr_t)dir : -errno;
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_readdir_start(void* dir, void* entries, size_t max_entries) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  (void)entries;
  (void)max_entries;
  
  // Read one entry
  struct dirent* entry = readdir((DIR*)dir);
  if (entry) {
    future->result = 1;
  } else {
    future->result = 0;  // No more entries
  }
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_closedir_start(void* dir) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = closedir((DIR*)dir);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  return future;
}

static size_t __yo_dirent_size(void) {
  return sizeof(struct dirent);
}

static uint16_t __yo_dirent_reclen(void* entry) {
#if defined(__linux__)
  return ((struct dirent*)entry)->d_reclen;
#else
  return (uint16_t)((struct dirent*)entry)->d_reclen;
#endif
}

static uint64_t __yo_dirent_ino(void* entry) {
  return (uint64_t)((struct dirent*)entry)->d_ino;
}

#if defined(__linux__)
static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Use getdents64 syscall directly
  long nread = syscall(SYS_getdents64, fd, buf, buf_size);
  future->result = (nread < 0) ? -errno : (int32_t)nread;
  atomic_init(&future->state, -1);
  
  return future;
}
#elif defined(__APPLE__)
static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // macOS doesn't have getdents, use getdirentries
  long basep = 0;
  ssize_t nread = getdirentries(fd, (char*)buf, (int)buf_size, &basep);
  future->result = (nread < 0) ? -errno : (int32_t)nread;
  atomic_init(&future->state, -1);
  
  return future;
}
#endif

// ============================================================================
// DNS Operations
// ============================================================================
#include <netdb.h>

static yo_io_future_t* __yo_async_getaddrinfo_start(const char* node, const char* service,
                                                     const void* hints, void** result) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct addrinfo* res = NULL;
  int ret = getaddrinfo(node, service, (const struct addrinfo*)hints, &res);
  
  if (ret == 0) {
    *result = res;
    future->result = 0;
  } else {
    future->result = -ret;  // Return negative gai error code
  }
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_getnameinfo_start(const void* addr, uint32_t addrlen,
                                                     char* host, size_t hostlen,
                                                     char* service, size_t servlen, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int ret = getnameinfo((const struct sockaddr*)addr, (socklen_t)addrlen,
                        host, (socklen_t)hostlen, service, (socklen_t)servlen, flags);
  future->result = (ret == 0) ? 0 : -ret;
  atomic_init(&future->state, -1);
  
  return future;
}

static void __yo_freeaddrinfo(void* res) {
  if (res) freeaddrinfo((struct addrinfo*)res);
}

static size_t __yo_addrinfo_size(void) {
  return sizeof(struct addrinfo);
}

static int32_t __yo_addrinfo_flags(void* ai) {
  return ((struct addrinfo*)ai)->ai_flags;
}

static int32_t __yo_addrinfo_family(void* ai) {
  return ((struct addrinfo*)ai)->ai_family;
}

static int32_t __yo_addrinfo_socktype(void* ai) {
  return ((struct addrinfo*)ai)->ai_socktype;
}

static int32_t __yo_addrinfo_protocol(void* ai) {
  return ((struct addrinfo*)ai)->ai_protocol;
}

static uint32_t __yo_addrinfo_addrlen(void* ai) {
  return (uint32_t)((struct addrinfo*)ai)->ai_addrlen;
}

static void* __yo_addrinfo_addr(void* ai) {
  return ((struct addrinfo*)ai)->ai_addr;
}

static char* __yo_addrinfo_canonname(void* ai) {
  return ((struct addrinfo*)ai)->ai_canonname;
}

static void* __yo_addrinfo_next(void* ai) {
  return ((struct addrinfo*)ai)->ai_next;
}

// ============================================================================
// Signal Operations
// ============================================================================
#include <signal.h>

// Signal handler storage (up to 32 signals)
static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};

static void __yo_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
    __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = (void (*)(void*))handler;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = __yo_signal_trampoline;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = SA_RESTART;
  
  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_signal_stop(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;
  
  __yo_signal_handlers[signum] = NULL;
  __yo_signal_handler_data[signum] = NULL;
  
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_DFL;
  sigemptyset(&sa.sa_mask);
  
  if (sigaction(signum, &sa, NULL) < 0) {
    return -errno;
  }
  return 0;
}

static int32_t __yo_kill(int32_t pid, int32_t signum) {
  int result = kill((pid_t)pid, signum);
  return (result < 0) ? -errno : 0;
}

// ============================================================================
// TTY Operations
// ============================================================================
#include <termios.h>
#include <sys/ioctl.h>

static struct termios __yo_orig_termios;
static bool __yo_termios_saved = false;

static int32_t __yo_tty_init(int32_t fd) {
  if (!__yo_termios_saved) {
    if (tcgetattr(fd, &__yo_orig_termios) < 0) {
      return -errno;
    }
    __yo_termios_saved = true;
  }
  return 0;
}

static int32_t __yo_tty_set_mode(int32_t fd, int32_t mode) {
  struct termios t;
  if (tcgetattr(fd, &t) < 0) return -errno;
  
  switch (mode) {
    case 0:  // TTY_MODE_NORMAL
      t = __yo_orig_termios;
      break;
    case 1:  // TTY_MODE_RAW
      t.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
      t.c_oflag &= ~(OPOST);
      t.c_cflag |= (CS8);
      t.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
      t.c_cc[VMIN] = 1;
      t.c_cc[VTIME] = 0;
      break;
    case 2:  // TTY_MODE_IO (Unix binary mode)
      t.c_iflag &= ~(ICRNL | IXON);
      t.c_oflag &= ~(OPOST);
      break;
    default:
      return -EINVAL;
  }
  
  if (tcsetattr(fd, TCSAFLUSH, &t) < 0) return -errno;
  return 0;
}

static int32_t __yo_tty_reset_mode(void) {
  if (__yo_termios_saved) {
    if (tcsetattr(STDIN_FILENO, TCSAFLUSH, &__yo_orig_termios) < 0) {
      return -errno;
    }
  }
  return 0;
}

static int32_t __yo_tty_get_winsize(int32_t fd, int32_t* width, int32_t* height) {
  struct winsize ws;
  if (ioctl(fd, TIOCGWINSZ, &ws) < 0) {
    return -errno;
  }
  *width = ws.ws_col;
  *height = ws.ws_row;
  return 0;
}

static int32_t __yo_isatty(int32_t fd) {
  return isatty(fd) ? 1 : 0;
}

// ============================================================================
// FS Event Operations (placeholder - needs kqueue/inotify)
// ============================================================================

typedef struct {
  int fd;
  void (*callback)(const char*, int, void*);
  void* user_data;
} yo_fs_event_t;

static void* __yo_fs_event_init(void) {
  yo_fs_event_t* handle = (yo_fs_event_t*)__yo_malloc(sizeof(yo_fs_event_t));
  memset(handle, 0, sizeof(yo_fs_event_t));
  return handle;
}

static int32_t __yo_fs_event_start(void* handle, const char* path, uint32_t flags, void* callback) {
  (void)handle;
  (void)path;
  (void)flags;
  (void)callback;
  // TODO: Implement with inotify (Linux) or kqueue (macOS)
  return -ENOTSUP;
}

static int32_t __yo_fs_event_stop(void* handle) {
  (void)handle;
  return 0;
}

static void __yo_fs_event_close(void* handle) {
  if (handle) __yo_free(handle);
}

// ============================================================================
// Poll Operations (placeholder - needs kqueue/epoll)
// ============================================================================

typedef struct {
  int fd;
  int events;
  void (*callback)(int, int, void*);
  void* user_data;
} yo_poll_t;

static void* __yo_poll_init(int32_t fd) {
  yo_poll_t* handle = (yo_poll_t*)__yo_malloc(sizeof(yo_poll_t));
  memset(handle, 0, sizeof(yo_poll_t));
  handle->fd = fd;
  return handle;
}

static int32_t __yo_poll_start(void* handle, int32_t events, void* callback) {
  (void)handle;
  (void)events;
  (void)callback;
  // TODO: Implement with epoll (Linux) or kqueue (macOS)
  return -ENOTSUP;
}

static int32_t __yo_poll_stop(void* handle) {
  (void)handle;
  return 0;
}

static void __yo_poll_close(void* handle) {
  if (handle) __yo_free(handle);
}

#endif // !defined(_WIN32) - End of POSIX-only File Extra Operations
`);
}
