/**
 * runtime-core.ts
 *
 * Core async scheduler: cooperative single-threaded event loop,
 * continuation queue, spawn/wait primitives, concurrency helpers.
 */

import { Emitter } from "../../emitter";
import type { TargetInfo } from "../../target";
import { isTargetMacos, isTargetWasm, isTargetWindows } from "../../target";

export function generateAsyncRuntimeCore(
  emitter: Emitter,
  targetInfo: TargetInfo
): void {
  const hasIO = !isTargetWasm(targetInfo);

  emitter.emitLine(`
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
${
  isTargetWindows(targetInfo)
    ? `static __declspec(thread) yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};`
    : `static __thread yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};`
}

// Async scheduler initialized flag
static bool yo_async_scheduler_initialized = false;

// Count of active poll/fs_event watches (used by all platforms)
static size_t __yo_active_watch_count = 0;

${
  hasIO
    ? `// Whether the I/O subsystem has been initialized
static bool __yo_io_initialized = false;

// Forward declarations for I/O functions
static void __yo_io_init(void);
static void __yo_io_cleanup(void);
static bool __yo_has_pending_io(void);
static int __yo_io_poll(void);
static int __yo_io_wait(void);`
    : ``
}

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
// NOTE: This does NOT increment refcount. The task lifetime is managed by:
// - Constructor: starts with refcount = 1 (user ref)
// - Await/spawn: increments refcount (event loop ref) before starting cold future
// - Completion: decrements refcount (releases event loop ref)
// - User drop: decrements refcount (releases user ref)
void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("[ASYNC] Spawning task: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
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
void yo_async_poll_step(void) {
  yo_async_run_ready_tasks();
${
  hasIO
    ? `  if (__yo_io_initialized) {
    __yo_io_poll();
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      __yo_io_wait();
    }
  }`
    : ``
}
}

// Run event loop until a specific Future completes (for async main)
void __yo_async_run_until_complete(void* future_ptr) {
  if (!yo_async_scheduler_initialized) {
    __yo_async_scheduler_init();
  }
  
${hasIO ? `  __yo_io_init();  // Initialize platform-specific async I/O` : ``}
  
  ASYNC_DEBUG("[ASYNC] Starting event loop for future=%p\\n", future_ptr);
  
  typedef struct { int state; } generic_future_t;
  generic_future_t* future = (generic_future_t*)future_ptr;
  
  int __future_state = future->state;
  while (__future_state != -1 && __future_state != -2) {
    int tasks_run = 0;
    while (tasks_run < 100) {
      yo_continuation_t* cont = yo_thread_async_queue.head;
      if (!cont) break;
      
      yo_thread_async_queue.head = cont->next;
      if (!yo_thread_async_queue.head) {
        yo_thread_async_queue.tail = NULL;
      }
      yo_thread_async_queue.count--;
      
      ASYNC_DEBUG("[ASYNC] Executing continuation: resume_fn=%p, sm=%p (queue_count=%zu)\\n",
                  (void*)cont->resume_fn, cont->state_machine, yo_thread_async_queue.count);
      
      cont->resume_fn(cont->state_machine);
      __yo_free(cont);
      tasks_run++;
    }
    
${
  hasIO
    ? `    // Poll I/O completions (non-blocking)
    __yo_io_poll();
    
    // If no ready tasks but pending I/O, block until completion
    if (!yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\\n");
      __yo_io_wait();
      __future_state = future->state;
      continue;
    }`
    : ``
}
    
    __future_state = future->state;
    if (!yo_thread_async_queue.head) {
${
  hasIO
    ? `      if (!__yo_has_pending_io()) {
        ASYNC_DEBUG("[ASYNC] No tasks or I/O, future state=%d\\n", __future_state);
        if (__future_state != -1 && __future_state != -2) {
          ASYNC_DEBUG("[ASYNC] WARNING: No tasks/IO but future not complete\\n");
          break;
        }
      }`
    : `      ASYNC_DEBUG("[ASYNC] WARNING: Queue empty but future not complete (state=%d)\\n", __future_state);
      break;`
}
    }
  }
  
${hasIO ? `  __yo_io_cleanup();` : ``}
  
  ASYNC_DEBUG("[ASYNC] Event loop finished, future state=%d\\n", future->state);
  
  if (future->state == -2) {
    fprintf(stderr, "panic: async main Future was aborted by an effect handler\\n");
    abort();
  }
}

// Wait for all async tasks to complete (drains the queue)
void __yo_async_wait_all(void) {
  if (!yo_async_scheduler_initialized) {
    return;
  }
  
  ASYNC_DEBUG("[ASYNC] Waiting for all tasks to complete (queue_count=%zu)\\n", yo_thread_async_queue.count);
  
${hasIO ? `  __yo_io_init();  // Ensure async I/O is initialized` : ``}
  
  while (true) {
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
    
${
  hasIO
    ? `    __yo_io_poll();
    
    if (!tasks_processed && !yo_thread_async_queue.head && __yo_has_pending_io()) {
      ASYNC_DEBUG("[ASYNC] No ready tasks, waiting for I/O...\\n");
      __yo_io_wait();
      continue;
    }
    
    if (!yo_thread_async_queue.head && !__yo_has_pending_io()) {
      break;
    }`
    : `    if (!yo_thread_async_queue.head) {
      break;
    }`
}
  }
  
  ASYNC_DEBUG("[ASYNC] All tasks completed\\n");
}

// NOTE: yo_async_register_continuation has been removed.

// ============================================================================
// Concurrency Helper Functions (from std/concurrency.yo)
// ============================================================================

// Get the number of hardware threads (CPU cores)
size_t __yo_thread_get_hardware_threads(void) {
${
  isTargetWindows(targetInfo)
    ? `  SYSTEM_INFO sysinfo;
  GetSystemInfo(&sysinfo);
  return (size_t)sysinfo.dwNumberOfProcessors;`
    : isTargetMacos(targetInfo)
      ? `  int count;
  size_t size = sizeof(count);
  if (sysctlbyname("hw.ncpu", &count, &size, NULL, 0) == 0) {
    return (size_t)count;
  }
  return 1;`
      : `  long count = sysconf(_SC_NPROCESSORS_ONLN);
  return count > 0 ? (size_t)count : 1;`
}
}

// Set maximum threads (placeholder for future spawn support)
void __yo_thread_set_maximum_threads(size_t num) {
  ASYNC_DEBUG("[CONCURRENCY] set_maximum_threads(%zu) - currently no-op for async/await\\n", num);
  (void)num;
}

// Get current thread ID (useful for debugging)
size_t __yo_get_thread_id(void) {
${
  isTargetWindows(targetInfo)
    ? `  return (size_t)GetCurrentThreadId();`
    : isTargetMacos(targetInfo)
      ? `  uint64_t tid;
  pthread_threadid_np(NULL, &tid);
  return (size_t)tid;`
      : `  return (size_t)syscall(SYS_gettid);`
}
}

// Yield execution (allows other tasks to run)
void __yo_thread_yield(void) {
${isTargetWindows(targetInfo) ? `  SwitchToThread();` : `  sched_yield();`}
}

// Async yield - creates an immediately-ready Future for cooperative yielding
typedef struct __yo_yield_future_t {
  int state;
  void (*continuation_fn)(void*);
  void* continuation_sm;
} __yo_yield_future_t;

__yo_yield_future_t __yo_async_yield(void) {
  __yo_yield_future_t future;
  future.state = -1;
  future.continuation_fn = NULL;
  future.continuation_sm = NULL;
  return future;
}
`);
}
