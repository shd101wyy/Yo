/**
 * parallelism-runtime.ts
 *
 * Generates the parallelism runtime code for multi-threaded isolated worker execution.
 * This implements the Worker type with message passing for parallel execution.
 *
 * NOTE: This is for spawn/spawn_local (parallelism with multiple threads).
 * For async/await (concurrency on single thread), see runtime.ts.
 */

import { Emitter } from "../../emitter";

/**
 * Generates the parallelism runtime code for Worker spawn and message passing.
 * Workers run on separate OS threads with isolated heaps.
 */
export function generateParallelismRuntime(
  emitter: Emitter,
  _debugParallelism: boolean
): void {
  emitter.emitLine(`
// ============================================================================
// Parallelism Runtime - Multi-Threaded Isolated Workers
// ============================================================================
// This implements isolated worker threads with message passing.
// Each worker runs on its own OS thread with its own:
// - Heap (GC-managed objects are thread-local)
// - Reference counting (non-atomic, thread-local)
// - Cycle collector (thread-local)
//
// Workers communicate via channels using send/recv.
// Only "sendable" types (primitives, value structs) can cross thread boundaries.
// Reference types (object, Dyn) cannot be sent between threads.
//
// Design: Both parent and child use the same yo_worker_t type.
// - Parent has a yo_worker_t that points to child
// - Child receives a yo_worker_t that points to parent (channels flipped)
// - Each tracks the other's liveness via other_alive pointer

// ============================================================================
// Channel Implementation - Bounded MPSC Queue
// ============================================================================

#define __YO_CHANNEL_DEFAULT_CAPACITY 16

// Channel for inter-thread communication
typedef struct __yo_channel_t {
  YO_THREAD_SYNC_TYPE mutex;       // Protects queue operations
  YO_COND_TYPE not_empty;          // Signaled when queue has data
  YO_COND_TYPE not_full;           // Signaled when queue has space
  void** buffer;                   // Ring buffer for messages
  size_t capacity;                 // Buffer capacity
  size_t head;                     // Read position
  size_t tail;                     // Write position
  size_t count;                    // Number of items in queue
  _Atomic bool closed;             // Channel closed flag
} __yo_channel_t;

// Create a new channel with specified capacity
__yo_channel_t* __yo_channel_create(size_t capacity) {
  __yo_channel_t* ch = (__yo_channel_t*)__yo_malloc(sizeof(__yo_channel_t));
  if (!ch) return NULL;
  
  ch->buffer = (void**)__yo_malloc(capacity * sizeof(void*));
  if (!ch->buffer) {
    __yo_free(ch);
    return NULL;
  }
  
  yo_mutex_init(&ch->mutex);
  yo_cond_init(&ch->not_empty);
  yo_cond_init(&ch->not_full);
  ch->capacity = capacity;
  ch->head = 0;
  ch->tail = 0;
  ch->count = 0;
  atomic_init(&ch->closed, false);
  
  PARALLELISM_DEBUG("[CHANNEL] Created channel %p with capacity %zu\\n", (void*)ch, capacity);
  return ch;
}

// Destroy a channel and free resources
void __yo_channel_destroy(__yo_channel_t* ch) {
  if (!ch) return;
  
  PARALLELISM_DEBUG("[CHANNEL] Destroying channel %p\\n", (void*)ch);
  
  yo_mutex_destroy(&ch->mutex);
  yo_cond_destroy(&ch->not_empty);
  yo_cond_destroy(&ch->not_full);
  __yo_free(ch->buffer);
  __yo_free(ch);
}

// Close a channel (wake up all waiting threads)
void __yo_channel_close(__yo_channel_t* ch) {
  if (!ch) return;
  
  yo_mutex_lock(&ch->mutex);
  atomic_store(&ch->closed, true);
  yo_cond_broadcast(&ch->not_empty);  // Wake up all receivers
  yo_cond_broadcast(&ch->not_full);   // Wake up all senders
  yo_mutex_unlock(&ch->mutex);
  
  PARALLELISM_DEBUG("[CHANNEL] Closed channel %p\\n", (void*)ch);
}

// Send a message to the channel (blocking)
// Returns true if sent, false if channel is closed
bool __yo_channel_send(__yo_channel_t* ch, void* msg) {
  if (!ch) return false;
  
  yo_mutex_lock(&ch->mutex);
  
  // Wait for space in the buffer
  while (ch->count >= ch->capacity && !atomic_load(&ch->closed)) {
    PARALLELISM_DEBUG("[CHANNEL] Channel %p full, waiting...\\n", (void*)ch);
    yo_cond_wait(&ch->not_full, &ch->mutex);
  }
  
  // Check if closed while waiting
  if (atomic_load(&ch->closed)) {
    yo_mutex_unlock(&ch->mutex);
    PARALLELISM_DEBUG("[CHANNEL] Channel %p closed, send failed\\n", (void*)ch);
    return false;
  }
  
  // Add message to buffer
  ch->buffer[ch->tail] = msg;
  ch->tail = (ch->tail + 1) % ch->capacity;
  ch->count++;
  
  PARALLELISM_DEBUG("[CHANNEL] Sent message %p to channel %p (count=%zu)\\n", msg, (void*)ch, ch->count);
  
  // Signal that data is available
  yo_cond_signal(&ch->not_empty);
  yo_mutex_unlock(&ch->mutex);
  
  return true;
}

// Receive a message from the channel (blocking)
// Returns NULL if channel is closed and empty
void* __yo_channel_recv(__yo_channel_t* ch) {
  if (!ch) return NULL;
  
  yo_mutex_lock(&ch->mutex);
  
  // Wait for data in the buffer
  while (ch->count == 0 && !atomic_load(&ch->closed)) {
    PARALLELISM_DEBUG("[CHANNEL] Channel %p empty, waiting...\\n", (void*)ch);
    yo_cond_wait(&ch->not_empty, &ch->mutex);
  }
  
  // Check if closed and empty
  if (ch->count == 0 && atomic_load(&ch->closed)) {
    yo_mutex_unlock(&ch->mutex);
    PARALLELISM_DEBUG("[CHANNEL] Channel %p closed and empty, recv failed\\n", (void*)ch);
    return NULL;
  }
  
  // Get message from buffer
  void* msg = ch->buffer[ch->head];
  ch->head = (ch->head + 1) % ch->capacity;
  ch->count--;
  
  PARALLELISM_DEBUG("[CHANNEL] Received message %p from channel %p (count=%zu)\\n", msg, (void*)ch, ch->count);
  
  // Signal that space is available
  yo_cond_signal(&ch->not_full);
  yo_mutex_unlock(&ch->mutex);
  
  return msg;
}

// Try to receive without blocking
// Returns NULL if no message available or closed
void* __yo_channel_try_recv(__yo_channel_t* ch) {
  if (!ch) return NULL;
  
  yo_mutex_lock(&ch->mutex);
  
  if (ch->count == 0) {
    yo_mutex_unlock(&ch->mutex);
    return NULL;
  }
  
  void* msg = ch->buffer[ch->head];
  ch->head = (ch->head + 1) % ch->capacity;
  ch->count--;
  
  yo_cond_signal(&ch->not_full);
  yo_mutex_unlock(&ch->mutex);
  
  return msg;
}

// Check if channel is closed
bool __yo_channel_is_closed(__yo_channel_t* ch) {
  if (!ch) return true;
  return atomic_load(&ch->closed);
}

// ============================================================================
// Worker Implementation
// ============================================================================
// 
// Design: __yo_worker_t is used by BOTH parent and child (symmetric design)
// 
// Parent's view:                    Child's view:
// ┌─────────────────┐              ┌─────────────────┐
// │ __yo_worker_t   │              │ __yo_worker_t   │
// │ send_channel ───┼──────────────┼─► recv_channel  │
// │ recv_channel ◄──┼──────────────┼── send_channel  │
// │ self_alive ─────┼──► child     │ self_alive ─────┼──► parent reads
// │ other_alive ◄───┼── child sets │ other_alive ◄───┼── parent sets
// └─────────────────┘              └─────────────────┘
//
// When child exits: sets parent's other_alive = false
// When parent drops: sets child's other_alive = false (if child still alive)

// Forward declaration
typedef struct __yo_worker_t __yo_worker_t;

// Worker handle - same type for both parent and child (symmetric)
// Reference counted for proper lifecycle management
struct __yo_worker_t {
  // Reference counting header (for GC integration)
  size_t ref_count;                // Reference count (non-atomic, thread-local ownership)
  
  // Communication channels
  __yo_channel_t* send_channel;    // Channel to send messages TO the other side
  __yo_channel_t* recv_channel;    // Channel to receive messages FROM the other side
  
  // Liveness tracking (cross-thread, so must be atomic)
  _Atomic bool self_alive;         // Am I still alive? (other side reads this)
  _Atomic bool* other_alive;       // Is the other side alive? (points to other's self_alive)
  
  // Thread handle (only meaningful for parent's view of child)
  YO_THREAD_TYPE thread;           // OS thread handle (for join)
  bool owns_thread;                // Does this worker own the thread? (parent: yes, child: no)
};

// Worker callback function type
typedef void (*__yo_worker_callback_fn)(__yo_worker_t* self, void* closure);

// Thread entry point argument
typedef struct __yo_worker_spawn_args_t {
  __yo_worker_callback_fn callback;  // User's callback function
  void* closure;                     // Captured environment for callback
  __yo_worker_t* child_worker;       // Child's worker handle (already allocated)
} __yo_worker_spawn_args_t;

// Increment worker reference count
void __yo_worker_dup(__yo_worker_t* worker) {
  if (!worker) return;
  worker->ref_count++;
  PARALLELISM_DEBUG("[WORKER] dup worker %p, ref_count=%zu\\n", (void*)worker, worker->ref_count);
}

// Decrement worker reference count and free if zero
void __yo_worker_drop(__yo_worker_t* worker) {
  if (!worker) return;
  
  PARALLELISM_DEBUG("[WORKER] drop worker %p, ref_count=%zu\\n", (void*)worker, worker->ref_count);
  
  if (worker->ref_count <= 1) {
    PARALLELISM_DEBUG("[WORKER] Destroying worker %p\\n", (void*)worker);
    
    // Mark self as no longer alive (other side will see this)
    atomic_store(&worker->self_alive, false);
    
    // Close and destroy channels
    // Note: Channels are shared, but each side only closes them when it's done
    if (worker->send_channel) {
      __yo_channel_close(worker->send_channel);
    }
    if (worker->recv_channel) {
      __yo_channel_close(worker->recv_channel);
    }
    
    // If we own the thread (parent), we need to handle cleanup
    // But we don't join here - that should be done explicitly
    
    // Don't destroy channels here - they might still be in use by other side
    // Channels are destroyed when BOTH sides are done (refcounted separately)
    // For simplicity now, let's just free the worker struct
    // TODO: Proper channel refcounting
    
    __yo_free(worker);
  } else {
    worker->ref_count--;
  }
}

// Worker thread entry point
static void* __yo_worker_thread_entry(void* arg) {
  __yo_worker_spawn_args_t* args = (__yo_worker_spawn_args_t*)arg;
  
  PARALLELISM_DEBUG("[WORKER] Child thread started (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  // Initialize thread-local GC state for this worker thread
  __yo_gc_init_thread();
  
  // Get the child's worker handle
  __yo_worker_t* child_worker = args->child_worker;
  
  // Call the user's callback with the child's worker handle
  args->callback(child_worker, args->closure);
  
  PARALLELISM_DEBUG("[WORKER] Child callback completed\\n");
  
  // Mark self as no longer alive (parent will see this)
  atomic_store(&child_worker->self_alive, false);
  
  // Close channels from child side to wake up any blocked parent
  __yo_channel_close(child_worker->send_channel);
  __yo_channel_close(child_worker->recv_channel);
  
  // Drop the child's reference to its worker handle
  __yo_worker_drop(child_worker);
  
  // Run thread-local GC cleanup
  __yo_gc_collect();
  
  // Free the spawn args
  __yo_free(args);
  
  PARALLELISM_DEBUG("[WORKER] Child thread exiting (tid=%zu)\\n", (size_t)__yo_get_thread_id());
  
  return NULL;
}

// Spawn a worker on a dedicated OS thread (spawn_local)
// Returns the parent's worker handle
__yo_worker_t* __yo_worker_spawn_local(__yo_worker_callback_fn callback, void* closure) {
  PARALLELISM_DEBUG("[WORKER] Spawning local worker\\n");
  
  // Create two channels for bidirectional communication
  __yo_channel_t* parent_to_child = __yo_channel_create(__YO_CHANNEL_DEFAULT_CAPACITY);
  __yo_channel_t* child_to_parent = __yo_channel_create(__YO_CHANNEL_DEFAULT_CAPACITY);
  
  if (!parent_to_child || !child_to_parent) {
    PARALLELISM_DEBUG("[WORKER] Failed to create channels\\n");
    if (parent_to_child) __yo_channel_destroy(parent_to_child);
    if (child_to_parent) __yo_channel_destroy(child_to_parent);
    return NULL;
  }
  
  // Allocate parent's worker handle
  __yo_worker_t* parent_worker = (__yo_worker_t*)__yo_malloc(sizeof(__yo_worker_t));
  if (!parent_worker) {
    __yo_channel_destroy(parent_to_child);
    __yo_channel_destroy(child_to_parent);
    return NULL;
  }
  
  // Allocate child's worker handle
  __yo_worker_t* child_worker = (__yo_worker_t*)__yo_malloc(sizeof(__yo_worker_t));
  if (!child_worker) {
    __yo_free(parent_worker);
    __yo_channel_destroy(parent_to_child);
    __yo_channel_destroy(child_to_parent);
    return NULL;
  }
  
  // Initialize parent's worker
  parent_worker->ref_count = 1;  // Parent owns one reference
  parent_worker->send_channel = parent_to_child;
  parent_worker->recv_channel = child_to_parent;
  atomic_init(&parent_worker->self_alive, true);
  parent_worker->other_alive = &child_worker->self_alive;  // Points to child's self_alive
  parent_worker->owns_thread = true;
  
  // Initialize child's worker (channels are flipped!)
  child_worker->ref_count = 1;  // Child owns one reference (will be passed to callback)
  child_worker->send_channel = child_to_parent;  // Child sends to parent
  child_worker->recv_channel = parent_to_child;  // Child receives from parent
  atomic_init(&child_worker->self_alive, true);
  child_worker->other_alive = &parent_worker->self_alive;  // Points to parent's self_alive
  child_worker->owns_thread = false;  // Child doesn't own the thread
  
  // Prepare spawn arguments
  __yo_worker_spawn_args_t* args = (__yo_worker_spawn_args_t*)__yo_malloc(sizeof(__yo_worker_spawn_args_t));
  if (!args) {
    __yo_free(parent_worker);
    __yo_free(child_worker);
    __yo_channel_destroy(parent_to_child);
    __yo_channel_destroy(child_to_parent);
    return NULL;
  }
  
  args->callback = callback;
  args->closure = closure;
  args->child_worker = child_worker;
  
  // Create the thread
  int ret = yo_thread_create(&parent_worker->thread, __yo_worker_thread_entry, args);
  if (ret != 0) {
    PARALLELISM_DEBUG("[WORKER] Failed to create thread (ret=%d)\\n", ret);
    __yo_free(args);
    __yo_free(parent_worker);
    __yo_free(child_worker);
    __yo_channel_destroy(parent_to_child);
    __yo_channel_destroy(child_to_parent);
    return NULL;
  }
  
  // Copy thread handle to child (for debugging purposes)
  child_worker->thread = parent_worker->thread;
  
  PARALLELISM_DEBUG("[WORKER] Spawned local worker, parent=%p, child=%p\\n", 
                    (void*)parent_worker, (void*)child_worker);
  
  return parent_worker;
}

// Wait for a worker to complete (join the thread)
void __yo_worker_join(__yo_worker_t* worker) {
  if (!worker || !worker->owns_thread) return;
  
  PARALLELISM_DEBUG("[WORKER] Joining worker %p\\n", (void*)worker);
  yo_thread_join(worker->thread);
  PARALLELISM_DEBUG("[WORKER] Worker %p joined\\n", (void*)worker);
}

// Check if the other side is still alive
bool __yo_worker_is_other_alive(__yo_worker_t* worker) {
  if (!worker || !worker->other_alive) return false;
  return atomic_load(worker->other_alive);
}

// ============================================================================
// Type-Specific Send/Recv Functions
// ============================================================================

// Worker send for i32
bool __yo_worker_send_i32(__yo_worker_t* worker, int32_t value) {
  if (!worker || !worker->send_channel) return false;
  int32_t* msg = (int32_t*)__yo_malloc(sizeof(int32_t));
  if (!msg) return false;
  *msg = value;
  bool ok = __yo_channel_send(worker->send_channel, msg);
  if (!ok) __yo_free(msg);
  return ok;
}

// Worker recv for i32 - returns Result-like (success flag + value)
int32_t __yo_worker_recv_i32(__yo_worker_t* worker, bool* ok) {
  if (!worker || !worker->recv_channel) {
    if (ok) *ok = false;
    return 0;
  }
  void* msg = __yo_channel_recv(worker->recv_channel);
  if (!msg) {
    if (ok) *ok = false;
    return 0;
  }
  int32_t value = *(int32_t*)msg;
  __yo_free(msg);
  if (ok) *ok = true;
  return value;
}

// Worker send for boolean
bool __yo_worker_send_boolean(__yo_worker_t* worker, bool value) {
  if (!worker || !worker->send_channel) return false;
  bool* msg = (bool*)__yo_malloc(sizeof(bool));
  if (!msg) return false;
  *msg = value;
  bool ok = __yo_channel_send(worker->send_channel, msg);
  if (!ok) __yo_free(msg);
  return ok;
}

// Worker recv for boolean
bool __yo_worker_recv_boolean(__yo_worker_t* worker, bool* ok) {
  if (!worker || !worker->recv_channel) {
    if (ok) *ok = false;
    return false;
  }
  void* msg = __yo_channel_recv(worker->recv_channel);
  if (!msg) {
    if (ok) *ok = false;
    return false;
  }
  bool value = *(bool*)msg;
  __yo_free(msg);
  if (ok) *ok = true;
  return value;
}
`);
}
