/**
 * runtime-core.ts
 *
 * Core async scheduler: cooperative single-threaded event loop,
 * continuation queue, spawn/wait primitives, concurrency helpers.
 */

import { Emitter } from "../../emitter";

export function generateAsyncRuntimeCore(emitter: Emitter): void {
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
`);
}
