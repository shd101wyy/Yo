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

// Spawn an async task by starting its execution
// For async functions without await, this just calls them
// For async functions with await, this starts the state machine
static void yo_async_spawn(void* future) {
  // For now, do nothing - the Future is already being executed
  // In a more sophisticated runtime, we might enqueue it to run later
  ASYNC_DEBUG("Spawning async task: future=%p\\n", future);
  (void)future;  // Suppress unused parameter warning
}

// Register a continuation to be called when a Future completes
// This is called when await encounters a pending Future
static void yo_async_register_continuation(
    void* future,
    void (*resume_fn)(void*),
    void* state_machine) {
  
  ASYNC_DEBUG("Registering continuation for future=%p: resume_fn=%p, sm=%p\\n",
              future, (void*)resume_fn, state_machine);
  
  (void)future;  // Suppress unused parameter warning
  
  // For now, just enqueue the continuation
  // In a full implementation, we'd attach it to the Future
  // and invoke it when the Future completes
  
  // Since we don't have actual async I/O yet, we'll just enqueue it
  // to run in the next event loop iteration
  yo_async_enqueue_continuation(resume_fn, state_machine);
}

// Initialize async runtime (called at program start)
static void yo_async_runtime_init(void) {
  yo_thread_async_queue.head = NULL;
  yo_thread_async_queue.tail = NULL;
  yo_thread_async_queue.count = 0;
  ASYNC_DEBUG("Async runtime initialized\\n");
}
`);
}
