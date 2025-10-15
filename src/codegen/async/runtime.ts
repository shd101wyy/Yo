/**
 * runtime.ts
 *
 * Generates the async runtime code for per-thread task scheduling.
 * This implements a simple cooperative scheduler with thread affinity.
 */

import { Emitter } from "../../emitter";

/**
 * Generates the async runtime code with per-thread task queues.
 * This respects BRC thread affinity - Futures stay on their owner thread.
 */
export function generateAsyncRuntime(
  emitter: Emitter,
  _debugAsyncAwait: boolean
): void {
  emitter.emitLine(`
// ============================================================================
// Async/Await Runtime - Per-Thread Task Scheduler
// ============================================================================
// This implements a cooperative async runtime with thread affinity.
// Each thread has its own task queue for Futures owned by that thread.
// This respects the BRC memory model where objects stay on their owner thread.

// Special drop function for Future types
// Futures should not be freed while they're still running, even if RC=0
void __yo_future_drop(void* ptr) {
  if (!ptr) return;
  
  yo_ref_header_t* header = (yo_ref_header_t*)ptr;
  
  // For Futures, we need to check the is_running flag
  // The Future struct has is_running after the header
  // We'll use a generic approach by checking the offset
  
  // All Future types have the same layout:
  // - yo_ref_header_t header
  // - _Atomic(yo_future_state_t) state
  // - void* state_machine
  // - result (optional)
  
  typedef struct {
    yo_ref_header_t header;
    int state;  // enum: YO_FUTURE_RUNNING/COMPLETED/ERROR
    void* state_machine;
  } yo_future_generic_t;
  
  yo_future_generic_t* future = (yo_future_generic_t*)ptr;
  
  // Decrement reference count
  __yo_decr_rc(ptr, NULL);
  
  // Note: The actual freeing is handled by __yo_decr_rc, which will
  // call the dispose function if ref count reaches 0.
  // The dispose function will free the state machine.
}

// Thread support
#ifdef _WIN32
  #include <windows.h>
  #include <process.h>
  typedef HANDLE yo_thread_handle_t;
  typedef DWORD yo_thread_id_t;
  typedef CRITICAL_SECTION yo_mutex_t;
  #define YO_MUTEX_INIT(m) InitializeCriticalSection(m)
  #define YO_MUTEX_DESTROY(m) DeleteCriticalSection(m)
  #define YO_MUTEX_LOCK(m) EnterCriticalSection(m)
  #define YO_MUTEX_UNLOCK(m) LeaveCriticalSection(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)GetCurrentThreadId())
#else
  #include <pthread.h>
  #include <unistd.h>
  #ifdef __linux__
    #include <sys/syscall.h>  // For syscall() and SYS_* constants
  #elif defined(__APPLE__)
    #include <mach/thread_policy.h>
    #include <mach/thread_act.h>
  #endif
  typedef pthread_t yo_thread_handle_t;
  typedef pthread_t yo_thread_id_t;
  typedef pthread_mutex_t yo_mutex_t;
  #define YO_MUTEX_INIT(m) pthread_mutex_init(m, NULL)
  #define YO_MUTEX_DESTROY(m) pthread_mutex_destroy(m)
  #define YO_MUTEX_LOCK(m) pthread_mutex_lock(m)
  #define YO_MUTEX_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)pthread_self())
#endif

// Forward declarations for state machine resume functions
// These will be generated for each async function

// Continuation - represents a state machine waiting to be resumed
typedef struct yo_continuation_t {
  void (*resume_fn)(void* state_machine);  // Function to call to resume
  void* state_machine;                      // State machine to resume
  struct yo_continuation_t* next;           // Next in linked list
} yo_continuation_t;

// Worker thread structure with per-thread task queue for async/await
typedef struct yo_worker_thread {
  yo_thread_handle_t handle;
  yo_thread_id_t id;
  bool active;
  size_t core_id;                        // CPU core this worker is pinned to
  
  // Task queue for async state machines (no coroutines!)
  yo_continuation_t* task_queue_head;    // Head of task queue
  yo_continuation_t* task_queue_tail;    // Tail of task queue
  size_t task_queue_count;               // Number of pending tasks
  yo_mutex_t queue_mutex;                // Protects this worker's queue
} yo_worker_thread_t;

// Global async/await thread pool state (NO coroutines!)
static size_t yo_async_max_threads = 0;
static bool yo_async_scheduler_initialized = false;

// Thread pool state
static yo_worker_thread_t* yo_worker_threads = NULL;
static size_t yo_worker_thread_count = 0;
static size_t yo_async_active_worker_limit = 0;
static _Atomic bool yo_worker_shutdown = false;
static _Atomic size_t yo_next_worker_index = 0;
static _Atomic size_t yo_active_task_count = 0;

// Forward declarations
static void __yo_async_scheduler_init(void);
static void __yo_concurrency_set_maximum_threads(size_t num);
static void __yo_set_thread_affinity(size_t core_id);

// Initialize async scheduler
static void __yo_async_scheduler_init(void) {
  if (yo_async_scheduler_initialized) {
    return;
  }
  yo_async_scheduler_initialized = true;
  ASYNC_DEBUG("Async scheduler initialized\\n");
}

// Spawn an async task by starting its execution on a worker thread
void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("Spawning async task to worker: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
  
  __yo_async_scheduler_init();
  
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);
  }
  
  if (yo_worker_thread_count > 0) {
    size_t limit = yo_async_active_worker_limit > 0 ? yo_async_active_worker_limit : yo_worker_thread_count;
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % limit;
    yo_worker_thread_t* worker = &yo_worker_threads[worker_idx];
    
    ASYNC_DEBUG("Assigning async task to worker %zu\\n", worker_idx);
    
    atomic_fetch_add(&yo_active_task_count, 1);
    
    yo_continuation_t* task = (yo_continuation_t*)__yo_malloc(sizeof(yo_continuation_t));
    task->resume_fn = resume_fn;
    task->state_machine = state_machine;
    task->next = NULL;
    
    YO_MUTEX_LOCK(&worker->queue_mutex);
    
    if (worker->task_queue_tail) {
      worker->task_queue_tail->next = task;
      worker->task_queue_tail = task;
    } else {
      worker->task_queue_head = task;
      worker->task_queue_tail = task;
    }
    worker->task_queue_count++;
    
    YO_MUTEX_UNLOCK(&worker->queue_mutex);
    
    ASYNC_DEBUG("Enqueued task to worker %zu (queue size: %zu)\\n", worker_idx, worker->task_queue_count);
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
  }
}

// Worker thread function
#ifdef _WIN32
static unsigned __stdcall __yo_worker_thread_func(void* arg) {
#else
static void* __yo_worker_thread_func(void* arg) {
#endif
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  yo_thread_id_t thread_id = YO_THREAD_ID();
  
  __yo_set_thread_affinity(worker->core_id);
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu started on core %zu (worker=%p)\\n", (unsigned long)thread_id, worker->core_id, worker);
  
  while (!atomic_load(&yo_worker_shutdown)) {
    YO_MUTEX_LOCK(&worker->queue_mutex);
    
    yo_continuation_t* task = worker->task_queue_head;
    if (task) {
      worker->task_queue_head = task->next;
      if (!worker->task_queue_head) {
        worker->task_queue_tail = NULL;
      }
      worker->task_queue_count--;
    }
    
    YO_MUTEX_UNLOCK(&worker->queue_mutex);
    
    if (!task) {
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);
      #endif
      continue;
    }
    
    CONCURRENCY_DEBUG("[WORKER] Thread %lu executing task=%p (state_machine=%p, resume_fn=%p)\\n", 
                      (unsigned long)thread_id, task, task->state_machine, task->resume_fn);
    
    if (task->resume_fn && task->state_machine) {
      task->resume_fn(task->state_machine);
    }
    
    __yo_free(task);
    
    atomic_fetch_sub(&yo_active_task_count, 1);
    
    CONCURRENCY_DEBUG("[WORKER] Thread %lu completed task, remaining tasks=%zu\\n", 
                      (unsigned long)thread_id, atomic_load(&yo_active_task_count));
  }
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu exiting\\n", (unsigned long)thread_id);
  #ifdef _WIN32
  return 0;
  #else
  return NULL;
  #endif
}

// Get number of hardware threads available
size_t __yo_concurrency_get_hardware_threads(void) {
  #ifdef _WIN32
  SYSTEM_INFO sysinfo;
  GetSystemInfo(&sysinfo);
  return (size_t)sysinfo.dwNumberOfProcessors;
  #else
  long nprocs = sysconf(_SC_NPROCESSORS_ONLN);
  if (nprocs < 1) {
    return 1;
  }
  return (size_t)nprocs;
  #endif
}

// Set thread affinity to bind worker to specific CPU core
static void __yo_set_thread_affinity(size_t core_id) {
  #ifdef _WIN32
  DWORD_PTR mask = 1ULL << core_id;
  SetThreadAffinityMask(GetCurrentThread(), mask);
  CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (Windows)\\n", core_id);
  
  #elif defined(__APPLE__)
  thread_affinity_policy_data_t policy = { (integer_t)core_id };
  kern_return_t result = thread_policy_set(pthread_mach_thread_np(pthread_self()), 
                    THREAD_AFFINITY_POLICY, 
                    (thread_policy_t)&policy, 
                    THREAD_AFFINITY_POLICY_COUNT);
  if (result == KERN_SUCCESS) {
    CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (macOS)\\n", core_id);
  } else {
    CONCURRENCY_DEBUG("[AFFINITY] Failed to set thread affinity to core %zu (macOS, error=%d)\\n", core_id, result);
  }
  
  #elif defined(__linux__)
  unsigned long mask = 1UL << core_id;
  #if defined(__x86_64__)
    long result = syscall(203, 0, sizeof(unsigned long), &mask);
  #elif defined(__aarch64__)
    long result = syscall(122, 0, sizeof(unsigned long), &mask);
  #elif defined(__i386__)
    long result = syscall(241, 0, sizeof(unsigned long), &mask);
  #elif defined(__arm__)
    long result = syscall(241, 0, sizeof(unsigned long), &mask);
  #else
    long result = syscall(203, 0, sizeof(unsigned long), &mask);
  #endif
  
  if (result == 0) {
    CONCURRENCY_DEBUG("[AFFINITY] Set thread affinity to core %zu (Linux)\\n", core_id);
  } else {
    CONCURRENCY_DEBUG("[AFFINITY] Failed to set thread affinity to core %zu (Linux, errno=%d)\\n", core_id, (int)result);
  }
  
  #else
  CONCURRENCY_DEBUG("[AFFINITY] Thread affinity not supported on this platform (core %zu requested)\\n", core_id);
  (void)core_id;
  #endif
}

// Initialize thread pool
static void __yo_thread_pool_init(size_t num_threads) {
  if (num_threads < 1 || yo_worker_thread_count > 0) {
    return;
  }
  
  CONCURRENCY_DEBUG("[POOL] Initializing %zu worker threads\\n", num_threads);
  
  yo_worker_threads = (yo_worker_thread_t*)__yo_malloc(sizeof(yo_worker_thread_t) * num_threads);
  yo_worker_thread_count = num_threads;
  atomic_store(&yo_worker_shutdown, false);
  atomic_store(&yo_next_worker_index, 0);
  
  for (size_t i = 0; i < num_threads; i++) {
    yo_worker_threads[i].active = true;
    yo_worker_threads[i].core_id = i;
    yo_worker_threads[i].task_queue_head = NULL;
    yo_worker_threads[i].task_queue_tail = NULL;
    yo_worker_threads[i].task_queue_count = 0;
    YO_MUTEX_INIT(&yo_worker_threads[i].queue_mutex);
    
    #ifdef _WIN32
    yo_worker_threads[i].handle = (HANDLE)_beginthreadex(
      NULL, 0, __yo_worker_thread_func, &yo_worker_threads[i], 0, NULL
    );
    #else
    pthread_create(&yo_worker_threads[i].handle, NULL, __yo_worker_thread_func, &yo_worker_threads[i]);
    #endif
    
    CONCURRENCY_DEBUG("[POOL] Spawned worker thread %zu (will pin to core %zu)\\n", i, i);
  }
}

// Set maximum number of threads for async/await thread pool
void __yo_concurrency_set_maximum_threads(size_t num) {
  __yo_async_scheduler_init();
  
  if (num == 0) {
    num = __yo_concurrency_get_hardware_threads();
  }
  
  yo_async_max_threads = num;
  
  if (yo_worker_thread_count == 0) {
    size_t hardware_threads = __yo_concurrency_get_hardware_threads();
    __yo_thread_pool_init(hardware_threads);
  }
  
  if (num <= yo_worker_thread_count) {
    yo_async_active_worker_limit = num;
    CONCURRENCY_DEBUG("[POOL] Limited async task distribution to first %zu workers\\n", num);
  } else {
    yo_async_active_worker_limit = yo_worker_thread_count;
    CONCURRENCY_DEBUG("[POOL] Cannot limit to %zu workers (only %zu available)\\n", num, yo_worker_thread_count);
  }
}

// Wait for all async tasks to complete
void __yo_async_wait_all(void) {
  if (!yo_async_scheduler_initialized) {
    return;
  }
  
  CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for all async tasks to complete\\n");
  
  if (yo_worker_thread_count > 0) {
    CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for thread pool to finish (active_tasks=%zu)\\n", 
                      atomic_load(&yo_active_task_count));
    
    while (atomic_load(&yo_active_task_count) > 0) {
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);
      #endif
    }
    
    CONCURRENCY_DEBUG("[WAIT_ALL] All tasks completed, shutting down workers\\n");
    
    atomic_store(&yo_worker_shutdown, true);
    
    for (size_t i = 0; i < yo_worker_thread_count; i++) {
      if (yo_worker_threads[i].active) {
        #ifdef _WIN32
        WaitForSingleObject(yo_worker_threads[i].handle, INFINITE);
        CloseHandle(yo_worker_threads[i].handle);
        #else
        pthread_join(yo_worker_threads[i].handle, NULL);
        #endif
        YO_MUTEX_DESTROY(&yo_worker_threads[i].queue_mutex);
      }
    }
    
    __yo_free(yo_worker_threads);
    yo_worker_threads = NULL;
    yo_worker_thread_count = 0;
    
    CONCURRENCY_DEBUG("[WAIT_ALL] Thread pool shut down\\n");
  }
}

// Per-thread async task queue
typedef struct {
  yo_continuation_t* head;  // Head of continuation queue
  yo_continuation_t* tail;  // Tail of continuation queue
  size_t count;             // Number of pending continuations
} yo_async_task_queue_t;

// Thread-local async runtime state
#if defined(_WIN32)
  __declspec(thread) static yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
#else
  __thread static yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
#endif

// Enqueue a continuation to be executed
static void yo_async_enqueue_continuation(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("Enqueueing continuation: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
  
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
  ASYNC_DEBUG("Queue count: %zu\\n", yo_thread_async_queue.count);
}

// Generic Future type for runtime operations
// All Future types have the same layout for the fields we care about in runtime code
typedef struct {
  yo_ref_header_t header;
  _Atomic(yo_future_state_t) state;
  void* state_machine;
  void (*resume_fn)(void*); // Resume function for lazy spawn
  _Atomic(void*) continuation_fn;
  _Atomic(void*) continuation_sm;
} yo_future_generic_t;

// Dispose function for Future types - frees the state machine
void yo_future_dispose(void* future_ptr) {
  yo_future_generic_t* future = (yo_future_generic_t*)future_ptr;
  
  // Free the state machine if it exists
  if (future->state_machine) {
    ASYNC_DEBUG("Disposing Future: freeing state machine %p\\n", future->state_machine);
    __yo_free(future->state_machine);
    future->state_machine = NULL;
  }
}

// Dequeue and execute one continuation
// Returns true if a continuation was executed, false if queue is empty
static bool yo_async_run_one_continuation(void) {
  if (!yo_thread_async_queue.head) {
    return false;  // Queue is empty
  }
  
  yo_continuation_t* cont = yo_thread_async_queue.head;
  yo_thread_async_queue.head = cont->next;
  
  if (!yo_thread_async_queue.head) {
    yo_thread_async_queue.tail = NULL;  // Queue is now empty
  }
  
  yo_thread_async_queue.count--;
  
  ASYNC_DEBUG("Executing continuation: resume_fn=%p, sm=%p (queue count: %zu)\\n", 
              (void*)cont->resume_fn, cont->state_machine, yo_thread_async_queue.count);
  
  // Execute the continuation
  cont->resume_fn(cont->state_machine);
  
  __yo_free(cont);
  return true;
}

// Run the async event loop until all tasks complete
// This processes all continuations in the queue until empty
static void yo_async_run_event_loop(void) {
  ASYNC_DEBUG("Starting event loop (queue count: %zu)\\n", yo_thread_async_queue.count);
  
  while (yo_thread_async_queue.count > 0) {
    bool executed = yo_async_run_one_continuation();
    if (!executed) {
      break;  // Queue is empty
    }
  }
  
  ASYNC_DEBUG("Event loop finished\\n");
}

// Register a continuation to be called when a Future completes
// This is called when await encounters a pending Future
void yo_async_register_continuation(
    void* future_ptr,
    void (*resume_fn)(void*),
    void* state_machine) {
  
  ASYNC_DEBUG("Registering continuation for future=%p: resume_fn=%p, sm=%p\\n",
              future_ptr, (void*)resume_fn, state_machine);
  
  yo_future_generic_t* future = (yo_future_generic_t*)future_ptr;
  
  // Note: state_machine parameter is the AWAITING state machine (e.g., yo_user_main)
  // future->state_machine is the TASK's state machine (e.g., task1)
  // These are different! The continuation resumes the awaiting state machine.
  
  // Atomically register the continuation
  // We use release semantics so the continuation registration is visible when state becomes COMPLETED
  atomic_store_explicit(&future->continuation_fn, (void*)resume_fn, memory_order_release);
  atomic_store_explicit(&future->continuation_sm, state_machine, memory_order_release);
  
  // After registering the continuation, check if the Future already completed
  // We use acquire semantics to ensure we see the result write if state is COMPLETED
  yo_future_state_t current_state = atomic_load_explicit(&future->state, memory_order_acquire);
  
  if (current_state == YO_FUTURE_COMPLETED) {
    // The Future completed between our await check and continuation registration
    // We need to spawn the continuation ourselves
    ASYNC_DEBUG("Future %p already completed during registration, spawning continuation immediately\\n", future_ptr);
    
    // Clear the continuation (so the completing task doesn't also spawn it)
    atomic_store_explicit(&future->continuation_fn, NULL, memory_order_relaxed);
    atomic_store_explicit(&future->continuation_sm, NULL, memory_order_relaxed);
    
    // Spawn the continuation with the awaiting state machine
    yo_async_spawn_task(resume_fn, state_machine);
  }
  // Otherwise, the completing task will spawn the continuation when it sets state=COMPLETED
}

// Forward declaration - implemented later where yo_async_scheduler_initialized is defined
static void __yo_async_scheduler_init(void);
`);
}
