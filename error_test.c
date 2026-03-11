#ifndef _WIN32
#define _DEFAULT_SOURCE
#define _GNU_SOURCE  // Needed for sched_getcpu() on Linux
#else
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#endif

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#ifdef _WIN32
  #include <windows.h>
  #include <bcrypt.h>
  #include <io.h>
  #include <sys/stat.h>
#else
  #include <unistd.h>
  #include <sys/stat.h>
  #include <sys/random.h>
#endif

// Using libc allocator
#define __yo_malloc malloc
#define __yo_calloc calloc
#define __yo_realloc realloc
#define __yo_free free
#define __yo_aligned_alloc aligned_alloc



// Module file:///home/yiyiwang/Workspace/Yo/tests/error.test.yo
// Module ID: yo681fba6f

// Future state enum - shared by all Future types
typedef enum {
  YO_FUTURE_RUNNING = 0,    // Task is in progress (queued or executing)
  YO_FUTURE_COMPLETED = 1,  // Task completed successfully
  YO_FUTURE_ERROR = 2       // Task failed with error
} yo_future_state_t;

// Non-atomic Reference Counting with Thread-Local Cycle Collection
// Based on QuickJS trial deletion algorithm
// See CYCLE_COLLECTION.md for design details

// Debug flag for GC operations - use --debug-gc flag to enable
// #define YO_DEBUG_GC 1

#ifdef YO_DEBUG_GC
  #define GC_DEBUG(...) fprintf(stderr, "GC: " __VA_ARGS__)
#else
  #define GC_DEBUG(...)
#endif

// Debug flag for parallelism operations - use --debug-parallelism flag to enable
// #define YO_DEBUG_PARALLELISM 1

#ifdef YO_DEBUG_PARALLELISM
  #define PARALLELISM_DEBUG(...) fprintf(stderr, __VA_ARGS__)
#else
  #define PARALLELISM_DEBUG(...)
#endif

// Debug flag for async/await operations - use --debug-async-await flag to enable
// #define YO_DEBUG_ASYNC_AWAIT 1

#ifdef YO_DEBUG_ASYNC_AWAIT
  #define ASYNC_DEBUG(...) fprintf(stderr, "ASYNC: " __VA_ARGS__)
#else
  #define ASYNC_DEBUG(...)
#endif

// GC mark states for QuickJS-style trial deletion cycle collection
typedef enum {
  YO_GC_UNMARKED = 0,      // Object not yet processed
  YO_GC_CANDIDATE = 1,     // Object is a candidate for cycle collection
  YO_GC_TRIAL_DELETED = 2, // Object has been trial-deleted (RC decremented)
  YO_GC_LIVE = 3,          // Object is reachable (RC > 0 after trial deletion)
  YO_GC_GARBAGE = 4        // Object is garbage (RC = 0 after trial deletion)
} yo_gc_mark_t;

// GC flags
#define YO_GC_TRACKED              0x01  // Object is tracked by GC (might participate in cycles)

// Thread synchronization for stop-the-world GC
#ifndef YO_THREAD_SYNC_TYPE
#if defined(_WIN32)
  // Windows: Use native Windows APIs for better compatibility
  #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
  #endif
  #ifndef _WINSOCKAPI_
  #define _WINSOCKAPI_
  #endif
  #include <windows.h>
  #include <process.h>
  typedef CRITICAL_SECTION YO_THREAD_SYNC_TYPE;
  typedef CONDITION_VARIABLE YO_COND_TYPE;
  typedef HANDLE YO_THREAD_TYPE;
  #define YO_THREAD_SYNC_INIT {0}
  #define YO_THREAD_SYNC_LOCK(m) EnterCriticalSection(m)
  #define YO_THREAD_SYNC_UNLOCK(m) LeaveCriticalSection(m)
  #define YO_COND_INIT CONDITION_VARIABLE_INIT
  #define yo_mutex_init(m) InitializeCriticalSection(m)
  #define yo_mutex_destroy(m) DeleteCriticalSection(m)
  #define yo_mutex_lock(m) EnterCriticalSection(m)
  #define yo_mutex_unlock(m) LeaveCriticalSection(m)
  #define yo_cond_init(c) InitializeConditionVariable(c)
  #define yo_cond_destroy(c) ((void)0)
  #define yo_cond_wait(c, m) SleepConditionVariableCS(c, m, INFINITE)
  #define yo_cond_signal(c) WakeConditionVariable(c)
  #define yo_cond_broadcast(c) WakeAllConditionVariable(c)
  #define yo_thread_create(t, func, arg) (*(t) = (HANDLE)_beginthreadex(NULL, 0, func, arg, 0, NULL), *(t) != NULL ? 0 : -1)
  #define yo_thread_join(t) (WaitForSingleObject(t, INFINITE), CloseHandle(t), 0)
  #define yo_thread_self() ((uintptr_t)GetCurrentThreadId())
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  // Unix-like systems: Use pthreads (more reliable, especially on macOS)
  #include <pthread.h>
  #include <unistd.h>
  #include <sys/syscall.h>
  #if defined(__APPLE__)
    #include <sys/types.h>
    #include <sys/sysctl.h>
  #endif
  typedef pthread_mutex_t YO_THREAD_SYNC_TYPE;
  typedef pthread_cond_t YO_COND_TYPE;
  typedef pthread_t YO_THREAD_TYPE;
  #define YO_THREAD_SYNC_INIT PTHREAD_MUTEX_INITIALIZER
  #define YO_THREAD_SYNC_LOCK(m) pthread_mutex_lock(m)
  #define YO_THREAD_SYNC_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_COND_INIT PTHREAD_COND_INITIALIZER
  #define yo_mutex_init(m) pthread_mutex_init(m, NULL)
  #define yo_mutex_destroy(m) pthread_mutex_destroy(m)
  #define yo_mutex_lock(m) pthread_mutex_lock(m)
  #define yo_mutex_unlock(m) pthread_mutex_unlock(m)
  #define yo_cond_init(c) pthread_cond_init(c, NULL)
  #define yo_cond_destroy(c) pthread_cond_destroy(c)
  #define yo_cond_wait(c, m) pthread_cond_wait(c, m)
  #define yo_cond_signal(c) pthread_cond_signal(c)
  #define yo_cond_broadcast(c) pthread_cond_broadcast(c)
  #define yo_thread_create(t, func, arg) pthread_create(t, NULL, func, arg)
  #define yo_thread_join(t) pthread_join(t, NULL)
  #define yo_thread_self() ((uintptr_t)pthread_self())
#else
  #error "Unsupported platform for threading"
#endif
#endif

// Thread handle type for parallelism - value type, stack allocated
// Contains the OS thread handle (pthread_t or HANDLE)
typedef struct __yo_thread_t {
  YO_THREAD_TYPE handle;
} __yo_thread_t;

// Thread callback type for spawn
typedef void (*__yo_thread_fn)(void* closure);

YO_THREAD_SYNC_TYPE yo_mutex_create(void);
YO_COND_TYPE yo_cond_create(void);
/**
 * Create and initialize a mutex (stack-allocated value)
 * Returns an initialized mutex that can be used with yo_mutex_lock/unlock
 */
YO_THREAD_SYNC_TYPE yo_mutex_create(void) {
  YO_THREAD_SYNC_TYPE mutex;
  yo_mutex_init(&mutex);
  return mutex;
}

/**
 * Create and initialize a condition variable (stack-allocated value)
 * Returns an initialized condition variable that can be used with yo_cond_wait/signal/broadcast
 */
YO_COND_TYPE yo_cond_create(void) {
  YO_COND_TYPE cond;
  yo_cond_init(&cond);
  return cond;
}

// Forward declare yo_thread_gc_state_t for use in yo_ref_header_t
typedef struct yo_thread_gc_state yo_thread_gc_state_t;

// Reference counting header - simple non-atomic RC with cycle collection support
// Thread-local: each object is owned by the thread that created it
typedef struct yo_ref_header_t {
  // Simple reference count (non-atomic, thread-local)
  size_t ref_count;
  
  // GC cycle collection fields
  uint8_t gc_flags;                                     // GC tracking flags
  yo_gc_mark_t gc_mark;                                 // GC mark state for trial deletion
  
  // GC object management fields (doubly-linked list for O(1) deletion)
  struct yo_ref_header_t* gc_next;                      // Next object in thread-local GC tracking list
  struct yo_ref_header_t* gc_prev;                      // Previous object in thread-local GC tracking list
  void (*dispose_fn)(void*);                            // Dispose function for this object type (immutable after construction)
  void (*traverse_fn)(void*, void (*visit)(void*));     // Traversal function for GC marking (immutable after construction)
} yo_ref_header_t;

// Per-thread GC state - defined after yo_ref_header_t so it can use complete type
struct yo_thread_gc_state {
  yo_ref_header_t* tracked_objects;          // Head of this thread's tracked objects list
  size_t tracked_count;                      // Number of objects tracked by this thread
  size_t thread_id;                          // Thread identifier (for debugging)
  size_t alloc_count;                        // Allocations since last collection
  yo_thread_gc_state_t* next;                // Next thread in global thread list
  yo_thread_gc_state_t* prev;                // Previous thread in global thread list (for O(1) removal)
};

// Generic Future type - used by async runtime for type-agnostic operations
// All concrete Future types share this same layout for common fields
typedef struct {
  yo_ref_header_t header;
  yo_future_state_t state;
  void* state_machine;
  void (*state_machine_dispose_fn)(void*);
  void (*resume_fn)(void*);
  void* continuation_fn;
  void* continuation_sm;
  bool detached;
  // Note: concrete Future types may have additional fields (e.g., result) after this
} yo_future_generic_t;

// Generic I/O Future type for extern "Yo" functions returning Impl Future(T)
// This has the same layout as async state machines (state, result, continuation_fn, continuation_sm)
// so the await codegen can access ->state and ->result uniformly
typedef struct yo_io_future_t {
  yo_ref_header_t header;                       // Reference counting (must be first)
  _Atomic int state;                            // Future state (0 = pending, -1 = completed)
  int32_t result;                               // The result value (bytes read/written or -errno)
  _Atomic(void (*)(void*)) continuation_fn;     // Continuation function
  _Atomic(void*) continuation_sm;               // Continuation state machine
} yo_io_future_t;

// Forward declarations will be added here if needed


typedef struct { // Slice wrapper struct
  uint8_t** data;
  size_t length;
} Slice_uint8_t_u42_;


// Command-line arguments (initialized in main)
static int32_t __yo_argc;
static uint8_t** __yo_argv;
static Slice_uint8_t_u42_ __yo_args;

// Function declarations
/// Extern functions

/// Async runtime functions
void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine);
void yo_future_dispose(void* ptr);

/// Object constructors
void __yo_decr_rc(void* ptr); // Decrement reference count
void* __yo_incr_rc(void* ptr); // Increment reference count
void __yo_gc_register(void* ptr); // Register object for cycle detection
void __yo_gc_unregister(void* ptr); // Unregister object from cycle detection
void __yo_gc_collect(); // Trigger garbage collection
void __yo_gc_init_thread(); // Initialize thread-local GC state (for worker threads)
void __yo_cleanup_thread_gc(); // Clean up thread-local GC state
static void yo_init_process_cleanup(void); // Initialize process cleanup

/// Closure constructors

/// Capture dispose functions

/// Dyn type constructors

/// Regular functions
/// Closure vtable instances


// Function implementations

// ============================================================================
// Async/Await Runtime - Single-Threaded Cooperative Scheduler
// ============================================================================
// This implements a cooperative async runtime for single-threaded concurrency.
// All async tasks run on the SAME thread - no parallelism, just interleaving.
// Uses non-atomic reference counting (everything is thread-local).
//
// LAZY EXECUTION MODEL:
// - async { ... } blocks are LAZY: the constructor returns a cold (unstarted)
//   future with refcount = 1 (only user ref). No execution happens at creation.
// - In sync context (not inside a state machine), the call site eagerly starts
//   the future after construction (equivalent to Rust's tokio::spawn).
// - In async context, futures stay cold until explicitly await-ed or join-ed.
// - await starts the cold future (via __yo_resume_fn), takes an event loop
//   reference, and suspends the caller until the future completes.
// - Completion decrements the event loop reference; user drop decrements the user ref.
// - State machine is freed when refcount hits 0.

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

// Count of active poll/fs_event watches (used by all platforms)
static size_t __yo_active_watch_count = 0;

// Whether the I/O subsystem has been initialized (set by __yo_io_init in platform runtimes)
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
static bool __yo_io_initialized = false;
#endif

// Forward declarations for I/O functions (defined later, may be stubs if liburing unavailable)
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
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
  ASYNC_DEBUG("[ASYNC] Scheduler initialized\n");
}

// Enqueue a continuation to be executed on the current thread's event loop
// NOTE: This is a low-level function that does NOT manage refcounts.
// Use yo_async_spawn_task for spawning tasks with proper lifetime management.
static void yo_async_enqueue_continuation(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("[ASYNC] Enqueueing continuation: resume_fn=%p, sm=%p\n", (void*)resume_fn, state_machine);
  
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
  ASYNC_DEBUG("[ASYNC] Queue count: %zu\n", yo_thread_async_queue.count);
}

// Spawn an async task by enqueueing it to the current thread's event loop
// NOTE: This does NOT increment refcount. The task lifetime is managed by:
// - Constructor: starts with refcount = 1 (user ref)
// - Await/spawn: increments refcount (event loop ref) before starting cold future
// - Completion: decrements refcount (releases event loop ref)
// - User drop: decrements refcount (releases user ref)
void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("[ASYNC] Spawning task: resume_fn=%p, sm=%p\n", (void*)resume_fn, state_machine);
  yo_async_enqueue_continuation(resume_fn, state_machine);
}

// Process all ready tasks in the queue (non-blocking).
void yo_async_run_ready_tasks(void) {
  while (yo_thread_async_queue.head) {
    yo_continuation_t* cont = yo_thread_async_queue.head;
    yo_thread_async_queue.head = cont->next;
    if (!yo_thread_async_queue.head) {
      yo_thread_async_queue.tail = NULL;
    }
    yo_thread_async_queue.count--;
    cont->resume_fn(cont->state_machine);
    __yo_free(cont);
  }
}

// Perform one step of the event loop: drain task queue, then poll/wait for I/O.
// Used by synchronous io.await to make progress on both pure-async tasks
// and I/O operations. Safe to call repeatedly in a busy loop — it only polls I/O
// if the I/O subsystem has been initialized (i.e., the program uses IO operations).
void yo_async_poll_step(void) {
  yo_async_run_ready_tasks();
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
  if (__yo_io_initialized) {
    __yo_io_poll();
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      __yo_io_wait();
    }
  }
#endif
}

// Run event loop until a specific Future completes (for async main)
// The Future must have an 'int state' field at offset 0
// State -1 means completed, -2 means aborted
void __yo_async_run_until_complete(void* future_ptr) {
  if (!yo_async_scheduler_initialized) {
    __yo_async_scheduler_init();
  }
  
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
  __yo_io_init();  // Initialize platform-specific async I/O
#endif
  
  ASYNC_DEBUG("[ASYNC] Starting event loop for future=%p\n", future_ptr);
  
  // future_ptr points to a heap-backed Future/state-machine struct.
  // It must have int state at offset 0.
  typedef struct { int state; } generic_future_t;
  generic_future_t* future = (generic_future_t*)future_ptr;
  
  // Run the event loop until the future completes or is aborted
  int __future_state = future->state;
  while (__future_state != -1 && __future_state != -2) {
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
      
      ASYNC_DEBUG("[ASYNC] Executing continuation: resume_fn=%p, sm=%p (queue_count=%zu)\n",
                  (void*)cont->resume_fn, cont->state_machine, yo_thread_async_queue.count);
      
      // Execute the continuation
      cont->resume_fn(cont->state_machine);
      
      // Free the continuation
      __yo_free(cont);
      tasks_run++;
    }
    
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
    // 2. Poll I/O completions (non-blocking)
    __yo_io_poll();
    
    // 3. If no ready tasks but pending I/O, block until completion
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\n");
      __yo_io_wait();
      __future_state = future->state;
      continue;
    }
#endif
    
    __future_state = future->state;
    // 4. If no tasks and no I/O, check if future is complete
    if (!yo_thread_async_queue.head) {
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
      if (!__yo_has_pending_io()) {
        // No tasks, no I/O - future must be waiting on something else or complete
        ASYNC_DEBUG("[ASYNC] No tasks or I/O, future state=%d\n", __future_state);
        if (__future_state != -1 && __future_state != -2) {
          // Future not complete but nothing to do - this shouldn't happen
          ASYNC_DEBUG("[ASYNC] WARNING: No tasks/IO but future not complete\n");
          break;
        }
      }
#else
      // No async I/O support on this platform
      ASYNC_DEBUG("[ASYNC] WARNING: Queue empty but future not complete (state=%d)\n", __future_state);
      break;
#endif
    }
  }
  
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
  __yo_io_cleanup();
#endif
  
  ASYNC_DEBUG("[ASYNC] Event loop finished, future state=%d\n", future->state);
  
  if (future->state == -2) {
    fprintf(stderr, "panic: async main Future was aborted by an effect handler\n");
    abort();
  }
}

// Wait for all async tasks to complete (drains the queue)
void __yo_async_wait_all(void) {
  if (!yo_async_scheduler_initialized) {
    return;
  }
  
  ASYNC_DEBUG("[ASYNC] Waiting for all tasks to complete (queue_count=%zu)\n", yo_thread_async_queue.count);
  
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
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
      
      ASYNC_DEBUG("[ASYNC] Executing continuation: resume_fn=%p, sm=%p\n",
                  (void*)cont->resume_fn, cont->state_machine);
      
      cont->resume_fn(cont->state_machine);
      __yo_free(cont);
      tasks_processed = true;
    }
    
#if defined(__linux__) || defined(__APPLE__) || defined(_WIN32)
    // 2. Poll for I/O completions (non-blocking)
    __yo_io_poll();
    
    // 3. If no tasks were processed, no new tasks after polling, and there's pending I/O, wait for completion
    if (!tasks_processed && !yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\n");
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
  
  ASYNC_DEBUG("[ASYNC] All tasks completed\n");
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
  ASYNC_DEBUG("[CONCURRENCY] set_maximum_threads(%zu) - currently no-op for async/await\n", num);
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
  int state;                                    // Future state (0 = running, -1 = completed)
  void (*continuation_fn)(void*);               // Continuation (if awaited)
  void* continuation_sm;                        // Continuation state machine
} __yo_yield_future_t;

__yo_yield_future_t __yo_async_yield(void) {
  __yo_yield_future_t future;
  // Initialize as completed (state = -1) so await will not actually suspend
  // The suspension happens because await checks the queue and processes other tasks
  future.state = -1;
  future.continuation_fn = NULL;
  future.continuation_sm = NULL;
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
#include <sys/utsname.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <sys/uio.h>
#include <time.h>
#include <errno.h>

static struct io_uring __yo_io_ring;
// __yo_io_initialized is defined in runtime-core
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
    fprintf(stderr, "[Yo] io_uring_queue_init failed: %s\n", strerror(-ret));
    exit(1);
  }
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] io_uring initialized with 256 entries\n");
}

// Cleanup io_uring
static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  io_uring_queue_exit(&__yo_io_ring);
  __yo_io_initialized = false;
  ASYNC_DEBUG("[IO] io_uring cleaned up\n");
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return __yo_pending_io_count > 0 || __yo_active_watch_count > 0;
}

// Forward declaration for poll/fs_event tick (defined in runtime-io-common)
static int __yo_poll_and_fs_event_tick(void);

// Process completions from CQ
// The future pointer is stored directly in the SQE user data
static void __yo_io_process_cqe(struct io_uring_cqe* cqe) {
  yo_io_future_t* future = (yo_io_future_t*)io_uring_cqe_get_data(cqe);
  __yo_pending_io_count--;

  // Set the result
  future->result = cqe->res;
  
  ASYNC_DEBUG("[IO] Completed I/O: result=%d (pending=%zu)\n",
              future->result, __yo_pending_io_count);
  
  // Mark as completed (state -1 = done)
  future->state = -1;
  
  // Wake continuation if registered
  void (*cont_fn)(void*) = future->continuation_fn;
  void* cont_sm = future->continuation_sm;
  
  ASYNC_DEBUG("[IO] Continuation check: cont_fn=%p, cont_sm=%p\n", (void*)cont_fn, cont_sm);
  
  if (cont_fn && cont_sm) {
    ASYNC_DEBUG("[IO] Spawning continuation for I/O completion\n");
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
  
  // Also tick poll/fs_event handles
  count += __yo_poll_and_fs_event_tick();
  
  if (count > 0) {
    ASYNC_DEBUG("[IO] Polled %d completions\n", count);
  }
  return count;
}

// Wait for at least one I/O completion (blocking)
static int __yo_io_wait(void) {
  // If only poll/fs_event watches are pending (no io_uring ops), use a short sleep
  if (__yo_pending_io_count == 0 && __yo_active_watch_count > 0) {
    struct timespec ts = {0, 10 * 1000 * 1000}; // 10ms
    nanosleep(&ts, NULL);
    return __yo_poll_and_fs_event_tick();
  }
  
  struct io_uring_cqe* cqe;
  int ret = io_uring_wait_cqe(&__yo_io_ring, &cqe);
  if (ret < 0) {
    ASYNC_DEBUG("[IO] WARNING: io_uring_wait_cqe failed: %d\n", ret);
    return 0;
  }
  
  ASYNC_DEBUG("[IO] Waiting for I/O completion...\n");
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
  future->state = 0;  // 0 = pending
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    future->state = -1;  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\n");
    return future;
  }
  
  io_uring_prep_read(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\n",
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
  future->state = 0;  // 0 = pending
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // Submit to io_uring
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    // Queue full
    future->result = -EAGAIN;
    future->state = -1;  // Mark as completed
    ASYNC_DEBUG("[IO] WARNING: io_uring SQ full, returning EAGAIN\n");
    return future;
  }
  
  io_uring_prep_write(sqe, fd, buffer, (unsigned)size, (int64_t)offset);
  io_uring_sqe_set_data(sqe, future);  // Store future pointer directly
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\n",
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
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_openat(sqe, dirfd, path, flags, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async openat: dirfd=%d path=%s flags=0x%x mode=0%o (pending=%zu)\n",
              dirfd, path, flags, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async close operation
static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_close(sqe, fd);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async close: fd=%d (pending=%zu)\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async statx operation (for async stat)
// Uses statx which is the modern replacement for stat, supported by io_uring
static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_statx(sqe, dirfd, path, flags, mask, (struct statx*)statxbuf);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async statx: dirfd=%d path=%s flags=0x%x mask=0x%x (pending=%zu)\n",
              dirfd, path, flags, mask, __yo_pending_io_count);
  
  return future;
}

// Create and start an async mkdirat operation
static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_mkdirat(sqe, dirfd, path, (mode_t)mode);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async mkdirat: dirfd=%d path=%s mode=0%o (pending=%zu)\n",
              dirfd, path, mode, __yo_pending_io_count);
  
  return future;
}

// Create and start an async unlinkat operation
static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_unlinkat(sqe, dirfd, path, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async unlinkat: dirfd=%d path=%s flags=0x%x (pending=%zu)\n",
              dirfd, path, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async renameat operation
static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_renameat(sqe, olddirfd, oldpath, newdirfd, newpath, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async renameat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s (pending=%zu)\n",
              olddirfd, oldpath, newdirfd, newpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async symlinkat operation
static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_symlinkat(sqe, target, newdirfd, linkpath);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async symlinkat: target=%s newdirfd=%d linkpath=%s (pending=%zu)\n",
              target, newdirfd, linkpath, __yo_pending_io_count);
  
  return future;
}

// Create and start an async linkat operation (hard link)
static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_linkat(sqe, olddirfd, oldpath, newdirfd, newpath, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async linkat: olddirfd=%d oldpath=%s newdirfd=%d newpath=%s flags=0x%x (pending=%zu)\n",
              olddirfd, oldpath, newdirfd, newpath, flags, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fsync operation
static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async fsync: fd=%d (pending=%zu)\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async fdatasync operation
static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_fsync(sqe, fd, IORING_FSYNC_DATASYNC);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async fdatasync: fd=%d (pending=%zu)\n", fd, __yo_pending_io_count);
  
  return future;
}

// Create and start an async ftruncate operation
static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;

#if defined(IORING_OP_FTRUNCATE)
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }

  io_uring_prep_rw(IORING_OP_FTRUNCATE, sqe, fd, NULL, 0, (uint64_t)length);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;

  ASYNC_DEBUG("[IO] Started async ftruncate: fd=%d length=%lld (pending=%zu)\n",
              fd, (long long)length, __yo_pending_io_count);
#else
  int result = ftruncate(fd, (off_t)length);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;

  ASYNC_DEBUG("[IO] Completed ftruncate synchronously (liburing fallback): fd=%d length=%lld result=%d\n",
              fd, (long long)length, future->result);
#endif
  
  return future;
}

// ============================================================================
// Synchronous FD Operations (Linux) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = pipe((int*)pipefd);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = dup2(oldfd, newfd);
  return (result < 0) ? -errno : result;
}

static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  off_t result = lseek(fd, (off_t)offset, whence);
  return (result < 0) ? (int64_t)(-errno) : (int64_t)result;
}

static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  int result = fallocate(fd, mode, (off_t)offset, (off_t)length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  int result = fcntl(fd, F_GETFL);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFL, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  int result = fcntl(fd, F_GETFD);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFD, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_flock(int32_t fd, int32_t operation) {
  int result = flock(fd, operation);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = readv(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = writev(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pread(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pwrite(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static size_t __yo_iovec_size(void) {
  return sizeof(struct iovec);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  struct iovec* vec = (struct iovec*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  int result = posix_fadvise(fd, (off_t)offset, (off_t)len, advice);
  return (result == 0) ? 0 : -result;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  int result = madvise((void*)addr, length, advice);
  return (result < 0) ? -errno : 0;
}

static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  void* result = mmap((void*)addr, length, prot, flags, fd, (off_t)offset);
  if (result == MAP_FAILED) {
    return (uint8_t*)(intptr_t)(-errno);
  }
  return (uint8_t*)result;
}

static bool __yo_sync_mmap_is_error(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  return (value < 0) && (value >= -65535);
}

static int32_t __yo_sync_mmap_errno(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  if ((value < 0) && (value >= -65535)) {
    return (int32_t)(-value);
  }
  return 0;
}

static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) {
  int result = munmap((void*)addr, length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) {
  int result = mprotect((void*)addr, length, prot);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) {
  int result = msync((void*)addr, length, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  int result = fchmod(fd, (mode_t)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  int result = fchmodat(dirfd, path, (mode_t)mode, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result = readlinkat(dirfd, path, buf, bufsize);
  return (result < 0) ? -errno : (int32_t)result;
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
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = socket(domain, type, protocol);
  future->result = (result < 0) ? -errno : result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\n",
              domain, type, protocol, future->result);
  
  return future;
}

// Async bind - bind socket to address
static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = bind(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\n", sockfd, future->result);
  
  return future;
}

// Async listen - mark socket as listening
static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = listen(sockfd, backlog);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection (using io_uring)
static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_accept(sqe, sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen, 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async accept: sockfd=%d (pending=%zu)\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async connect - connect to remote address (using io_uring)
static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_connect(sqe, sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async connect: sockfd=%d (pending=%zu)\n", sockfd, __yo_pending_io_count);
  
  return future;
}

// Async send - send data on socket (using io_uring)
static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_send(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async send: sockfd=%d len=%zu (pending=%zu)\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async recv - receive data from socket (using io_uring)
static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    future->state = -1;
    return future;
  }
  
  io_uring_prep_recv(sqe, sockfd, buf, len, flags);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[IO] Started async recv: sockfd=%d len=%zu (pending=%zu)\n", sockfd, len, __yo_pending_io_count);
  
  return future;
}

// Async sendto - send data to specific address (UDP)
static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // io_uring doesn't have direct sendto, use synchronous
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] sendto completed: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
  
  return future;
}

// Async recvfrom - receive data with source address (UDP)
static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  // io_uring doesn't have direct recvfrom, use synchronous
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  future->result = (result < 0) ? -errno : (int32_t)result;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] recvfrom completed: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
  
  return future;
}

// Async shutdown - shutdown socket
static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = shutdown(sockfd, how);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\n", sockfd, how, future->result);
  
  return future;
}

// Async setsockopt - set socket option
static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                    const void* optval, uint32_t optlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\n",
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
  future->state = 0;
  future->result = 0;
  future->continuation_fn = NULL;
  future->continuation_sm = NULL;
  
  int result = getsockopt(sockfd, level, optname, optval, (socklen_t*)optlen);
  future->result = (result < 0) ? -errno : 0;
  future->state = -1;
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Sync getsockname - get local socket address
static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getsockname(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync getpeername - get remote peer address
static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getpeername(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync setsockopt - set socket option value
static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     const void* optval, uint32_t optlen) {
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  return (result < 0) ? -errno : 0;
}

// Sync getsockopt - get socket option value
static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     void* optval, uint32_t* optlen) {
  socklen_t len = (socklen_t)(*optlen);
  int result = getsockopt(sockfd, level, optname, optval, &len);
  if (result < 0) {
    return -errno;
  }
  *optlen = (uint32_t)len;
  return 0;
}

// Sync socketpair - create a connected socket pair
static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  int result = socketpair(domain, sock_type, protocol, (int*)sv);
  return (result < 0) ? -errno : 0;
}

// Sync clock_gettime - read current clock time
static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  struct timespec ts;
  int result = clock_gettime((clockid_t)clock_id, &ts);
  if (result < 0) {
    return -errno;
  }
  *sec = (int64_t)ts.tv_sec;
  *nsec = (int64_t)ts.tv_nsec;
  return 0;
}

// Sync uname - system identification
static int32_t __yo_sync_uname(void* buf) {
  int result = uname((struct utsname*)buf);
  return (result < 0) ? -errno : 0;
}

// Sync gethostname - read host name
static int32_t __yo_sync_gethostname(char* name, size_t len) {
  int result = gethostname(name, len);
  if (result < 0) {
    return -errno;
  }
  if (len > 0) {
    name[len - 1] = ' ';
  }
  return 0;
}

// Sync umask - set process file mode creation mask
static int32_t __yo_sync_umask(int32_t mask) {
  mode_t prev = umask((mode_t)mask);
  return (int32_t)prev;
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
  ASYNC_DEBUG("[IO] open(%s, 0x%x, 0%o) = %d\n", path, flags, mode, result);
  return result;
}

static void __yo_file_close(int32_t fd) {
  ASYNC_DEBUG("[IO] close(%d)\n", fd);
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) {
    int result = -errno;
    ASYNC_DEBUG("[IO] fstat(%d) failed: %d\n", fd, result);
    return result;
  }
  ASYNC_DEBUG("[IO] fstat(%d) = %lld bytes\n", fd, (long long)st.st_size);
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

#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/utsname.h>
#include <time.h>

// Stub functions when liburing is not available
static inline void __yo_io_init(void) {
  fprintf(stderr, "[Yo] Warning: liburing not available, async I/O disabled\n");
}

static inline void __yo_io_cleanup(void) {}

static inline bool __yo_has_pending_io(void) {
  return __yo_active_watch_count > 0;
}

static int __yo_poll_and_fs_event_tick(void);

static inline int __yo_io_poll(void) { return __yo_poll_and_fs_event_tick(); }

static inline int __yo_io_wait(void) {
  if (__yo_active_watch_count > 0) {
    struct timespec ts = {0, 10 * 1000 * 1000};
    nanosleep(&ts, NULL);
    return __yo_poll_and_fs_event_tick();
  }
  return 0;
}

static inline void* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async read not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  (void)fd; (void)buffer; (void)size; (void)offset;
  fprintf(stderr, "[Yo] Error: async write not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  (void)dirfd; (void)path; (void)flags; (void)mode;
  fprintf(stderr, "[Yo] Error: async openat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_close_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async close not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  (void)dirfd; (void)path; (void)flags; (void)mask; (void)statxbuf;
  fprintf(stderr, "[Yo] Error: async statx not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  (void)dirfd; (void)path; (void)mode;
  fprintf(stderr, "[Yo] Error: async mkdirat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  (void)dirfd; (void)path; (void)flags;
  fprintf(stderr, "[Yo] Error: async unlinkat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath;
  fprintf(stderr, "[Yo] Error: async renameat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  (void)target; (void)newdirfd; (void)linkpath;
  fprintf(stderr, "[Yo] Error: async symlinkat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  (void)olddirfd; (void)oldpath; (void)newdirfd; (void)newpath; (void)flags;
  fprintf(stderr, "[Yo] Error: async linkat not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fsync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fsync not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_fdatasync_start(int32_t fd) {
  (void)fd;
  fprintf(stderr, "[Yo] Error: async fdatasync not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  (void)fd; (void)length;
  fprintf(stderr, "[Yo] Error: async ftruncate not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  (void)domain; (void)type; (void)protocol;
  fprintf(stderr, "[Yo] Error: async socket not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async bind not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  (void)sockfd; (void)backlog;
  fprintf(stderr, "[Yo] Error: async listen not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async accept not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  (void)sockfd; (void)addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async connect not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async send not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  (void)sockfd; (void)buf; (void)len; (void)flags;
  fprintf(stderr, "[Yo] Error: async recv not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                             const void* dest_addr, uint32_t addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)dest_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async sendto not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                               void* src_addr, uint32_t* addrlen) {
  (void)sockfd; (void)buf; (void)len; (void)flags; (void)src_addr; (void)addrlen;
  fprintf(stderr, "[Yo] Error: async recvfrom not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  (void)sockfd; (void)how;
  fprintf(stderr, "[Yo] Error: async shutdown not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 const void* optval, uint32_t optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async setsockopt not supported without liburing\n");
  abort();
  return NULL;
}

static inline void* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname,
                                                 void* optval, uint32_t* optlen) {
  (void)sockfd; (void)level; (void)optname; (void)optval; (void)optlen;
  fprintf(stderr, "[Yo] Error: async getsockopt not supported without liburing\n");
  abort();
  return NULL;
}

static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getsockname(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getpeername(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     const void* optval, uint32_t optlen) {
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     void* optval, uint32_t* optlen) {
  socklen_t len = (socklen_t)(*optlen);
  int result = getsockopt(sockfd, level, optname, optval, &len);
  if (result < 0) {
    return -errno;
  }
  *optlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  int result = socketpair(domain, sock_type, protocol, (int*)sv);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  struct timespec ts;
  int result = clock_gettime((clockid_t)clock_id, &ts);
  if (result < 0) {
    return -errno;
  }
  *sec = (int64_t)ts.tv_sec;
  *nsec = (int64_t)ts.tv_nsec;
  return 0;
}

static int32_t __yo_sync_uname(void* buf) {
  int result = uname((struct utsname*)buf);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_gethostname(char* name, size_t len) {
  int result = gethostname(name, len);
  if (result < 0) {
    return -errno;
  }
  if (len > 0) {
    name[len - 1] = ' ';
  }
  return 0;
}

static int32_t __yo_sync_umask(int32_t mask) {
  mode_t prev = umask((mode_t)mask);
  return (int32_t)prev;
}

static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\n");
  return -1;
}

static void __yo_file_close(int32_t fd) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\n");
}

static int64_t __yo_file_size(int32_t fd) {
  fprintf(stderr, "[Yo] Error: file operations not supported without liburing\n");
  return -1;
}

// Sync operations work without liburing (pure POSIX calls)
static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = pipe((int*)pipefd);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = dup2(oldfd, newfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = readv(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = writev(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pread(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pwrite(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static size_t __yo_iovec_size(void) {
  return sizeof(struct iovec);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  struct iovec* vec = (struct iovec*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  int result = posix_fadvise(fd, (off_t)offset, (off_t)len, advice);
  return (result == 0) ? 0 : -result;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  int result = madvise((void*)addr, length, advice);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  int result = fchmod(fd, (mode_t)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  int result = fchmodat(dirfd, path, (mode_t)mode, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result = readlinkat(dirfd, path, buf, bufsize);
  return (result < 0) ? -errno : (int32_t)result;
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
#include <sys/utsname.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <sys/uio.h>
#include <time.h>
#include <errno.h>
#include <pthread.h>

// Global dispatch queue for I/O completions
static dispatch_queue_t __yo_io_queue = NULL;
// __yo_io_initialized is defined in runtime-core
static _Atomic size_t __yo_pending_io_count = 0;

// Semaphore for blocking wait
static dispatch_semaphore_t __yo_io_semaphore = NULL;

// Cross-thread continuation queue (dispatch callbacks run on GCD threads)
typedef struct yo_io_continuation_t {
  void (*resume_fn)(void*);
  void* state_machine;
  struct yo_io_continuation_t* next;
} yo_io_continuation_t;

static pthread_mutex_t __yo_io_ready_mutex = PTHREAD_MUTEX_INITIALIZER;
static yo_io_continuation_t* __yo_io_ready_head = NULL;
static yo_io_continuation_t* __yo_io_ready_tail = NULL;

// Initialize dispatch_io subsystem
static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  
  // Create a serial queue for I/O completions to ensure thread safety
  __yo_io_queue = dispatch_queue_create("yo.io.completion", DISPATCH_QUEUE_SERIAL);
  __yo_io_semaphore = dispatch_semaphore_create(0);
  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] dispatch_io initialized\n");
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
  ASYNC_DEBUG("[IO] dispatch_io cleaned up\n");
}

// Check if there are pending I/O operations
static inline bool __yo_has_pending_io(void) {
  return atomic_load(&__yo_pending_io_count) > 0 || __yo_active_watch_count > 0;
}

// Forward declaration for poll/fs_event tick (defined in runtime-io-common)
static int __yo_poll_and_fs_event_tick(void);

// Process completions - on macOS, GCD handles this automatically via callback
// This function processes any completions that have been queued
static int __yo_io_poll(void) {
  // dispatch_io delivers completions on GCD threads.
  // Drain cross-thread ready continuations and enqueue to event-loop thread.
  yo_io_continuation_t* local_head = NULL;
  yo_io_continuation_t* local_tail = NULL;

  pthread_mutex_lock(&__yo_io_ready_mutex);
  local_head = __yo_io_ready_head;
  local_tail = __yo_io_ready_tail;
  __yo_io_ready_head = NULL;
  __yo_io_ready_tail = NULL;
  pthread_mutex_unlock(&__yo_io_ready_mutex);

  int count = 0;
  yo_io_continuation_t* node = local_head;
  while (node) {
    yo_io_continuation_t* next = node->next;
    yo_async_spawn_task(node->resume_fn, node->state_machine);
    __yo_free(node);
    count++;
    node = next;
  }

  if (count > 0) {
    ASYNC_DEBUG("[IO] Polled %d completions from GCD threads\n", count);
  }
  
  // Also tick poll/fs_event handles
  count += __yo_poll_and_fs_event_tick();
  
  return count;
}

// Wait for at least one I/O completion
static int __yo_io_wait(void) {
  if (atomic_load(&__yo_pending_io_count) == 0 && __yo_active_watch_count > 0) {
    // Only watches pending, use short sleep then tick
    dispatch_time_t timeout = dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_MSEC);
    dispatch_semaphore_wait(__yo_io_semaphore, timeout);
    return __yo_poll_and_fs_event_tick();
  }
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
  
  ASYNC_DEBUG("[IO] Waking continuation: cont_fn=%p, cont_sm=%p, result=%d\n",
              (void*)cont_fn, cont_sm, future->result);
  
  if (cont_fn && cont_sm) {
    yo_io_continuation_t* node = (yo_io_continuation_t*)__yo_malloc(sizeof(yo_io_continuation_t));
    node->resume_fn = cont_fn;
    node->state_machine = cont_sm;
    node->next = NULL;

    pthread_mutex_lock(&__yo_io_ready_mutex);
    if (__yo_io_ready_tail) {
      __yo_io_ready_tail->next = node;
      __yo_io_ready_tail = node;
    } else {
      __yo_io_ready_head = node;
      __yo_io_ready_tail = node;
    }
    pthread_mutex_unlock(&__yo_io_ready_mutex);
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
  
  // Use random I/O only for seekable regular/block files.
  // Pipes/sockets/ttys must use stream mode or writes/reads fail with ESPIPE.
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)dup(fd);
  if (dispatch_fd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to dup fd for read: fd=%d errno=%d\n", fd, errno);
    return future;
  }
  struct stat st;
  bool use_random = false;
  if (fstat(fd, &st) == 0) {
    use_random = S_ISREG(st.st_mode) || S_ISBLK(st.st_mode);
  }
  dispatch_io_type_t io_type = use_random ? DISPATCH_IO_RANDOM : DISPATCH_IO_STREAM;
  
  dispatch_io_t channel = dispatch_io_create(io_type, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\n", error);
    }
  });
  
  if (!channel) {
    close((int)dispatch_fd);
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to create dispatch_io channel: %d\n", errno);
    return future;
  }

  // Ensure callbacks deliver data promptly
  dispatch_io_set_low_water(channel, 1);
  dispatch_io_set_high_water(channel, (size_t)size);
  
  // Capture buffer pointer for the block
  void* buf = buffer;
  yo_io_future_t* fut = future;
  uint32_t sz = size;
  __block size_t total = 0;
  __block bool completed = false;
  off_t read_offset = use_random ? (off_t)offset : 0;
  
  dispatch_io_read(channel, read_offset, (size_t)size, __yo_io_queue,
    ^(bool done, dispatch_data_t data, int error) {
      if (completed) {
        return;
      }
      if (error) {
        fut->result = -error;
        if (done || !use_random) {
          completed = true;
          dispatch_io_close(channel, DISPATCH_IO_STOP);
          __yo_io_wake_continuation(fut);
        }
        return;
      }
      
      if (data) {
        // Copy data to buffer (respect region offsets)
        dispatch_data_apply(data, ^bool(dispatch_data_t region, size_t region_offset, const void* region_buffer, size_t region_size) {
          (void)region;
          size_t to_copy = region_size;
          if (region_offset >= sz) {
            return false;
          }
          if (region_offset + to_copy > sz) {
            to_copy = sz - region_offset;
          }
          if (to_copy > 0) {
            memcpy((char*)buf + region_offset, region_buffer, to_copy);
            size_t end = region_offset + to_copy;
            if (end > total) {
              total = end;
            }
          }
          return true;
        });
      }

      // For stream descriptors (pipes/sockets/ttys), complete as soon as any data arrives,
      // matching read(2) semantics for "up to size" bytes.
      if (!use_random && total > 0) {
        completed = true;
        fut->result = (int32_t)total;
        dispatch_io_close(channel, DISPATCH_IO_STOP);
        ASYNC_DEBUG("[IO] Stream read completed: %d bytes\n", fut->result);
        __yo_io_wake_continuation(fut);
        return;
      }
      
      if (done) {
        completed = true;
        fut->result = (int32_t)total;
        dispatch_io_close(channel, 0);
        ASYNC_DEBUG("[IO] Read completed: %d bytes\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  ASYNC_DEBUG("[IO] Started async read: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\n",
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
  
  // For O_APPEND fds, dispatch_io with DISPATCH_IO_RANDOM uses pwrite() which
  // ignores O_APPEND. Fall back to synchronous write() which respects it.
  int fl = fcntl(fd, F_GETFL);
  if (fl != -1 && (fl & O_APPEND)) {
    ssize_t written = write(fd, buffer, size);
    if (written < 0) {
      future->result = -errno;
    } else {
      future->result = (int32_t)written;
    }
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] Synchronous append write: fd=%d result=%d\n", fd, future->result);
    return future;
  }
  
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  dispatch_fd_t dispatch_fd = (dispatch_fd_t)dup(fd);
  if (dispatch_fd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    ASYNC_DEBUG("[IO] Failed to dup fd for write: fd=%d errno=%d\n", fd, errno);
    return future;
  }
  struct stat st;
  bool use_random = false;
  if (fstat(fd, &st) == 0) {
    use_random = S_ISREG(st.st_mode) || S_ISBLK(st.st_mode);
  }
  dispatch_io_type_t io_type = use_random ? DISPATCH_IO_RANDOM : DISPATCH_IO_STREAM;
  
  dispatch_io_t channel = dispatch_io_create(io_type, dispatch_fd, __yo_io_queue, ^(int error) {
    if (error) {
      ASYNC_DEBUG("[IO] Channel cleanup error: %d\n", error);
    }
  });
  
  if (!channel) {
    close((int)dispatch_fd);
    future->result = -errno;
    atomic_store(&future->state, -1);
    atomic_fetch_sub(&__yo_pending_io_count, 1);
    return future;
  }
  
  // Create dispatch_data from buffer
  dispatch_data_t data = dispatch_data_create(buffer, size, __yo_io_queue, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
  
  yo_io_future_t* fut = future;
  off_t write_offset = use_random ? (off_t)offset : 0;
  
  dispatch_io_write(channel, write_offset, data, __yo_io_queue,
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
        ASYNC_DEBUG("[IO] Write completed: %d bytes\n", fut->result);
        __yo_io_wake_continuation(fut);
      }
    });
  
  // dispatch_data is retained by the write operation
  dispatch_release(data);
  
  ASYNC_DEBUG("[IO] Started async write: fd=%d buffer=%p size=%u offset=%llu (pending=%zu)\n",
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
  
  ASYNC_DEBUG("[IO] openat completed: path=%s result=%d\n", path, future->result);
  
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
  
  ASYNC_DEBUG("[IO] close completed: fd=%d result=%d\n", fd, future->result);
  
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
  if (flags & AT_SYMLINK_NOFOLLOW) {
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
  
  ASYNC_DEBUG("[IO] stat completed: path=%s result=%d\n", path, future->result);
  
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
  
  ASYNC_DEBUG("[IO] mkdirat completed: path=%s result=%d\n", path, future->result);
  
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
    if (flags & 0x80) {  // AT_REMOVEDIR (macOS value)
      result = rmdir(path);
    } else {
      result = unlink(path);
    }
  } else {
    result = unlinkat(dirfd, path, flags);
  }
  
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] unlinkat completed: path=%s result=%d\n", path, future->result);
  
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
  
  ASYNC_DEBUG("[IO] renameat completed: %s -> %s result=%d\n", oldpath, newpath, future->result);
  
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
  
  ASYNC_DEBUG("[IO] symlinkat completed: %s -> %s result=%d\n", target, linkpath, future->result);
  
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
  
  ASYNC_DEBUG("[IO] linkat completed: %s -> %s result=%d\n", oldpath, newpath, future->result);
  
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
  
  ASYNC_DEBUG("[IO] fsync completed: fd=%d result=%d\n", fd, future->result);
  
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
  
  ASYNC_DEBUG("[IO] ftruncate completed: fd=%d length=%lld result=%d\n",
              fd, (long long)length, future->result);
  
  return future;
}

// ============================================================================
// Synchronous FD Operations (macOS) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = pipe((int*)pipefd);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = dup2(oldfd, newfd);
  return (result < 0) ? -errno : result;
}

static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  off_t result = lseek(fd, (off_t)offset, whence);
  return (result < 0) ? (int64_t)(-errno) : (int64_t)result;
}

static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  if (offset < 0 || length < 0) return -EINVAL;

  uint64_t target_u = (uint64_t)offset + (uint64_t)length;
  if (target_u > 0x7FFFFFFFFFFFFFFFULL) return -EINVAL;
  off_t target = (off_t)target_u;
  if ((uint64_t)target != target_u) return -EINVAL;

  fstore_t store;
  memset(&store, 0, sizeof(store));
  store.fst_flags = F_ALLOCATECONTIG;
  store.fst_posmode = F_VOLPOSMODE;
  store.fst_offset = (off_t)offset;
  store.fst_length = (off_t)length;

  int result = fcntl(fd, F_PREALLOCATE, &store);
  if (result < 0) {
    store.fst_flags = F_ALLOCATEALL;
    result = fcntl(fd, F_PREALLOCATE, &store);
  }
  if (result < 0) {
    int alloc_errno = errno;

    // Some filesystems may not support F_PREALLOCATE. Keep a best-effort
    // fallocate behavior for basic allocation modes.
    if (alloc_errno == ENOTSUP || alloc_errno == EOPNOTSUPP || alloc_errno == ENOSYS || alloc_errno == EINVAL) {
      // FALLOC_FL_KEEP_SIZE = 0x01
      if ((mode & 0x01) != 0) {
        return 0;
      }
      if (ftruncate(fd, target) < 0) return -errno;
      return 0;
    }

    return -alloc_errno;
  }

  // FALLOC_FL_KEEP_SIZE = 0x01
  if ((mode & 0x01) == 0) {
    struct stat st;
    if (fstat(fd, &st) < 0) return -errno;
    if (st.st_size < target) {
      if (ftruncate(fd, target) < 0) return -errno;
    }
  }

  return 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  int result = fcntl(fd, F_GETFL, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFL, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  int result = fcntl(fd, F_GETFD, 0);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) {
  int result = fcntl(fd, F_SETFD, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_flock(int32_t fd, int32_t operation) {
  int result = flock(fd, operation);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = readv(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  ssize_t result = writev(fd, (const struct iovec*)iov, (int)iovcnt);
  return (result < 0) ? -errno : (int32_t)result;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pread(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  struct iovec* vec = (struct iovec*)iov;
  ssize_t total = 0;
  off_t current = (off_t)offset;

  for (int32_t i = 0; i < iovcnt; i++) {
    if (vec[i].iov_len == 0) continue;
    ssize_t n = pwrite(fd, vec[i].iov_base, vec[i].iov_len, current);
    if (n < 0) {
      return (total > 0) ? (int32_t)total : -errno;
    }
    total += n;
    if ((size_t)n < vec[i].iov_len) {
      break;
    }
    current += (off_t)n;
  }

  return (int32_t)total;
}

static size_t __yo_iovec_size(void) {
  return sizeof(struct iovec);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  struct iovec* vec = (struct iovec*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  (void)fd;
  (void)offset;
  (void)len;
  (void)advice;
  // No direct equivalent on macOS; treat as advisory no-op.
  return 0;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  int result = madvise((void*)addr, length, advice);
  return (result < 0) ? -errno : 0;
}

static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  void* result = mmap((void*)addr, length, prot, flags, fd, (off_t)offset);
  if (result == MAP_FAILED) {
    return (uint8_t*)(intptr_t)(-errno);
  }
  return (uint8_t*)result;
}

static bool __yo_sync_mmap_is_error(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  return (value < 0) && (value >= -65535);
}

static int32_t __yo_sync_mmap_errno(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  if ((value < 0) && (value >= -65535)) {
    return (int32_t)(-value);
  }
  return 0;
}

static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) {
  int result = munmap((void*)addr, length);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) {
  int result = mprotect((void*)addr, length, prot);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) {
  int result = msync((void*)addr, length, flags);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  int result = fchmod(fd, (mode_t)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  int result;
  if (dirfd == -100) {
    result = chmod(path, (mode_t)mode);
  } else {
    result = fchmodat(dirfd, path, (mode_t)mode, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  int result = fchown(fd, (uid_t)uid, (gid_t)gid);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  int result;
  if (dirfd == -100) {
    if (flags & AT_SYMLINK_NOFOLLOW) {
      result = lchown(path, (uid_t)uid, (gid_t)gid);
    } else {
      result = chown(path, (uid_t)uid, (gid_t)gid);
    }
  } else {
    result = fchownat(dirfd, path, (uid_t)uid, (gid_t)gid, flags);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  ssize_t result;
  if (dirfd == -100) {
    result = readlink(path, buf, bufsize);
  } else {
    result = readlinkat(dirfd, path, buf, bufsize);
  }
  return (result < 0) ? -errno : (int32_t)result;
}

// ============================================================================
// Socket Operations (macOS)
// ============================================================================
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/un.h>

// Async socket - create socket (non-blocking for async dispatch_source operations)
static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int result = socket(domain, type, protocol);
  if (result >= 0) {
    int flags = fcntl(result, F_GETFL, 0);
    if (flags >= 0) fcntl(result, F_SETFL, flags | O_NONBLOCK);
  }
  future->result = (result < 0) ? -errno : result;
  atomic_init(&future->state, -1);
  
  ASYNC_DEBUG("[IO] socket completed: domain=%d type=%d protocol=%d result=%d\n",
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
  
  ASYNC_DEBUG("[IO] bind completed: sockfd=%d result=%d\n", sockfd, future->result);
  
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
  
  ASYNC_DEBUG("[IO] listen completed: sockfd=%d backlog=%d result=%d\n", sockfd, backlog, future->result);
  
  return future;
}

// Async accept - accept incoming connection using dispatch_source for true async
static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking accept first
  int result = accept(sockfd, (struct sockaddr*)addr, (socklen_t*)addrlen);
  if (result >= 0) {
    // Set accepted socket to non-blocking too
    int fl = fcntl(result, F_GETFL, 0);
    if (fl >= 0) fcntl(result, F_SETFL, fl | O_NONBLOCK);
    future->result = result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] accept completed immediately: sockfd=%d result=%d\n", sockfd, result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] accept failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // Socket not ready — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* a = addr;
  uint32_t* al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    int r = accept(sfd, (struct sockaddr*)a, (socklen_t*)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    if (r >= 0) {
      int fl = fcntl(r, F_GETFL, 0);
      if (fl >= 0) fcntl(r, F_SETFL, fl | O_NONBLOCK);
      fut->result = r;
    } else {
      fut->result = -errno;
    }
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] accept completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] accept waiting via dispatch_source: sockfd=%d\n", sockfd);
  return future;
}

// Async connect - connect to remote address using dispatch_source for true async
static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking connect
  int result = connect(sockfd, (const struct sockaddr*)addr, (socklen_t)addrlen);
  if (result == 0) {
    future->result = 0;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] connect completed immediately: sockfd=%d\n", sockfd);
    return future;
  }
  
  if (errno != EINPROGRESS) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] connect failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // Connection in progress — wait for writable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    int so_error = 0;
    socklen_t len = sizeof(so_error);
    getsockopt(sfd, SOL_SOCKET, SO_ERROR, &so_error, &len);
    fut->result = (so_error == 0) ? 0 : -so_error;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] connect completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] connect waiting via dispatch_source: sockfd=%d\n", sockfd);
  return future;
}

// Async send - send data on socket using dispatch_source for true async
static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking send first
  ssize_t result = send(sockfd, buf, len, flags);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] send completed immediately: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] send failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // Socket not writable — wait via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  const void* b = buf;
  size_t l = len;
  int32_t f = flags;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = send(sfd, b, l, f);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] send completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] send waiting via dispatch_source: sockfd=%d\n", sockfd);
  return future;
}

// Async recv - receive data from socket using dispatch_source for true async
static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking recv first
  ssize_t result = recv(sockfd, buf, len, flags);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recv completed immediately: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recv failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // No data available — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* b = buf;
  size_t l = len;
  int32_t f = flags;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = recv(sfd, b, l, f);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] recv completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] recv waiting via dispatch_source: sockfd=%d\n", sockfd);
  return future;
}

// Async sendto - send data to specific address (UDP) using dispatch_source for true async
static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking sendto first
  ssize_t result = sendto(sockfd, buf, len, flags, (const struct sockaddr*)dest_addr, (socklen_t)addrlen);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] sendto completed immediately: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] sendto failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // Socket not writable — wait via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  const void* b = buf;
  size_t l = len;
  int32_t f = flags;
  const void* da = dest_addr;
  uint32_t al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_WRITE, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = sendto(sfd, b, l, f, (const struct sockaddr*)da, (socklen_t)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] sendto completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] sendto waiting via dispatch_source: sockfd=%d\n", sockfd);
  return future;
}

// Async recvfrom - receive data with source address (UDP) using dispatch_source for true async
static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();
  
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  // Try non-blocking recvfrom first
  ssize_t result = recvfrom(sockfd, buf, len, flags, (struct sockaddr*)src_addr, (socklen_t*)addrlen);
  if (result >= 0) {
    future->result = (int32_t)result;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recvfrom completed immediately: sockfd=%d len=%zu result=%d\n", sockfd, len, future->result);
    return future;
  }
  
  if (errno != EAGAIN && errno != EWOULDBLOCK) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    ASYNC_DEBUG("[IO] recvfrom failed: sockfd=%d errno=%d\n", sockfd, errno);
    return future;
  }
  
  // No data available — wait for readable via dispatch_source
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_fetch_add(&__yo_pending_io_count, 1);
  
  yo_io_future_t* fut = future;
  int32_t sfd = sockfd;
  void* b = buf;
  size_t l = len;
  int32_t f = flags;
  void* sa = src_addr;
  uint32_t* al = addrlen;
  
  dispatch_source_t source = dispatch_source_create(
    DISPATCH_SOURCE_TYPE_READ, (uintptr_t)sockfd, 0, __yo_io_queue);
  
  dispatch_source_set_event_handler(source, ^{
    ssize_t r = recvfrom(sfd, b, l, f, (struct sockaddr*)sa, (socklen_t*)al);
    if (r < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      return; // Spurious wake, wait for next event
    }
    fut->result = (r >= 0) ? (int32_t)r : -errno;
    dispatch_source_cancel(source);
    __yo_io_wake_continuation(fut);
    ASYNC_DEBUG("[IO] recvfrom completed via dispatch: sockfd=%d result=%d\n", sfd, fut->result);
  });
  
  dispatch_source_set_cancel_handler(source, ^{
    dispatch_release(source);
  });
  
  dispatch_resume(source);
  
  ASYNC_DEBUG("[IO] recvfrom waiting via dispatch_source: sockfd=%d\n", sockfd);
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
  
  ASYNC_DEBUG("[IO] shutdown completed: sockfd=%d how=%d result=%d\n", sockfd, how, future->result);
  
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
  
  ASYNC_DEBUG("[IO] setsockopt completed: sockfd=%d level=%d optname=%d result=%d\n",
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
  
  ASYNC_DEBUG("[IO] getsockopt completed: sockfd=%d level=%d optname=%d result=%d\n",
              sockfd, level, optname, future->result);
  
  return future;
}

// Sync getsockname - get local socket address
static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getsockname(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync getpeername - get remote peer address
static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  socklen_t len = (socklen_t)(*addrlen);
  int result = getpeername(sockfd, (struct sockaddr*)addr, &len);
  if (result < 0) {
    return -errno;
  }
  *addrlen = (uint32_t)len;
  return 0;
}

// Sync setsockopt - set socket option value
static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     const void* optval, uint32_t optlen) {
  int result = setsockopt(sockfd, level, optname, optval, (socklen_t)optlen);
  return (result < 0) ? -errno : 0;
}

// Sync getsockopt - get socket option value
static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname,
                                     void* optval, uint32_t* optlen) {
  socklen_t len = (socklen_t)(*optlen);
  int result = getsockopt(sockfd, level, optname, optval, &len);
  if (result < 0) {
    return -errno;
  }
  *optlen = (uint32_t)len;
  return 0;
}

// Sync socketpair - create a connected socket pair
static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  int result = socketpair(domain, sock_type, protocol, (int*)sv);
  return (result < 0) ? -errno : 0;
}

// Sync clock_gettime - read current clock time
static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  struct timespec ts;
  int result = clock_gettime((clockid_t)clock_id, &ts);
  if (result < 0) {
    return -errno;
  }
  *sec = (int64_t)ts.tv_sec;
  *nsec = (int64_t)ts.tv_nsec;
  return 0;
}

// Sync uname - system identification
static int32_t __yo_sync_uname(void* buf) {
  int result = uname((struct utsname*)buf);
  return (result < 0) ? -errno : 0;
}

// Sync gethostname - read host name
static int32_t __yo_sync_gethostname(char* name, size_t len) {
  int result = gethostname(name, len);
  if (result < 0) {
    return -errno;
  }
  if (len > 0) {
    name[len - 1] = ' ';
  }
  return 0;
}

// Sync umask - set process file mode creation mask
static int32_t __yo_sync_umask(int32_t mask) {
  mode_t prev = umask((mode_t)mask);
  return (int32_t)prev;
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
  ASYNC_DEBUG("[IO] open(%s, 0x%x, 0%o) = %d\n", path, flags, mode, result);
  return result;
}

static void __yo_file_close(int32_t fd) {
  ASYNC_DEBUG("[IO] close(%d)\n", fd);
  close(fd);
}

static int64_t __yo_file_size(int32_t fd) {
  struct stat st;
  if (fstat(fd, &st) < 0) {
    int result = -errno;
    ASYNC_DEBUG("[IO] fstat(%d) failed: %d\n", fd, result);
    return result;
  }
  ASYNC_DEBUG("[IO] fstat(%d) = %lld bytes\n", fd, (long long)st.st_size);
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
// Async I/O Runtime (Windows - IOCP)
// ============================================================================

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <direct.h>
#include <stdlib.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <string.h>


#ifndef DT_UNKNOWN
#define DT_UNKNOWN 0
#endif
#ifndef DT_DIR
#define DT_DIR 4
#endif
#ifndef DT_REG
#define DT_REG 8
#endif
#ifndef DT_LNK
#define DT_LNK 10
#endif
#ifndef DT_FIFO
#define DT_FIFO 1
#endif
#ifndef DT_CHR
#define DT_CHR 2
#endif
#ifndef DT_BLK
#define DT_BLK 6
#endif
#ifndef DT_SOCK
#define DT_SOCK 12
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0x200000
#endif
#ifndef O_NONBLOCK
#define O_NONBLOCK 0x0004
#endif
#ifndef FD_CLOEXEC
#define FD_CLOEXEC 1
#endif
#ifndef PROT_NONE
#define PROT_NONE 0
#endif
#ifndef PROT_READ
#define PROT_READ 1
#endif
#ifndef PROT_WRITE
#define PROT_WRITE 2
#endif
#ifndef PROT_EXEC
#define PROT_EXEC 4
#endif
#ifndef MAP_SHARED
#define MAP_SHARED 1
#endif
#ifndef MAP_PRIVATE
#define MAP_PRIVATE 2
#endif
#ifndef MAP_ANONYMOUS
#define MAP_ANONYMOUS 0x20
#endif
#ifndef MS_ASYNC
#define MS_ASYNC 1
#endif
#ifndef MS_INVALIDATE
#define MS_INVALIDATE 2
#endif
#ifndef MS_SYNC
#define MS_SYNC 4
#endif
#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif
#ifndef AT_REMOVEDIR
#define AT_REMOVEDIR 0x200
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#define AT_SYMLINK_NOFOLLOW 0x100
#endif
#ifndef AF_UNIX
#define AF_UNIX 1
#endif
#ifndef UNIX_PATH_MAX
#define UNIX_PATH_MAX 108
#endif
typedef struct __yo_sockaddr_un {
  ADDRESS_FAMILY sun_family;
  char sun_path[UNIX_PATH_MAX];
} __yo_sockaddr_un_t;
#ifndef SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
#define SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE 0x2
#endif
#ifndef PROCESS_QUERY_LIMITED_INFORMATION
#define PROCESS_QUERY_LIMITED_INFORMATION 0x1000
#endif

// __yo_io_initialized is defined in runtime-core
static _Atomic size_t __yo_pending_io_count = 0;
static HANDLE __yo_io_iocp = NULL;
static CRITICAL_SECTION __yo_dir_state_mutex;

typedef struct yo_win_timer_entry_t {
  uint64_t due_ms;
  yo_io_future_t* future;
  struct yo_win_timer_entry_t* next;
} yo_win_timer_entry_t;

static yo_win_timer_entry_t* __yo_win_timer_head = NULL;

typedef struct {
  OVERLAPPED overlapped;
  yo_io_future_t* future;
  HANDLE handle;
  bool is_socket;
  SOCKET sock;
  WSABUF wsabuf;
  DWORD sock_flags;
} yo_win_overlapped_t;

typedef struct {
  void* iov_base;
  size_t iov_len;
} yo_iovec_t;

static bool __yo_is_at_fdcwd(int32_t dirfd) {
  return (dirfd == -100 || dirfd == -2);
}

static int __yo_win_last_error_to_errno(void) {
  DWORD err = GetLastError();
  switch (err) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
    case ERROR_INVALID_NAME:
      return ENOENT;
    case ERROR_ACCESS_DENIED:
    case ERROR_SHARING_VIOLATION:
    case ERROR_LOCK_VIOLATION:
      return EACCES;
    case ERROR_FILE_EXISTS:
    case ERROR_ALREADY_EXISTS:
      return EEXIST;
    case ERROR_NOT_ENOUGH_MEMORY:
    case ERROR_OUTOFMEMORY:
      return ENOMEM;
    case ERROR_INVALID_HANDLE:
      return EBADF;
    case ERROR_INVALID_PARAMETER:
    case ERROR_INVALID_FLAGS:
      return EINVAL;
    case ERROR_BROKEN_PIPE:
    case ERROR_NO_DATA:
      return EPIPE;
    case ERROR_DISK_FULL:
      return ENOSPC;
    case ERROR_DIR_NOT_EMPTY:
      return ENOTEMPTY;
    case ERROR_NOT_SUPPORTED:
    case ERROR_CALL_NOT_IMPLEMENTED:
      return ENOSYS;
    case ERROR_DIRECTORY:
      return ENOTDIR;
    case ERROR_TOO_MANY_OPEN_FILES:
      return EMFILE;
    case ERROR_PRIVILEGE_NOT_HELD:
      return EPERM;
    default:
      return (int)err;
  }
}

static int __yo_win_error_to_errno(DWORD err) {
  SetLastError(err);
  return __yo_win_last_error_to_errno();
}

static wchar_t* __yo_win_utf8_to_wide(const char* str) {
  if (!str) return NULL;
  int len = MultiByteToWideChar(CP_UTF8, 0, str, -1, NULL, 0);
  if (len <= 0) return NULL;
  wchar_t* buf = (wchar_t*)__yo_malloc((size_t)len * sizeof(wchar_t));
  if (!buf) return NULL;
  if (!MultiByteToWideChar(CP_UTF8, 0, str, -1, buf, len)) {
    __yo_free(buf);
    return NULL;
  }
  return buf;
}

static int __yo_win_wide_to_utf8(const wchar_t* wstr, char* out, size_t out_size) {
  if (!wstr || !out || out_size == 0) return -EINVAL;
  int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, out, (int)out_size, NULL, NULL);
  if (len <= 0) {
    return -__yo_win_last_error_to_errno();
  }
  return len - 1;
}

static bool __yo_win_is_socket_fd(int32_t fd) {
  SOCKET s = (SOCKET)(uintptr_t)(uint32_t)fd;
  int sock_type = 0;
  int optlen = (int)sizeof(sock_type);
  return getsockopt(s, SOL_SOCKET, SO_TYPE, (char*)&sock_type, &optlen) == 0;
}

static DWORD __yo_win_mmap_page_protect(int32_t prot, int32_t flags, bool anonymous_map) {
  bool can_read = ((prot & PROT_READ) != 0);
  bool can_write = ((prot & PROT_WRITE) != 0);
  bool can_exec = ((prot & PROT_EXEC) != 0);
  bool private_map = ((flags & MAP_PRIVATE) != 0);

  if (can_exec) {
    if (can_write) {
      if (private_map && !anonymous_map) return PAGE_EXECUTE_WRITECOPY;
      return PAGE_EXECUTE_READWRITE;
    }
    if (can_read) return PAGE_EXECUTE_READ;
    return PAGE_EXECUTE;
  }

  if (can_write) {
    if (private_map && !anonymous_map) return PAGE_WRITECOPY;
    return PAGE_READWRITE;
  }
  if (can_read) return PAGE_READONLY;
  return PAGE_NOACCESS;
}

static DWORD __yo_win_mmap_view_access(int32_t prot, int32_t flags, bool anonymous_map) {
  bool private_map = ((flags & MAP_PRIVATE) != 0);
  bool can_read = ((prot & PROT_READ) != 0);
  bool can_write = ((prot & PROT_WRITE) != 0);
  bool can_exec = ((prot & PROT_EXEC) != 0);

  if (private_map && !anonymous_map) {
    DWORD access = FILE_MAP_COPY;
#ifdef FILE_MAP_EXECUTE
    if (can_exec) access = (access | FILE_MAP_EXECUTE);
#endif
    return access;
  }

  DWORD access = 0;
  if (can_read || can_write) access = (access | FILE_MAP_READ);
  if (can_write) access = (access | FILE_MAP_WRITE);
#ifdef FILE_MAP_EXECUTE
  if (can_exec) access = (access | FILE_MAP_EXECUTE);
#endif
  if (access == 0) access = FILE_MAP_READ;
  return access;
}

static void __yo_io_init(void) {
  if (__yo_io_initialized) return;
  InitializeCriticalSection(&__yo_dir_state_mutex);
  __yo_io_iocp = CreateIoCompletionPort(INVALID_HANDLE_VALUE, NULL, 0, 1);
  if (!__yo_io_iocp) {
    ASYNC_DEBUG("[IO] CreateIoCompletionPort failed: %lu\n", GetLastError());
  }

  WSADATA wsa;
  int wsa_result = WSAStartup(MAKEWORD(2, 2), &wsa);
  if (wsa_result != 0) {
    ASYNC_DEBUG("[IO] WSAStartup failed: %d\n", wsa_result);
  }

  __yo_io_initialized = true;
  ASYNC_DEBUG("[IO] Windows async runtime initialized\n");
}

static void __yo_io_cleanup(void) {
  if (!__yo_io_initialized) return;
  if (__yo_io_iocp) {
    CloseHandle(__yo_io_iocp);
    __yo_io_iocp = NULL;
  }
  while (__yo_win_timer_head) {
    yo_win_timer_entry_t* node = __yo_win_timer_head;
    __yo_win_timer_head = node->next;
    __yo_free(node);
  }
  DeleteCriticalSection(&__yo_dir_state_mutex);
  WSACleanup();
  __yo_io_initialized = false;
}

static bool __yo_win_associate_handle(HANDLE handle) {
  if (!__yo_io_iocp) return false;
  HANDLE res = CreateIoCompletionPort(handle, __yo_io_iocp, 0, 0);
  if (res != NULL) {
    SetFileCompletionNotificationModes(handle, FILE_SKIP_COMPLETION_PORT_ON_SUCCESS);
    return true;
  }
  return GetLastError() == ERROR_INVALID_PARAMETER;
}

static int __yo_poll_and_fs_event_tick(void);

static inline bool __yo_has_pending_io(void) {
  return atomic_load(&__yo_pending_io_count) > 0 || __yo_active_watch_count > 0;
}

static void __yo_io_wake_continuation(yo_io_future_t* future) {
  atomic_store_explicit(&future->state, -1, memory_order_release);

  void (*cont_fn)(void*) = atomic_load_explicit(&future->continuation_fn, memory_order_acquire);
  void* cont_sm = atomic_load_explicit(&future->continuation_sm, memory_order_acquire);

  if (cont_fn && cont_sm) {
    yo_async_spawn_task(cont_fn, cont_sm);
  }

  atomic_fetch_sub(&__yo_pending_io_count, 1);
}

static uint64_t __yo_win_now_ms(void) {
  return (uint64_t)GetTickCount64();
}

static void __yo_win_timer_add(yo_io_future_t* future, uint64_t milliseconds) {
  atomic_fetch_add(&__yo_pending_io_count, 1);

  yo_win_timer_entry_t* node = (yo_win_timer_entry_t*)__yo_malloc(sizeof(yo_win_timer_entry_t));
  if (!node) {
    future->result = -ENOMEM;
    __yo_io_wake_continuation(future);
    return;
  }

  uint64_t now_ms = __yo_win_now_ms();
  node->due_ms = now_ms + milliseconds;
  node->future = future;
  node->next = NULL;

  if (!__yo_win_timer_head || node->due_ms < __yo_win_timer_head->due_ms) {
    node->next = __yo_win_timer_head;
    __yo_win_timer_head = node;
    return;
  }

  yo_win_timer_entry_t* cur = __yo_win_timer_head;
  while (cur->next && cur->next->due_ms <= node->due_ms) {
    cur = cur->next;
  }
  node->next = cur->next;
  cur->next = node;
}

static int __yo_win_timer_process_due(uint64_t now_ms) {
  int fired = 0;
  while (__yo_win_timer_head && __yo_win_timer_head->due_ms <= now_ms) {
    yo_win_timer_entry_t* node = __yo_win_timer_head;
    __yo_win_timer_head = node->next;
    node->future->result = (int32_t)sizeof(uint64_t);
    __yo_io_wake_continuation(node->future);
    __yo_free(node);
    fired++;
  }
  return fired;
}

static DWORD __yo_win_timer_next_timeout(uint64_t now_ms) {
  if (!__yo_win_timer_head) return INFINITE;
  if (__yo_win_timer_head->due_ms <= now_ms) return 0;
  uint64_t delta = __yo_win_timer_head->due_ms - now_ms;
  if (delta > 0xFFFFFFFFULL) return 0xFFFFFFFFU;
  return (DWORD)delta;
}

static void __yo_win_process_completion(yo_win_overlapped_t* ov, DWORD bytes) {
  if (!ov) return;

  if (ov->is_socket) {
    DWORD flags = 0;
    DWORD transferred = bytes;
    BOOL ok = WSAGetOverlappedResult(ov->sock, &ov->overlapped, &transferred, FALSE, &flags);
    if (!ok) {
      ov->future->result = -(int32_t)WSAGetLastError();
    } else {
      ov->future->result = (int32_t)transferred;
    }
  } else {
    DWORD transferred = bytes;
    BOOL ok = GetOverlappedResult(ov->handle, &ov->overlapped, &transferred, FALSE);
    if (!ok) {
      DWORD err = GetLastError();
      if (err == ERROR_HANDLE_EOF) {
        ov->future->result = 0;
      } else {
        ov->future->result = -__yo_win_error_to_errno(err);
      }
    } else {
      ov->future->result = (int32_t)transferred;
    }
  }

  __yo_io_wake_continuation(ov->future);
  __yo_free(ov);
}

static int __yo_io_poll(void) {
  if (!__yo_io_iocp) return 0;

  OVERLAPPED_ENTRY entries[64];
  ULONG count = 0;
  BOOL ok = GetQueuedCompletionStatusEx(__yo_io_iocp, entries, 64, &count, 0, FALSE);
  if (!ok && GetLastError() == WAIT_TIMEOUT) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }
  if (!ok) {
    return __yo_win_timer_process_due(__yo_win_now_ms());
  }

  int processed = 0;
  for (ULONG i = 0; i < count; i++) {
    if (!entries[i].lpOverlapped) continue;
    __yo_win_process_completion((yo_win_overlapped_t*)entries[i].lpOverlapped,
                                entries[i].dwNumberOfBytesTransferred);
    processed++;
  }
  processed += __yo_win_timer_process_due(__yo_win_now_ms());
  processed += __yo_poll_and_fs_event_tick();
  return processed;
}

static int __yo_io_wait(void) {
  if (!__yo_io_iocp) return 0;
  if (atomic_load(&__yo_pending_io_count) == 0 && __yo_active_watch_count > 0) {
    Sleep(10);
    return __yo_poll_and_fs_event_tick();
  }
  if (atomic_load(&__yo_pending_io_count) == 0) return 0;

  DWORD bytes = 0;
  ULONG_PTR key = 0;
  OVERLAPPED* ov = NULL;
  DWORD timeout_ms = __yo_win_timer_next_timeout(__yo_win_now_ms());
  if (__yo_active_watch_count > 0 && (timeout_ms == INFINITE || timeout_ms > 50)) {
    timeout_ms = 50;
  }
  BOOL ok = GetQueuedCompletionStatus(__yo_io_iocp, &bytes, &key, &ov, timeout_ms);
  if (!ok && GetLastError() == WAIT_TIMEOUT) {
    return __yo_win_timer_process_due(__yo_win_now_ms()) + __yo_poll_and_fs_event_tick();
  }
  if (!ok) {
    return __yo_win_timer_process_due(__yo_win_now_ms()) + __yo_poll_and_fs_event_tick();
  }
  if (!ov) return __yo_poll_and_fs_event_tick();

  __yo_win_process_completion((yo_win_overlapped_t*)ov, bytes);
  return 1 + __yo_win_timer_process_due(__yo_win_now_ms()) + __yo_poll_and_fs_event_tick();
}

// ============================================================================
// File Operations (Windows)
// ============================================================================

// Track append-mode file descriptors (O_APPEND on Windows overlapped I/O
// doesn't work automatically — we must use _write which respects the CRT flag)
#define __YO_WIN_APPEND_FD_MAX 256
static int __yo_win_append_fds[__YO_WIN_APPEND_FD_MAX];
static int __yo_win_append_fd_count = 0;

static void __yo_win_fd_mark_append(int fd) {
  if (__yo_win_append_fd_count < __YO_WIN_APPEND_FD_MAX) {
    __yo_win_append_fds[__yo_win_append_fd_count++] = fd;
  }
}

static bool __yo_win_fd_is_append(int fd) {
  for (int i = 0; i < __yo_win_append_fd_count; i++) {
    if (__yo_win_append_fds[i] == fd) return true;
  }
  return false;
}

static void __yo_win_fd_unmark_append(int fd) {
  for (int i = 0; i < __yo_win_append_fd_count; i++) {
    if (__yo_win_append_fds[i] == fd) {
      __yo_win_append_fds[i] = __yo_win_append_fds[--__yo_win_append_fd_count];
      return;
    }
  }
}

// Forward declaration for dir state cleanup (defined later, used in close)
static void __yo_win_cleanup_dir_state(int32_t fd);

static yo_win_overlapped_t* __yo_win_alloc_overlapped(yo_io_future_t* future, HANDLE handle, uint64_t offset) {
  yo_win_overlapped_t* ov = (yo_win_overlapped_t*)__yo_malloc(sizeof(yo_win_overlapped_t));
  if (!ov) return NULL;
  memset(ov, 0, sizeof(yo_win_overlapped_t));
  ov->future = future;
  ov->handle = handle;
  ov->is_socket = false;
  ov->sock = INVALID_SOCKET;
  ov->overlapped.Offset = (DWORD)(offset & 0xFFFFFFFF);
  ov->overlapped.OffsetHigh = (DWORD)((offset >> 32) & 0xFFFFFFFF);
  return ov;
}

static DWORD __yo_win_access_flags(int32_t flags) {
  if ((flags & O_RDWR) == O_RDWR) return GENERIC_READ | GENERIC_WRITE;
  if (flags & O_WRONLY) return GENERIC_WRITE;
  return GENERIC_READ;
}

static DWORD __yo_win_creation_flags(int32_t flags) {
  if (flags & O_CREAT) {
    if (flags & O_EXCL) return CREATE_NEW;
    if (flags & O_TRUNC) return CREATE_ALWAYS;
    return OPEN_ALWAYS;
  }
  if (flags & O_TRUNC) return TRUNCATE_EXISTING;
  return OPEN_EXISTING;
}

static yo_io_future_t* __yo_async_read_start(int32_t fd, void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (fd < 0) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }

  DWORD handle_type = GetFileType(handle);
  if (handle_type == FILE_TYPE_PIPE || handle_type == FILE_TYPE_CHAR) {
    (void)offset;
    int result = _read(fd, buffer, (unsigned int)size);
    future->result = (result < 0) ? -errno : result;
    atomic_store(&future->state, -1);
    return future;
  }

  __yo_win_associate_handle(handle);

  yo_win_overlapped_t* ov = __yo_win_alloc_overlapped(future, handle, offset);
  if (!ov) {
    future->result = -ENOMEM;
    atomic_store(&future->state, -1);
    return future;
  }

  BOOL ok = ReadFile(handle, buffer, (DWORD)size, NULL, &ov->overlapped);
  if (ok) {
    DWORD bytes_transferred = 0;
    GetOverlappedResult(handle, &ov->overlapped, &bytes_transferred, FALSE);
    future->result = (int32_t)bytes_transferred;
    __yo_free(ov);
    atomic_store(&future->state, -1);
    return future;
  }
  DWORD err = GetLastError();
  if (err != ERROR_IO_PENDING) {
    __yo_free(ov);
    if (err == ERROR_HANDLE_EOF) {
      future->result = 0;
    } else {
      future->result = -__yo_win_error_to_errno(err);
    }
    atomic_store(&future->state, -1);
    return future;
  }

  atomic_fetch_add(&__yo_pending_io_count, 1);
  return future;
}

static yo_io_future_t* __yo_async_write_start(int32_t fd, const void* buffer, uint32_t size, uint64_t offset) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (fd < 0) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -EBADF;
    atomic_store(&future->state, -1);
    return future;
  }

  DWORD handle_type = GetFileType(handle);
  if (handle_type == FILE_TYPE_PIPE || handle_type == FILE_TYPE_CHAR) {
    (void)offset;
    int result = _write(fd, buffer, (unsigned int)size);
    future->result = (result < 0) ? -errno : result;
    atomic_store(&future->state, -1);
    return future;
  }

  // Check if file was opened with O_APPEND — overlapped I/O doesn't auto-append
  if (__yo_win_fd_is_append(fd)) {
    // Get file size and write at end
    LARGE_INTEGER fsize;
    if (GetFileSizeEx(handle, &fsize)) {
      offset = (uint64_t)fsize.QuadPart;
    }
  }

  __yo_win_associate_handle(handle);

  yo_win_overlapped_t* ov = __yo_win_alloc_overlapped(future, handle, offset);
  if (!ov) {
    future->result = -ENOMEM;
    atomic_store(&future->state, -1);
    return future;
  }

  BOOL ok = WriteFile(handle, buffer, (DWORD)size, NULL, &ov->overlapped);
  if (ok) {
    DWORD bytes_transferred = 0;
    GetOverlappedResult(handle, &ov->overlapped, &bytes_transferred, FALSE);
    future->result = (int32_t)bytes_transferred;
    __yo_free(ov);
    atomic_store(&future->state, -1);
    return future;
  }
  DWORD err = GetLastError();
  if (err != ERROR_IO_PENDING) {
    __yo_free(ov);
    future->result = -__yo_win_error_to_errno(err);
    atomic_store(&future->state, -1);
    return future;
  }

  atomic_fetch_add(&__yo_pending_io_count, 1);
  return future;
}

static yo_io_future_t* __yo_async_openat_start(int32_t dirfd, const char* path, int32_t flags, int32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD access = __yo_win_access_flags(flags);
  DWORD creation = __yo_win_creation_flags(flags);
  DWORD attrs = FILE_ATTRIBUTE_NORMAL;
  bool is_directory = (flags & O_DIRECTORY) != 0;
  if (is_directory) {
    attrs |= FILE_FLAG_BACKUP_SEMANTICS;
  } else {
    attrs |= FILE_FLAG_OVERLAPPED;
  }

  HANDLE handle = CreateFileW(wpath, access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, creation, attrs, NULL);
  __yo_free(wpath);

  if (handle == INVALID_HANDLE_VALUE) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  if (!is_directory) {
    if (!__yo_win_associate_handle(handle)) {
      CloseHandle(handle);
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }
  }

  int osfhandle_flags = _O_BINARY;
  if ((flags & O_RDWR) == 0 && (flags & O_WRONLY) == 0) {
    osfhandle_flags |= _O_RDONLY;
  }
  if (flags & O_APPEND) {
    osfhandle_flags |= _O_APPEND;
  }
  int fd = _open_osfhandle((intptr_t)handle, osfhandle_flags);
  if (fd < 0) {
    CloseHandle(handle);
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  if (flags & O_APPEND) {
    __yo_win_fd_mark_append(fd);
  }

  (void)mode;
  future->result = fd;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_close_start(int32_t fd) {
  __yo_io_init();

  __yo_win_fd_unmark_append(fd);
  __yo_win_cleanup_dir_state(fd);

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  SOCKET s = (SOCKET)(uintptr_t)(uint32_t)fd;
  int cs = closesocket(s);
  if (cs == 0) {
    future->result = 0;
  } else {
    DWORD wsa_err = WSAGetLastError();
    if (wsa_err == WSAENOTSOCK) {
      int result = _close(fd);
      future->result = (result < 0) ? -errno : 0;
    } else {
      future->result = -(int32_t)wsa_err;
    }
  }
  atomic_init(&future->state, -1);
  return future;
}

typedef struct {
  struct _stat64 stat;
  uint32_t atime_nsec;
  uint32_t mtime_nsec;
  uint32_t ctime_nsec;
  int64_t btime_sec;
  uint32_t btime_nsec;
  uint64_t file_index;
} yo_win_stat_t;

static void __yo_win_filetime_to_timespec(FILETIME ft, int64_t* sec, uint32_t* nsec) {
  ULONGLONG t = ((ULONGLONG)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
  *sec = (int64_t)(t / 10000000ULL) - 11644473600LL;
  *nsec = (uint32_t)((t % 10000000ULL) * 100ULL);
}

static yo_io_future_t* __yo_async_statx_start(int32_t dirfd, const char* path, int32_t flags, uint32_t mask, void* statxbuf) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = -1;
  if (__yo_is_at_fdcwd(dirfd)) {
    wchar_t* wpath = __yo_win_utf8_to_wide(path);
    if (!wpath) {
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }
    (void)mask;
    yo_win_stat_t* ws = (yo_win_stat_t*)statxbuf;
    memset(ws, 0, sizeof(yo_win_stat_t));

    // Check if we should not follow symlinks
    bool nofollow = (flags & AT_SYMLINK_NOFOLLOW) != 0;
    bool is_symlink = false;

    // Check for reparse point (symlink) before stat
    DWORD attrs = GetFileAttributesW(wpath);
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT)) {
      is_symlink = true;
    }

    result = _wstat64(wpath, &ws->stat);
    if (result == 0) {
      WIN32_FILE_ATTRIBUTE_DATA fad;
      if (GetFileAttributesExW(wpath, GetFileExInfoStandard, &fad)) {
        int64_t sec; uint32_t nsec;
        __yo_win_filetime_to_timespec(fad.ftLastAccessTime, &sec, &ws->atime_nsec);
        __yo_win_filetime_to_timespec(fad.ftLastWriteTime, &sec, &ws->mtime_nsec);
        __yo_win_filetime_to_timespec(fad.ftCreationTime, &ws->btime_sec, &ws->btime_nsec);
        ws->ctime_nsec = ws->mtime_nsec;
      }
      // If nofollow and it's a symlink, set mode to S_IFLNK
      if (nofollow && is_symlink) {
        ws->stat.st_mode = (ws->stat.st_mode & ~0170000) | 0120000; // S_IFLNK
      }
      // Get NTFS file index as inode equivalent
      DWORD share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
      DWORD f = FILE_FLAG_BACKUP_SEMANTICS; // needed to open directories
      if (nofollow) f |= FILE_FLAG_OPEN_REPARSE_POINT;
      HANDLE fh = CreateFileW(wpath, 0, share, NULL, OPEN_EXISTING, f, NULL);
      if (fh != INVALID_HANDLE_VALUE) {
        BY_HANDLE_FILE_INFORMATION info;
        if (GetFileInformationByHandle(fh, &info)) {
          ws->file_index = ((uint64_t)info.nFileIndexHigh << 32) | info.nFileIndexLow;
          ws->stat.st_nlink = (short)info.nNumberOfLinks;
        }
        CloseHandle(fh);
      }
    }
    __yo_free(wpath);
  } else {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_mkdirat_start(int32_t dirfd, const char* path, int32_t mode) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  (void)mode;
  int result = _wmkdir(wpath);
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_unlinkat_start(int32_t dirfd, const char* path, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(dirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result;
  if (flags & AT_REMOVEDIR) {
    result = _wrmdir(wpath);
  } else {
    result = _wunlink(wpath);
  }
  __yo_free(wpath);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_renameat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(olddirfd) || !__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wold = __yo_win_utf8_to_wide(oldpath);
  wchar_t* wnew = __yo_win_utf8_to_wide(newpath);
  if (!wold || !wnew) {
    if (wold) __yo_free(wold);
    if (wnew) __yo_free(wnew);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  int result = _wrename(wold, wnew);
  __yo_free(wold);
  __yo_free(wnew);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_symlinkat_start(const char* target, int32_t newdirfd, const char* linkpath) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* wtarget = __yo_win_utf8_to_wide(target);
  wchar_t* wlink = __yo_win_utf8_to_wide(linkpath);
  if (!wtarget || !wlink) {
    if (wtarget) __yo_free(wtarget);
    if (wlink) __yo_free(wlink);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD attrs = GetFileAttributesW(wtarget);
  DWORD flags = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
  if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) {
    flags |= SYMBOLIC_LINK_FLAG_DIRECTORY;
  }

  BOOL ok = CreateSymbolicLinkW(wlink, wtarget, flags);
  __yo_free(wtarget);
  __yo_free(wlink);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_linkat_start(int32_t olddirfd, const char* oldpath, int32_t newdirfd, const char* newpath, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (!__yo_is_at_fdcwd(olddirfd) || !__yo_is_at_fdcwd(newdirfd)) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  (void)flags;
  wchar_t* wold = __yo_win_utf8_to_wide(oldpath);
  wchar_t* wnew = __yo_win_utf8_to_wide(newpath);
  if (!wold || !wnew) {
    if (wold) __yo_free(wold);
    if (wnew) __yo_free(wnew);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  BOOL ok = CreateHardLinkW(wnew, wold, NULL);
  __yo_free(wold);
  __yo_free(wnew);
  future->result = ok ? 0 : -__yo_win_last_error_to_errno();
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fsync_start(int32_t fd) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _commit(fd);
  future->result = (result < 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_fdatasync_start(int32_t fd) {
  return __yo_async_fsync_start(fd);
}

static yo_io_future_t* __yo_async_ftruncate_start(int32_t fd, int64_t length) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = _chsize_s(fd, (size_t)length);
  future->result = (result != 0) ? -errno : 0;
  atomic_init(&future->state, -1);
  return future;
}

// ============================================================================
// Synchronous FD Operations (Windows) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_pipe(int32_t* pipefd) {
  int result = _pipe(pipefd, 4096, _O_BINARY);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_dup(int32_t oldfd) {
  int result = _dup(oldfd);
  return (result < 0) ? -errno : result;
}

static int32_t __yo_sync_dup2(int32_t oldfd, int32_t newfd) {
  int result = _dup2(oldfd, newfd);
  return (result < 0) ? -errno : newfd;
}

static int64_t __yo_sync_lseek(int32_t fd, int64_t offset, int32_t whence) {
  if (fd < 0) return (int64_t)(-EBADF);
  if (__yo_win_is_socket_fd(fd)) return (int64_t)(-ESPIPE);
  intptr_t hv = _get_osfhandle(fd);
  if (hv == -1) return (int64_t)(-EBADF);
  DWORD ft = GetFileType((HANDLE)hv);
  if (ft == FILE_TYPE_PIPE || ft == FILE_TYPE_CHAR) return (int64_t)(-ESPIPE);
  __int64 result = _lseeki64(fd, (__int64)offset, whence);
  return (result < 0) ? (int64_t)(-errno) : (int64_t)result;
}

static int32_t __yo_sync_fallocate(int32_t fd, int32_t mode, int64_t offset, int64_t length) {
  if (fd < 0) return -EBADF;
  if (offset < 0 || length < 0) return -EINVAL;

  uint64_t target_u = (uint64_t)offset + (uint64_t)length;
  if (target_u > 0x7FFFFFFFFFFFFFFFULL) return -EINVAL;
  __int64 target = (__int64)target_u;

  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) return -EBADF;
  HANDLE handle = (HANDLE)handle_value;

  FILE_ALLOCATION_INFO alloc_info;
  alloc_info.AllocationSize.QuadPart = target;
  if (!SetFileInformationByHandle(handle, FileAllocationInfo, &alloc_info, sizeof(alloc_info))) {
    return -__yo_win_last_error_to_errno();
  }

  // FALLOC_FL_KEEP_SIZE = 0x01
  if ((mode & 0x01) == 0) {
    struct _stat64 st;
    if (_fstat64(fd, &st) != 0) return -errno;
    if ((__int64)st.st_size < target) {
      int result = _chsize_s(fd, target);
      if (result != 0) return -errno;
    }
  }

  return 0;
}

static int32_t __yo_sync_fcntl_getfl(int32_t fd) {
  if (fd < 0) return -EBADF;
  if (__yo_win_is_socket_fd(fd)) {
    // Winsock does not provide a portable way to query current FIONBIO mode.
    // Return 0 (blocking) as best-effort default.
    return 0;
  }

  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) return -EBADF;
  return 0;
}

static int32_t __yo_sync_fcntl_setfl(int32_t fd, int32_t flags) {
  if (fd < 0) return -EBADF;
  if (__yo_win_is_socket_fd(fd)) {
    u_long mode = ((flags & O_NONBLOCK) != 0) ? 1UL : 0UL;
    int result = ioctlsocket((SOCKET)(uintptr_t)(uint32_t)fd, FIONBIO, &mode);
    return (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  }

  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) return -EBADF;

  if ((flags & O_NONBLOCK) != 0) {
    HANDLE handle = (HANDLE)handle_value;
    if (GetFileType(handle) == FILE_TYPE_PIPE) {
      DWORD pipe_mode = PIPE_NOWAIT;
      if (SetNamedPipeHandleState(handle, &pipe_mode, NULL, NULL)) {
        return 0;
      }
      return -__yo_win_last_error_to_errno();
    }
    return -ENOSYS;
  }

  return 0;
}

static int32_t __yo_sync_fcntl_getfd(int32_t fd) {
  if (fd < 0) return -EBADF;
  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) {
    return __yo_win_is_socket_fd(fd) ? 0 : -EBADF;
  }

  DWORD handle_flags = 0;
  if (!GetHandleInformation((HANDLE)handle_value, &handle_flags)) {
    return -__yo_win_last_error_to_errno();
  }

  return ((handle_flags & HANDLE_FLAG_INHERIT) != 0) ? 0 : FD_CLOEXEC;
}

static int32_t __yo_sync_fcntl_setfd(int32_t fd, int32_t flags) {
  if (fd < 0) return -EBADF;
  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) {
    return __yo_win_is_socket_fd(fd) ? 0 : -EBADF;
  }

  DWORD inherit_value = ((flags & FD_CLOEXEC) != 0) ? 0 : HANDLE_FLAG_INHERIT;
  BOOL ok = SetHandleInformation((HANDLE)handle_value, HANDLE_FLAG_INHERIT, inherit_value);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

#define LOCK_SH 1
#define LOCK_EX 2
#define LOCK_NB 4
#define LOCK_UN 8

static int32_t __yo_sync_flock(int32_t fd, int32_t operation) {
  if (fd < 0) return -EBADF;
  intptr_t handle_value = _get_osfhandle(fd);
  if (handle_value == -1) return -EBADF;
  HANDLE handle = (HANDLE)handle_value;
  OVERLAPPED ov;
  memset(&ov, 0, sizeof(ov));
  if ((operation & LOCK_UN) != 0) {
    BOOL ok = UnlockFileEx(handle, 0, 0xFFFFFFFF, 0xFFFFFFFF, &ov);
    if (!ok && GetLastError() == ERROR_NOT_LOCKED) return 0;
    return ok ? 0 : -__yo_win_last_error_to_errno();
  }
  UnlockFileEx(handle, 0, 0xFFFFFFFF, 0xFFFFFFFF, &ov);
  memset(&ov, 0, sizeof(ov));
  DWORD flags = 0;
  if ((operation & LOCK_EX) != 0) flags |= LOCKFILE_EXCLUSIVE_LOCK;
  if ((operation & LOCK_NB) != 0) flags |= LOCKFILE_FAIL_IMMEDIATELY;
  BOOL ok = LockFileEx(handle, flags, 0, 0xFFFFFFFF, 0xFFFFFFFF, &ov);
  if (!ok && (operation & LOCK_NB) != 0 && GetLastError() == ERROR_LOCK_VIOLATION) {
    return -EAGAIN;
  }
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_readv(int32_t fd, void* iov, int32_t iovcnt) {
  if (fd < 0) return -EBADF;
  if (iovcnt < 0) return -EINVAL;
  if (iovcnt == 0) return 0;

  yo_iovec_t* vec = (yo_iovec_t*)iov;

  if (__yo_win_is_socket_fd(fd)) {
    WSABUF* bufs = (WSABUF*)__yo_malloc(sizeof(WSABUF) * (size_t)iovcnt);
    if (!bufs) return -ENOMEM;

    for (int32_t i = 0; i < iovcnt; i++) {
      if (vec[i].iov_len > 0xFFFFFFFFu) {
        __yo_free(bufs);
        return -EINVAL;
      }
      bufs[i].buf = (CHAR*)vec[i].iov_base;
      bufs[i].len = (ULONG)vec[i].iov_len;
    }

    DWORD recvd = 0;
    DWORD flags = 0;
    int result = WSARecv((SOCKET)(uintptr_t)(uint32_t)fd, bufs, (DWORD)iovcnt, &recvd, &flags, NULL, NULL);
    __yo_free(bufs);
    return (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : (int32_t)recvd;
  }

  intptr_t hv = _get_osfhandle(fd);
  if (hv == -1) return -EBADF;
  HANDLE handle = (HANDLE)hv;

  HANDLE evt = CreateEvent(NULL, TRUE, FALSE, NULL);
  if (!evt) return -ENOMEM;

  LARGE_INTEGER cur_pos;
  LARGE_INTEGER zero_dist;
  zero_dist.QuadPart = 0;
  if (!SetFilePointerEx(handle, zero_dist, &cur_pos, FILE_CURRENT)) {
    cur_pos.QuadPart = 0;
  }

  int32_t total = 0;
  for (int32_t i = 0; i < iovcnt; i++) {
    char* ptr = (char*)vec[i].iov_base;
    size_t remaining = vec[i].iov_len;
    while (remaining > 0) {
      DWORD chunk = (remaining > 0x7FFFFFFF) ? 0x7FFFFFFF : (DWORD)remaining;
      OVERLAPPED ov;
      memset(&ov, 0, sizeof(ov));
      ov.Offset = (DWORD)(cur_pos.QuadPart & 0xFFFFFFFF);
      ov.OffsetHigh = (DWORD)(cur_pos.QuadPart >> 32);
      ov.hEvent = (HANDLE)((uintptr_t)evt | 1);
      ResetEvent(evt);
      DWORD bytes_read = 0;
      BOOL ok = ReadFile(handle, ptr, chunk, &bytes_read, &ov);
      if (!ok) {
        DWORD err = GetLastError();
        if (err == ERROR_IO_PENDING) {
          WaitForSingleObject(evt, INFINITE);
          ok = GetOverlappedResult(handle, &ov, &bytes_read, FALSE);
          if (!ok) {
            CloseHandle(evt);
            return (total > 0) ? total : -__yo_win_last_error_to_errno();
          }
        } else if (err == ERROR_HANDLE_EOF) {
          CloseHandle(evt);
          return total;
        } else {
          CloseHandle(evt);
          return (total > 0) ? total : -__yo_win_last_error_to_errno();
        }
      }
      if (bytes_read == 0) {
        CloseHandle(evt);
        return total;
      }
      total += (int32_t)bytes_read;
      cur_pos.QuadPart += bytes_read;
      if (bytes_read < chunk) {
        SetFilePointerEx(handle, cur_pos, NULL, FILE_BEGIN);
        CloseHandle(evt);
        return total;
      }
      ptr += bytes_read;
      remaining -= bytes_read;
    }
  }

  SetFilePointerEx(handle, cur_pos, NULL, FILE_BEGIN);
  CloseHandle(evt);
  return total;
}

static int32_t __yo_sync_writev(int32_t fd, void* iov, int32_t iovcnt) {
  if (fd < 0) return -EBADF;
  if (iovcnt < 0) return -EINVAL;
  if (iovcnt == 0) return 0;

  yo_iovec_t* vec = (yo_iovec_t*)iov;

  if (__yo_win_is_socket_fd(fd)) {
    WSABUF* bufs = (WSABUF*)__yo_malloc(sizeof(WSABUF) * (size_t)iovcnt);
    if (!bufs) return -ENOMEM;

    for (int32_t i = 0; i < iovcnt; i++) {
      if (vec[i].iov_len > 0xFFFFFFFFu) {
        __yo_free(bufs);
        return -EINVAL;
      }
      bufs[i].buf = (CHAR*)vec[i].iov_base;
      bufs[i].len = (ULONG)vec[i].iov_len;
    }

    DWORD sent = 0;
    int result = WSASend((SOCKET)(uintptr_t)(uint32_t)fd, bufs, (DWORD)iovcnt, &sent, 0, NULL, NULL);
    __yo_free(bufs);
    return (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : (int32_t)sent;
  }

  intptr_t whv = _get_osfhandle(fd);
  if (whv == -1) return -EBADF;
  HANDLE whandle = (HANDLE)whv;

  HANDLE wevt = CreateEvent(NULL, TRUE, FALSE, NULL);
  if (!wevt) return -ENOMEM;

  LARGE_INTEGER wcur_pos;
  LARGE_INTEGER wzero_dist;
  wzero_dist.QuadPart = 0;
  if (!SetFilePointerEx(whandle, wzero_dist, &wcur_pos, FILE_CURRENT)) {
    wcur_pos.QuadPart = 0;
  }

  int32_t total = 0;
  for (int32_t i = 0; i < iovcnt; i++) {
    char* ptr = (char*)vec[i].iov_base;
    size_t remaining = vec[i].iov_len;
    while (remaining > 0) {
      DWORD chunk = (remaining > 0x7FFFFFFF) ? 0x7FFFFFFF : (DWORD)remaining;
      OVERLAPPED ov;
      memset(&ov, 0, sizeof(ov));
      ov.Offset = (DWORD)(wcur_pos.QuadPart & 0xFFFFFFFF);
      ov.OffsetHigh = (DWORD)(wcur_pos.QuadPart >> 32);
      ov.hEvent = (HANDLE)((uintptr_t)wevt | 1);
      ResetEvent(wevt);
      DWORD bytes_written = 0;
      BOOL ok = WriteFile(whandle, ptr, chunk, &bytes_written, &ov);
      if (!ok) {
        DWORD err = GetLastError();
        if (err == ERROR_IO_PENDING) {
          WaitForSingleObject(wevt, INFINITE);
          ok = GetOverlappedResult(whandle, &ov, &bytes_written, FALSE);
          if (!ok) {
            CloseHandle(wevt);
            return (total > 0) ? total : -__yo_win_last_error_to_errno();
          }
        } else {
          CloseHandle(wevt);
          return (total > 0) ? total : -__yo_win_last_error_to_errno();
        }
      }
      total += (int32_t)bytes_written;
      wcur_pos.QuadPart += bytes_written;
      if (bytes_written < chunk) {
        SetFilePointerEx(whandle, wcur_pos, NULL, FILE_BEGIN);
        CloseHandle(wevt);
        return total;
      }
      ptr += bytes_written;
      remaining -= bytes_written;
    }
  }

  SetFilePointerEx(whandle, wcur_pos, NULL, FILE_BEGIN);
  CloseHandle(wevt);
  return total;
}

static int32_t __yo_sync_preadv(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  if (iovcnt < 0 || offset < 0) return -EINVAL;
  if (__yo_win_is_socket_fd(fd)) return -ESPIPE;

  int64_t saved = __yo_sync_lseek(fd, 0, 1);
  if (saved < 0) return (int32_t)saved;

  int64_t seeked = __yo_sync_lseek(fd, offset, 0);
  if (seeked < 0) return (int32_t)seeked;

  int32_t result = __yo_sync_readv(fd, iov, iovcnt);

  int64_t restored = __yo_sync_lseek(fd, saved, 0);
  if (restored < 0 && result >= 0) {
    return (int32_t)restored;
  }

  return result;
}

static int32_t __yo_sync_pwritev(int32_t fd, void* iov, int32_t iovcnt, int64_t offset) {
  if (iovcnt < 0 || offset < 0) return -EINVAL;
  if (__yo_win_is_socket_fd(fd)) return -ESPIPE;

  int64_t saved = __yo_sync_lseek(fd, 0, 1);
  if (saved < 0) return (int32_t)saved;

  int64_t seeked = __yo_sync_lseek(fd, offset, 0);
  if (seeked < 0) return (int32_t)seeked;

  int32_t result = __yo_sync_writev(fd, iov, iovcnt);

  int64_t restored = __yo_sync_lseek(fd, saved, 0);
  if (restored < 0 && result >= 0) {
    return (int32_t)restored;
  }

  return result;
}

static size_t __yo_iovec_size(void) {
  return sizeof(yo_iovec_t);
}

static void __yo_iovec_set(void* iov, size_t index, void* base, size_t len) {
  yo_iovec_t* vec = (yo_iovec_t*)iov;
  vec[index].iov_base = base;
  vec[index].iov_len = len;
}

static int32_t __yo_sync_fadvise(int32_t fd, int64_t offset, int64_t len, int32_t advice) {
  (void)fd;
  (void)offset;
  (void)len;
  (void)advice;
  // No direct equivalent on Windows; treat as advisory no-op.
  return 0;
}

static int32_t __yo_sync_madvise(uint8_t* addr, size_t length, int32_t advice) {
  if (!addr || length == 0) {
    return -EINVAL;
  }

  // Best effort: map MADV_DONTNEED to MEM_RESET to hint pages are discardable.
  if (advice == 4) {
    (void)VirtualAlloc((void*)addr, length, MEM_RESET, PAGE_NOACCESS);
  }

  return 0;
}

static uint8_t* __yo_sync_mmap(uint8_t* addr, size_t length, int32_t prot, int32_t flags, int32_t fd, int64_t offset) {
  if (length == 0) {
    return (uint8_t*)(intptr_t)(-EINVAL);
  }
  if (offset < 0) {
    return (uint8_t*)(intptr_t)(-EINVAL);
  }

  bool anonymous_map = ((flags & MAP_ANONYMOUS) != 0);
  HANDLE file_handle = INVALID_HANDLE_VALUE;

  if (!anonymous_map) {
    if (fd < 0) {
      return (uint8_t*)(intptr_t)(-EBADF);
    }
    intptr_t handle_value = _get_osfhandle(fd);
    if (handle_value == -1) {
      return (uint8_t*)(intptr_t)(-EBADF);
    }
    file_handle = (HANDLE)handle_value;
  }

  uint64_t map_end = ((uint64_t)offset + (uint64_t)length);
  bool prot_none = (prot == 0);
  DWORD protect = prot_none ? PAGE_READWRITE : __yo_win_mmap_page_protect(prot, flags, anonymous_map);
  HANDLE mapping = CreateFileMappingW(
    file_handle,
    NULL,
    protect,
    (DWORD)(map_end >> 32),
    (DWORD)(map_end & 0xFFFFFFFFu),
    NULL
  );
  if (!mapping) {
    return (uint8_t*)(intptr_t)(-__yo_win_last_error_to_errno());
  }

  DWORD desired_access = prot_none ? (FILE_MAP_READ | FILE_MAP_WRITE) : __yo_win_mmap_view_access(prot, flags, anonymous_map);
  uint64_t offset_u64 = (uint64_t)offset;
  void* view = NULL;

  if (addr) {
    view = MapViewOfFileEx(
      mapping,
      desired_access,
      (DWORD)(offset_u64 >> 32),
      (DWORD)(offset_u64 & 0xFFFFFFFFu),
      (SIZE_T)length,
      (LPVOID)addr
    );
  } else {
    view = MapViewOfFile(
      mapping,
      desired_access,
      (DWORD)(offset_u64 >> 32),
      (DWORD)(offset_u64 & 0xFFFFFFFFu),
      (SIZE_T)length
    );
  }

  if (!CloseHandle(mapping)) {
    // Ignore mapping handle close failure after map attempt.
  }

  if (!view) {
    return (uint8_t*)(intptr_t)(-__yo_win_last_error_to_errno());
  }

  if (prot_none) {
    DWORD old_protect;
    VirtualProtect(view, length, PAGE_NOACCESS, &old_protect);
  }

  return (uint8_t*)view;
}

static bool __yo_sync_mmap_is_error(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  return (value < 0) && (value >= -65535);
}

static int32_t __yo_sync_mmap_errno(uint8_t* addr) {
  intptr_t value = (intptr_t)addr;
  if ((value < 0) && (value >= -65535)) {
    return (int32_t)(-value);
  }
  return 0;
}

static int32_t __yo_sync_munmap(uint8_t* addr, size_t length) {
  (void)length;
  BOOL ok = UnmapViewOfFile((LPCVOID)addr);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_mprotect(uint8_t* addr, size_t length, int32_t prot) {
  DWORD old_protect = 0;
  DWORD new_protect = __yo_win_mmap_page_protect(prot, MAP_SHARED, true);
  BOOL ok = VirtualProtect((LPVOID)addr, (SIZE_T)length, new_protect, &old_protect);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_msync(uint8_t* addr, size_t length, int32_t flags) {
  (void)flags;
  BOOL ok = FlushViewOfFile((LPCVOID)addr, (SIZE_T)length);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_fchmod(int32_t fd, uint32_t mode) {
  if (fd < 0) return -EBADF;
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) return -EBADF;
  wchar_t path_buf[MAX_PATH];
  DWORD len = GetFinalPathNameByHandleW(handle, path_buf, MAX_PATH, FILE_NAME_NORMALIZED);
  if (len == 0 || len >= MAX_PATH) return -__yo_win_last_error_to_errno();
  int result = _wchmod(path_buf, (int)mode);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchmodat(int32_t dirfd, const char* path, uint32_t mode, int32_t flags) {
  if (!__yo_is_at_fdcwd(dirfd)) return -EINVAL;
  (void)flags;
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  int result = _wchmod(wpath, (int)mode);
  __yo_free(wpath);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_fchown(int32_t fd, uint32_t uid, uint32_t gid) {
  (void)fd;
  if (uid == (uint32_t)0xFFFFFFFF && gid == (uint32_t)0xFFFFFFFF) return 0;
  return -ENOSYS;
}

static int32_t __yo_sync_fchownat(int32_t dirfd, const char* path, uint32_t uid, uint32_t gid, int32_t flags) {
  (void)dirfd; (void)path; (void)flags;
  if (uid == (uint32_t)0xFFFFFFFF && gid == (uint32_t)0xFFFFFFFF) return 0;
  return -ENOSYS;
}

static int32_t __yo_sync_readlinkat(int32_t dirfd, const char* path, char* buf, size_t bufsize) {
  if (!__yo_is_at_fdcwd(dirfd)) return -EINVAL;
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  HANDLE handle = CreateFileW(wpath, 0,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                              NULL);
  __yo_free(wpath);
  if (handle == INVALID_HANDLE_VALUE) return -__yo_win_last_error_to_errno();
  wchar_t wbuf[MAX_PATH];
  DWORD len = GetFinalPathNameByHandleW(handle, wbuf, MAX_PATH, FILE_NAME_NORMALIZED);
  CloseHandle(handle);
  if (len == 0 || len >= MAX_PATH) return -__yo_win_last_error_to_errno();
  int written = __yo_win_wide_to_utf8(wbuf, buf, bufsize);
  return (written < 0) ? written : written;
}

// ============================================================================
// Directory Listing (Windows)
// ============================================================================

typedef struct {
  uint16_t d_reclen;
  uint8_t d_type;
  uint8_t _pad;
  uint64_t d_ino;
  char d_name[1];
} yo_win_dirent_t;

typedef struct yo_win_dir_state_t {
  int32_t fd;
  HANDLE find_handle;
  WIN32_FIND_DATAW find_data;
  bool has_data;
  int phase;
  wchar_t* pattern;
  struct yo_win_dir_state_t* next;
} yo_win_dir_state_t;

static yo_win_dir_state_t* __yo_dir_state_head = NULL;

static yo_win_dir_state_t* __yo_win_get_dir_state(int32_t fd) {
  EnterCriticalSection(&__yo_dir_state_mutex);
  yo_win_dir_state_t* node = __yo_dir_state_head;
  while (node) {
    if (node->fd == fd) {
      LeaveCriticalSection(&__yo_dir_state_mutex);
      return node;
    }
    node = node->next;
  }

  node = (yo_win_dir_state_t*)__yo_malloc(sizeof(yo_win_dir_state_t));
  memset(node, 0, sizeof(yo_win_dir_state_t));
  node->fd = fd;
  node->find_handle = INVALID_HANDLE_VALUE;
  node->has_data = false;
  node->phase = 0;
  node->pattern = NULL;
  node->next = __yo_dir_state_head;
  __yo_dir_state_head = node;
  LeaveCriticalSection(&__yo_dir_state_mutex);
  return node;
}

static void __yo_win_cleanup_dir_state(int32_t fd) {
  EnterCriticalSection(&__yo_dir_state_mutex);
  yo_win_dir_state_t** pp = &__yo_dir_state_head;
  while (*pp) {
    if ((*pp)->fd == fd) {
      yo_win_dir_state_t* node = *pp;
      *pp = node->next;
      if (node->find_handle != INVALID_HANDLE_VALUE) {
        FindClose(node->find_handle);
      }
      if (node->pattern) {
        __yo_free(node->pattern);
      }
      __yo_free(node);
      LeaveCriticalSection(&__yo_dir_state_mutex);
      return;
    }
    pp = &((*pp)->next);
  }
  LeaveCriticalSection(&__yo_dir_state_mutex);
}

static size_t __yo_win_dirent_write(char* buf, size_t buf_size, const char* name, uint8_t dtype) {
  size_t name_len = strlen(name);
  size_t base = offsetof(yo_win_dirent_t, d_name);
  size_t reclen = base + name_len + 1;
  size_t aligned = (reclen + 7) & ~((size_t)7);
  if (aligned > buf_size) return 0;

  yo_win_dirent_t* ent = (yo_win_dirent_t*)buf;
  ent->d_reclen = (uint16_t)aligned;
  ent->d_type = dtype;
  ent->d_ino = 0;
  memcpy(ent->d_name, name, name_len + 1);
  return aligned;
}

static yo_io_future_t* __yo_async_getdents_start(int32_t fd, void* buf, uint32_t buf_size) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (buf_size == 0) {
    future->result = 0;
    atomic_init(&future->state, -1);
    return future;
  }

  yo_win_dir_state_t* state = __yo_win_get_dir_state(fd);
  if (state->find_handle == INVALID_HANDLE_VALUE && !state->pattern) {
    HANDLE handle = (HANDLE)_get_osfhandle(fd);
    if (handle == INVALID_HANDLE_VALUE) {
      future->result = -EBADF;
      atomic_init(&future->state, -1);
      return future;
    }

    wchar_t path_buf[MAX_PATH];
    DWORD len = GetFinalPathNameByHandleW(handle, path_buf, MAX_PATH, FILE_NAME_NORMALIZED);
    if (len == 0 || len >= MAX_PATH) {
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }

    size_t path_len = wcslen(path_buf);
    wchar_t* pattern = (wchar_t*)__yo_malloc((path_len + 3) * sizeof(wchar_t));
    wcscpy(pattern, path_buf);
    if (pattern[path_len - 1] != L'\\' && pattern[path_len - 1] != L'/') {
      pattern[path_len] = L'\\';
      pattern[path_len + 1] = L'*';
      pattern[path_len + 2] = L'\0';
    } else {
      pattern[path_len] = L'*';
      pattern[path_len + 1] = L'\0';
    }
    state->pattern = pattern;

    state->find_handle = FindFirstFileW(state->pattern, &state->find_data);
    if (state->find_handle == INVALID_HANDLE_VALUE) {
      future->result = 0;  // No entries
      atomic_init(&future->state, -1);
      return future;
    }
    state->has_data = true;
    state->phase = 0;
  }

  size_t total = 0;
  char* out = (char*)buf;

  while (total < buf_size) {
    if (!state->has_data) {
      break;
    }

    char name_buf[MAX_PATH];
    if (__yo_win_wide_to_utf8(state->find_data.cFileName, name_buf, sizeof(name_buf)) < 0) {
      state->has_data = false;
      break;
    }

    uint8_t dtype = (state->find_data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? DT_DIR : DT_REG;
    size_t written = __yo_win_dirent_write(out + total, buf_size - total, name_buf, dtype);
    if (!written) break;
    total += written;

    if (!FindNextFileW(state->find_handle, &state->find_data)) {
      FindClose(state->find_handle);
      state->find_handle = INVALID_HANDLE_VALUE;
      state->has_data = false;
    }
  }

  if (total == 0 && !state->has_data) {
    future->result = 0;
  } else {
    future->result = (int32_t)total;
  }
  atomic_init(&future->state, -1);
  return future;
}

static size_t __yo_dirent_size(void) {
  return sizeof(yo_win_dirent_t);
}

static uint16_t __yo_dirent_reclen(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_reclen;
}

static uint8_t __yo_dirent_type(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_type;
}

static const char* __yo_dirent_name(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_name;
}

static uint64_t __yo_dirent_ino(void* entry) {
  return ((yo_win_dirent_t*)entry)->d_ino;
}

// ============================================================================
// Socket Operations (Windows)
// ============================================================================

static yo_io_future_t* __yo_async_socket_start(int32_t domain, int32_t type, int32_t protocol) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  SOCKET s = WSASocketW(domain, type, protocol, NULL, 0, WSA_FLAG_OVERLAPPED);
  if (s == INVALID_SOCKET) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    if (__yo_io_iocp) {
      CreateIoCompletionPort((HANDLE)s, __yo_io_iocp, 0, 0);
    }
    future->result = (int32_t)(uintptr_t)s;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_bind_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = bind((SOCKET)(uintptr_t)sockfd, (const struct sockaddr*)addr, (int)addrlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_listen_start(int32_t sockfd, int32_t backlog) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = listen((SOCKET)(uintptr_t)sockfd, backlog);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_accept_start(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int len = (int)(*addrlen);
  SOCKET result = accept((SOCKET)(uintptr_t)sockfd, (struct sockaddr*)addr, &len);
  if (result == INVALID_SOCKET) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    *addrlen = (uint32_t)len;
    if (__yo_io_iocp) {
      CreateIoCompletionPort((HANDLE)result, __yo_io_iocp, 0, 0);
    }
    future->result = (int32_t)(uintptr_t)result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_connect_start(int32_t sockfd, const void* addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = connect((SOCKET)(uintptr_t)sockfd, (const struct sockaddr*)addr, (int)addrlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_send_start(int32_t sockfd, const void* buf, size_t len, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  SOCKET s = (SOCKET)(uintptr_t)sockfd;
  yo_win_overlapped_t* ov = (yo_win_overlapped_t*)__yo_malloc(sizeof(yo_win_overlapped_t));
  memset(ov, 0, sizeof(yo_win_overlapped_t));
  ov->future = future;
  ov->is_socket = true;
  ov->sock = s;
  ov->wsabuf.buf = (char*)buf;
  ov->wsabuf.len = (ULONG)len;

  DWORD sent = 0;
  int result = WSASend(s, &ov->wsabuf, 1, &sent, (DWORD)flags, &ov->overlapped, NULL);

  if (result == 0 || (result == SOCKET_ERROR && WSAGetLastError() == WSA_IO_PENDING)) {
    atomic_init(&future->state, 0);
    atomic_fetch_add(&__yo_pending_io_count, 1);
    return future;
  }

  future->result = -(int32_t)WSAGetLastError();
  atomic_init(&future->state, -1);
  __yo_free(ov);
  return future;
}

static yo_io_future_t* __yo_async_recv_start(int32_t sockfd, void* buf, size_t len, int32_t flags) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  SOCKET s = (SOCKET)(uintptr_t)sockfd;
  yo_win_overlapped_t* ov = (yo_win_overlapped_t*)__yo_malloc(sizeof(yo_win_overlapped_t));
  memset(ov, 0, sizeof(yo_win_overlapped_t));
  ov->future = future;
  ov->is_socket = true;
  ov->sock = s;
  ov->wsabuf.buf = (char*)buf;
  ov->wsabuf.len = (ULONG)len;
  ov->sock_flags = (DWORD)flags;

  DWORD received = 0;
  int result = WSARecv(s, &ov->wsabuf, 1, &received, &ov->sock_flags, &ov->overlapped, NULL);

  if (result == 0 || (result == SOCKET_ERROR && WSAGetLastError() == WSA_IO_PENDING)) {
    atomic_init(&future->state, 0);
    atomic_fetch_add(&__yo_pending_io_count, 1);
    return future;
  }

  future->result = -(int32_t)WSAGetLastError();
  atomic_init(&future->state, -1);
  __yo_free(ov);
  return future;
}

static yo_io_future_t* __yo_async_sendto_start(int32_t sockfd, const void* buf, size_t len, int32_t flags,
                                                const void* dest_addr, uint32_t addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int result = sendto((SOCKET)(uintptr_t)sockfd, (const char*)buf, (int)len, flags,
                        (const struct sockaddr*)dest_addr, (int)addrlen);
    future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : result;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_recvfrom_start(int32_t sockfd, void* buf, size_t len, int32_t flags,
                                                  void* src_addr, uint32_t* addrlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  if (len > INT_MAX) {
    future->result = -EINVAL;
  } else {
    int alen = (int)(*addrlen);
    int result = recvfrom((SOCKET)(uintptr_t)sockfd, (char*)buf, (int)len, flags,
                          (struct sockaddr*)src_addr, &alen);
    if (result == SOCKET_ERROR) {
      future->result = -(int32_t)WSAGetLastError();
    } else {
      *addrlen = (uint32_t)alen;
      future->result = result;
    }
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_shutdown_start(int32_t sockfd, int32_t how) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = shutdown((SOCKET)(uintptr_t)sockfd, how);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_setsockopt_start(int32_t sockfd, int32_t level, int32_t optname, const void* optval, uint32_t optlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int result = setsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (const char*)optval, (int)optlen);
  future->result = (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_getsockopt_start(int32_t sockfd, int32_t level, int32_t optname, void* optval, uint32_t* optlen) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int len = (int)(*optlen);
  int result = getsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (char*)optval, &len);
  if (result == SOCKET_ERROR) {
    future->result = -(int32_t)WSAGetLastError();
  } else {
    *optlen = (uint32_t)len;
    future->result = 0;
  }
  atomic_init(&future->state, -1);
  return future;
}

static int32_t __yo_sync_getsockname(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();

  int len = (int)(*addrlen);
  int result = getsockname((SOCKET)(uintptr_t)sockfd, (struct sockaddr*)addr, &len);
  if (result == SOCKET_ERROR) {
    return -(int32_t)WSAGetLastError();
  }

  *addrlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_getpeername(int32_t sockfd, void* addr, uint32_t* addrlen) {
  __yo_io_init();

  int len = (int)(*addrlen);
  int result = getpeername((SOCKET)(uintptr_t)sockfd, (struct sockaddr*)addr, &len);
  if (result == SOCKET_ERROR) {
    return -(int32_t)WSAGetLastError();
  }

  *addrlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_setsockopt(int32_t sockfd, int32_t level, int32_t optname, const void* optval, uint32_t optlen) {
  __yo_io_init();

  int result = setsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (const char*)optval, (int)optlen);
  return (result == SOCKET_ERROR) ? -(int32_t)WSAGetLastError() : 0;
}

static int32_t __yo_sync_getsockopt(int32_t sockfd, int32_t level, int32_t optname, void* optval, uint32_t* optlen) {
  __yo_io_init();

  int len = (int)(*optlen);
  int result = getsockopt((SOCKET)(uintptr_t)sockfd, level, optname, (char*)optval, &len);
  if (result == SOCKET_ERROR) {
    return -(int32_t)WSAGetLastError();
  }

  *optlen = (uint32_t)len;
  return 0;
}

static int32_t __yo_sync_socketpair(int32_t domain, int32_t sock_type, int32_t protocol, int32_t* sv) {
  __yo_io_init();

  if (!sv) {
    return -EINVAL;
  }

  if (sock_type != SOCK_STREAM) {
    return -WSAESOCKTNOSUPPORT;
  }

  // Windows has no native socketpair(); emulate with loopback TCP.
  // Accept common caller domains used for socketpair APIs.
  if (!(domain == AF_UNIX || domain == AF_INET || domain == AF_UNSPEC)) {
    return -WSAEAFNOSUPPORT;
  }

  if (!(protocol == 0 || protocol == IPPROTO_TCP)) {
    return -WSAEPROTONOSUPPORT;
  }

  SOCKET listener = INVALID_SOCKET;
  SOCKET client = INVALID_SOCKET;
  SOCKET server = INVALID_SOCKET;

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;

  listener = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, WSA_FLAG_OVERLAPPED);
  if (listener == INVALID_SOCKET) {
    return -(int32_t)WSAGetLastError();
  }

  if (bind(listener, (const struct sockaddr*)&addr, (int)sizeof(addr)) == SOCKET_ERROR) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(listener);
    return err;
  }

  if (listen(listener, 1) == SOCKET_ERROR) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(listener);
    return err;
  }

  int addrlen = (int)sizeof(addr);
  if (getsockname(listener, (struct sockaddr*)&addr, &addrlen) == SOCKET_ERROR) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(listener);
    return err;
  }

  client = WSASocketW(AF_INET, SOCK_STREAM, IPPROTO_TCP, NULL, 0, WSA_FLAG_OVERLAPPED);
  if (client == INVALID_SOCKET) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(listener);
    return err;
  }

  if (connect(client, (const struct sockaddr*)&addr, addrlen) == SOCKET_ERROR) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(client);
    closesocket(listener);
    return err;
  }

  server = accept(listener, NULL, NULL);
  if (server == INVALID_SOCKET) {
    int32_t err = -(int32_t)WSAGetLastError();
    closesocket(client);
    closesocket(listener);
    return err;
  }

  closesocket(listener);

  if (__yo_io_iocp) {
    CreateIoCompletionPort((HANDLE)client, __yo_io_iocp, 0, 0);
    CreateIoCompletionPort((HANDLE)server, __yo_io_iocp, 0, 0);
  }

  sv[0] = (int32_t)(uintptr_t)client;
  sv[1] = (int32_t)(uintptr_t)server;
  return 0;
}

static int32_t __yo_sync_clock_gettime(int32_t clock_id, int64_t* sec, int64_t* nsec) {
  if (!sec || !nsec) {
    return -EINVAL;
  }

  // CLOCK_REALTIME (0): wall clock time since Unix epoch
  if (clock_id == 0) {
    FILETIME ft;
    HMODULE kernel = GetModuleHandleW(L"kernel32.dll");
    typedef VOID (WINAPI *get_precise_time_fn)(LPFILETIME);
    get_precise_time_fn get_precise = NULL;
    if (kernel) {
      get_precise = (get_precise_time_fn)GetProcAddress(kernel, "GetSystemTimePreciseAsFileTime");
    }
    if (get_precise) {
      get_precise(&ft);
    } else {
      GetSystemTimeAsFileTime(&ft);
    }

    ULARGE_INTEGER ts100;
    ts100.LowPart = ft.dwLowDateTime;
    ts100.HighPart = ft.dwHighDateTime;

    const uint64_t WINDOWS_TO_UNIX_EPOCH_SECONDS = 11644473600ULL;
    uint64_t total_100ns = ts100.QuadPart;
    uint64_t total_seconds = total_100ns / 10000000ULL;
    uint64_t rem_100ns = total_100ns % 10000000ULL;

    if (total_seconds < WINDOWS_TO_UNIX_EPOCH_SECONDS) {
      return -EINVAL;
    }

    *sec = (int64_t)(total_seconds - WINDOWS_TO_UNIX_EPOCH_SECONDS);
    *nsec = (int64_t)(rem_100ns * 100ULL);
    return 0;
  }

  // CLOCK_MONOTONIC (Linux=1, macOS commonly=6)
  if (clock_id == 1 || clock_id == 6) {
    LARGE_INTEGER freq;
    LARGE_INTEGER counter;
    if (!QueryPerformanceFrequency(&freq) || freq.QuadPart <= 0) {
      return -EINVAL;
    }
    if (!QueryPerformanceCounter(&counter)) {
      return -EINVAL;
    }

    int64_t s = (int64_t)(counter.QuadPart / freq.QuadPart);
    int64_t rem = (int64_t)(counter.QuadPart % freq.QuadPart);
    int64_t ns = (int64_t)((rem * 1000000000LL) / freq.QuadPart);

    *sec = s;
    *nsec = ns;
    return 0;
  }

  return -EINVAL;
}

static void __yo_win_copy_cstr_field(char* dst, size_t dst_len, const char* src) {
  if (!dst || dst_len == 0) return;
  if (!src) {
    dst[0] = ' ';
    return;
  }

  size_t i = 0;
  while (i + 1 < dst_len && src[i] != ' ') {
    dst[i] = src[i];
    i++;
  }
  dst[i] = ' ';
}

static int32_t __yo_sync_uname(void* buf) {
  if (!buf) {
    return -EINVAL;
  }

  __yo_io_init();

  const size_t field_size = 256;
  const size_t total_size = (field_size * 5);
  char* out = (char*)buf;
  memset(out, 0, total_size);

  // sysname
  __yo_win_copy_cstr_field(out + (field_size * 0), field_size, "Windows");

  // nodename
  char host[256];
  host[0] = ' ';
  if (gethostname(host, (int)sizeof(host)) == SOCKET_ERROR) {
    __yo_win_copy_cstr_field(out + (field_size * 1), field_size, "localhost");
  } else {
    host[sizeof(host) - 1] = ' ';
    __yo_win_copy_cstr_field(out + (field_size * 1), field_size, host);
  }

  // release / version
  __yo_win_copy_cstr_field(out + (field_size * 2), field_size, "win32");
  __yo_win_copy_cstr_field(out + (field_size * 3), field_size, "nt");

  // machine
  SYSTEM_INFO si;
  GetNativeSystemInfo(&si);
  const char* machine = "unknown";
  switch (si.wProcessorArchitecture) {
    case PROCESSOR_ARCHITECTURE_AMD64:
      machine = "x86_64";
      break;
    case PROCESSOR_ARCHITECTURE_ARM64:
      machine = "aarch64";
      break;
    case PROCESSOR_ARCHITECTURE_INTEL:
      machine = "x86";
      break;
    case PROCESSOR_ARCHITECTURE_ARM:
      machine = "arm";
      break;
    default:
      machine = "unknown";
      break;
  }
  __yo_win_copy_cstr_field(out + (field_size * 4), field_size, machine);

  return 0;
}

static int32_t __yo_sync_gethostname(char* name, size_t len) {
  __yo_io_init();

  if (!name || len == 0) {
    return -EINVAL;
  }

  int result = gethostname(name, (int)len);
  if (result == SOCKET_ERROR) {
    return -(int32_t)WSAGetLastError();
  }
  name[len - 1] = ' ';
  return 0;
}

static int32_t __yo_process_umask = 0;

static int32_t __yo_sync_umask(int32_t mask) {
  int32_t prev = __yo_process_umask;
  __yo_process_umask = mask & 0777;
  return prev;
}

// ============================================================================
// Synchronous File Helpers (Windows)
// ============================================================================

static int32_t __yo_file_open(const char* path, int32_t flags, int32_t mode) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  int fd = _wopen(wpath, flags, mode);
  __yo_free(wpath);
  return (fd < 0) ? -errno : fd;
}

static void __yo_file_close(int32_t fd) {
  SOCKET s = (SOCKET)(uintptr_t)(uint32_t)fd;
  int cs = closesocket(s);
  if (cs != 0) {
    DWORD wsa_err = WSAGetLastError();
    if (wsa_err == WSAENOTSOCK) {
      _close(fd);
    }
  }
}

static int64_t __yo_file_size(int32_t fd) {
  struct _stat64 st;
  if (_fstat64(fd, &st) < 0) return -1;
  return (int64_t)st.st_size;
}

// ============================================================================
// Stat Buffer Accessors (Windows)
// ============================================================================

static size_t __yo_statx_buf_size(void) {
  return sizeof(yo_win_stat_t);
}

static int64_t __yo_statx_size(void* statxbuf) {
  return (int64_t)((yo_win_stat_t*)statxbuf)->stat.st_size;
}

static uint32_t __yo_statx_mode(void* statxbuf) {
  return (uint32_t)((yo_win_stat_t*)statxbuf)->stat.st_mode;
}

static int64_t __yo_statx_mtime_sec(void* statxbuf) {
  return (int64_t)((yo_win_stat_t*)statxbuf)->stat.st_mtime;
}

static uint32_t __yo_statx_mtime_nsec(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->mtime_nsec;
}

static int64_t __yo_statx_atime_sec(void* statxbuf) {
  return (int64_t)((yo_win_stat_t*)statxbuf)->stat.st_atime;
}

static uint32_t __yo_statx_atime_nsec(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->atime_nsec;
}

static int64_t __yo_statx_ctime_sec(void* statxbuf) {
  return (int64_t)((yo_win_stat_t*)statxbuf)->stat.st_ctime;
}

static uint32_t __yo_statx_ctime_nsec(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->ctime_nsec;
}

static int64_t __yo_statx_btime_sec(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->btime_sec;
}

static uint32_t __yo_statx_btime_nsec(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->btime_nsec;
}

static uint32_t __yo_statx_uid(void* statxbuf) {
  return (uint32_t)((yo_win_stat_t*)statxbuf)->stat.st_uid;
}

static uint32_t __yo_statx_gid(void* statxbuf) {
  return (uint32_t)((yo_win_stat_t*)statxbuf)->stat.st_gid;
}

static uint64_t __yo_statx_ino(void* statxbuf) {
  return ((yo_win_stat_t*)statxbuf)->file_index;
}

static uint64_t __yo_statx_dev_major(void* statxbuf) {
  return (uint64_t)((yo_win_stat_t*)statxbuf)->stat.st_dev;
}

static uint64_t __yo_statx_dev_minor(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint64_t __yo_statx_nlink(void* statxbuf) {
  return (uint64_t)((yo_win_stat_t*)statxbuf)->stat.st_nlink;
}

static uint64_t __yo_statx_blksize(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

static uint64_t __yo_statx_blocks(void* statxbuf) {
  (void)statxbuf;
  return 0;
}

// ============================================================================
// Socket Address Helpers (Windows)
// ============================================================================

static size_t __yo_sockaddr_in_size(void) {
  return sizeof(struct sockaddr_in);
}

static size_t __yo_sockaddr_in6_size(void) {
  return sizeof(struct sockaddr_in6);
}

static size_t __yo_sockaddr_un_size(void) {
  return sizeof(__yo_sockaddr_un_t);
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
  memcpy(&((struct sockaddr_in6*)addr)->sin6_addr, ip, sizeof(struct in6_addr));
}

static void __yo_sockaddr_in6_get_addr(void* addr, void* out) {
  memcpy(out, &((struct sockaddr_in6*)addr)->sin6_addr, sizeof(struct in6_addr));
}

static void __yo_sockaddr_un_set_path(void* addr, const char* path) {
  __yo_sockaddr_un_t* un = (__yo_sockaddr_un_t*)addr;
  strncpy(un->sun_path, path, UNIX_PATH_MAX - 1);
  un->sun_path[UNIX_PATH_MAX - 1] = ' ';
}

static const char* __yo_sockaddr_un_get_path(void* addr) {
  return ((__yo_sockaddr_un_t*)addr)->sun_path;
}

static int32_t __yo_inet_pton(int32_t af, const char* src, void* dst) {
  return InetPtonA(af, src, dst) == 1 ? 1 : 0;
}

static const char* __yo_inet_ntop(int32_t af, const void* src, char* dst, uint32_t size) {
  return InetNtopA(af, src, dst, (DWORD)size);
}

static uint16_t __yo_htons(uint16_t hostshort) { return htons(hostshort); }
static uint16_t __yo_ntohs(uint16_t netshort) { return ntohs(netshort); }
static uint32_t __yo_htonl(uint32_t hostlong) { return htonl(hostlong); }
static uint32_t __yo_ntohl(uint32_t netlong) { return ntohl(netlong); }

// ============================================================================
// File Extra Operations (Windows)
// ============================================================================

static FILETIME __yo_win_timespec_to_filetime(int64_t sec, int64_t nsec) {
  ULONGLONG t = ((ULONGLONG)(sec + 11644473600LL) * 10000000ULL) + ((ULONGLONG)(nsec / 100));
  FILETIME ft;
  ft.dwLowDateTime = (DWORD)t;
  ft.dwHighDateTime = (DWORD)(t >> 32);
  return ft;
}

static int32_t __yo_win_sendfile_fallback_copy(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  if (offset < 0) return -EINVAL;

  HANDLE in_handle = (HANDLE)_get_osfhandle(in_fd);
  HANDLE out_handle = (HANDLE)_get_osfhandle(out_fd);
  if (in_handle == INVALID_HANDLE_VALUE || out_handle == INVALID_HANDLE_VALUE) return -EBADF;

  wchar_t in_path[MAX_PATH];
  DWORD in_len = GetFinalPathNameByHandleW(in_handle, in_path, MAX_PATH, FILE_NAME_NORMALIZED);
  if (in_len == 0 || in_len >= MAX_PATH) {
    return -__yo_win_last_error_to_errno();
  }

  wchar_t out_path[MAX_PATH];
  DWORD out_len = GetFinalPathNameByHandleW(out_handle, out_path, MAX_PATH, FILE_NAME_NORMALIZED);
  if (out_len == 0 || out_len >= MAX_PATH) {
    return -__yo_win_last_error_to_errno();
  }

  HANDLE in_sync = CreateFileW(
    in_path,
    GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (in_sync == INVALID_HANDLE_VALUE) {
    return -__yo_win_last_error_to_errno();
  }

  HANDLE out_sync = CreateFileW(
    out_path,
    GENERIC_WRITE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL,
    OPEN_EXISTING,
    FILE_ATTRIBUTE_NORMAL,
    NULL
  );
  if (out_sync == INVALID_HANDLE_VALUE) {
    CloseHandle(in_sync);
    return -__yo_win_last_error_to_errno();
  }

  __int64 out_pos = _lseeki64(out_fd, 0, SEEK_CUR);
  if (out_pos < 0) out_pos = 0;

  LARGE_INTEGER in_start;
  in_start.QuadPart = (LONGLONG)offset;
  if (!SetFilePointerEx(in_sync, in_start, NULL, FILE_BEGIN)) {
    CloseHandle(in_sync);
    CloseHandle(out_sync);
    return -__yo_win_last_error_to_errno();
  }

  LARGE_INTEGER out_start;
  out_start.QuadPart = out_pos;
  if (!SetFilePointerEx(out_sync, out_start, NULL, FILE_BEGIN)) {
    CloseHandle(in_sync);
    CloseHandle(out_sync);
    return -__yo_win_last_error_to_errno();
  }

  unsigned char buffer[65536];
  size_t total = 0;
  while (total < count) {
    size_t remaining = count - total;
    size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    DWORD to_read = (chunk > (size_t)0xFFFFFFFFu) ? 0xFFFFFFFFu : (DWORD)chunk;
    DWORD read_bytes = 0;
    if (!ReadFile(in_sync, buffer, to_read, &read_bytes, NULL)) {
      int32_t err = -__yo_win_last_error_to_errno();
      CloseHandle(in_sync);
      CloseHandle(out_sync);
      return err;
    }
    if (read_bytes == 0) {
      break;
    }

    size_t written = 0;
    while (written < (size_t)read_bytes) {
      size_t write_remaining = (size_t)read_bytes - written;
      DWORD to_write =
        (write_remaining > (size_t)0xFFFFFFFFu) ? 0xFFFFFFFFu : (DWORD)write_remaining;
      DWORD written_bytes = 0;
      if (!WriteFile(out_sync, (const char*)(buffer + written), to_write, &written_bytes, NULL)) {
        int32_t err = -__yo_win_last_error_to_errno();
        CloseHandle(in_sync);
        CloseHandle(out_sync);
        return err;
      }
      if (written_bytes == 0) {
        CloseHandle(in_sync);
        CloseHandle(out_sync);
        return -EIO;
      }
      written += (size_t)written_bytes;
    }

    total += (size_t)read_bytes;
  }

  CloseHandle(in_sync);
  CloseHandle(out_sync);

  (void)_lseeki64(out_fd, out_pos + (__int64)total, SEEK_SET);

  return (int32_t)total;
}

// ============================================================================
// Synchronous Operations (Windows) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_access(int32_t dirfd, const char* path, int32_t mode) {
  if (!__yo_is_at_fdcwd(dirfd)) return -EINVAL;

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();

  int win_mode = mode & ~1;
  if (win_mode == 0 && mode != 0) win_mode = 0;

  int result = _waccess(wpath, win_mode);
  __yo_free(wpath);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_realpath(const char* path, char* resolved) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();

  wchar_t wbuf[MAX_PATH];
  DWORD len = GetFullPathNameW(wpath, MAX_PATH, wbuf, NULL);
  __yo_free(wpath);
  if (len == 0 || len >= MAX_PATH) return -__yo_win_last_error_to_errno();

  HANDLE handle = CreateFileW(wbuf, FILE_READ_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (handle == INVALID_HANDLE_VALUE) return -__yo_win_last_error_to_errno();

  DWORD final_len = GetFinalPathNameByHandleW(handle, wbuf, MAX_PATH, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  CloseHandle(handle);
  if (final_len == 0 || final_len >= MAX_PATH) return -__yo_win_last_error_to_errno();

  wchar_t* normalized = wbuf;
    if (wbuf[0] == L'\\' && wbuf[1] == L'\\' && wbuf[2] == L'?' && wbuf[3] == L'\\' &&
      wbuf[4] == L'U' && wbuf[5] == L'N' && wbuf[6] == L'C' && wbuf[7] == L'\\') {
    size_t tail_len = wcslen(wbuf + 8);
    wbuf[0] = L'\\';
    wbuf[1] = L'\\';
    memmove(wbuf + 2, wbuf + 8, (tail_len + 1) * sizeof(wchar_t));
  } else if (wbuf[0] == L'\\' && wbuf[1] == L'\\' && wbuf[2] == L'?' && wbuf[3] == L'\\') {
    normalized = wbuf + 4;
  }

  int written = __yo_win_wide_to_utf8(normalized, resolved, MAX_PATH);
  return (written < 0) ? written : 0;
}

static int32_t __yo_sync_mkdtemp(char* template_str) {
  wchar_t* wtemplate = __yo_win_utf8_to_wide(template_str);
  if (!wtemplate) return -__yo_win_last_error_to_errno();

  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) {
    __yo_free(wtemplate);
    return -errno;
  }

  int result = _wmkdir(wtemplate);
  if (result == 0) {
    __yo_win_wide_to_utf8(wtemplate, template_str, MAX_PATH);
  }
  __yo_free(wtemplate);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_mkstemp(char* template_str) {
  wchar_t* wtemplate = __yo_win_utf8_to_wide(template_str);
  if (!wtemplate) return -__yo_win_last_error_to_errno();

  if (_wmktemp_s(wtemplate, wcslen(wtemplate) + 1) != 0) {
    __yo_free(wtemplate);
    return -errno;
  }

  int fd = _wopen(wtemplate, _O_CREAT | _O_EXCL | _O_RDWR | _O_BINARY, _S_IREAD | _S_IWRITE);
  if (fd >= 0) {
    __yo_win_wide_to_utf8(wtemplate, template_str, MAX_PATH);
  }
  __yo_free(wtemplate);
  return (fd < 0) ? -errno : fd;
}

static int32_t __yo_sync_copyfile(const char* src_path, const char* dst_path, int32_t flags) {
  (void)flags;
  wchar_t* wsrc = __yo_win_utf8_to_wide(src_path);
  wchar_t* wdst = __yo_win_utf8_to_wide(dst_path);
  if (!wsrc || !wdst) {
    if (wsrc) __yo_free(wsrc);
    if (wdst) __yo_free(wdst);
    return -__yo_win_last_error_to_errno();
  }

  BOOL ok = CopyFileW(wsrc, wdst, FALSE);
  __yo_free(wsrc);
  __yo_free(wdst);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_sendfile(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  return __yo_win_sendfile_fallback_copy(out_fd, in_fd, offset, count);
}

static int32_t __yo_sync_utime(const char* path, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  HANDLE handle = CreateFileW(wpath, FILE_WRITE_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  __yo_free(wpath);
  if (handle == INVALID_HANDLE_VALUE) return -__yo_win_last_error_to_errno();
  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  CloseHandle(handle);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_futime(int32_t fd, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  if (fd < 0) return -EBADF;
  HANDLE orig_handle = (HANDLE)_get_osfhandle(fd);
  if (orig_handle == INVALID_HANDLE_VALUE) return -EBADF;
  wchar_t path_buf[MAX_PATH];
  DWORD len = GetFinalPathNameByHandleW(orig_handle, path_buf, MAX_PATH, FILE_NAME_NORMALIZED);
  if (len == 0 || len >= MAX_PATH) return -__yo_win_last_error_to_errno();
  HANDLE handle = CreateFileW(path_buf, FILE_WRITE_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (handle == INVALID_HANDLE_VALUE) return -__yo_win_last_error_to_errno();
  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  CloseHandle(handle);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

static int32_t __yo_sync_lutime(const char* path, int64_t atime_sec, int64_t atime_nsec, int64_t mtime_sec, int64_t mtime_nsec) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  HANDLE handle = CreateFileW(wpath, FILE_WRITE_ATTRIBUTES,
                              FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING,
                              FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                              NULL);
  __yo_free(wpath);
  if (handle == INVALID_HANDLE_VALUE) return -__yo_win_last_error_to_errno();
  FILETIME at = __yo_win_timespec_to_filetime(atime_sec, atime_nsec);
  FILETIME mt = __yo_win_timespec_to_filetime(mtime_sec, mtime_nsec);
  BOOL ok = SetFileTime(handle, NULL, &at, &mt);
  CloseHandle(handle);
  return ok ? 0 : -__yo_win_last_error_to_errno();
}

typedef struct {
  uint64_t type;
  uint64_t bsize;
  uint64_t blocks;
  uint64_t bfree;
  uint64_t bavail;
  uint64_t files;
  uint64_t ffree;
} yo_win_statfs_t;

static int32_t __yo_sync_statfs(const char* path, void* statfsbuf) {
  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) return -__yo_win_last_error_to_errno();
  ULARGE_INTEGER free_avail, total_bytes, free_bytes;
  if (!GetDiskFreeSpaceExW(wpath, &free_avail, &total_bytes, &free_bytes)) {
    __yo_free(wpath);
    return -__yo_win_last_error_to_errno();
  }
  DWORD sectors_per_cluster = 0, bytes_per_sector = 0, num_free_clusters = 0, total_clusters = 0;
  if (!GetDiskFreeSpaceW(wpath, &sectors_per_cluster, &bytes_per_sector, &num_free_clusters, &total_clusters)) {
    __yo_free(wpath);
    return -__yo_win_last_error_to_errno();
  }
  __yo_free(wpath);
  uint64_t bsize = (uint64_t)sectors_per_cluster * (uint64_t)bytes_per_sector;
  yo_win_statfs_t* fs = (yo_win_statfs_t*)statfsbuf;
  fs->type = 0;
  fs->bsize = bsize;
  fs->blocks = bsize ? (total_bytes.QuadPart / bsize) : 0;
  fs->bfree = bsize ? (free_bytes.QuadPart / bsize) : 0;
  fs->bavail = bsize ? (free_avail.QuadPart / bsize) : 0;
  fs->files = 0;
  fs->ffree = 0;
  return 0;
}

static size_t __yo_statfs_buf_size(void) { return sizeof(yo_win_statfs_t); }
static uint64_t __yo_statfs_type(void* buf) { return ((yo_win_statfs_t*)buf)->type; }
static uint64_t __yo_statfs_bsize(void* buf) { return ((yo_win_statfs_t*)buf)->bsize; }
static uint64_t __yo_statfs_blocks(void* buf) { return ((yo_win_statfs_t*)buf)->blocks; }
static uint64_t __yo_statfs_bfree(void* buf) { return ((yo_win_statfs_t*)buf)->bfree; }
static uint64_t __yo_statfs_bavail(void* buf) { return ((yo_win_statfs_t*)buf)->bavail; }
static uint64_t __yo_statfs_files(void* buf) { return ((yo_win_statfs_t*)buf)->files; }
static uint64_t __yo_statfs_ffree(void* buf) { return ((yo_win_statfs_t*)buf)->ffree; }

// ============================================================================
// Directory Scanning (Windows - FindFirstFileW/FindNextFileW)
// ============================================================================

typedef struct yo_win_opendir_state_s {
  HANDLE find_handle;
  WIN32_FIND_DATAW find_data;
  bool has_data;
  wchar_t* pattern;
  struct yo_win_opendir_state_s* next;
} yo_win_opendir_state_t;

static yo_io_future_t* __yo_async_scandir_start(int32_t dirfd, const char* path) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  char full_path[MAX_PATH];
  if (__yo_is_at_fdcwd(dirfd)) {
    strncpy(full_path, path, MAX_PATH - 1);
    full_path[MAX_PATH - 1] = '\0';
  } else {
    HANDLE dh = (HANDLE)_get_osfhandle(dirfd);
    if (dh == INVALID_HANDLE_VALUE) {
      future->result = -EBADF;
      atomic_init(&future->state, -1);
      return future;
    }
    wchar_t dir_buf[MAX_PATH];
    DWORD dlen = GetFinalPathNameByHandleW(dh, dir_buf, MAX_PATH, FILE_NAME_NORMALIZED);
    if (dlen == 0 || dlen >= MAX_PATH) {
      future->result = -__yo_win_last_error_to_errno();
      atomic_init(&future->state, -1);
      return future;
    }
    char dir_utf8[MAX_PATH];
    if (__yo_win_wide_to_utf8(dir_buf, dir_utf8, MAX_PATH) < 0) {
      future->result = -EINVAL;
      atomic_init(&future->state, -1);
      return future;
    }
    snprintf(full_path, MAX_PATH, "%s\\%s", dir_utf8, path);
  }

  int fd = _open(full_path, _O_RDONLY | 0x200000);
  future->result = (fd < 0) ? -errno : fd;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_opendir_start(const char* path) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }

  size_t path_len = wcslen(wpath);
  wchar_t* pattern = (wchar_t*)__yo_malloc((path_len + 3) * sizeof(wchar_t));
  wcscpy(pattern, wpath);
  if (path_len > 0 && wpath[path_len - 1] != L'\\' && wpath[path_len - 1] != L'/') {
    pattern[path_len] = L'\\';
    pattern[path_len + 1] = L'*';
    pattern[path_len + 2] = L'\0';
  } else {
    pattern[path_len] = L'*';
    pattern[path_len + 1] = L'\0';
  }
  __yo_free(wpath);

  yo_win_opendir_state_t* state = (yo_win_opendir_state_t*)__yo_malloc(sizeof(yo_win_opendir_state_t));
  memset(state, 0, sizeof(yo_win_opendir_state_t));
  state->pattern = pattern;
  state->find_handle = FindFirstFileW(state->pattern, &state->find_data);
  if (state->find_handle == INVALID_HANDLE_VALUE) {
    DWORD err = GetLastError();
    __yo_free(state->pattern);
    __yo_free(state);
    if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) {
      future->result = -ENOENT;
    } else {
      future->result = -__yo_win_error_to_errno(err);
    }
    atomic_init(&future->state, -1);
    return future;
  }
  state->has_data = true;

  future->result = (int32_t)(intptr_t)state;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_readdir_start(void* dir, void* entries, size_t max_entries) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  (void)entries;
  (void)max_entries;

  yo_win_opendir_state_t* state = (yo_win_opendir_state_t*)dir;
  if (!state || state->find_handle == INVALID_HANDLE_VALUE) {
    future->result = 0;
    atomic_init(&future->state, -1);
    return future;
  }

  if (!state->has_data) {
    future->result = 0;
    atomic_init(&future->state, -1);
    return future;
  }

  future->result = 1;
  if (!FindNextFileW(state->find_handle, &state->find_data)) {
    state->has_data = false;
  }
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_closedir_start(void* dir) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  yo_win_opendir_state_t* state = (yo_win_opendir_state_t*)dir;
  if (state) {
    if (state->find_handle != INVALID_HANDLE_VALUE) {
      FindClose(state->find_handle);
    }
    if (state->pattern) {
      __yo_free(state->pattern);
    }
    __yo_free(state);
  }

  future->result = 0;
  atomic_init(&future->state, -1);
  return future;
}

// ============================================================================
// DNS Operations (Windows)
// ============================================================================

static yo_io_future_t* __yo_async_getaddrinfo_start(const uint8_t* node, const uint8_t* service,
                                                     const uint8_t* hints, uint8_t** result) {
  __yo_io_init();
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  struct addrinfo* res = NULL;
  int ret = getaddrinfo((const char*)node, (const char*)service, (const struct addrinfo*)hints, &res);

  if (ret == 0) {
    *result = (uint8_t*)res;
    future->result = 0;
  } else {
    future->result = ret;  // Return raw gai error code
  }
  atomic_init(&future->state, -1);

  return future;
}

static yo_io_future_t* __yo_async_getnameinfo_start(const uint8_t* addr, uint32_t addrlen,
                                                     uint8_t* host, size_t hostlen,
                                                     uint8_t* service, size_t servlen, int32_t flags) {
  __yo_io_init();
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int ret = getnameinfo((const struct sockaddr*)addr, (socklen_t)addrlen,
                        (char*)host, (socklen_t)hostlen, (char*)service, (socklen_t)servlen, flags);
  future->result = ret;  // Return raw gai error code
  atomic_init(&future->state, -1);

  return future;
}

static void __yo_freeaddrinfo(uint8_t* res) {
  if (res) freeaddrinfo((struct addrinfo*)res);
}

static size_t __yo_addrinfo_size(void) { return sizeof(struct addrinfo); }
static int32_t __yo_addrinfo_flags(uint8_t* ai) { return ((struct addrinfo*)ai)->ai_flags; }
static int32_t __yo_addrinfo_family(uint8_t* ai) { return ((struct addrinfo*)ai)->ai_family; }
static int32_t __yo_addrinfo_socktype(uint8_t* ai) { return ((struct addrinfo*)ai)->ai_socktype; }
static int32_t __yo_addrinfo_protocol(uint8_t* ai) { return ((struct addrinfo*)ai)->ai_protocol; }
static uint32_t __yo_addrinfo_addrlen(uint8_t* ai) { return (uint32_t)((struct addrinfo*)ai)->ai_addrlen; }
static uint8_t* __yo_addrinfo_addr(uint8_t* ai) { return (uint8_t*)((struct addrinfo*)ai)->ai_addr; }
static uint8_t* __yo_addrinfo_canonname(uint8_t* ai) { return (uint8_t*)((struct addrinfo*)ai)->ai_canonname; }
static uint8_t* __yo_addrinfo_next(uint8_t* ai) { return (uint8_t*)((struct addrinfo*)ai)->ai_next; }

// ============================================================================
// Process Operations (Windows)
// ============================================================================

typedef struct yo_process_handle_entry {
  int32_t pid;
  HANDLE handle;
  struct yo_process_handle_entry* next;
} yo_process_handle_entry;

static yo_process_handle_entry* __yo_process_handles = NULL;

static void __yo_process_add_handle(int32_t pid, HANDLE handle) {
  yo_process_handle_entry* entry = (yo_process_handle_entry*)__yo_malloc(sizeof(yo_process_handle_entry));
  entry->pid = pid;
  entry->handle = handle;
  entry->next = __yo_process_handles;
  __yo_process_handles = entry;
}

static HANDLE __yo_process_get_handle(int32_t pid) {
  yo_process_handle_entry* cur = __yo_process_handles;
  while (cur) {
    if (cur->pid == pid) return cur->handle;
    cur = cur->next;
  }
  return NULL;
}

static void __yo_process_remove_handle(int32_t pid) {
  yo_process_handle_entry* prev = NULL;
  yo_process_handle_entry* cur = __yo_process_handles;
  while (cur) {
    if (cur->pid == pid) {
      if (prev) {
        prev->next = cur->next;
      } else {
        __yo_process_handles = cur->next;
      }
      if (cur->handle) CloseHandle(cur->handle);
      __yo_free(cur);
      return;
    }
    prev = cur;
    cur = cur->next;
  }
}

static bool __yo_win_arg_needs_quotes(const char* arg) {
  if (!arg || arg[0] == '\0') return true;
  for (const char* p = arg; *p; p++) {
    if (*p == ' ' || *p == '\t' || *p == '\n' || *p == '"') return true;
  }
  return false;
}

static size_t __yo_win_quoted_arg_length(const char* arg) {
  if (!__yo_win_arg_needs_quotes(arg)) return strlen(arg);
  size_t len = 2; // quotes
  size_t backslashes = 0;
  for (const char* p = arg; *p; p++) {
    if (*p == '\\') {
      backslashes++;
    } else if (*p == '"') {
      len += backslashes * 2 + 2; // escaped backslashes + escaped quote
      backslashes = 0;
    } else {
      len += backslashes + 1;
      backslashes = 0;
    }
  }
  len += backslashes * 2; // trailing backslashes before closing quote
  return len;
}

static char* __yo_win_append_quoted_arg(char* dst, const char* arg) {
  if (!__yo_win_arg_needs_quotes(arg)) {
    size_t len = strlen(arg);
    memcpy(dst, arg, len);
    return dst + len;
  }

  *dst++ = '"';
  size_t backslashes = 0;
  for (const char* p = arg; *p; p++) {
    if (*p == '\\') {
      backslashes++;
    } else if (*p == '"') {
      for (size_t i = 0; i < backslashes * 2 + 1; i++) *dst++ = '\\';
      *dst++ = '"';
      backslashes = 0;
    } else {
      for (size_t i = 0; i < backslashes; i++) *dst++ = '\\';
      *dst++ = *p;
      backslashes = 0;
    }
  }
  for (size_t i = 0; i < backslashes * 2; i++) *dst++ = '\\';
  *dst++ = '"';
  return dst;
}

static char* __yo_win_build_command_line(char* const argv[]) {
  if (!argv || !argv[0]) return NULL;

  size_t total = 0;
  int count = 0;
  for (char* const* p = argv; *p; p++) {
    if (count > 0) total += 1; // space
    total += __yo_win_quoted_arg_length(*p);
    count++;
  }

  char* buf = (char*)__yo_malloc(total + 1);
  char* out = buf;
  count = 0;
  for (char* const* p = argv; *p; p++) {
    if (count > 0) *out++ = ' ';
    out = __yo_win_append_quoted_arg(out, *p);
    count++;
  }
  *out = '\0';
  return buf;
}

static wchar_t* __yo_win_build_env_block(char* const envp[]) {
  if (!envp) return NULL;

  size_t total_wchars = 1; // final double-null
  for (char* const* p = envp; *p; p++) {
    int len = MultiByteToWideChar(CP_UTF8, 0, *p, -1, NULL, 0);
    if (len <= 0) return NULL;
    total_wchars += (size_t)len;
  }

  wchar_t* block = (wchar_t*)__yo_malloc(sizeof(wchar_t) * total_wchars);
  wchar_t* out = block;

  for (char* const* p = envp; *p; p++) {
    int len = MultiByteToWideChar(CP_UTF8, 0, *p, -1, out, (int)(total_wchars - (out - block)));
    if (len <= 0) {
      __yo_free(block);
      return NULL;
    }
    out += len; // includes null terminator
  }

  *out = L'\0';
  return block;
}

static HANDLE __yo_win_dup_inheritable_handle(HANDLE handle) {
  if (!handle || handle == INVALID_HANDLE_VALUE) return NULL;
  HANDLE dup = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), handle, GetCurrentProcess(), &dup, 0, TRUE, DUPLICATE_SAME_ACCESS)) {
    return NULL;
  }
  return dup;
}

static yo_io_future_t* __yo_async_spawn_start(const uint8_t* file, uint8_t** argv, uint8_t** envp,
                                              int32_t stdin_fd, int32_t stdout_fd, int32_t stderr_fd) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  wchar_t* wfile = __yo_win_utf8_to_wide((const char*)file);
  if (!wfile) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  char* cmd_utf8 = __yo_win_build_command_line((char* const*)argv);
  if (!cmd_utf8) {
    __yo_free(wfile);
    future->result = -EINVAL;
    atomic_init(&future->state, -1);
    return future;
  }
  wchar_t* cmdline = __yo_win_utf8_to_wide(cmd_utf8);
  __yo_free(cmd_utf8);
  if (!cmdline) {
    __yo_free(wfile);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  wchar_t* env_block = __yo_win_build_env_block((char* const*)envp);
  if (envp && !env_block) {
    __yo_free(cmdline);
    __yo_free(wfile);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  HANDLE hStdIn = (stdin_fd >= 0) ? (HANDLE)_get_osfhandle(stdin_fd) : GetStdHandle(STD_INPUT_HANDLE);
  HANDLE hStdOut = (stdout_fd >= 0) ? (HANDLE)_get_osfhandle(stdout_fd) : GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE hStdErr = (stderr_fd >= 0) ? (HANDLE)_get_osfhandle(stderr_fd) : GetStdHandle(STD_ERROR_HANDLE);

  if (hStdIn == INVALID_HANDLE_VALUE || hStdOut == INVALID_HANDLE_VALUE || hStdErr == INVALID_HANDLE_VALUE) {
    if (env_block) __yo_free(env_block);
    __yo_free(cmdline);
    __yo_free(wfile);
    future->result = -EBADF;
    atomic_init(&future->state, -1);
    return future;
  }

  HANDLE hStdInInherit = __yo_win_dup_inheritable_handle(hStdIn);
  HANDLE hStdOutInherit = __yo_win_dup_inheritable_handle(hStdOut);
  HANDLE hStdErrInherit = __yo_win_dup_inheritable_handle(hStdErr);
  if (!hStdInInherit || !hStdOutInherit || !hStdErrInherit) {
    if (hStdInInherit) CloseHandle(hStdInInherit);
    if (hStdOutInherit) CloseHandle(hStdOutInherit);
    if (hStdErrInherit) CloseHandle(hStdErrInherit);
    if (env_block) __yo_free(env_block);
    __yo_free(cmdline);
    __yo_free(wfile);
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  STARTUPINFOW si;
  PROCESS_INFORMATION pi;
  ZeroMemory(&si, sizeof(si));
  ZeroMemory(&pi, sizeof(pi));
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdInput = hStdInInherit;
  si.hStdOutput = hStdOutInherit;
  si.hStdError = hStdErrInherit;

  DWORD flags = 0;
  if (env_block) flags |= CREATE_UNICODE_ENVIRONMENT;

  BOOL ok = CreateProcessW(NULL, cmdline, NULL, NULL, TRUE, flags, env_block, NULL, &si, &pi);

  CloseHandle(hStdInInherit);
  CloseHandle(hStdOutInherit);
  CloseHandle(hStdErrInherit);
  if (env_block) __yo_free(env_block);
  __yo_free(cmdline);
  __yo_free(wfile);

  if (!ok) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  CloseHandle(pi.hThread);
  __yo_process_add_handle((int32_t)pi.dwProcessId, pi.hProcess);
  future->result = (int32_t)pi.dwProcessId;
  atomic_init(&future->state, -1);
  return future;
}

static yo_io_future_t* __yo_async_waitpid_start(int32_t pid, int32_t options) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  HANDLE handle = __yo_process_get_handle(pid);
  if (!handle) {
    future->result = -ESRCH;
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD timeout = (options != 0) ? 0 : INFINITE;
  DWORD wait_result = WaitForSingleObject(handle, timeout);
  if (wait_result == WAIT_TIMEOUT) {
    future->result = 0;
    atomic_init(&future->state, -1);
    return future;
  }
  if (wait_result != WAIT_OBJECT_0) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  DWORD exit_code = 0;
  if (!GetExitCodeProcess(handle, &exit_code)) {
    future->result = -__yo_win_last_error_to_errno();
    atomic_init(&future->state, -1);
    return future;
  }

  __yo_process_remove_handle(pid);
  future->result = (int32_t)exit_code;
  atomic_init(&future->state, -1);
  return future;
}

static int32_t __yo_process_exit_status(int32_t status) {
  return status;
}

static int32_t __yo_process_term_signal(int32_t status) {
  (void)status;
  return 0;
}

// ============================================================================
// Signal Operations (Windows)
// ============================================================================

static void (*__yo_signal_handlers[32])(void*) = {NULL};
static void* __yo_signal_handler_data[32] = {NULL};
static bool __yo_signal_use_crt[32] = {false};

static bool __yo_win_signal_supported_by_crt(int32_t signum) {
  switch (signum) {
#ifdef SIGABRT
    case SIGABRT:
#endif
#ifdef SIGFPE
    case SIGFPE:
#endif
#ifdef SIGILL
    case SIGILL:
#endif
#ifdef SIGINT
    case SIGINT:
#endif
#ifdef SIGSEGV
    case SIGSEGV:
#endif
#ifdef SIGTERM
    case SIGTERM:
#endif
#ifdef SIGBREAK
    case SIGBREAK:
#endif
      return true;
    default:
      return false;
  }
}

static void __yo_win_signal_trampoline(int signum) {
  if (signum >= 0 && signum < 32 && __yo_signal_handlers[signum]) {
    __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
  }
}

static int32_t __yo_signal_start(int32_t signum, void* handler) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  __yo_signal_handlers[signum] = (void (*)(void*))handler;
  __yo_signal_handler_data[signum] = NULL;

  if (__yo_win_signal_supported_by_crt(signum)) {
    if (signal(signum, __yo_win_signal_trampoline) == SIG_ERR) {
      __yo_signal_handlers[signum] = NULL;
      __yo_signal_handler_data[signum] = NULL;
      __yo_signal_use_crt[signum] = false;
      return -EINVAL;
    }
    __yo_signal_use_crt[signum] = true;
  } else {
    __yo_signal_use_crt[signum] = false;
  }

  return 0;
}

static int32_t __yo_signal_stop(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  if (__yo_signal_use_crt[signum]) {
    if (signal(signum, SIG_DFL) == SIG_ERR) {
      return -EINVAL;
    }
  }

  __yo_signal_handlers[signum] = NULL;
  __yo_signal_handler_data[signum] = NULL;
  __yo_signal_use_crt[signum] = false;
  return 0;
}

static int32_t __yo_win_deliver_local_signal(int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  if (__yo_signal_handlers[signum]) {
    __yo_signal_handlers[signum](__yo_signal_handler_data[signum]);
    return 0;
  }

  if (__yo_signal_use_crt[signum]) {
    int result = raise(signum);
    return (result == 0) ? 0 : -errno;
  }

  return -ENOSYS;
}

static int32_t __yo_kill(int32_t pid, int32_t signum) {
  if (signum < 0 || signum >= 32) return -EINVAL;

  DWORD current_pid = GetCurrentProcessId();
  if (pid == 0 || (DWORD)pid == current_pid) {
    if (signum == 0) return 0;
    return __yo_win_deliver_local_signal(signum);
  }

  if (signum == 0) {
    HANDLE probe = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, (DWORD)pid);
    if (!probe) return -__yo_win_last_error_to_errno();
    CloseHandle(probe);
    return 0;
  }

  if (signum == 9) {
    HANDLE handle = __yo_process_get_handle(pid);
    bool must_close = false;
    if (!handle) {
      handle = OpenProcess(PROCESS_TERMINATE, FALSE, (DWORD)pid);
      if (!handle) return -__yo_win_last_error_to_errno();
      must_close = true;
    }

    BOOL ok = TerminateProcess(handle, 1);
    int32_t result = ok ? 0 : -__yo_win_last_error_to_errno();
    if (must_close) CloseHandle(handle);
    return result;
  }

  return -ENOSYS;
}

// ============================================================================
// TTY Operations (Windows Console API)
// ============================================================================

static DWORD __yo_orig_console_mode_in = 0;
static DWORD __yo_orig_console_mode_out = 0;
static bool __yo_console_mode_saved = false;

static int32_t __yo_tty_init(int32_t fd) {
  if (!__yo_console_mode_saved) {
    HANDLE h_in = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE h_out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (h_in != INVALID_HANDLE_VALUE) {
      GetConsoleMode(h_in, &__yo_orig_console_mode_in);
    }
    if (h_out != INVALID_HANDLE_VALUE) {
      GetConsoleMode(h_out, &__yo_orig_console_mode_out);
    }
    __yo_console_mode_saved = true;
  }
  (void)fd;
  return 0;
}

static int32_t __yo_tty_set_mode(int32_t fd, int32_t mode) {
  if (fd < 0) return -EBADF;
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) return -EBADF;

  DWORD console_mode = 0;
  if (!GetConsoleMode(handle, &console_mode)) return -ENOTTY;

  DWORD file_type = GetFileType(handle);
  bool is_input = (file_type == FILE_TYPE_CHAR);
  DWORD new_mode = 0;

  switch (mode) {
    case 0:  // TTY_MODE_NORMAL
      if (is_input) {
        new_mode = __yo_orig_console_mode_in;
      } else {
        new_mode = __yo_orig_console_mode_out;
      }
      break;
    case 1:  // TTY_MODE_RAW
      if (is_input) {
        new_mode = ENABLE_VIRTUAL_TERMINAL_INPUT;
      } else {
        new_mode = ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING | DISABLE_NEWLINE_AUTO_RETURN;
      }
      break;
    case 2:  // TTY_MODE_IO
      if (is_input) {
        new_mode = ENABLE_VIRTUAL_TERMINAL_INPUT;
      } else {
        new_mode = ENABLE_PROCESSED_OUTPUT | ENABLE_VIRTUAL_TERMINAL_PROCESSING;
      }
      break;
    default:
      return -EINVAL;
  }

  if (!SetConsoleMode(handle, new_mode)) return -__yo_win_last_error_to_errno();
  return 0;
}

static int32_t __yo_tty_reset_mode(void) {
  if (__yo_console_mode_saved) {
    HANDLE h_in = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE h_out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (h_in != INVALID_HANDLE_VALUE) {
      SetConsoleMode(h_in, __yo_orig_console_mode_in);
    }
    if (h_out != INVALID_HANDLE_VALUE) {
      SetConsoleMode(h_out, __yo_orig_console_mode_out);
    }
  }
  return 0;
}

static int32_t __yo_tty_get_winsize(int32_t fd, int32_t* width, int32_t* height) {
  if (fd < 0) return -EBADF;
  HANDLE handle = (HANDLE)_get_osfhandle(fd);
  if (handle == INVALID_HANDLE_VALUE) return -EBADF;

  CONSOLE_SCREEN_BUFFER_INFO csbi;
  if (!GetConsoleScreenBufferInfo(handle, &csbi)) {
    HANDLE h_out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (h_out == INVALID_HANDLE_VALUE || !GetConsoleScreenBufferInfo(h_out, &csbi)) {
      return -__yo_win_last_error_to_errno();
    }
  }
  *width = (int32_t)(csbi.srWindow.Right - csbi.srWindow.Left + 1);
  *height = (int32_t)(csbi.srWindow.Bottom - csbi.srWindow.Top + 1);
  return 0;
}

static int32_t __yo_isatty(int32_t fd) { return _isatty(fd) ? 1 : 0; }

// ============================================================================
// FS Events (Windows - ReadDirectoryChangesW / FindFirstChangeNotification)
// ============================================================================

typedef struct yo_fs_event_s {
  HANDLE dir_handle;
  HANDLE change_handle;
  void (*callback)(const char*, int, void*);
  void* user_data;
  int active;
  char* path;
  int is_dir;
  OVERLAPPED overlapped;
  char notify_buf[4096];
  int use_rdcw;
  struct yo_fs_event_s* next;
} yo_fs_event_t;

static yo_fs_event_t* __yo_active_fs_events = NULL;

static void* __yo_fs_event_init(void) {
  yo_fs_event_t* handle = (yo_fs_event_t*)__yo_malloc(sizeof(yo_fs_event_t));
  memset(handle, 0, sizeof(yo_fs_event_t));
  handle->dir_handle = INVALID_HANDLE_VALUE;
  handle->change_handle = INVALID_HANDLE_VALUE;
  return handle;
}

static int32_t __yo_fs_event_start(void* h, const char* path, uint32_t flags, void* callback, void* user_data) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle || !path || !callback) return -EINVAL;

  handle->path = (char*)__yo_malloc(strlen(path) + 1);
  strcpy(handle->path, path);
  handle->callback = (void (*)(const char*, int, void*))callback;
  handle->user_data = user_data;

  wchar_t* wpath = __yo_win_utf8_to_wide(path);
  if (!wpath) {
    __yo_free(handle->path);
    handle->path = NULL;
    return -EINVAL;
  }

  DWORD attrs = GetFileAttributesW(wpath);
  if (attrs == INVALID_FILE_ATTRIBUTES) {
    int err = __yo_win_last_error_to_errno();
    __yo_free(wpath);
    __yo_free(handle->path);
    handle->path = NULL;
    return -err;
  }

  handle->is_dir = (attrs & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;

  if (handle->is_dir) {
    handle->dir_handle = CreateFileW(wpath,
      FILE_LIST_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
      NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED,
      NULL);

    if (handle->dir_handle == INVALID_HANDLE_VALUE) {
      int err = __yo_win_last_error_to_errno();
      __yo_free(wpath);
      __yo_free(handle->path);
      handle->path = NULL;
      return -err;
    }
    handle->use_rdcw = 1;

    memset(&handle->overlapped, 0, sizeof(OVERLAPPED));
    handle->overlapped.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);

    BOOL watch_subtree = (flags & 4) ? TRUE : FALSE;
    DWORD filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
                   FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SIZE |
                   FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION;

    BOOL ok = ReadDirectoryChangesW(handle->dir_handle,
      handle->notify_buf, sizeof(handle->notify_buf),
      watch_subtree, filter, NULL, &handle->overlapped, NULL);

    if (!ok) {
      int err = __yo_win_last_error_to_errno();
      CloseHandle(handle->overlapped.hEvent);
      CloseHandle(handle->dir_handle);
      handle->dir_handle = INVALID_HANDLE_VALUE;
      __yo_free(wpath);
      __yo_free(handle->path);
      handle->path = NULL;
      return -err;
    }
  } else {
    wchar_t dir_part[MAX_PATH];
    wcscpy(dir_part, wpath);
    wchar_t* last_sep = wcsrchr(dir_part, L'\\');
    if (!last_sep) last_sep = wcsrchr(dir_part, L'/');
    if (last_sep) {
      *last_sep = L'\0';
    } else {
      dir_part[0] = L'.';
      dir_part[1] = L'\0';
    }

    BOOL watch_subtree = FALSE;
    DWORD filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_ATTRIBUTES |
                   FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE;

    handle->change_handle = FindFirstChangeNotificationW(dir_part, watch_subtree, filter);
    if (handle->change_handle == INVALID_HANDLE_VALUE) {
      int err = __yo_win_last_error_to_errno();
      __yo_free(wpath);
      __yo_free(handle->path);
      handle->path = NULL;
      return -err;
    }
    handle->use_rdcw = 0;
  }

  __yo_free(wpath);

  handle->active = 1;
  handle->next = __yo_active_fs_events;
  __yo_active_fs_events = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_fs_event_stop(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

  if (handle->use_rdcw) {
    if (handle->dir_handle != INVALID_HANDLE_VALUE) {
      CancelIo(handle->dir_handle);
      if (handle->overlapped.hEvent) {
        CloseHandle(handle->overlapped.hEvent);
        handle->overlapped.hEvent = NULL;
      }
      CloseHandle(handle->dir_handle);
      handle->dir_handle = INVALID_HANDLE_VALUE;
    }
  } else {
    if (handle->change_handle != INVALID_HANDLE_VALUE) {
      FindCloseChangeNotification(handle->change_handle);
      handle->change_handle = INVALID_HANDLE_VALUE;
    }
  }

  if (handle->path) {
    __yo_free(handle->path);
    handle->path = NULL;
  }

  yo_fs_event_t** pp = &__yo_active_fs_events;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_fs_event_close(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return;
  if (handle->active) __yo_fs_event_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Poll Operations (Windows - WaitForSingleObject / PeekNamedPipe / select)
// ============================================================================

typedef struct yo_poll_s {
  int fd;
  int events;
  void (*callback)(int, int, void*);
  void* user_data;
  int active;
  struct yo_poll_s* next;
} yo_poll_t;

static yo_poll_t* __yo_active_polls = NULL;

static void* __yo_poll_init(int32_t fd) {
  yo_poll_t* handle = (yo_poll_t*)__yo_malloc(sizeof(yo_poll_t));
  memset(handle, 0, sizeof(yo_poll_t));
  handle->fd = fd;
  return handle;
}

static int32_t __yo_poll_start(void* h, int32_t events, void* callback, void* user_data) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle || !callback) return -EINVAL;

  handle->events = events;
  handle->callback = (void (*)(int, int, void*))callback;
  handle->user_data = user_data;
  handle->active = 1;

  handle->next = __yo_active_polls;
  __yo_active_polls = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_poll_stop(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

  yo_poll_t** pp = &__yo_active_polls;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_poll_close(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return;
  if (handle->active) __yo_poll_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Tick function: check all active poll and fs_event handles (non-blocking)
// Called from __yo_io_poll() and __yo_io_wait()
// ============================================================================

static int __yo_poll_and_fs_event_tick(void) {
  int count = 0;

  // --- Tick FS event handles ---
  {
    yo_fs_event_t* fse = __yo_active_fs_events;
    while (fse) {
      yo_fs_event_t* next = fse->next;
      if (fse->active) {
        if (fse->use_rdcw && fse->dir_handle != INVALID_HANDLE_VALUE) {
          DWORD bytes_returned = 0;
          BOOL ok = GetOverlappedResult(fse->dir_handle, &fse->overlapped, &bytes_returned, FALSE);
          if (ok && bytes_returned > 0) {
            char* ptr = fse->notify_buf;
            while (1) {
              FILE_NOTIFY_INFORMATION* info = (FILE_NOTIFY_INFORMATION*)ptr;
              int yo_event = 0;
              switch (info->Action) {
                case FILE_ACTION_ADDED:
                case FILE_ACTION_REMOVED:
                case FILE_ACTION_RENAMED_OLD_NAME:
                case FILE_ACTION_RENAMED_NEW_NAME:
                  yo_event = 1;
                  break;
                case FILE_ACTION_MODIFIED:
                  yo_event = 2;
                  break;
              }
              if (yo_event != 0 && fse->callback && fse->active) {
                char name_buf[MAX_PATH];
                int name_len = WideCharToMultiByte(CP_UTF8, 0,
                  info->FileName, (int)(info->FileNameLength / sizeof(wchar_t)),
                  name_buf, MAX_PATH - 1, NULL, NULL);
                if (name_len > 0) {
                  name_buf[name_len] = '\0';
                } else {
                  name_buf[0] = '\0';
                }
                fse->callback(name_buf, yo_event, fse->user_data);
                count++;
              }
              if (info->NextEntryOffset == 0) break;
              ptr += info->NextEntryOffset;
            }

            ResetEvent(fse->overlapped.hEvent);
            memset(&fse->overlapped, 0, sizeof(OVERLAPPED));
            fse->overlapped.hEvent = CreateEvent(NULL, TRUE, FALSE, NULL);
            ReadDirectoryChangesW(fse->dir_handle,
              fse->notify_buf, sizeof(fse->notify_buf),
              FALSE,
              FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
              FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SIZE |
              FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION,
              NULL, &fse->overlapped, NULL);
          }
        } else if (!fse->use_rdcw && fse->change_handle != INVALID_HANDLE_VALUE) {
          DWORD wait_result = WaitForSingleObject(fse->change_handle, 0);
          if (wait_result == WAIT_OBJECT_0) {
            if (fse->callback && fse->active) {
              fse->callback("", 2, fse->user_data);
              count++;
            }
            FindNextChangeNotification(fse->change_handle);
          }
        }
      }
      fse = next;
    }
  }

  // --- Tick poll handles ---
  {
    yo_poll_t* ph = __yo_active_polls;
    while (ph) {
      yo_poll_t* next = ph->next;
      if (ph->active) {
        HANDLE handle = (HANDLE)_get_osfhandle(ph->fd);
        int yo_events = 0;

        if (handle != INVALID_HANDLE_VALUE && __yo_win_is_socket_fd(ph->fd)) {
          SOCKET sock = (SOCKET)(uintptr_t)(uint32_t)ph->fd;
          fd_set read_fds, write_fds, except_fds;
          struct timeval tv = {0, 0};

          FD_ZERO(&read_fds);
          FD_ZERO(&write_fds);
          FD_ZERO(&except_fds);

          if (ph->events & 1) FD_SET(sock, &read_fds);
          if (ph->events & 2) FD_SET(sock, &write_fds);
          FD_SET(sock, &except_fds);

          int ret = select(0, &read_fds, &write_fds, &except_fds, &tv);
          if (ret > 0) {
            if (FD_ISSET(sock, &read_fds))  yo_events |= 1;
            if (FD_ISSET(sock, &write_fds)) yo_events |= 2;
            if (FD_ISSET(sock, &except_fds)) yo_events |= 4;
          } else if (ret < 0) {
            if (ph->callback && ph->active) {
              ph->callback(0, -(int)WSAGetLastError(), ph->user_data);
              count++;
            }
            ph = next;
            continue;
          }
        } else if (handle != INVALID_HANDLE_VALUE) {
          DWORD file_type = GetFileType(handle);
          if (file_type == FILE_TYPE_PIPE) {
            if (ph->events & 1) {
              DWORD avail = 0;
              BOOL ok = PeekNamedPipe(handle, NULL, 0, NULL, &avail, NULL);
              if (ok) {
                if (avail > 0) yo_events |= 1;
              } else {
                DWORD err = GetLastError();
                if (err == ERROR_BROKEN_PIPE || err == ERROR_NO_DATA) {
                  yo_events |= 1;
                  yo_events |= 4;
                }
              }
            }
            if (ph->events & 2) {
              yo_events |= 2;
            }
          } else {
            DWORD wait_result = WaitForSingleObject(handle, 0);
            if (wait_result == WAIT_OBJECT_0) {
              if (ph->events & 1) yo_events |= 1;
            }
          }
        }

        if (yo_events != 0) {
          if (ph->callback && ph->active) {
            ph->callback(yo_events, 0, ph->user_data);
            count++;
          }
        }
      }
      ph = next;
    }
  }

  return count;
}

#endif // _WIN32


// ============================================================================
// File System Helper Functions
// ============================================================================
// These functions help extract fields from struct stat, which has platform-specific layout.

#ifndef _WIN32
#include <sys/types.h>
#include <sys/stat.h>
#include <dirent.h>
#include <string.h>
#if defined(__APPLE__)
#include <sys/dirent.h>
#include <unistd.h>
#endif

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
#if defined(_DIRENT_HAVE_D_TYPE) || defined(__APPLE__)
  return ((struct dirent*)entry)->d_type;
#else
  // d_type not available on some systems, return DT_UNKNOWN
  return 0;
#endif
}
#endif // !_WIN32

// ============================================================================
// Timer Operations (cross-platform)
// ============================================================================

#if defined(__linux__)
#include <sys/timerfd.h>

// Extended future for timer that holds timerfd and buffer for cleanup
typedef struct {
  yo_io_future_t base;
  int timerfd;
  uint64_t* read_buf;
} yo_timer_future_t;

static void __yo_timer_future_dispose(void* ptr) {
  yo_timer_future_t* tf = (yo_timer_future_t*)ptr;
  if (tf->timerfd >= 0) {
    close(tf->timerfd);
    tf->timerfd = -1;
  }
  if (tf->read_buf) {
    __yo_free(tf->read_buf);
    tf->read_buf = NULL;
  }
}

// Async sleep using timerfd + io_uring
static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();
  
  yo_timer_future_t* timer_future = (yo_timer_future_t*)__yo_malloc(sizeof(yo_timer_future_t));
  memset(timer_future, 0, sizeof(yo_timer_future_t));
  
  yo_io_future_t* future = &timer_future->base;
  future->header.ref_count = 1;
  future->header.dispose_fn = __yo_timer_future_dispose;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  timer_future->timerfd = -1;
  timer_future->read_buf = NULL;
  
  // Create a timerfd
  int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
  if (tfd < 0) {
    future->result = -errno;
    atomic_store(&future->state, -1);
    return future;
  }
  timer_future->timerfd = tfd;
  
  // Set timer to expire after milliseconds
  struct itimerspec its = {0};
  its.it_value.tv_sec = (time_t)(milliseconds / 1000);
  its.it_value.tv_nsec = (long)((milliseconds % 1000) * 1000000);
  
  if (timerfd_settime(tfd, 0, &its, NULL) < 0) {
    int err = errno;
    future->result = -err;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Use io_uring to read from timerfd (fires when timer expires)
  struct io_uring_sqe* sqe = io_uring_get_sqe(&__yo_io_ring);
  if (!sqe) {
    future->result = -EAGAIN;
    atomic_store(&future->state, -1);
    return future;
  }
  
  // Allocate buffer for timerfd read (8 bytes)
  uint64_t* buf = (uint64_t*)__yo_malloc(sizeof(uint64_t));
  timer_future->read_buf = buf;
  io_uring_prep_read(sqe, tfd, buf, sizeof(uint64_t), 0);
  io_uring_sqe_set_data(sqe, future);
  io_uring_submit(&__yo_io_ring);
  __yo_pending_io_count++;
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\n",
              (unsigned long long)milliseconds, __yo_pending_io_count);
  
  return future;
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
      fut->result = (int32_t)sizeof(uint64_t);  // Match timerfd read size on Linux
      __yo_io_wake_continuation(fut);
    }
  );
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms (pending=%zu)\n",
              (unsigned long long)milliseconds, atomic_load(&__yo_pending_io_count));
  
  return future;
}

#elif defined(_WIN32)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WINSOCKAPI_
#define _WINSOCKAPI_
#endif
#include <windows.h>

static void __yo_io_init(void);
static void __yo_win_timer_add(yo_io_future_t* future, uint64_t milliseconds);

static yo_io_future_t* __yo_async_sleep_start(uint64_t milliseconds) {
  __yo_io_init();

  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  future->header.ref_count = 1;
  atomic_init(&future->state, 0);
  future->result = 0;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  __yo_win_timer_add(future, milliseconds);
  
  ASYNC_DEBUG("[TIMER] Started async sleep: %llu ms\n", (unsigned long long)milliseconds);
  
  return future;
}

#endif

// ============================================================================
// File Extra Operations (POSIX-only)
// ============================================================================
#if !defined(_WIN32)

#if defined(__linux__)
#include <sys/sendfile.h>
#elif defined(__APPLE__)
#include <copyfile.h>
#endif

// Fallback for platforms where sendfile cannot handle all fd combinations
// (e.g. macOS sendfile requires socket destination).
#if defined(__linux__) || defined(__APPLE__)
static int32_t __yo_sendfile_fallback_copy(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
  unsigned char buffer[65536];
  size_t total = 0;

  while (total < count) {
    size_t remaining = count - total;
    size_t chunk = remaining < sizeof(buffer) ? remaining : sizeof(buffer);

    ssize_t nread = pread(in_fd, buffer, chunk, (off_t)(offset + (int64_t)total));
    if (nread < 0) {
      return -errno;
    }
    if (nread == 0) {
      break;
    }

    size_t written = 0;
    while (written < (size_t)nread) {
      ssize_t nwrite = write(out_fd, buffer + written, (size_t)nread - written);
      if (nwrite < 0) {
        return -errno;
      }
      written += (size_t)nwrite;
    }

    total += (size_t)nread;
  }

  return (int32_t)total;
}
#endif

// ============================================================================
// Synchronous Operations (POSIX-only) - no IOFuture overhead
// ============================================================================

static int32_t __yo_sync_access(int32_t dirfd, const char* path, int32_t mode) {
  int result;
  if (dirfd == -100) {  // AT_FDCWD
    result = access(path, mode);
  } else {
    result = faccessat(dirfd, path, mode, 0);
  }
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_realpath(const char* path, char* resolved) {
  char* result = realpath(path, resolved);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkdtemp(char* template) {
  char* result = mkdtemp(template);
  return result ? 0 : -errno;
}

static int32_t __yo_sync_mkstemp(char* template) {
  int fd = mkstemp(template);
  return (fd < 0) ? -errno : fd;
}

static int32_t __yo_sync_copyfile(const char* src, const char* dst, int32_t flags) {
#if defined(__linux__)
  int src_fd = open(src, O_RDONLY);
  if (src_fd < 0) return -errno;

  struct stat st;
  if (fstat(src_fd, &st) < 0) {
    int err = errno;
    close(src_fd);
    return -err;
  }

  int open_flags = O_WRONLY | O_CREAT | O_TRUNC;
  if (flags & 1) open_flags |= O_EXCL;

  int dst_fd = open(dst, open_flags, st.st_mode);
  if (dst_fd < 0) {
    int err = errno;
    close(src_fd);
    return -err;
  }

  ssize_t copied = 0;
  off_t off_in = 0;
#ifdef __NR_copy_file_range
  copied = syscall(__NR_copy_file_range, src_fd, &off_in, dst_fd, NULL, (size_t)st.st_size, 0);
#endif
  if (copied < 0) {
    off_t offset = 0;
    copied = sendfile(dst_fd, src_fd, &offset, (size_t)st.st_size);
  }

  close(src_fd);
  close(dst_fd);
  return (copied < 0) ? -errno : 0;

#elif defined(__APPLE__)
  copyfile_flags_t cf_flags = COPYFILE_ALL;
  if (flags & 1) cf_flags |= COPYFILE_EXCL;
  if (flags & 2) cf_flags |= COPYFILE_CLONE;
  if (flags & 4) cf_flags |= COPYFILE_CLONE_FORCE;

  int result = copyfile(src, dst, NULL, cf_flags);
  return (result < 0) ? -errno : 0;
#else
  (void)src; (void)dst; (void)flags;
  return -ENOSYS;
#endif
}

static int32_t __yo_sync_sendfile(int32_t out_fd, int32_t in_fd, int64_t offset, size_t count) {
#if defined(__linux__)
  off_t off = (off_t)offset;
  ssize_t sent = sendfile(out_fd, in_fd, &off, count);
  return (sent < 0) ? -errno : (int32_t)sent;
#elif defined(__APPLE__)
  off_t len = (off_t)count;
  int result = sendfile(in_fd, out_fd, (off_t)offset, &len, NULL, 0);
  if (result < 0) {
    if (errno == ENOTSOCK || errno == EINVAL || errno == ENOSYS) {
      return __yo_sendfile_fallback_copy(out_fd, in_fd, offset, count);
    }
    return -errno;
  }
  return (int32_t)len;
#else
  (void)out_fd; (void)in_fd; (void)offset; (void)count;
  return -ENOSYS;
#endif
}

static int32_t __yo_sync_utime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                               int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, 0);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_futime(int32_t fd, int64_t atime_sec, int64_t atime_nsec,
                                int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = futimens(fd, times);
  return (result < 0) ? -errno : 0;
}

static int32_t __yo_sync_lutime(const char* path, int64_t atime_sec, int64_t atime_nsec,
                                int64_t mtime_sec, int64_t mtime_nsec) {
  struct timespec times[2];
  times[0].tv_sec = (time_t)atime_sec;
  times[0].tv_nsec = (long)atime_nsec;
  times[1].tv_sec = (time_t)mtime_sec;
  times[1].tv_nsec = (long)mtime_nsec;
  int result = utimensat(AT_FDCWD, path, times, AT_SYMLINK_NOFOLLOW);
  return (result < 0) ? -errno : 0;
}

// Statfs support
#include <sys/statvfs.h>

static int32_t __yo_sync_statfs(const char* path, void* buf) {
  int result = statvfs(path, (struct statvfs*)buf);
  return (result < 0) ? -errno : 0;
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
#include <sys/syscall.h>
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
  
  // macOS doesn't have getdents; emulate using readdir on a dup()'d fd
  int dup_fd = dup(fd);
  if (dup_fd < 0) {
    future->result = -errno;
    atomic_init(&future->state, -1);
    return future;
  }

  DIR* dir = fdopendir(dup_fd);
  if (!dir) {
    int err = errno;
    close(dup_fd);
    future->result = -err;
    atomic_init(&future->state, -1);
    return future;
  }

  int dir_fd = dirfd(dir);
  size_t total = 0;
  long last_pos = telldir(dir);
  struct dirent* entry = NULL;

  while ((entry = readdir(dir)) != NULL) {
    size_t reclen = (size_t)entry->d_reclen;
    if (entry->d_type == DT_UNKNOWN) {
      struct stat st;
      if (dir_fd >= 0 && fstatat(dir_fd, entry->d_name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        if (S_ISDIR(st.st_mode)) {
          entry->d_type = DT_DIR;
        } else if (S_ISREG(st.st_mode)) {
          entry->d_type = DT_REG;
        } else if (S_ISLNK(st.st_mode)) {
          entry->d_type = DT_LNK;
        } else if (S_ISCHR(st.st_mode)) {
          entry->d_type = DT_CHR;
        } else if (S_ISBLK(st.st_mode)) {
          entry->d_type = DT_BLK;
        } else if (S_ISFIFO(st.st_mode)) {
          entry->d_type = DT_FIFO;
        } else if (S_ISSOCK(st.st_mode)) {
          entry->d_type = DT_SOCK;
        } else {
          entry->d_type = DT_UNKNOWN;
        }
      }
    }
    if (total + reclen > (size_t)buf_size) {
      // Roll back to the previous position so the entry is returned next time
      seekdir(dir, last_pos);
      break;
    }
    memcpy((char*)buf + total, entry, reclen);
    total += reclen;
    last_pos = telldir(dir);
  }

  closedir(dir);  // closes dup_fd
  future->result = (int32_t)total;
  atomic_init(&future->state, -1);
  
  return future;
}
#endif

// ============================================================================
// DNS Operations
// ============================================================================
#include <netdb.h>

static yo_io_future_t* __yo_async_getaddrinfo_start(const uint8_t* node, const uint8_t* service,
                                                     const uint8_t* hints, uint8_t** result) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  struct addrinfo* res = NULL;
  int ret = getaddrinfo((const char*)node, (const char*)service, (const struct addrinfo*)hints, &res);
  
  if (ret == 0) {
    *result = (uint8_t*)res;
    future->result = 0;
  } else {
    future->result = ret;  // Return raw gai error code (already negative on glibc)
  }
  atomic_init(&future->state, -1);
  
  return future;
}

static yo_io_future_t* __yo_async_getnameinfo_start(const uint8_t* addr, uint32_t addrlen,
                                                     uint8_t* host, size_t hostlen,
                                                     uint8_t* service, size_t servlen, int32_t flags) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));
  
  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);
  
  int ret = getnameinfo((const struct sockaddr*)addr, (socklen_t)addrlen,
                        (char*)host, (socklen_t)hostlen, (char*)service, (socklen_t)servlen, flags);
  future->result = ret;  // Return raw gai error code
  atomic_init(&future->state, -1);
  
  return future;
}

static void __yo_freeaddrinfo(uint8_t* res) {
  if (res) freeaddrinfo((struct addrinfo*)res);
}

static size_t __yo_addrinfo_size(void) {
  return sizeof(struct addrinfo);
}

static int32_t __yo_addrinfo_flags(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_flags;
}

static int32_t __yo_addrinfo_family(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_family;
}

static int32_t __yo_addrinfo_socktype(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_socktype;
}

static int32_t __yo_addrinfo_protocol(uint8_t* ai) {
  return ((struct addrinfo*)ai)->ai_protocol;
}

static uint32_t __yo_addrinfo_addrlen(uint8_t* ai) {
  return (uint32_t)((struct addrinfo*)ai)->ai_addrlen;
}

static uint8_t* __yo_addrinfo_addr(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_addr;
}

static uint8_t* __yo_addrinfo_canonname(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_canonname;
}

static uint8_t* __yo_addrinfo_next(uint8_t* ai) {
  return (uint8_t*)((struct addrinfo*)ai)->ai_next;
}

// ============================================================================
// Process Operations
// ============================================================================
#include <spawn.h>
#include <sys/wait.h>

extern char** environ;

static yo_io_future_t* __yo_async_spawn_start(const uint8_t* file, uint8_t** argv, uint8_t** envp,
                                              int32_t stdin_fd, int32_t stdout_fd, int32_t stderr_fd) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  posix_spawn_file_actions_t actions;
  posix_spawn_file_actions_init(&actions);

  if (stdin_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stdin_fd, 0);
  }
  if (stdout_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stdout_fd, 1);
  }
  if (stderr_fd >= 0) {
    posix_spawn_file_actions_adddup2(&actions, stderr_fd, 2);
  }

  pid_t pid = 0;
  char* const* envp_actual = envp ? (char* const*)envp : environ;
  int result = posix_spawnp(&pid, (const char*)file, &actions, NULL, (char* const*)argv, envp_actual);
  posix_spawn_file_actions_destroy(&actions);

  if (result != 0) {
    future->result = -result;
  } else {
    future->result = (int32_t)pid;
  }
  atomic_init(&future->state, -1);

  return future;
}

static yo_io_future_t* __yo_async_waitpid_start(int32_t pid, int32_t options) {
  yo_io_future_t* future = (yo_io_future_t*)__yo_malloc(sizeof(yo_io_future_t));
  memset(future, 0, sizeof(yo_io_future_t));

  future->header.ref_count = 1;
  atomic_init(&future->continuation_fn, NULL);
  atomic_init(&future->continuation_sm, NULL);

  int status = 0;
  pid_t result = waitpid((pid_t)pid, &status, options);
  if (result < 0) {
    future->result = -errno;
  } else if (result == 0) {
    // WNOHANG and child still running
    future->result = 0;
  } else {
    future->result = status;
  }
  atomic_init(&future->state, -1);

  return future;
}

static int32_t __yo_process_exit_status(int32_t status) {
  if (WIFEXITED(status)) {
    return (int32_t)WEXITSTATUS(status);
  }
  return -1;
}

static int32_t __yo_process_term_signal(int32_t status) {
  if (WIFSIGNALED(status)) {
    return (int32_t)WTERMSIG(status);
  }
  return 0;
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
// FS Event Operations (inotify on Linux, kqueue on macOS)
// ============================================================================

#include <poll.h>
#if defined(__linux__)
#include <sys/inotify.h>
#elif defined(__APPLE__)
#include <sys/event.h>

typedef struct yo_fs_event_entry_s {
  char* name;
  int64_t mtime_sec;
  int64_t mtime_nsec;
  int64_t size;
  struct yo_fs_event_entry_s* next;
} yo_fs_event_entry_t;
#endif

typedef struct yo_fs_event_s {
  int fd;
  int watch_fd;
  void (*callback)(const char*, int, void*);
  void* user_data;
  int active;
#if defined(__APPLE__)
  char* path;
  int is_dir;
  int exists;
  int64_t mtime_sec;
  int64_t mtime_nsec;
  int64_t size;
  yo_fs_event_entry_t* entries;
#endif
  struct yo_fs_event_s* next;
} yo_fs_event_t;

static yo_fs_event_t* __yo_active_fs_events = NULL;

#if defined(__APPLE__)
static void __yo_fs_event_free_entries(yo_fs_event_entry_t* head) {
  while (head) {
    yo_fs_event_entry_t* next = head->next;
    if (head->name) __yo_free(head->name);
    __yo_free(head);
    head = next;
  }
}

static yo_fs_event_entry_t* __yo_fs_event_find_entry(yo_fs_event_entry_t* head, const char* name) {
  while (head) {
    if (strcmp(head->name, name) == 0) {
      return head;
    }
    head = head->next;
  }
  return NULL;
}

static yo_fs_event_entry_t* __yo_fs_event_snapshot_dir(const char* path, int* err_out) {
  *err_out = 0;
  DIR* dir = opendir(path);
  if (!dir) {
    *err_out = errno;
    return NULL;
  }

  yo_fs_event_entry_t* head = NULL;
  struct dirent* ent = NULL;
  while ((ent = readdir(dir)) != NULL) {
    if ((strcmp(ent->d_name, ".") == 0) || (strcmp(ent->d_name, "..") == 0)) {
      continue;
    }

    size_t path_len = strlen(path);
    size_t name_len = strlen(ent->d_name);
    char* full_path = (char*)__yo_malloc(path_len + 1 + name_len + 1);
    memcpy(full_path, path, path_len);
    full_path[path_len] = '/';
    memcpy(full_path + path_len + 1, ent->d_name, name_len + 1);

    struct stat st;
    if (stat(full_path, &st) == 0) {
      yo_fs_event_entry_t* node = (yo_fs_event_entry_t*)__yo_malloc(sizeof(yo_fs_event_entry_t));
      memset(node, 0, sizeof(yo_fs_event_entry_t));
      node->name = (char*)__yo_malloc(name_len + 1);
      memcpy(node->name, ent->d_name, name_len + 1);
      node->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
      node->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
      node->size = (int64_t)st.st_size;
      node->next = head;
      head = node;
    }

    __yo_free(full_path);
  }

  closedir(dir);
  return head;
}

static int __yo_fs_event_detect_snapshot_changes(yo_fs_event_t* handle) {
  int yo_event = 0;

  if (handle->is_dir) {
    int snap_err = 0;
    yo_fs_event_entry_t* next_entries = __yo_fs_event_snapshot_dir(handle->path, &snap_err);
    if (snap_err != 0) {
      if (snap_err == ENOENT) {
        yo_event |= 1; // FS_EVENT_RENAME
      }
      return yo_event;
    }

    yo_fs_event_entry_t* ne = next_entries;
    while (ne) {
      yo_fs_event_entry_t* oe = __yo_fs_event_find_entry(handle->entries, ne->name);
      if (!oe) {
        yo_event |= 1; // FS_EVENT_RENAME (create)
      } else if ((oe->mtime_sec != ne->mtime_sec) ||
                 (oe->mtime_nsec != ne->mtime_nsec) ||
                 (oe->size != ne->size)) {
        yo_event |= 2; // FS_EVENT_CHANGE (modify)
      }
      ne = ne->next;
    }

    yo_fs_event_entry_t* oe = handle->entries;
    while (oe) {
      if (!__yo_fs_event_find_entry(next_entries, oe->name)) {
        yo_event |= 1; // FS_EVENT_RENAME (delete)
      }
      oe = oe->next;
    }

    __yo_fs_event_free_entries(handle->entries);
    handle->entries = next_entries;
    return yo_event;
  }

  struct stat st;
  if (stat(handle->path, &st) < 0) {
    if (errno == ENOENT && handle->exists) {
      handle->exists = 0;
      return 1; // FS_EVENT_RENAME (delete)
    }
    return 0;
  }

  if (!handle->exists) {
    handle->exists = 1;
    handle->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
    handle->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
    handle->size = (int64_t)st.st_size;
    return 1; // FS_EVENT_RENAME (create)
  }

  if ((handle->mtime_sec != (int64_t)st.st_mtimespec.tv_sec) ||
      (handle->mtime_nsec != (int64_t)st.st_mtimespec.tv_nsec) ||
      (handle->size != (int64_t)st.st_size)) {
    handle->mtime_sec = (int64_t)st.st_mtimespec.tv_sec;
    handle->mtime_nsec = (int64_t)st.st_mtimespec.tv_nsec;
    handle->size = (int64_t)st.st_size;
    return 2; // FS_EVENT_CHANGE
  }

  return 0;
}
#endif

static void* __yo_fs_event_init(void) {
  yo_fs_event_t* handle = (yo_fs_event_t*)__yo_malloc(sizeof(yo_fs_event_t));
  memset(handle, 0, sizeof(yo_fs_event_t));
  handle->fd = -1;
  handle->watch_fd = -1;
#if defined(__APPLE__)
  handle->path = NULL;
  handle->entries = NULL;
#endif
  return handle;
}

static int32_t __yo_fs_event_start(void* h, const char* path, uint32_t flags, void* callback, void* user_data) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle || !path || !callback) return -EINVAL;

#if defined(__linux__)
  handle->fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
  if (handle->fd < 0) return -errno;

  uint32_t mask = IN_MODIFY | IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO | IN_ATTRIB;
  if (flags & 4) mask |= IN_ISDIR; // FS_EVENT_RECURSIVE hint (inotify doesn't do recursive natively)
  handle->watch_fd = inotify_add_watch(handle->fd, path, mask);
  if (handle->watch_fd < 0) {
    int err = errno;
    close(handle->fd);
    handle->fd = -1;
    return -err;
  }
#elif defined(__APPLE__)
  handle->path = (char*)__yo_malloc(strlen(path) + 1);
  strcpy(handle->path, path);

  struct stat path_st;
  if (stat(path, &path_st) < 0) {
    int err = errno;
    __yo_free(handle->path);
    handle->path = NULL;
    return -err;
  }
  handle->is_dir = S_ISDIR(path_st.st_mode) ? 1 : 0;
  handle->exists = 1;
  handle->mtime_sec = (int64_t)path_st.st_mtimespec.tv_sec;
  handle->mtime_nsec = (int64_t)path_st.st_mtimespec.tv_nsec;
  handle->size = (int64_t)path_st.st_size;

  if (handle->is_dir) {
    int snap_err = 0;
    handle->entries = __yo_fs_event_snapshot_dir(path, &snap_err);
    if (snap_err != 0) {
      __yo_free(handle->path);
      handle->path = NULL;
      return -snap_err;
    }
  }

  // Open the path to get an fd for kqueue EVFILT_VNODE
  handle->fd = open(path, O_EVTONLY | O_CLOEXEC);
  if (handle->fd < 0) {
    int err = errno;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }

  handle->watch_fd = kqueue();
  if (handle->watch_fd < 0) {
    int err = errno;
    close(handle->fd);
    handle->fd = -1;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }

  // Register EVFILT_VNODE for common file/directory changes
  struct kevent ev;
  unsigned int fflags = NOTE_WRITE | NOTE_DELETE | NOTE_RENAME | NOTE_ATTRIB | NOTE_EXTEND;
  EV_SET(&ev, handle->fd, EVFILT_VNODE, EV_ADD | EV_CLEAR, fflags, 0, NULL);
  if (kevent(handle->watch_fd, &ev, 1, NULL, 0, NULL) < 0) {
    int err = errno;
    close(handle->watch_fd);
    close(handle->fd);
    handle->fd = -1;
    handle->watch_fd = -1;
    if (handle->entries) {
      __yo_fs_event_free_entries(handle->entries);
      handle->entries = NULL;
    }
    if (handle->path) {
      __yo_free(handle->path);
      handle->path = NULL;
    }
    return -err;
  }
#else
  return -ENOTSUP;
#endif

  handle->callback = (void (*)(const char*, int, void*))callback;
  handle->user_data = user_data;
  handle->active = 1;

  // Add to linked list
  handle->next = __yo_active_fs_events;
  __yo_active_fs_events = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_fs_event_stop(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

#if defined(__linux__)
  if (handle->watch_fd >= 0 && handle->fd >= 0) {
    inotify_rm_watch(handle->fd, handle->watch_fd);
    handle->watch_fd = -1;
  }
  if (handle->fd >= 0) {
    close(handle->fd);
    handle->fd = -1;
  }
#elif defined(__APPLE__)
  if (handle->watch_fd >= 0) {
    close(handle->watch_fd);
    handle->watch_fd = -1;
  }
  if (handle->fd >= 0) {
    close(handle->fd);
    handle->fd = -1;
  }
  if (handle->entries) {
    __yo_fs_event_free_entries(handle->entries);
    handle->entries = NULL;
  }
  if (handle->path) {
    __yo_free(handle->path);
    handle->path = NULL;
  }
#endif

  // Remove from linked list
  yo_fs_event_t** pp = &__yo_active_fs_events;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_fs_event_close(void* h) {
  yo_fs_event_t* handle = (yo_fs_event_t*)h;
  if (!handle) return;
  if (handle->active) __yo_fs_event_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Poll Operations (POSIX poll() on Linux/macOS)
// ============================================================================

typedef struct yo_poll_s {
  int fd;
  int events;
  void (*callback)(int, int, void*);
  void* user_data;
  int active;
  struct yo_poll_s* next;
} yo_poll_t;

static yo_poll_t* __yo_active_polls = NULL;

static void* __yo_poll_init(int32_t fd) {
  yo_poll_t* handle = (yo_poll_t*)__yo_malloc(sizeof(yo_poll_t));
  memset(handle, 0, sizeof(yo_poll_t));
  handle->fd = fd;
  return handle;
}

static int32_t __yo_poll_start(void* h, int32_t events, void* callback, void* user_data) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle || !callback) return -EINVAL;

  handle->events = events;
  handle->callback = (void (*)(int, int, void*))callback;
  handle->user_data = user_data;
  handle->active = 1;

  // Add to linked list
  handle->next = __yo_active_polls;
  __yo_active_polls = handle;
  __yo_active_watch_count++;
  return 0;
}

static int32_t __yo_poll_stop(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return -EINVAL;
  if (!handle->active) return 0;

  handle->active = 0;
  __yo_active_watch_count--;

  // Remove from linked list
  yo_poll_t** pp = &__yo_active_polls;
  while (*pp) {
    if (*pp == handle) {
      *pp = handle->next;
      break;
    }
    pp = &(*pp)->next;
  }
  handle->next = NULL;
  return 0;
}

static void __yo_poll_close(void* h) {
  yo_poll_t* handle = (yo_poll_t*)h;
  if (!handle) return;
  if (handle->active) __yo_poll_stop(h);
  __yo_free(handle);
}

// ============================================================================
// Tick function: check all active poll and fs_event handles (non-blocking)
// Called from __yo_io_poll() in platform-specific runtime files.
// ============================================================================

static int __yo_poll_and_fs_event_tick(void) {
  int count = 0;

  // --- Tick FS event handles ---
#if defined(__linux__)
  {
    yo_fs_event_t* fse = __yo_active_fs_events;
    while (fse) {
      yo_fs_event_t* next = fse->next;
      if (fse->active && fse->fd >= 0) {
        char buf[4096] __attribute__((aligned(__alignof__(struct inotify_event))));
        ssize_t len = read(fse->fd, buf, sizeof(buf));
        if (len > 0) {
          char* ptr = buf;
          while (ptr < buf + len) {
            struct inotify_event* event = (struct inotify_event*)ptr;
            int yo_event = 0;
            if (event->mask & (IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO)) {
              yo_event = 1; // FS_EVENT_RENAME
            }
            if (event->mask & (IN_MODIFY | IN_ATTRIB)) {
              yo_event |= 2; // FS_EVENT_CHANGE
            }
            const char* name = (event->len > 0) ? event->name : "";
            if (fse->callback && fse->active) {
              fse->callback(name, yo_event, fse->user_data);
              count++;
            }
            ptr += sizeof(struct inotify_event) + event->len;
          }
        }
      }
      fse = next;
    }
  }
#elif defined(__APPLE__)
  {
    yo_fs_event_t* fse = __yo_active_fs_events;
    while (fse) {
      yo_fs_event_t* next = fse->next;
      if (fse->active && fse->watch_fd >= 0) {
        int yo_event = __yo_fs_event_detect_snapshot_changes(fse);

        struct kevent ev;
        struct timespec ts = {0, 0}; // Non-blocking
        int n = kevent(fse->watch_fd, NULL, 0, &ev, 1, &ts);
        if (n > 0) {
          if (ev.fflags & (NOTE_DELETE | NOTE_RENAME)) {
            yo_event |= 1; // FS_EVENT_RENAME
          }
          if (ev.fflags & (NOTE_WRITE | NOTE_ATTRIB | NOTE_EXTEND)) {
            yo_event |= 2; // FS_EVENT_CHANGE
          }
        }

        if (yo_event != 0) {
          if (fse->callback && fse->active) {
            fse->callback("", yo_event, fse->user_data);
            count++;
          }
        }
      }
      fse = next;
    }
  }
#endif

  // --- Tick poll handles ---
  {
    yo_poll_t* ph = __yo_active_polls;
    while (ph) {
      yo_poll_t* next = ph->next;
      if (ph->active) {
        struct pollfd pfd;
        pfd.fd = ph->fd;
        pfd.events = 0;
        if (ph->events & 1) pfd.events |= POLLIN;   // POLL_READABLE
        if (ph->events & 2) pfd.events |= POLLOUT;  // POLL_WRITABLE
        if (ph->events & 8) pfd.events |= POLLPRI;  // POLL_PRIORITIZED
        pfd.revents = 0;

        int ret = poll(&pfd, 1, 0); // Non-blocking
        if (ret > 0) {
          int yo_events = 0;
          if (pfd.revents & POLLIN)  yo_events |= 1; // POLL_READABLE
          if (pfd.revents & POLLOUT) yo_events |= 2; // POLL_WRITABLE
          if (pfd.revents & POLLHUP) yo_events |= 4; // POLL_DISCONNECT
          if (pfd.revents & POLLPRI) yo_events |= 8; // POLL_PRIORITIZED
          if (ph->callback && ph->active) {
            ph->callback(yo_events, 0, ph->user_data);
            count++;
          }
        } else if (ret < 0) {
          if (ph->callback && ph->active) {
            ph->callback(0, -errno, ph->user_data);
            count++;
          }
        }
      }
      ph = next;
    }
  }

  return count;
}

#endif // !defined(_WIN32) - End of POSIX-only File Extra Operations


// ============================================================================
// Parallelism Runtime - Thread and Worker
// ============================================================================

// ============================================================================
// Thread - Dedicated OS Thread
// ============================================================================
// Simple wrapper around pthread. Each Thread runs on its own OS thread.
// - spawn: create new OS thread with closure (returns by value)
// - join: wait for thread to complete
//
// Note: __yo_thread_t and __yo_thread_fn are defined in the GC runtime types section
// to ensure they're available before user struct types that depend on them.

// Thread entry point wrapper
typedef struct __yo_thread_entry_args_t {
  __yo_thread_fn fn;            // User's function
  void* closure;                // User's closure data
} __yo_thread_entry_args_t;

// Thread entry point - Windows uses different signature
#if defined(_WIN32)
static unsigned __stdcall __yo_thread_entry(void* arg) {
#else
static void* __yo_thread_entry(void* arg) {
#endif
  __yo_thread_entry_args_t* args = (__yo_thread_entry_args_t*)arg;
  
  PARALLELISM_DEBUG("[THREAD] Thread started (tid=%zu)\n", (size_t)__yo_get_thread_id());
  
  // Initialize thread-local GC for this thread
  __yo_gc_init_thread();
  
  // Call user's function with closure
  args->fn(args->closure);
  
  PARALLELISM_DEBUG("[THREAD] Thread completed (tid=%zu)\n", (size_t)__yo_get_thread_id());
  
  // Cleanup thread-local GC
  __yo_gc_collect();
  
  // Free the closure data (heap-allocated by codegen)
  if (args->closure) {
    __yo_free(args->closure);
  }
  
  // Free args
  __yo_free(args);
  
#if defined(_WIN32)
  return 0;
#else
  return NULL;
#endif
}

// Spawn a new OS thread (returns by value)
// The codegen will handle extracting the closure function pointer and data
__yo_thread_t __yo_thread_spawn(__yo_thread_fn fn, void* closure) {
  PARALLELISM_DEBUG("[THREAD] Spawning new thread\n");
  
  __yo_thread_t thread;
  
  // Allocate entry args
  __yo_thread_entry_args_t* args = (__yo_thread_entry_args_t*)__yo_malloc(sizeof(__yo_thread_entry_args_t));
  args->fn = fn;
  args->closure = closure;
  
  // Create OS thread
  int ret = yo_thread_create(&thread.handle, __yo_thread_entry, args);
  if (ret != 0) {
    PARALLELISM_DEBUG("[THREAD] Failed to create thread (ret=%d)\n", ret);
    __yo_free(args);
    // Return invalid thread handle (handle will be 0/NULL)
    thread.handle = (YO_THREAD_TYPE){0};
  }
  
  PARALLELISM_DEBUG("[THREAD] Spawned thread\n");
  return thread;
}

// Wait for thread to complete
void __yo_thread_join(__yo_thread_t thread) {
  PARALLELISM_DEBUG("[THREAD] Joining thread\n");
  yo_thread_join(thread.handle);
  PARALLELISM_DEBUG("[THREAD] Thread joined\n");
}

// ============================================================================
// Worker - Thread Pool with Thread Affinity
// ============================================================================
// Worker spawns tasks on a thread pool. Each task has thread affinity:
// tasks are distributed round-robin to worker threads and stay on their
// assigned thread (no work stealing).
//
// Thread-per-core: By default, one worker thread per CPU core.
// Thread affinity: Each task runs on a specific worker thread.
// Thread-local GC: Each worker thread has its own GC heap.

// Task node for per-thread task queue
typedef struct __yo_worker_task_t {
  __yo_thread_fn fn;                    // Task function
  void* closure;                        // Task closure data
  struct __yo_worker_task_t* next;      // Next task in queue
} __yo_worker_task_t;

// Per-worker-thread state
typedef struct __yo_worker_thread_t {
  YO_THREAD_TYPE handle;                // OS thread handle
  YO_THREAD_SYNC_TYPE mutex;            // Mutex for task queue
  YO_COND_TYPE cond;                    // Condition variable for task availability
  __yo_worker_task_t* queue_head;       // Head of task queue
  __yo_worker_task_t* queue_tail;       // Tail of task queue
  volatile int shutdown;                // Shutdown flag
  volatile int running;                 // Thread running flag
  volatile int started;                 // Thread has started executing
} __yo_worker_thread_t;

// Global worker pool state
static __yo_worker_thread_t* __yo_worker_threads = NULL;  // Array of worker threads
static size_t __yo_worker_num_threads = 0;                // Number of worker threads
static size_t __yo_worker_next_thread = 0;                // Round-robin counter for task distribution
#if defined(_WIN32)
static YO_THREAD_SYNC_TYPE __yo_worker_pool_mutex;        // Pool-level mutex (initialized in __yo_worker_init_mutex)
static volatile int __yo_worker_pool_mutex_initialized = 0;
#else
static YO_THREAD_SYNC_TYPE __yo_worker_pool_mutex = YO_THREAD_SYNC_INIT;  // Pool-level mutex
#endif
static volatile int __yo_worker_pool_initialized = 0;     // Pool initialization flag

#if defined(_WIN32)
// Initialize the worker pool mutex on Windows (must be called before any use)
static void __yo_worker_init_mutex(void) {
  if (!__yo_worker_pool_mutex_initialized) {
    InitializeCriticalSection(&__yo_worker_pool_mutex);
    __yo_worker_pool_mutex_initialized = 1;
  }
}
#endif

// Worker thread entry point - Windows uses different signature
#if defined(_WIN32)
static unsigned __stdcall __yo_worker_thread_entry(void* arg) {
#else
static void* __yo_worker_thread_entry(void* arg) {
#endif
  __yo_worker_thread_t* worker = (__yo_worker_thread_t*)arg;
  
  PARALLELISM_DEBUG("[WORKER] Worker thread started (tid=%zu)\n", (size_t)__yo_get_thread_id());
  
  // Initialize thread-local GC for this worker thread
  __yo_gc_init_thread();
  
  // Signal that this thread has started
  worker->started = 1;
  
  while (1) {
    __yo_worker_task_t* task = NULL;
    
    // Wait for a task
    yo_mutex_lock(&worker->mutex);
    while (worker->queue_head == NULL && !worker->shutdown) {
      yo_cond_wait(&worker->cond, &worker->mutex);
    }
    
    // Check for shutdown
    if (worker->shutdown && worker->queue_head == NULL) {
      yo_mutex_unlock(&worker->mutex);
      break;
    }
    
    // Dequeue task
    task = worker->queue_head;
    if (task != NULL) {
      worker->queue_head = task->next;
      if (worker->queue_head == NULL) {
        worker->queue_tail = NULL;
      }
    }
    yo_mutex_unlock(&worker->mutex);
    
    // Execute task
    if (task != NULL) {
      PARALLELISM_DEBUG("[WORKER] Executing task (tid=%zu)\n", (size_t)__yo_get_thread_id());
      task->fn(task->closure);
      
      // Free task closure and task node
      if (task->closure) {
        __yo_free(task->closure);
      }
      __yo_free(task);
      
      // Run GC after task completion to clean up any cycles
      __yo_gc_collect();
    }
  }
  
  PARALLELISM_DEBUG("[WORKER] Worker thread exiting (tid=%zu)\n", (size_t)__yo_get_thread_id());
  
  // Final GC cleanup
  __yo_gc_collect();
  
#if defined(_WIN32)
  return 0;
#else
  return NULL;
#endif
}

// Initialize the worker pool with the specified number of threads
static void __yo_worker_pool_shutdown(void);  // Forward declaration
static void __yo_worker_pool_init(size_t num_threads) {
  if (__yo_worker_pool_initialized) {
    return;
  }
  
  PARALLELISM_DEBUG("[WORKER] Initializing worker pool with %zu threads\n", num_threads);
  
  __yo_worker_threads = (__yo_worker_thread_t*)__yo_malloc(sizeof(__yo_worker_thread_t) * num_threads);
  __yo_worker_num_threads = num_threads;
  __yo_worker_next_thread = 0;
  
  for (size_t i = 0; i < num_threads; i++) {
    __yo_worker_thread_t* worker = &__yo_worker_threads[i];
    yo_mutex_init(&worker->mutex);
    yo_cond_init(&worker->cond);
    worker->queue_head = NULL;
    worker->queue_tail = NULL;
    worker->shutdown = 0;
    worker->running = 1;
    worker->started = 0;
    
    int ret = yo_thread_create(&worker->handle, __yo_worker_thread_entry, worker);
    if (ret != 0) {
      PARALLELISM_DEBUG("[WORKER] Failed to create worker thread %zu (ret=%d)\n", i, ret);
      worker->running = 0;
      worker->started = 1;  // Mark as "started" to avoid waiting forever
    }
  }
  
  // Wait for all worker threads to start
  for (size_t i = 0; i < num_threads; i++) {
    __yo_worker_thread_t* worker = &__yo_worker_threads[i];
    while (!worker->started) {
      // Busy wait with yield to let threads start
#if defined(_WIN32)
      SwitchToThread();
#else
      sched_yield();
#endif
    }
  }
  
  __yo_worker_pool_initialized = 1;
  
  // Register shutdown handler via atexit (runs LIFO, so registered last = runs first)
  atexit(__yo_worker_pool_shutdown);
  
  PARALLELISM_DEBUG("[WORKER] Worker pool initialized\n");
}

// Shutdown the worker pool
static void __yo_worker_pool_shutdown(void) {
  if (!__yo_worker_pool_initialized) {
    return;
  }
  
  PARALLELISM_DEBUG("[WORKER] Shutting down worker pool\n");
  
  // Signal all workers to shutdown
  for (size_t i = 0; i < __yo_worker_num_threads; i++) {
    __yo_worker_thread_t* worker = &__yo_worker_threads[i];
    yo_mutex_lock(&worker->mutex);
    worker->shutdown = 1;
    yo_cond_signal(&worker->cond);
    yo_mutex_unlock(&worker->mutex);
  }
  
  // Wait for all workers to finish
  for (size_t i = 0; i < __yo_worker_num_threads; i++) {
    __yo_worker_thread_t* worker = &__yo_worker_threads[i];
    if (worker->running) {
      yo_thread_join(worker->handle);
    }
    yo_mutex_destroy(&worker->mutex);
    yo_cond_destroy(&worker->cond);
    
    // Free any remaining tasks in queue (shouldn't happen normally)
    __yo_worker_task_t* task = worker->queue_head;
    while (task != NULL) {
      __yo_worker_task_t* next = task->next;
      if (task->closure) {
        __yo_free(task->closure);
      }
      __yo_free(task);
      task = next;
    }
  }
  
  __yo_free(__yo_worker_threads);
  __yo_worker_threads = NULL;
  __yo_worker_num_threads = 0;
  __yo_worker_pool_initialized = 0;
  
  PARALLELISM_DEBUG("[WORKER] Worker pool shutdown complete\n");
}

// Get number of hardware threads (CPU cores)
static size_t __yo_get_hardware_threads(void) {
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

// Get CPU ID that the current thread is running on
// Returns -1 if CPU affinity information is not available
int __yo_get_cpu_id(void) {
#if defined(__linux__)
  // On Linux, use sched_getcpu() to get the current CPU
  int cpu = sched_getcpu();
  return cpu;
#elif defined(__APPLE__)
  // On macOS, there's no direct equivalent to sched_getcpu()
  // We could use thread_info but it's more complex
  // For now, return -1 to indicate "not available"
  return -1;
#elif defined(_WIN32)
  // On Windows, use GetCurrentProcessorNumber()
  return (int)GetCurrentProcessorNumber();
#else
  // Unknown platform
  return -1;
#endif
}

// Set the number of worker threads (must be called before first spawn)
void __yo_worker_set_num_threads(size_t num) {
#if defined(_WIN32)
  __yo_worker_init_mutex();
#endif
  YO_THREAD_SYNC_LOCK(&__yo_worker_pool_mutex);
  if (!__yo_worker_pool_initialized) {
    // Pool not initialized yet, just set for later
    __yo_worker_num_threads = num;
    PARALLELISM_DEBUG("[WORKER] Set num_threads to %zu (pool not yet initialized)\n", num);
  } else {
    PARALLELISM_DEBUG("[WORKER] Warning: Cannot change num_threads after pool is initialized\n");
  }
  YO_THREAD_SYNC_UNLOCK(&__yo_worker_pool_mutex);
}

// Get the number of worker threads
size_t __yo_worker_get_num_threads(void) {
#if defined(_WIN32)
  __yo_worker_init_mutex();
#endif
  YO_THREAD_SYNC_LOCK(&__yo_worker_pool_mutex);
  size_t num = __yo_worker_num_threads;
  if (num == 0) {
    num = __yo_get_hardware_threads();
  }
  YO_THREAD_SYNC_UNLOCK(&__yo_worker_pool_mutex);
  return num;
}

// Spawn a task on the worker pool
// Uses round-robin distribution for thread affinity
void __yo_worker_spawn(__yo_thread_fn fn, void* closure) {
#if defined(_WIN32)
  __yo_worker_init_mutex();
#endif
  YO_THREAD_SYNC_LOCK(&__yo_worker_pool_mutex);
  
  // Initialize pool on first spawn if not already done
  if (!__yo_worker_pool_initialized) {
    size_t num = __yo_worker_num_threads;
    if (num == 0) {
      num = __yo_get_hardware_threads();
    }
    __yo_worker_pool_init(num);
  }
  
  // Select worker thread (round-robin for thread affinity)
  size_t thread_idx = __yo_worker_next_thread % __yo_worker_num_threads;
  __yo_worker_next_thread++;
  
  YO_THREAD_SYNC_UNLOCK(&__yo_worker_pool_mutex);
  
  PARALLELISM_DEBUG("[WORKER] Spawning task on worker thread %zu\n", thread_idx);
  
  // Create task node
  __yo_worker_task_t* task = (__yo_worker_task_t*)__yo_malloc(sizeof(__yo_worker_task_t));
  task->fn = fn;
  task->closure = closure;
  task->next = NULL;
  
  // Enqueue task to the selected worker's queue
  __yo_worker_thread_t* worker = &__yo_worker_threads[thread_idx];
  yo_mutex_lock(&worker->mutex);
  if (worker->queue_tail == NULL) {
    worker->queue_head = task;
    worker->queue_tail = task;
  } else {
    worker->queue_tail->next = task;
    worker->queue_tail = task;
  }
  yo_cond_signal(&worker->cond);
  yo_mutex_unlock(&worker->mutex);
}

// Non-atomic reference counting functions (thread-local)
void __yo_decr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Skip if this object is marked as garbage by the GC.
  // During GC collection, dispose functions may call ___drop on children,
  // but those children are also being collected by the GC.
  // The GC is responsible for freeing garbage objects, not the RC system.
  if ((header->gc_flags & YO_GC_TRACKED) && header->gc_mark == YO_GC_GARBAGE) {
    GC_DEBUG("Decr: Skipping ptr=%p (marked as GC garbage)\n", ptr);
    return;
  }
  
  GC_DEBUG("Decr: ptr=%p RC=%zu->%zu\n", ptr, header->ref_count, header->ref_count - 1);
  
  if (header->ref_count == 1) {
    // Last reference - deallocate immediately without decrementing
    GC_DEBUG("Decr: Deallocating ptr=%p (last ref)\n", ptr);
    __yo_gc_unregister(ptr);
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  } else {
    // More than one reference - just decrement
    header->ref_count--;
  }
}

void* __yo_incr_rc(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  header->ref_count++;
  GC_DEBUG("Incr: ptr=%p RC=%zu\n", ptr, header->ref_count);
  return ptr;
}

// Atomic reference counting functions for Iso types (thread-safe)
void* __yo_incr_rc_atomic(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  atomic_fetch_add(((_Atomic size_t*)&header->ref_count), 1);
  return ptr;
}

void __yo_decr_rc_atomic(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  size_t old_count = atomic_fetch_sub(((_Atomic size_t*)&header->ref_count), 1);
  
  if (old_count == 1) {
    // Last reference - deallocate
    // Note: No GC tracking needed for Iso types (they don't participate in cycles)
    if (header->dispose_fn) {
      header->dispose_fn(ptr);
    }
    __yo_free(ptr);
  }
}
// Per-thread GC tracking state for cycle collection
static _Thread_local yo_thread_gc_state_t* yo_current_thread_gc = NULL;  // Current thread's GC state
static yo_thread_gc_state_t* yo_all_thread_gcs = NULL;  // Global list of all thread GC states (for cleanup)
#if defined(_WIN32)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex;
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static YO_THREAD_SYNC_TYPE yo_thread_list_mutex = YO_THREAD_SYNC_INIT;
#endif
static size_t yo_gc_min_threshold = 256;       // Minimum threshold for adaptive scaling
static size_t yo_gc_collect_threshold = 256;   // Adaptive: starts at min, grows to 2x live objects after each GC

// Thread cleanup infrastructure
#if defined(_WIN32)
// Windows: Use native TLS API instead of C11 tss_t (better compiler support)
static DWORD yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
static volatile LONG yo_thread_cleanup_init_started = 0;
static volatile LONG yo_thread_cleanup_init_done = 0;

static void yo_init_thread_cleanup_key(void) {
  // Simple once-only initialization using interlocked operations
  if (InterlockedCompareExchange(&yo_thread_cleanup_init_started, 1, 0) == 0) {
    yo_thread_cleanup_key = TlsAlloc();
    InterlockedExchange(&yo_thread_cleanup_init_done, 1);
  } else {
    // Wait for initialization to complete
    while (InterlockedCompareExchange(&yo_thread_cleanup_init_done, 1, 1) == 0) {
      Sleep(0);
    }
  }
}
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
static pthread_key_t yo_thread_cleanup_key = (pthread_key_t)(-1);
static pthread_once_t yo_thread_cleanup_once = PTHREAD_ONCE_INIT;

static void yo_pthread_cleanup(void* value) {
  if (value != NULL) {
    __yo_cleanup_thread_gc();
  }
}

static void yo_init_thread_cleanup_key(void) {
  pthread_key_create(&yo_thread_cleanup_key, yo_pthread_cleanup);
}
#endif

// Initialize thread-local GC state
static void yo_init_thread_gc() {
  if (yo_current_thread_gc != NULL) return;

#if defined(_WIN32)
  yo_init_thread_cleanup_key();
  if (yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsSetValue(yo_thread_cleanup_key, (void*)1);
  }
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  pthread_once(&yo_thread_cleanup_once, yo_init_thread_cleanup_key);
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_setspecific(yo_thread_cleanup_key, (void*)1);
  }
#endif
  
  yo_init_process_cleanup();

  yo_current_thread_gc = (yo_thread_gc_state_t*)__yo_malloc(sizeof(yo_thread_gc_state_t));
  yo_current_thread_gc->tracked_objects = NULL;
  yo_current_thread_gc->tracked_count = 0;
  yo_current_thread_gc->thread_id = yo_thread_self();
  yo_current_thread_gc->alloc_count = 0;

  // Add to global thread list (for cleanup coordination)
  yo_mutex_lock(&yo_thread_list_mutex);
  yo_current_thread_gc->next = yo_all_thread_gcs;
  yo_current_thread_gc->prev = NULL;
  if (yo_all_thread_gcs != NULL) {
    yo_all_thread_gcs->prev = yo_current_thread_gc;
  }
  yo_all_thread_gcs = yo_current_thread_gc;
  yo_mutex_unlock(&yo_thread_list_mutex);
}

// Public function to initialize thread-local GC (for worker threads)
void __yo_gc_init_thread() {
  yo_init_thread_gc();
}
void __yo_gc_register(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    yo_init_thread_gc();
  }
  
  GC_DEBUG("GC Register: ptr=%p\n", ptr);
  
  // Check if already tracked
  if (header->gc_flags & YO_GC_TRACKED) {
    return;
  }
  
  header->gc_flags |= YO_GC_TRACKED;
  header->gc_mark = YO_GC_UNMARKED;
  
  // Add to thread-local tracking list
  header->gc_next = yo_current_thread_gc->tracked_objects;
  header->gc_prev = NULL;
  if (yo_current_thread_gc->tracked_objects != NULL) {
    yo_current_thread_gc->tracked_objects->gc_prev = header;
  }
  yo_current_thread_gc->tracked_objects = header;
  yo_current_thread_gc->tracked_count++;
  
  // Check if we should trigger GC
  if (yo_current_thread_gc->tracked_count >= yo_gc_collect_threshold) {
    __yo_gc_collect();
  }
}

void __yo_gc_unregister(void* ptr) {
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  if (yo_current_thread_gc == NULL) {
    return;
  }
  
  if (!(header->gc_flags & YO_GC_TRACKED)) {
    return;
  }
  
  // Remove from tracking list (O(1) with doubly-linked list)
  if (header->gc_prev != NULL) {
    header->gc_prev->gc_next = header->gc_next;
  } else {
    yo_current_thread_gc->tracked_objects = header->gc_next;
  }
  
  if (header->gc_next != NULL) {
    header->gc_next->gc_prev = header->gc_prev;
  }

  yo_current_thread_gc->tracked_count--;
  header->gc_flags &= ~YO_GC_TRACKED;
}
// QuickJS-style trial deletion for cycle collection
// Phase 1: Trial deletion - decrement ref counts for internal references
static void yo_gc_trial_delete_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only process tracked objects
  if (!(header->gc_flags & YO_GC_TRACKED)) return;
  
  // Trial decrement
  if (header->ref_count > 0) {
    header->ref_count--;
    GC_DEBUG("TrialDelete: ptr=%p, ref_count->%zu\n", ptr, header->ref_count);
  }
}

// Phase 2: Restore ref counts for live objects
static void yo_gc_restore_visitor(void* ptr) {
  if (ptr == NULL) return;
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // Only restore for objects that were trial-deleted
  if (header->gc_mark == YO_GC_LIVE) {
    header->ref_count++;
    GC_DEBUG("Restore: ptr=%p, ref_count->%zu\n", ptr, header->ref_count);
  }
}

void __yo_gc_collect() {
  if (yo_current_thread_gc == NULL) return;
  
  yo_ref_header_t* head = yo_current_thread_gc->tracked_objects;
  if (head == NULL) return;
  
  GC_DEBUG("GC: Starting collection, tracked_count=%zu\n", yo_current_thread_gc->tracked_count);
  
  size_t collected = 0;
  
  // Phase 1: Mark all as candidates and trial-delete
  yo_ref_header_t* obj = head;
  while (obj != NULL) {
    obj->gc_mark = YO_GC_CANDIDATE;
    obj = obj->gc_next;
  }
  
  // Trial deletion: decrement RC for all internal references
  obj = head;
  while (obj != NULL) {
    if (obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_trial_delete_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 2: Identify garbage (RC == 0) and live objects (RC > 0)
  obj = head;
  while (obj != NULL) {
    if (obj->ref_count == 0) {
      obj->gc_mark = YO_GC_GARBAGE;
      GC_DEBUG("GC: Marked as garbage: ptr=%p\n", obj);
    } else {
      obj->gc_mark = YO_GC_LIVE;
      GC_DEBUG("GC: Marked as live: ptr=%p (ref_count=%zu)\n", obj, obj->ref_count);
    }
    obj = obj->gc_next;
  }
  
  // Phase 3: Restore ref counts for live objects
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == YO_GC_LIVE && obj->traverse_fn) {
      obj->traverse_fn(obj, yo_gc_restore_visitor);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4a: Call dispose functions on all garbage objects (while memory is still valid)
  // This must happen before freeing any objects, because dispose functions may try
  // to access other garbage objects (e.g., to check gc_mark in __yo_decr_rc).
  obj = head;
  while (obj != NULL) {
    if (obj->gc_mark == YO_GC_GARBAGE && obj->dispose_fn) {
      GC_DEBUG("GC: Disposing garbage: ptr=%p\n", obj);
      obj->dispose_fn(obj);
    }
    obj = obj->gc_next;
  }
  
  // Phase 4b: Free all garbage objects and remove from tracking list
  yo_ref_header_t* current = head;
  yo_ref_header_t* prev = NULL;
  
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    if (current->gc_mark == YO_GC_GARBAGE) {
      GC_DEBUG("GC: Freeing garbage: ptr=%p\n", current);
      
      // Remove from tracking list
      if (prev == NULL) {
        yo_current_thread_gc->tracked_objects = next;
      } else {
        prev->gc_next = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
      
      yo_current_thread_gc->tracked_count--;
      collected++;
      
      // Free the object (dispose was already called in Phase 4a)
      __yo_free(current);
      
      current = next;
    } else {
      // Reset mark for next collection
      current->gc_mark = YO_GC_UNMARKED;
      prev = current;
      current = next;
    }
  }
  
  // Adaptive threshold: set to max(min_threshold, 2 * remaining_objects)
  size_t new_threshold = yo_current_thread_gc->tracked_count * 2;
  if (new_threshold < yo_gc_min_threshold) {
    new_threshold = yo_gc_min_threshold;
  }
  yo_gc_collect_threshold = new_threshold;
  
  GC_DEBUG("GC: Collection complete, collected=%zu, remaining=%zu, next_threshold=%zu\n", collected, yo_current_thread_gc->tracked_count, yo_gc_collect_threshold);
}

size_t __yo_gc_tracked_count() {
  if (yo_current_thread_gc == NULL) return 0;
  return yo_current_thread_gc->tracked_count;
}
// Clean up thread-local GC state
void __yo_cleanup_thread_gc() {
  yo_mutex_lock(&yo_thread_list_mutex);
  
  yo_thread_gc_state_t* my_gc_state = yo_current_thread_gc;
  
  if (my_gc_state == NULL) {
    yo_mutex_unlock(&yo_thread_list_mutex);
    return;
  }
  
  GC_DEBUG("CleanupThread: tracked_count=%zu\n", my_gc_state->tracked_count);
  
  // Force dispose all remaining tracked objects
  yo_ref_header_t* current = my_gc_state->tracked_objects;
  while (current != NULL) {
    yo_ref_header_t* next = current->gc_next;
    
    GC_DEBUG("CleanupThread: Disposing object ptr=%p\n", current);
    if (current->dispose_fn) {
      current->dispose_fn(current);
    }
    __yo_free(current);
    
    current = next;
  }
  
  // Remove from global list
  if (my_gc_state->prev != NULL) {
    my_gc_state->prev->next = my_gc_state->next;
  } else {
    yo_all_thread_gcs = my_gc_state->next;
  }
  
  if (my_gc_state->next != NULL) {
    my_gc_state->next->prev = my_gc_state->prev;
  }
  
  yo_mutex_unlock(&yo_thread_list_mutex);
  
  __yo_free(my_gc_state);
  yo_current_thread_gc = NULL;
}

// Process cleanup
static void yo_process_cleanup(void) {
  GC_DEBUG("ProcessCleanup: Called\n");
  
  if (yo_current_thread_gc != NULL) {
    __yo_gc_collect();
    __yo_cleanup_thread_gc();
  }
  
#if defined(_WIN32)
  if (yo_thread_cleanup_key != TLS_OUT_OF_INDEXES) {
    TlsFree(yo_thread_cleanup_key);
    yo_thread_cleanup_key = TLS_OUT_OF_INDEXES;
  }
#elif defined(__linux__) || defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
  if (yo_thread_cleanup_key != (pthread_key_t)(-1)) {
    pthread_key_delete(yo_thread_cleanup_key);
  }
#endif
}

#if defined(_WIN32)
static INIT_ONCE yo_process_cleanup_once = INIT_ONCE_STATIC_INIT;
static BOOL CALLBACK yo_process_cleanup_init_callback(PINIT_ONCE InitOnce, PVOID Parameter, PVOID *Context) {
  (void)InitOnce; (void)Parameter; (void)Context;
  InitializeCriticalSection(&yo_thread_list_mutex);
  atexit(yo_process_cleanup);
  return TRUE;
}
#endif

static void yo_init_process_cleanup(void) {
#if defined(_WIN32)
  InitOnceExecuteOnce(&yo_process_cleanup_once, yo_process_cleanup_init_callback, NULL, NULL);
#else
  static bool cleanup_initialized = false;
  if (cleanup_initialized) return;
  cleanup_initialized = true;
  atexit(yo_process_cleanup);
#endif
}