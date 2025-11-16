/**
 * runtime.ts
 *
 * Generates the async runtime code for per-thread task scheduling.
 * This implements a simple cooperative scheduler with thread affinity.
 */

import { Emitter } from "../../emitter";

/**
 * Generates the async runtime code with per-thread task queues.
 * Futures stay on their owner thread for proper memory management.
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
// Objects stay on their owner thread for proper memory management.

// Special drop function for Future types
// Futures should not be freed while they're still running, even if RC=0
void __yo_future_drop(void* ptr) {
  if (!ptr) return;
  
  yo_gc_header_t* header = (yo_gc_header_t*)ptr;
  yo_future_generic_t* future = (yo_future_generic_t*)ptr;
  
  ASYNC_DEBUG("__yo_future_drop: ptr=%p\\n", ptr);
  
  // Futures are now GC-managed - they will be collected automatically
  // when unreachable. We only need to handle running tasks here.
  
  yo_future_state_t current_state = atomic_load_explicit(&future->state, memory_order_acquire);
  
  #ifdef YO_DEBUG_ASYNC_AWAIT
  size_t current_tid = __yo_get_thread_id();
  ASYNC_DEBUG("__yo_future_drop: ptr=%p, state=%d, current_tid=%zu\\n",
              ptr, current_state, current_tid);
  #endif

  // If Future is still running, mark as detached so async runtime continues execution
  if (current_state == YO_FUTURE_RUNNING) {
    ASYNC_DEBUG("__yo_future_drop: Future %p is still RUNNING, marking as detached\\n", ptr);
    atomic_store_explicit(&future->detached, true, memory_order_release);
  }
  
  // Note: GC will handle memory cleanup when Future becomes unreachable
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
  struct yo_continuation_t* next;           // Next in linked list (for queue or free list)
} yo_continuation_t;

// Work-stealing deque - lock-free for owner, locked for thieves
// Each worker has a deque that allows:
// - Push/pop from bottom (owner thread, lock-free)
// - Steal from top (other threads, uses lock)
typedef struct yo_work_deque {
  _Atomic(yo_continuation_t*) top;       // Top pointer (thieves steal from here)
  _Atomic(yo_continuation_t*) bottom;    // Bottom pointer (owner pushes/pops here)
  yo_continuation_t** buffer;            // Circular buffer
  size_t buffer_size;                    // Power of 2 size
  size_t mask;                           // buffer_size - 1 (for fast modulo)
  yo_mutex_t steal_mutex;                // Lock for stealing (protects top pointer)
  _Atomic size_t count;                  // Approximate task count (for load balancing)
} yo_work_deque_t;

// Worker thread structure with work-stealing deque
typedef struct yo_worker_thread {
  yo_thread_handle_t handle;
  yo_thread_id_t id;
  bool active;
  size_t core_id;                        // CPU core this worker is pinned to
  size_t worker_index;                   // Index in worker array
  
  // Work-stealing deque for tasks
  yo_work_deque_t deque;
  
  // Statistics for debugging
  _Atomic size_t tasks_executed;
  _Atomic size_t tasks_stolen;
  _Atomic size_t steal_attempts;
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
static void __yo_deque_init(yo_work_deque_t* deque, size_t initial_size);
static void __yo_deque_destroy(yo_work_deque_t* deque);
static void __yo_deque_push_bottom(yo_work_deque_t* deque, yo_continuation_t* task);
static yo_continuation_t* __yo_deque_pop_bottom(yo_work_deque_t* deque);
static yo_continuation_t* __yo_deque_steal(yo_work_deque_t* deque);
static yo_continuation_t* __yo_try_steal_from_random_worker(size_t current_worker_index);

// Initialize work-stealing deque
static void __yo_deque_init(yo_work_deque_t* deque, size_t initial_size) {
  // Round up to next power of 2
  size_t size = 1;
  while (size < initial_size) size *= 2;
  
  deque->buffer_size = size;
  deque->mask = size - 1;
  deque->buffer = (yo_continuation_t**)__yo_calloc(size, sizeof(yo_continuation_t*));
  atomic_store_explicit(&deque->top, (yo_continuation_t*)0, memory_order_relaxed);
  atomic_store_explicit(&deque->bottom, (yo_continuation_t*)0, memory_order_relaxed);
  atomic_store_explicit(&deque->count, 0, memory_order_relaxed);
  YO_MUTEX_INIT(&deque->steal_mutex);
}

// Destroy work-stealing deque
static void __yo_deque_destroy(yo_work_deque_t* deque) {
  if (deque->buffer) {
    __yo_free(deque->buffer);
    deque->buffer = NULL;
  }
  YO_MUTEX_DESTROY(&deque->steal_mutex);
}

// Push task to bottom of deque (owner thread only, lock-free)
static void __yo_deque_push_bottom(yo_work_deque_t* deque, yo_continuation_t* task) {
  size_t bottom = (size_t)atomic_load_explicit(&deque->bottom, memory_order_relaxed);
  size_t index = bottom & deque->mask;
  
  deque->buffer[index] = task;
  
  // Memory fence to ensure task is written before incrementing bottom
  atomic_thread_fence(memory_order_release);
  atomic_store_explicit(&deque->bottom, (yo_continuation_t*)(bottom + 1), memory_order_relaxed);
  atomic_fetch_add_explicit(&deque->count, 1, memory_order_relaxed);
}

// Pop task from bottom of deque (owner thread only, lock-free)
static yo_continuation_t* __yo_deque_pop_bottom(yo_work_deque_t* deque) {
  size_t bottom = (size_t)atomic_load_explicit(&deque->bottom, memory_order_relaxed);
  if (bottom == 0) return NULL;
  
  bottom--;
  atomic_store_explicit(&deque->bottom, (yo_continuation_t*)bottom, memory_order_relaxed);
  
  // Memory fence to ensure bottom is decremented before reading top
  atomic_thread_fence(memory_order_seq_cst);
  
  size_t top = (size_t)atomic_load_explicit(&deque->top, memory_order_relaxed);
  
  if (bottom < top) {
    // Deque is empty, restore bottom
    atomic_store_explicit(&deque->bottom, (yo_continuation_t*)(bottom + 1), memory_order_relaxed);
    return NULL;
  }
  
  size_t index = bottom & deque->mask;
  yo_continuation_t* task = deque->buffer[index];
  
  if (bottom == top) {
    // Last element - need to compete with thieves
    if (!atomic_compare_exchange_strong_explicit(
          &deque->top,
          (yo_continuation_t**)&top,
          (yo_continuation_t*)(top + 1),
          memory_order_seq_cst,
          memory_order_relaxed)) {
      // Lost race to thief, restore bottom and return NULL
      atomic_store_explicit(&deque->bottom, (yo_continuation_t*)(bottom + 1), memory_order_relaxed);
      return NULL;
    }
    // Won race, reset deque to empty
    atomic_store_explicit(&deque->bottom, (yo_continuation_t*)(top + 1), memory_order_relaxed);
  }
  
  if (task) {
    atomic_fetch_sub_explicit(&deque->count, 1, memory_order_relaxed);
  }
  return task;
}

// Steal task from top of deque (thief threads, uses lock)
static yo_continuation_t* __yo_deque_steal(yo_work_deque_t* deque) {
  YO_MUTEX_LOCK(&deque->steal_mutex);
  
  size_t top = (size_t)atomic_load_explicit(&deque->top, memory_order_acquire);
  size_t bottom = (size_t)atomic_load_explicit(&deque->bottom, memory_order_acquire);
  
  if (top >= bottom) {
    // Deque is empty
    YO_MUTEX_UNLOCK(&deque->steal_mutex);
    return NULL;
  }
  
  size_t index = top & deque->mask;
  yo_continuation_t* task = deque->buffer[index];
  
  if (!atomic_compare_exchange_strong_explicit(
        &deque->top,
        (yo_continuation_t**)&top,
        (yo_continuation_t*)(top + 1),
        memory_order_seq_cst,
        memory_order_relaxed)) {
    // Lost race, another thief got it
    YO_MUTEX_UNLOCK(&deque->steal_mutex);
    return NULL;
  }
  
  YO_MUTEX_UNLOCK(&deque->steal_mutex);
  
  if (task) {
    atomic_fetch_sub_explicit(&deque->count, 1, memory_order_relaxed);
  }
  return task;
}

// Try to steal a task from a random worker (except current worker)
static yo_continuation_t* __yo_try_steal_from_random_worker(size_t current_worker_index) {
  if (yo_worker_thread_count <= 1) return NULL;
  
  // Use thread ID as random seed for victim selection
  size_t random_start = (size_t)YO_THREAD_ID();
  
  // Try to steal from multiple workers (up to N-1 attempts where N = worker count)
  size_t max_attempts = yo_worker_thread_count - 1;
  for (size_t attempt = 0; attempt < max_attempts; attempt++) {
    size_t victim_index = (random_start + attempt) % yo_worker_thread_count;
    
    // Don't steal from ourselves
    if (victim_index == current_worker_index) continue;
    
    yo_worker_thread_t* victim = &yo_worker_threads[victim_index];
    
    // Quick check: is victim's queue worth stealing from?
    size_t victim_count = atomic_load_explicit(&victim->deque.count, memory_order_relaxed);
    if (victim_count == 0) continue;
    
    // Try to steal a task
    yo_continuation_t* stolen_task = __yo_deque_steal(&victim->deque);
    if (stolen_task) {
      ASYNC_DEBUG("Worker %zu stole task from worker %zu\\n", current_worker_index, victim_index);
      return stolen_task;
    }
  }
  
  return NULL;
}

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
    
    // Push to bottom of worker's deque (lock-free for owner)
    __yo_deque_push_bottom(&worker->deque, task);
    
    ASYNC_DEBUG("Enqueued task to worker %zu (queue size: %zu)\\n", 
                worker_idx, atomic_load(&worker->deque.count));
  } else {
    CONCURRENCY_DEBUG("[SPAWN] Error: No workers available\\n");
  }
}

// Worker thread function with work-stealing
#ifdef _WIN32
static unsigned __stdcall __yo_worker_thread_func(void* arg) {
#else
static void* __yo_worker_thread_func(void* arg) {
#endif
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  yo_thread_id_t thread_id = YO_THREAD_ID();
  size_t worker_idx = worker->worker_index;
  
  // Pin this worker thread to its assigned CPU core for optimal cache locality
  __yo_set_thread_affinity(worker->core_id);
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu started on core %zu (worker=%zu)\\n", 
                    (unsigned long)thread_id, worker->core_id, worker_idx);
  
  size_t idle_iterations = 0;
  const size_t MAX_IDLE_BEFORE_STEAL = 3;  // Try local queue 3 times before stealing
  
  while (!atomic_load(&yo_worker_shutdown)) {
    yo_continuation_t* task = NULL;
    
    // Try to pop from our own deque first (lock-free, LIFO for cache locality)
    task = __yo_deque_pop_bottom(&worker->deque);
    
    if (task) {
      // Found task in our own queue
      idle_iterations = 0;
      
      CONCURRENCY_DEBUG("[WORKER %zu] Executing own task=%p (state_machine=%p, resume_fn=%p)\\n", 
                        worker_idx, task, task->state_machine, task->resume_fn);
      
      if (task->resume_fn && task->state_machine) {
        task->resume_fn(task->state_machine);
      }
      
      __yo_free(task);
      atomic_fetch_add(&worker->tasks_executed, 1);
      atomic_fetch_sub(&yo_active_task_count, 1);
      
    } else {
      // No local task - try work-stealing after a few idle iterations
      idle_iterations++;
      
      if (idle_iterations >= MAX_IDLE_BEFORE_STEAL) {
        atomic_fetch_add(&worker->steal_attempts, 1);
        task = __yo_try_steal_from_random_worker(worker_idx);
        
        if (task) {
          // Successfully stole a task
          idle_iterations = 0;
          
          CONCURRENCY_DEBUG("[WORKER %zu] Executing stolen task=%p (state_machine=%p, resume_fn=%p)\\n", 
                            worker_idx, task, task->state_machine, task->resume_fn);
          
          if (task->resume_fn && task->state_machine) {
            task->resume_fn(task->state_machine);
          }
          
          __yo_free(task);
          atomic_fetch_add(&worker->tasks_executed, 1);
          atomic_fetch_add(&worker->tasks_stolen, 1);
          atomic_fetch_sub(&yo_active_task_count, 1);
          
        } else {
          // No tasks available anywhere - sleep briefly
          #ifdef _WIN32
          Sleep(1);
          #else
          usleep(1000);  // 1ms
          #endif
          idle_iterations = 0;  // Reset after sleep
        }
      } else {
        // Quick yield before trying again
        #ifdef _WIN32
        Sleep(0);  // Yield
        #else
        sched_yield();
        #endif
      }
    }
    
    CONCURRENCY_DEBUG("[WORKER %zu] Stats: executed=%zu, stolen=%zu, steal_attempts=%zu, active_tasks=%zu\\n",
                      worker_idx,
                      atomic_load(&worker->tasks_executed),
                      atomic_load(&worker->tasks_stolen),
                      atomic_load(&worker->steal_attempts),
                      atomic_load(&yo_active_task_count));
  }
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu exiting (executed=%zu, stolen=%zu)\\n", 
                    (unsigned long)thread_id,
                    atomic_load(&worker->tasks_executed),
                    atomic_load(&worker->tasks_stolen));
  
  // Note: Thread-local GC state cleaned up automatically by GC runtime
  
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

// Initialize thread pool with work-stealing deques
static void __yo_thread_pool_init(size_t num_threads) {
  if (num_threads < 1 || yo_worker_thread_count > 0) {
    return;
  }
  
  CONCURRENCY_DEBUG("[POOL] Initializing %zu worker threads with work-stealing\\n", num_threads);
  
  yo_worker_threads = (yo_worker_thread_t*)__yo_malloc(sizeof(yo_worker_thread_t) * num_threads);
  yo_worker_thread_count = num_threads;
  atomic_store(&yo_worker_shutdown, false);
  atomic_store(&yo_next_worker_index, 0);
  
  // Initial deque size (power of 2)
  const size_t INITIAL_DEQUE_SIZE = 256;
  
  for (size_t i = 0; i < num_threads; i++) {
    yo_worker_threads[i].active = true;
    yo_worker_threads[i].core_id = i;
    yo_worker_threads[i].worker_index = i;
    
    // Initialize work-stealing deque
    __yo_deque_init(&yo_worker_threads[i].deque, INITIAL_DEQUE_SIZE);
    
    // Initialize statistics
    atomic_store(&yo_worker_threads[i].tasks_executed, 0);
    atomic_store(&yo_worker_threads[i].tasks_stolen, 0);
    atomic_store(&yo_worker_threads[i].steal_attempts, 0);
    
    #ifdef _WIN32
    yo_worker_threads[i].handle = (HANDLE)_beginthreadex(
      NULL, 0, __yo_worker_thread_func, &yo_worker_threads[i], 0, NULL
    );
    if (yo_worker_threads[i].handle == NULL) {
      fprintf(stderr, "[POOL] Failed to create worker thread %zu\\n", i);
    }
    #else
    int result = pthread_create(&yo_worker_threads[i].handle, NULL, __yo_worker_thread_func, &yo_worker_threads[i]);
    if (result != 0) {
      fprintf(stderr, "[POOL] Failed to create worker thread %zu: %d\\n", i, result);
    }
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
    // Reserve 1 core for GC thread to avoid contention
    size_t worker_threads = hardware_threads > 1 ? hardware_threads - 1 : 1;
    CONCURRENCY_DEBUG("[POOL] Hardware threads: %zu, reserving 1 for GC, using %zu for async workers\\n", 
                      hardware_threads, worker_threads);
    __yo_thread_pool_init(worker_threads);
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
        
        // Clean up work-stealing deque
        __yo_deque_destroy(&yo_worker_threads[i].deque);
        
        CONCURRENCY_DEBUG("[WAIT_ALL] Worker %zu stats: executed=%zu, stolen=%zu, steal_attempts=%zu\\n",
                          i,
                          atomic_load(&yo_worker_threads[i].tasks_executed),
                          atomic_load(&yo_worker_threads[i].tasks_stolen),
                          atomic_load(&yo_worker_threads[i].steal_attempts));
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
  static __thread yo_async_task_queue_t yo_thread_async_queue = {NULL, NULL, 0};
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

// Note: yo_future_generic_t is now defined in type declarations (after yo_gc_header_t)

// Dispose function for Future types - frees the state machine
void yo_future_dispose(void* future_ptr) {
  yo_future_generic_t* future = (yo_future_generic_t*)future_ptr;
  
  // Free the state machine if it exists
  if (future->state_machine) {
    ASYNC_DEBUG("Disposing Future: cleaning up and freeing state machine %p\\n", future->state_machine);
    
    // Call the state machine dispose function to drop variables before freeing
    if (future->state_machine_dispose_fn) {
      future->state_machine_dispose_fn(future->state_machine);
    } else {
      // Fallback: just free the state machine (old behavior)
      __yo_free(future->state_machine);
    }
    
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
