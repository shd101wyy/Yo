/**
 * parallelism-runtime.ts
 *
 * Generates the parallelism runtime code for multi-threaded execution.
 *
 * Thread = Dedicated OS thread (pthread wrapper)
 * Worker = Thread pool task (future)
 * Channel = Inter-thread communication (future, separate)
 */

import { Emitter } from "../../emitter";

/**
 * Generates the parallelism runtime code.
 */
export function generateParallelismRuntime(
  emitter: Emitter,
  _debugParallelism: boolean
): void {
  emitter.emitLine(`
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

// Thread entry point
static void* __yo_thread_entry(void* arg) {
  __yo_thread_entry_args_t* args = (__yo_thread_entry_args_t*)arg;
  
  PARALLELISM_DEBUG("[THREAD] Thread started (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  // Initialize thread-local GC for this thread
  __yo_gc_init_thread();
  
  // Call user's function with closure
  args->fn(args->closure);
  
  PARALLELISM_DEBUG("[THREAD] Thread completed (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  // Cleanup thread-local GC
  __yo_gc_collect();
  
  // Free the closure data (heap-allocated by codegen)
  if (args->closure) {
    __yo_free(args->closure);
  }
  
  // Free args
  __yo_free(args);
  
  return NULL;
}

// Spawn a new OS thread (returns by value)
// The codegen will handle extracting the closure function pointer and data
__yo_thread_t __yo_thread_spawn(__yo_thread_fn fn, void* closure) {
  PARALLELISM_DEBUG("[THREAD] Spawning new thread\\n");
  
  __yo_thread_t thread;
  
  // Allocate entry args
  __yo_thread_entry_args_t* args = (__yo_thread_entry_args_t*)__yo_malloc(sizeof(__yo_thread_entry_args_t));
  args->fn = fn;
  args->closure = closure;
  
  // Create OS thread
  int ret = yo_thread_create(&thread.handle, __yo_thread_entry, args);
  if (ret != 0) {
    PARALLELISM_DEBUG("[THREAD] Failed to create thread (ret=%d)\\n", ret);
    __yo_free(args);
    // Return invalid thread handle (handle will be 0/NULL)
    thread.handle = (YO_THREAD_TYPE){0};
  }
  
  PARALLELISM_DEBUG("[THREAD] Spawned thread\\n");
  return thread;
}

// Wait for thread to complete
void __yo_thread_join(__yo_thread_t thread) {
  PARALLELISM_DEBUG("[THREAD] Joining thread\\n");
  yo_thread_join(thread.handle);
  PARALLELISM_DEBUG("[THREAD] Thread joined\\n");
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
} __yo_worker_thread_t;

// Global worker pool state
static __yo_worker_thread_t* __yo_worker_threads = NULL;  // Array of worker threads
static size_t __yo_worker_num_threads = 0;                // Number of worker threads
static size_t __yo_worker_next_thread = 0;                // Round-robin counter for task distribution
static YO_THREAD_SYNC_TYPE __yo_worker_pool_mutex = YO_THREAD_SYNC_INIT;  // Pool-level mutex
static volatile int __yo_worker_pool_initialized = 0;     // Pool initialization flag

// Worker thread entry point
static void* __yo_worker_thread_entry(void* arg) {
  __yo_worker_thread_t* worker = (__yo_worker_thread_t*)arg;
  
  PARALLELISM_DEBUG("[WORKER] Worker thread started (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  // Initialize thread-local GC for this worker thread
  __yo_gc_init_thread();
  
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
      PARALLELISM_DEBUG("[WORKER] Executing task (tid=%zu)\\n", (size_t)__yo_get_thread_id());
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
  
  PARALLELISM_DEBUG("[WORKER] Worker thread exiting (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  // Final GC cleanup
  __yo_gc_collect();
  
  return NULL;
}

// Initialize the worker pool with the specified number of threads
static void __yo_worker_pool_init(size_t num_threads) {
  if (__yo_worker_pool_initialized) {
    return;
  }
  
  PARALLELISM_DEBUG("[WORKER] Initializing worker pool with %zu threads\\n", num_threads);
  
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
    
    int ret = yo_thread_create(&worker->handle, __yo_worker_thread_entry, worker);
    if (ret != 0) {
      PARALLELISM_DEBUG("[WORKER] Failed to create worker thread %zu (ret=%d)\\n", i, ret);
      worker->running = 0;
    }
  }
  
  __yo_worker_pool_initialized = 1;
  PARALLELISM_DEBUG("[WORKER] Worker pool initialized\\n");
}

// Shutdown the worker pool
__attribute__((destructor))
static void __yo_worker_pool_shutdown(void) {
  if (!__yo_worker_pool_initialized) {
    return;
  }
  
  PARALLELISM_DEBUG("[WORKER] Shutting down worker pool\\n");
  
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
  
  PARALLELISM_DEBUG("[WORKER] Worker pool shutdown complete\\n");
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
  YO_THREAD_SYNC_LOCK(&__yo_worker_pool_mutex);
  if (!__yo_worker_pool_initialized) {
    // Pool not initialized yet, just set for later
    __yo_worker_num_threads = num;
    PARALLELISM_DEBUG("[WORKER] Set num_threads to %zu (pool not yet initialized)\\n", num);
  } else {
    PARALLELISM_DEBUG("[WORKER] Warning: Cannot change num_threads after pool is initialized\\n");
  }
  YO_THREAD_SYNC_UNLOCK(&__yo_worker_pool_mutex);
}

// Get the number of worker threads
size_t __yo_worker_get_num_threads(void) {
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
  
  PARALLELISM_DEBUG("[WORKER] Spawning task on worker thread %zu\\n", thread_idx);
  
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
`);
}
