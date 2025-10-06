/**
 * Stackless coroutine runtime generation
 *
 * This module generates C code for stackless coroutines using continuation-passing style.
 * Unlike the stackful approach (setjmp/longjmp), this transforms async functions into
 * state machines that can suspend and resume without separate stacks.
 */

import { Emitter } from "../emitter";

/**
 * Generate the stackless task runtime system
 * This includes:
 * - Task structure (no stack, no jmp_buf)
 * - Task queues (ready, suspended)
 * - Simple scheduler loop
 * - Wake-up mechanism
 */
export function generateStacklessRuntime(emitter: Emitter): void {
  emitter.emitLine(`
// ============================================================================
// STACKLESS COROUTINE RUNTIME
// ============================================================================
// This runtime uses continuation-passing style to implement cooperative
// multitasking without separate stacks. Functions with suspension points
// are transformed into state machines.

// Thread support (same as before)
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
  typedef pthread_t yo_thread_handle_t;
  typedef pthread_t yo_thread_id_t;
  typedef pthread_mutex_t yo_mutex_t;
  #define YO_MUTEX_INIT(m) pthread_mutex_init(m, NULL)
  #define YO_MUTEX_DESTROY(m) pthread_mutex_destroy(m)
  #define YO_MUTEX_LOCK(m) pthread_mutex_lock(m)
  #define YO_MUTEX_UNLOCK(m) pthread_mutex_unlock(m)
  #define YO_THREAD_ID() ((yo_thread_id_t)pthread_self())
#endif

// Forward declarations
typedef struct yo_task yo_task_t;
typedef struct yo_task_queue yo_task_queue_t;

// Task state
typedef enum {
  YO_TASK_READY,      // Ready to run (in ready queue)
  YO_TASK_RUNNING,    // Currently executing
  YO_TASK_SUSPENDED,  // Suspended on channel (in wait queues)
  YO_TASK_COMPLETED   // Finished execution
} yo_task_state_t;

// Select case information (same as before)
typedef struct yo_select_case {
  void* channel;              // Channel for this case
  bool is_send;               // true = send, false = receive
  void* value_ptr;            // For send: pointer to value, for recv: pointer to store result
  int case_index;             // Which case this is (for switch statement)
} yo_select_case_t;

// Stackless task structure
struct yo_task {
  void (*continuation)(yo_task_t*);  // Continuation function to resume from
  void* data;                         // Task-local state (heap-allocated struct with all locals)
  int state_id;                       // Which suspension point we're at (state machine state)
  yo_task_state_t state;              // Current task state
  void* wait_channel;                 // Channel this task is waiting on (NULL if not waiting)
  int select_ready_case;              // For select: which case became ready (-1 if none)
  yo_select_case_t* select_cases;     // For select: array of cases (saved during suspend)
  int select_num_cases;               // For select: number of cases
  yo_task_t* next;                    // Next task in queue (for ready/suspended queues)
  yo_task_t* next_wait;               // Next task in channel wait queue
};

// Task queue (simple linked list)
struct yo_task_queue {
  yo_task_t* head;
  yo_task_t* tail;
  size_t count;
};

// Worker thread structure with per-thread task queues
typedef struct {
  yo_thread_handle_t handle;
  yo_thread_id_t id;
  bool active;
  yo_task_queue_t ready_queue;     // Each worker has its own ready queue
  yo_mutex_t queue_mutex;          // Protects this worker's queue
} yo_worker_thread_t;

// Global scheduler state
static _Thread_local yo_task_t* yo_task_current = NULL;  // Thread-local current task
static _Thread_local yo_worker_thread_t* yo_task_current_worker = NULL;  // Thread-local worker pointer
static size_t yo_task_max_threads = 0;
static bool yo_task_scheduler_initialized = false;
static _Atomic size_t yo_active_task_count = 0;  // Total number of active tasks
static _Atomic bool yo_worker_shutdown = false;
static _Atomic size_t yo_next_worker_index = 0;  // For round-robin task distribution

// Thread pool state
static yo_worker_thread_t* yo_worker_threads = NULL;
static size_t yo_worker_thread_count = 0;

// ============================================================================
// TASK QUEUE OPERATIONS
// ============================================================================

// Enqueue a task to a worker's ready queue
static void __yo_task_enqueue_to_worker(yo_worker_thread_t* worker, yo_task_t* task) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  task->next = NULL;
  if (worker->ready_queue.tail) {
    worker->ready_queue.tail->next = task;
  } else {
    worker->ready_queue.head = task;
  }
  worker->ready_queue.tail = task;
  worker->ready_queue.count++;
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
}

// Dequeue a task from current worker's ready queue
static yo_task_t* __yo_task_dequeue_from_worker(yo_worker_thread_t* worker) {
  YO_MUTEX_LOCK(&worker->queue_mutex);
  
  yo_task_t* task = worker->ready_queue.head;
  if (task) {
    worker->ready_queue.head = task->next;
    if (!worker->ready_queue.head) {
      worker->ready_queue.tail = NULL;
    }
    worker->ready_queue.count--;
  }
  
  YO_MUTEX_UNLOCK(&worker->queue_mutex);
  return task;
}

// Re-enqueue current task (for yielding)
static void __yo_task_requeue_current(void) {
  if (!yo_task_current || !yo_task_current_worker) {
    return;
  }
  
  yo_task_current->state = YO_TASK_READY;
  __yo_task_enqueue_to_worker(yo_task_current_worker, yo_task_current);
}

// ============================================================================
// SCHEDULER
// ============================================================================

// Initialize task scheduler
static void __yo_task_scheduler_init(void) {
  if (!yo_task_scheduler_initialized) {
    yo_task_scheduler_initialized = true;
  }
}

// Worker thread function - runs tasks from its ready queue
#ifdef _WIN32
static unsigned __stdcall __yo_worker_thread_func(void* arg) {
#else
static void* __yo_worker_thread_func(void* arg) {
#endif
  yo_worker_thread_t* worker = (yo_worker_thread_t*)arg;
  yo_thread_id_t thread_id = YO_THREAD_ID();
  
  // Set thread-local worker pointer
  yo_task_current_worker = worker;
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu started (worker=%p)\\n", (unsigned long)thread_id, worker);
  
  while (!atomic_load(&yo_worker_shutdown)) {
    yo_task_t* task = __yo_task_dequeue_from_worker(worker);
    
    if (!task) {
      // No tasks available, sleep briefly
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);  // 1ms
      #endif
      continue;
    }
    
    CONCURRENCY_DEBUG("[WORKER] Thread %lu executing task=%p (state_id=%d)\\n", 
                     (unsigned long)thread_id, task, task->state_id);
    
    yo_task_current = task;
    task->state = YO_TASK_RUNNING;
    
    // Call continuation - it will return when:
    // 1. Task suspends (returns early with state=SUSPENDED)
    // 2. Task completes (returns with state=COMPLETED)
    task->continuation(task);
    
    if (task->state == YO_TASK_COMPLETED) {
      CONCURRENCY_DEBUG("[WORKER] Task=%p completed\\n", task);
      // Free task data and task itself
      if (task->data) {
        __yo_free(task->data);
      }
      __yo_free(task);
      atomic_fetch_sub(&yo_active_task_count, 1);
    } else if (task->state == YO_TASK_SUSPENDED) {
      CONCURRENCY_DEBUG("[WORKER] Task=%p suspended (state_id=%d)\\n", task, task->state_id);
      // Task is now in channel wait queues, don't re-enqueue
    } else {
      // Task is still ready (yielded) - re-enqueue
      CONCURRENCY_DEBUG("[WORKER] Task=%p yielded, re-enqueueing\\n", task);
      __yo_task_requeue_current();
    }
    
    yo_task_current = NULL;
  }
  
  CONCURRENCY_DEBUG("[WORKER] Thread %lu exiting\\n", (unsigned long)thread_id);
  #ifdef _WIN32
  return 0;
  #else
  return NULL;
  #endif
}

// Get number of hardware threads available
static size_t __yo_concurrency_get_hardware_threads(void) {
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
    yo_worker_threads[i].ready_queue = (yo_task_queue_t){NULL, NULL, 0};
    YO_MUTEX_INIT(&yo_worker_threads[i].queue_mutex);
    
    #ifdef _WIN32
    yo_worker_threads[i].handle = (HANDLE)_beginthreadex(
      NULL, 0, __yo_worker_thread_func, &yo_worker_threads[i], 0, NULL
    );
    #else
    pthread_create(&yo_worker_threads[i].handle, NULL, __yo_worker_thread_func, &yo_worker_threads[i]);
    #endif
    
    CONCURRENCY_DEBUG("[POOL] Spawned worker thread %zu\\n", i);
  }
}

// Set maximum number of threads for task scheduler
void __yo_concurrency_set_maximum_threads(size_t num) {
  __yo_task_scheduler_init();
  
  if (num == 0) {
    num = __yo_concurrency_get_hardware_threads();
  }
  
  yo_task_max_threads = num;
  __yo_thread_pool_init(num);
}

// Wait for all spawned tasks to complete
void __yo_task_wait_all(void) {
  if (!yo_task_scheduler_initialized) {
    return;
  }
  
  CONCURRENCY_DEBUG("[WAIT_ALL] Waiting for all tasks to complete\\n");
  
  if (yo_worker_thread_count > 0) {
    // Wait until all active tasks complete
    while (atomic_load(&yo_active_task_count) > 0) {
      #ifdef _WIN32
      Sleep(1);
      #else
      usleep(1000);  // 1ms
      #endif
    }
    
    CONCURRENCY_DEBUG("[WAIT_ALL] All tasks completed, shutting down workers\\n");
    
    // Signal workers to shutdown
    atomic_store(&yo_worker_shutdown, true);
    
    // Join all worker threads
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

// Spawn a simple unit task (void -> void)
void __yo_task_spawn_unit_function(void (*func)(void)) {
  // This is a placeholder - actual spawning will be done by generated code
  // that creates proper task structures with continuations
  CONCURRENCY_DEBUG("[SPAWN] Warning: __yo_task_spawn_unit_function called but not implemented for stackless\\n");
}
`);
}
