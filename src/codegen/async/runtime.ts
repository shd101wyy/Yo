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

#include <stdbool.h>
#include <stdatomic.h>

// Forward declarations for state machine resume functions
// These will be generated for each async function

// Continuation - represents a state machine waiting to be resumed
typedef struct yo_continuation_t {
  void (*resume_fn)(void* state_machine);  // Function to call to resume
  void* state_machine;                      // State machine to resume
  struct yo_continuation_t* next;           // Next in linked list
} yo_continuation_t;

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
  _Atomic(void*) continuation_fn;
  _Atomic(void*) continuation_sm;
} yo_future_generic_t;

// Dispose function for Future types - frees the state machine
static void yo_future_dispose(void* future_ptr) {
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

// Spawn an async task by starting its execution on a worker thread
// This enqueues the task to a worker's task queue (NO coroutines!)
static void yo_async_spawn_task(void (*resume_fn)(void*), void* state_machine) {
  ASYNC_DEBUG("Spawning async task to worker: resume_fn=%p, sm=%p\\n", (void*)resume_fn, state_machine);
  
  // Initialize the async scheduler if not already done
  __yo_async_scheduler_init();
  
  // If no workers, run on current thread immediately
  if (yo_worker_thread_count == 0) {
    __yo_concurrency_set_maximum_threads(0);  // Initialize with hardware threads
  }
  
  if (yo_worker_thread_count > 0) {
    // Assign to a worker thread (round-robin)
    size_t limit = yo_async_active_worker_limit > 0 ? yo_async_active_worker_limit : yo_worker_thread_count;
    size_t worker_idx = atomic_fetch_add(&yo_next_worker_index, 1) % limit;
    yo_worker_thread_t* worker = &yo_worker_threads[worker_idx];
    
    ASYNC_DEBUG("Assigning async task to worker %zu\\n", worker_idx);
    
    // Increment active task counter BEFORE enqueueing
    atomic_fetch_add(&yo_active_task_count, 1);
    
    // Enqueue task to worker's queue
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

// Register a continuation to be called when a Future completes
// This is called when await encounters a pending Future
static void yo_async_register_continuation(
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

// Initialize async runtime (called at program start)
static void __yo_async_scheduler_init(void) {
  if (yo_async_scheduler_initialized) {
    return;  // Already initialized
  }
  yo_async_scheduler_initialized = true;
  ASYNC_DEBUG("Async scheduler initialized\\n");
}
`);
}
