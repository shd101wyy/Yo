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
// Note: __yo_thread_t is returned by value (stack allocated)
// The pthread handle is stored directly in the struct

// Thread handle (value type, not pointer)
typedef struct __yo_thread_t {
  YO_THREAD_TYPE handle;        // OS thread handle (pthread_t or HANDLE)
} __yo_thread_t;

// Thread callback type - function pointer with closure
typedef void (*__yo_thread_fn)(void* closure);

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
`);
}
