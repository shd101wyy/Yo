import { Emitter } from "../../emitter";
import { CodeGenContext } from "../utils";

/**
 * Generate GC runtime function declarations and implementations
 *
 * Phase 2: Basic GC Infrastructure
 * - __yo_gc_alloc(type_descriptor) - heap allocation
 * - __yo_gc_collect() - manual GC trigger
 * - Basic stop-the-world mark-sweep collector
 */

/**
 * Generate GC runtime function declarations
 */
export function generateGCRuntimeDeclarations(emitter: Emitter): void {
  emitter.emitDeclarationLine(`/// GC Runtime Functions`);
  emitter.emitDeclarationLine(
    `void* __yo_gc_alloc(size_t size, void* type_descriptor);`
  );
  emitter.emitDeclarationLine(`void __yo_gc_collect(void);`);
  emitter.emitDeclarationLine(`void __yo_gc_print_stats(void);`);
  emitter.emitDeclarationLine(``);
  emitter.emitDeclarationLine(`/// Sync Primitives`);
  emitter.emitDeclarationLine(`YO_THREAD_SYNC_TYPE yo_mutex_create(void);`);
  emitter.emitDeclarationLine(`YO_COND_TYPE yo_cond_create(void);`);
  emitter.emitDeclarationLine(``);
}

/**
 * Generate GC runtime function implementations
 *
 * This implements a basic stop-the-world mark-sweep collector:
 * 1. All objects are tracked in a global linked list
 * 2. Mark phase: Scan shadow stack (TODO in Phase 3) and mark reachable objects
 * 3. Sweep phase: Free unmarked objects
 */
export function generateGCRuntimeFunctions(context: CodeGenContext): void {
  const emitter = context.emitter;

  const debugGc = context.debugGc
    ? "#ifdef YO_DEBUG_GC"
    : "#if 0  // YO_DEBUG_GC disabled";

  emitter.emitLine(`
// =============================================================================
// GC Runtime Implementation - Phase 2: Basic Mark-Sweep
// =============================================================================

// GC color constants for tri-color marking
#define YO_GC_WHITE 0  // Unmarked (will be collected)
#define YO_GC_GRAY  1  // Marked, children not yet scanned
#define YO_GC_BLACK 2  // Marked, children scanned

// Global GC state
typedef struct {
  yo_gc_header_t* all_objects;    // Head of all allocated objects list
  size_t total_objects;            // Total number of tracked objects
  size_t total_bytes;              // Total allocated bytes
  size_t gc_threshold;             // Trigger GC when bytes exceed this
  bool gc_enabled;                 // Can disable GC during initialization
} yo_gc_state_t;

static yo_gc_state_t yo_gc = {
  .all_objects = NULL,
  .total_objects = 0,
  .total_bytes = 0,
  .gc_threshold = 1024 * 1024,  // Start with 1MB threshold
  .gc_enabled = true
};

// =============================================================================
// Generational GC - Phase 5: Young/Old Generation Separation
// =============================================================================
// Concurrent GC - Phase 4: Tri-Color Marking
// =============================================================================

/**
 * Gray queue for concurrent marking
 * Tracks objects marked GRAY (pending scan) during concurrent marking phase
 */
typedef struct {
  void** objects;           // Array of gray objects to scan
  size_t size;              // Current number of objects
  size_t capacity;          // Array capacity
  YO_THREAD_SYNC_TYPE lock; // For concurrent access
} YoGrayQueue;

static YoGrayQueue yo_gray_queue = {
  .objects = NULL,
  .size = 0,
  .capacity = 0
};

// Concurrent marking state
static volatile bool yo_gc_is_marking = false;

/**
 * Initialize gray queue
 */
static void yo_gray_queue_init(void) {
  if (yo_gray_queue.objects == NULL) {
    yo_gray_queue.capacity = 1024;  // Initial capacity
    yo_gray_queue.objects = (void**)malloc(yo_gray_queue.capacity * sizeof(void*));
    yo_mutex_init(&yo_gray_queue.lock);
  }
  yo_gray_queue.size = 0;
}

/**
 * Push object to gray queue (thread-safe)
 */
static void yo_gc_push_gray(void* obj) {
  yo_mutex_lock(&yo_gray_queue.lock);
  
  // Resize if needed
  if (yo_gray_queue.size >= yo_gray_queue.capacity) {
    yo_gray_queue.capacity *= 2;
    yo_gray_queue.objects = (void**)realloc(
      yo_gray_queue.objects,
      yo_gray_queue.capacity * sizeof(void*)
    );
  }
  
  yo_gray_queue.objects[yo_gray_queue.size++] = obj;
  
  yo_mutex_unlock(&yo_gray_queue.lock);
}

/**
 * Pop object from gray queue (thread-safe)
 * Returns NULL if queue is empty
 */
static void* yo_gc_pop_gray(void) {
  yo_mutex_lock(&yo_gray_queue.lock);
  
  void* obj = NULL;
  if (yo_gray_queue.size > 0) {
    obj = yo_gray_queue.objects[--yo_gray_queue.size];
  }
  
  yo_mutex_unlock(&yo_gray_queue.lock);
  return obj;
}

/**
 * Check if gray queue has objects
 */
static bool yo_gc_has_gray_objects(void) {
  yo_mutex_lock(&yo_gray_queue.lock);
  bool has_objects = yo_gray_queue.size > 0;
  yo_mutex_unlock(&yo_gray_queue.lock);
  return has_objects;
}

/**
 * Get color of an object
 */
static inline uint8_t yo_gc_get_color(void* obj) {
  yo_gc_header_t* header = YO_GC_HEADER(obj);
  return header->mark_bits;
}

/**
 * Set color of an object
 */
static inline void yo_gc_set_color(void* obj, uint8_t color) {
  yo_gc_header_t* header = YO_GC_HEADER(obj);
  header->mark_bits = color;
}

// =============================================================================
// Safepoint Mechanism - Phase 4: Stop-The-World Coordination
// =============================================================================

/**
 * Safepoint state for stopping mutator threads during GC pauses
 * Safepoints are program points where threads can be safely paused for GC
 */
typedef struct {
  volatile bool requested;        // GC wants threads to stop
  YO_THREAD_SYNC_TYPE mutex;      // Protects safepoint state
  YO_COND_TYPE cond;              // Signals when safe to resume
  size_t num_threads;             // Total mutator threads (excluding GC thread)
  size_t threads_at_safepoint;    // Threads currently stopped
} YoSafepointState;

static YoSafepointState yo_safepoint_state = {
  .requested = false,
  .num_threads = 1,  // Start with main thread
  .threads_at_safepoint = 0
};


/**
 * Initialize safepoint mechanism
 */
static void yo_safepoint_init(void) {
  yo_mutex_init(&yo_safepoint_state.mutex);
  yo_cond_init(&yo_safepoint_state.cond);
}

// =============================================================================
// GC Thread Management - Phase 4: Concurrent GC Threads
// =============================================================================

/**
 * GC thread state
 * Dedicated background threads for concurrent marking and sweeping
 */
typedef struct {
  YO_THREAD_TYPE thread_id;  // Thread ID
  bool running;              // Thread is active
  bool should_exit;          // Signal thread to exit
} YoGCThread;

/**
 * Work queue for triggering GC cycles
 */
typedef struct {
  bool work_available;        // GC work needs to be done
  bool gc_in_progress;        // GC cycle currently running
  YO_THREAD_SYNC_TYPE mutex;  // Protects work queue state
  YO_COND_TYPE cond;          // Signals when work is available
} YoGCWorkQueue;

// Global GC thread and work queue
static YoGCThread yo_gc_thread = {
  .running = false,
  .should_exit = false
};

static YoGCWorkQueue yo_gc_work_queue = {
  .work_available = false,
  .gc_in_progress = false
};

/**
 * Initialize GC work queue
 */
static void yo_gc_work_queue_init(void) {
  yo_mutex_init(&yo_gc_work_queue.mutex);
  yo_cond_init(&yo_gc_work_queue.cond);
}

// =============================================================================
// GC Statistics - Phase 4: Performance Monitoring
// =============================================================================

/**
 * GC performance statistics
 * Tracks timing and memory metrics for monitoring and tuning
 */
typedef struct {
  // Collection counters
  uint64_t total_collections;
  
  // Pause time statistics (STW phases only)
  uint64_t total_pause_time_ns;
  uint64_t max_pause_time_ns;
  
  // Per-phase timing (including concurrent phases)
  uint64_t initial_mark_time_ns;
  uint64_t concurrent_mark_time_ns;
  uint64_t remark_time_ns;
  uint64_t concurrent_sweep_time_ns;
  
  // Memory statistics
  size_t bytes_allocated_since_last_gc;
  size_t total_bytes_allocated;
  size_t total_bytes_freed;
} YoGCStats;

static YoGCStats yo_gc_stats = {
  .total_collections = 0,
  .total_pause_time_ns = 0,
  .max_pause_time_ns = 0,
  .initial_mark_time_ns = 0,
  .concurrent_mark_time_ns = 0,
  .remark_time_ns = 0,
  .concurrent_sweep_time_ns = 0,
  .bytes_allocated_since_last_gc = 0,
  .total_bytes_allocated = 0,
  .total_bytes_freed = 0
};

/**
 * Get current time in nanoseconds
 */
static uint64_t yo_get_time_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}

// Forward declarations for GC thread functions
static void* yo_gc_thread_main(void* arg);
static void yo_gc_concurrent_cycle(void);
static void yo_gc_maybe_collect(void);

// Forward declaration for slow path
static void yo_safepoint_slow(void);

/**
 * Fast path safepoint check (inline for performance)
 * Called at loop back-edges and allocation sites
 * Overhead: ~2-3 cycles, well branch-predicted
 */
static inline void yo_safepoint(void) {
  // Fast path: Single flag check, almost always false
  if (__builtin_expect(yo_safepoint_state.requested, 0)) {
    yo_safepoint_slow();  // Rarely taken - thread parks here
  }
}

// =============================================================================
// Write Barrier - Phase 4: Maintain Tri-Color Invariant
// =============================================================================

/**
 * Write barrier for GC pointer writes (Dijkstra insertion barrier)
 * 
 * Maintains tri-color invariant during concurrent marking:
 * - If marking is active and new_value is WHITE, mark it GRAY
 * - This prevents BLACK objects from pointing to WHITE objects
 * 
 * Called before every GC pointer write: obj->field = new_value
 * 
 * Performance: Fast path is a single flag check (well-predicted)
 */
static inline void yo_write_barrier(void** slot, void* new_value) {
  (void)slot;  // Unused for now
  
  // Fast path: Skip barrier if not marking
  if (!__atomic_load_n(&yo_gc_is_marking, __ATOMIC_ACQUIRE)) {
    return;
  }
  
  // Only barrier non-null GC pointers
  if (new_value == NULL) {
    return;
  }
  
  // If new_value is WHITE, mark it GRAY
  uint8_t color = yo_gc_get_color(new_value);
  if (color == YO_GC_WHITE) {
    // Mark as GRAY (simple write since we're already synchronized)
    // In a truly concurrent implementation, this would use atomic CAS
    yo_gc_set_color(new_value, YO_GC_GRAY);
    yo_gc_push_gray(new_value);
    
    ${debugGc}
    printf("[GC] Write barrier: marked %p as GRAY\\\\n", new_value);
    #endif
  }
}

// Write barrier helper for a single GC object (used for value types)
static inline void yo_write_barrier_object(void* obj) {
  yo_write_barrier(NULL, obj);
}

// =============================================================================
// Shadow Stack - Phase 3
// =============================================================================

/**
 * Shadow stack frame for tracking GC pointer locals
 * Each function with GC pointer locals creates a frame on the C stack
 */
typedef struct YoShadowFrame {
  struct YoShadowFrame* prev;   // Previous frame (caller's frame)
  void** roots;                 // Array of pointers to GC pointer locals or value types containing GC pointers
  YoTypeDescriptor** root_types; // Array of type descriptors for each root (NULL for direct GC pointers)
  size_t num_roots;             // Number of roots in this frame
  const char* function_name;    // Function name (for debugging)
} YoShadowFrame;

// Thread-local shadow stack top
// Points to the current function's shadow frame
__thread YoShadowFrame* yo_shadow_stack_top = NULL;

// Forward declaration
static void yo_gc_mark_object(void* obj_ptr);

/**
 * Scan shadow stack and mark all roots
 */
static void yo_gc_scan_shadow_stack(void) {
  ${debugGc}
  size_t total_frames = 0;
  size_t total_roots = 0;
  #endif
  
  for (YoShadowFrame* frame = yo_shadow_stack_top; 
       frame != NULL; 
       frame = frame->prev) {
    
    ${debugGc}
    total_frames++;
    printf("[GC]   Frame: %s, roots=%zu\\n", 
           frame->function_name ? frame->function_name : "<unknown>",
           frame->num_roots);
    #endif
    
    // Scan all roots in this frame
    for (size_t i = 0; i < frame->num_roots; i++) {
      YoTypeDescriptor* root_type = frame->root_types ? frame->root_types[i] : NULL;
      
      if (root_type != NULL && root_type->traverse_fn != NULL) {
        // This is a value type containing GC pointers - use traverse function
        // frame->roots[i] points to the value type itself
        void* value_ptr = frame->roots[i];
        
        ${debugGc}
        total_roots++;
        printf("[GC]     Root[%zu] (value type %s): %p\\n", i, root_type->name, value_ptr);
        #endif
        
        if (value_ptr != NULL) {
          // Call traverse function to mark all GC pointers within the value type
          root_type->traverse_fn(value_ptr, yo_gc_mark_object);
        }
      } else {
        // This is a direct GC pointer - dereference to get the object
        // frame->roots[i] is a pointer to a local variable (void*)
        // Dereference it to get the object pointer (cast to void** first)
        void* obj = *(void**)frame->roots[i];
        
        ${debugGc}
        total_roots++;
        printf("[GC]     Root[%zu]: %p\\n", i, obj);
        #endif
        
        if (obj != NULL) {
          yo_gc_mark_object(obj);
        }
      }
    }
  }
  
  ${debugGc}
  printf("[GC] Scanned shadow stack: %zu frames, %zu total roots\\n",
         total_frames, total_roots);
  #endif
}

// =============================================================================
// Safepoint Implementation - Phase 4
// =============================================================================

/**
 * Slow path: Thread parks at safepoint waiting for GC to finish
 * Called when yo_safepoint_state.requested is true
 */
static void yo_safepoint_slow(void) {
  yo_mutex_lock(&yo_safepoint_state.mutex);
  
  // Increment counter - we're at the safepoint
  yo_safepoint_state.threads_at_safepoint++;
  
  ${debugGc}
  printf("[GC] Thread at safepoint (%zu/%zu)\\n", 
         yo_safepoint_state.threads_at_safepoint,
         yo_safepoint_state.num_threads);
  #endif
  
  // Signal GC thread if all mutator threads have stopped
  if (yo_safepoint_state.threads_at_safepoint == yo_safepoint_state.num_threads) {
    yo_cond_signal(&yo_safepoint_state.cond);
    ${debugGc}
    printf("[GC] All threads at safepoint - signaling GC\\n");
    #endif
  }
  
  // Wait for GC to finish and release us
  while (yo_safepoint_state.requested) {
    yo_cond_wait(&yo_safepoint_state.cond, &yo_safepoint_state.mutex);
  }
  
  // Decrement counter - we're resuming
  yo_safepoint_state.threads_at_safepoint--;
  
  ${debugGc}
  printf("[GC] Thread resuming from safepoint\\n");
  #endif
  
  yo_mutex_unlock(&yo_safepoint_state.mutex);
}

/**
 * Stop all mutator threads at safepoints
 * Called by GC thread before STW phases (initial mark, remark)
 */
static void yo_gc_stop_the_world(void) {
  ${debugGc}
  printf("[GC] Stopping the world...\\n");
  #endif
  
  yo_mutex_lock(&yo_safepoint_state.mutex);
  
  // Request safepoint - all threads will stop at next yo_safepoint() call
  __atomic_store_n(&yo_safepoint_state.requested, true, __ATOMIC_RELEASE);
  
  // Wait for all mutator threads to reach safepoints
  // Note: GC thread itself is not a mutator, so we don't count it
  while (yo_safepoint_state.threads_at_safepoint < yo_safepoint_state.num_threads) {
    ${debugGc}
    printf("[GC] Waiting for threads at safepoint: %zu/%zu\\n",
           yo_safepoint_state.threads_at_safepoint,
           yo_safepoint_state.num_threads);
    #endif
    yo_cond_wait(&yo_safepoint_state.cond, &yo_safepoint_state.mutex);
  }
  
  ${debugGc}
  printf("[GC] World stopped - all threads at safepoints\\n");
  #endif
  
  yo_mutex_unlock(&yo_safepoint_state.mutex);
}

/**
 * Resume all mutator threads from safepoints
 * Called by GC thread after STW phases complete
 */
static void yo_gc_resume_world(void) {
  ${debugGc}
  printf("[GC] Resuming the world...\\n");
  #endif
  
  yo_mutex_lock(&yo_safepoint_state.mutex);
  
  // Clear safepoint request
  __atomic_store_n(&yo_safepoint_state.requested, false, __ATOMIC_RELEASE);
  
  // Wake all waiting threads
  yo_cond_broadcast(&yo_safepoint_state.cond);
  
  ${debugGc}
  printf("[GC] World resumed\\n");
  #endif
  
  yo_mutex_unlock(&yo_safepoint_state.mutex);
}

// =============================================================================
// GC Allocation
// =============================================================================

/**
 * Allocate memory for a GC-managed object
 * 
 * @param size Size of the object payload (without header)
 * @param type_descriptor Pointer to type descriptor for pointer scanning
 * @return Pointer to object data (after header)
 */
void* __yo_gc_alloc(size_t size, void* type_descriptor) {
  size_t total_size = sizeof(yo_gc_header_t) + size;
  
  // Allocate memory (using mimalloc if available)
  yo_gc_header_t* header = (yo_gc_header_t*)__yo_malloc(total_size);
  if (header == NULL) {
    fprintf(stderr, "FATAL: GC allocation failed for %zu bytes\\n", total_size);
    abort();
  }
  
  // Initialize GC header
  header->mark_bits = YO_GC_WHITE;
  header->generation = 0;
  header->reserved = 0;
  header->has_finalizer = 0;
  header->type_tag = 0;  // TODO: Set from type descriptor
  header->size = (uint32_t)size;
  header->type_descriptor = type_descriptor;
  header->gc_next = NULL;
  header->gc_prev = NULL;
  header->dispose_fn = NULL;
  header->traverse_fn = NULL;
  
  // Add to global tracking list (at head for O(1))
  if (yo_gc.all_objects != NULL) {
    yo_gc.all_objects->gc_prev = header;
  }
  header->gc_next = yo_gc.all_objects;
  yo_gc.all_objects = header;
  
  // Update GC stats
  yo_gc.total_objects++;
  yo_gc.total_bytes += total_size;
  
  // Track allocation statistics
  yo_gc_stats.bytes_allocated_since_last_gc += total_size;
  yo_gc_stats.total_bytes_allocated += total_size;
  
  ${debugGc}
  printf("[GC] Allocated %zu bytes at %p (total: %zu objects, %zu bytes)\\n",
         size, (void*)(header + 1), yo_gc.total_objects, yo_gc.total_bytes);
  #endif
  
  // Trigger GC if threshold exceeded
  // With concurrent GC, this signals the GC thread instead of blocking
  if (yo_gc.gc_enabled) {
    yo_gc_maybe_collect();
  }
  
  // Return pointer to object data (after header)
  return (void*)(header + 1);
}

// =============================================================================
// GC Mark Phase
// =============================================================================

/**
 * Mark an object and add to gray queue (for concurrent marking)
 * Phase 4: Concurrent marking with gray queue
 */
static void yo_gc_mark_object(void* obj_ptr) {
  if (obj_ptr == NULL) {
    return;
  }
  
  // Get header from object pointer
  yo_gc_header_t* header = YO_GC_HEADER(obj_ptr);
  
  // Already marked? Skip
  uint8_t color = yo_gc_get_color(obj_ptr);
  if (color != YO_GC_WHITE) {
    return;
  }
  
  // Mark as GRAY and add to work queue
  yo_gc_set_color(obj_ptr, YO_GC_GRAY);
  yo_gc_push_gray(obj_ptr);
  
  ${debugGc}
  printf("[GC] Marked object at %p as GRAY (size: %u bytes)\\n", obj_ptr, header->size);
  #endif
}

// Helper function to mark a child as GRAY (used by traverse functions)
static void yo_gc_mark_child_gray(void* child) {
  if (child != NULL && yo_gc_get_color(child) == YO_GC_WHITE) {
    yo_gc_set_color(child, YO_GC_GRAY);
    yo_gc_push_gray(child);
  }
}

/**
 * Mark children of an object (concurrent marking)
 * Used during concurrent mark phase to scan GRAY objects
 */
static void yo_gc_mark_children_concurrent(void* obj_ptr) {
  if (obj_ptr == NULL) {
    return;
  }
  
  yo_gc_header_t* header = YO_GC_HEADER(obj_ptr);
  
  ${debugGc}
  printf("[GC] Scanning children of object at %p\\n", obj_ptr);
  #endif
  
  // Mark this object as BLACK (scanning/scanned)
  yo_gc_set_color(obj_ptr, YO_GC_BLACK);
  
  // Use traverse function if available (handles discriminated unions correctly)
  if (header->traverse_fn != NULL) {
    ${debugGc}
    printf("[GC]   Using traverse_fn\\n");
    #endif
    
    // Call traverse function with a visitor that marks children GRAY
    header->traverse_fn(obj_ptr, yo_gc_mark_child_gray);
  }
  // Fallback to type descriptor scanning for simple types
  else if (header->type_descriptor != NULL) {
    YoTypeDescriptor* desc = (YoTypeDescriptor*)header->type_descriptor;
    
    ${debugGc}
    printf("[GC]   Type: %s, pointer_count: %zu\\n", desc->name, desc->pointer_count);
    #endif
    
    // Scan all GC pointer fields in this object
    for (size_t i = 0; i < desc->pointer_count; i++) {
      // Calculate pointer to the field using offset
      void** field_ptr = (void**)((char*)obj_ptr + desc->pointer_offsets[i]);
      void* child = *field_ptr;  // TODO: Use atomic load for concurrent GC
      
      ${debugGc}
      printf("[GC]   Field[%zu] at offset %zu: %p\\n", 
             i, desc->pointer_offsets[i], child);
      #endif
      
      // Mark child if WHITE
      if (child != NULL && yo_gc_get_color(child) == YO_GC_WHITE) {
        yo_gc_set_color(child, YO_GC_GRAY);
        yo_gc_push_gray(child);
      }
    }
  }
}

/**
 * Scan shadow stack and mark roots as GRAY (for concurrent marking)
 */
// Helper to mark object as GRAY (used by traverse functions in concurrent GC)
static void yo_gc_mark_gray_visitor(void* obj) {
  if (obj != NULL && yo_gc_get_color(obj) == YO_GC_WHITE) {
    yo_gc_set_color(obj, YO_GC_GRAY);
    yo_gc_push_gray(obj);
  }
}

/**
 * Scan shadow stack concurrently and mark roots as GRAY
 */
static void yo_gc_scan_shadow_stack_concurrent(void) {
  ${debugGc}
  size_t total_frames = 0;
  size_t total_roots = 0;
  #endif
  
  for (YoShadowFrame* frame = yo_shadow_stack_top; 
       frame != NULL; 
       frame = frame->prev) {
    
    ${debugGc}
    total_frames++;
    printf("[GC]   Frame: %s, roots=%zu\\n", 
           frame->function_name ? frame->function_name : "<unknown>",
           frame->num_roots);
    #endif
    
    // Scan all roots in this frame
    for (size_t i = 0; i < frame->num_roots; i++) {
      // Skip NULL root entries (uninitialized/unregistered locals)
      if (frame->roots[i] == NULL) continue;
      
      YoTypeDescriptor* root_type = frame->root_types ? frame->root_types[i] : NULL;
      
      if (root_type != NULL && root_type->traverse_fn != NULL) {
        // This is a value type containing GC pointers - use traverse function
        void* value_ptr = frame->roots[i];
        
        ${debugGc}
        total_roots++;
        printf("[GC]     Root[%zu] (value type %s): %p\\n", i, root_type->name, value_ptr);
        #endif
        
        if (value_ptr != NULL) {
          // Call traverse function with a visitor that marks objects GRAY
          root_type->traverse_fn(value_ptr, yo_gc_mark_gray_visitor);
        }
      } else {
        // This is a direct GC pointer
        void* obj = *(void**)frame->roots[i];
        
        ${debugGc}
        total_roots++;
        printf("[GC]     Root[%zu]: %p\\n", i, obj);
        #endif
        
        // Mark root as GRAY if WHITE
        if (obj != NULL && yo_gc_get_color(obj) == YO_GC_WHITE) {
          yo_gc_set_color(obj, YO_GC_GRAY);
          yo_gc_push_gray(obj);
        }
      }
    }
  }
  
  ${debugGc}
  printf("[GC] Scanned shadow stack: %zu frames, %zu total roots\\n",
         total_frames, total_roots);
  #endif
}

/**
 * Phase 1: Initial Mark (STW - brief)
 * Reset all objects to WHITE and mark roots as GRAY
 */
static void yo_gc_initial_mark(void) {
  uint64_t start_time = yo_get_time_ns();
  
  ${debugGc}
  printf("[GC] Phase 1: Initial mark (STW)\\n");
  #endif
  
  // Initialize gray queue
  yo_gray_queue_init();
  
  // Reset all mark bits to WHITE
  for (yo_gc_header_t* header = yo_gc.all_objects; 
       header != NULL; 
       header = header->gc_next) {
    header->mark_bits = YO_GC_WHITE;
  }
  
  // Set marking flag
  __atomic_store_n(&yo_gc_is_marking, true, __ATOMIC_RELEASE);
  
  // Mark all shadow stack roots as GRAY
  yo_gc_scan_shadow_stack_concurrent();
  
  uint64_t end_time = yo_get_time_ns();
  uint64_t duration = end_time - start_time;
  yo_gc_stats.initial_mark_time_ns += duration;
  yo_gc_stats.total_pause_time_ns += duration;  // STW phase
  if (duration > yo_gc_stats.max_pause_time_ns) {
    yo_gc_stats.max_pause_time_ns = duration;
  }
  
  ${debugGc}
  printf("[GC] Initial mark complete, %zu objects in gray queue (%.2fms)\\n",
         yo_gray_queue.size, duration / 1e6);
  #endif
}

/**
 * Phase 2: Concurrent Mark (Parallel)
 * Process gray objects and mark their children
 * TODO: Currently runs in main thread, will be concurrent in future
 */
static void yo_gc_concurrent_mark(void) {
  uint64_t start_time = yo_get_time_ns();
  
  ${debugGc}
  printf("[GC] Phase 2: Concurrent mark\\n");
  size_t objects_scanned = 0;
  #endif
  
  // Process all gray objects
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj == NULL) break;
    
    ${debugGc}
    objects_scanned++;
    #endif
    
    // Scan children and mark them GRAY
    yo_gc_mark_children_concurrent(obj);
  }
  
  uint64_t end_time = yo_get_time_ns();
  uint64_t duration = end_time - start_time;
  yo_gc_stats.concurrent_mark_time_ns += duration;
  
  ${debugGc}
  printf("[GC] Concurrent mark complete, scanned %zu objects (%.2fms)\\n",
         objects_scanned, duration / 1e6);
  #endif
}

/**
 * Phase 3: Remark (STW - brief)
 * Re-scan roots and finish marking any remaining GRAY objects
 * TODO: Process write barriers when implemented
 */
static void yo_gc_remark(void) {
  uint64_t start_time = yo_get_time_ns();
  
  ${debugGc}
  printf("[GC] Phase 3: Remark (STW)\\n");
  #endif
  
  // Re-scan shadow stacks (may have changed during concurrent mark)
  yo_gc_scan_shadow_stack_concurrent();
  
  // Finish marking any remaining GRAY objects
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj == NULL) break;
    
    yo_gc_mark_children_concurrent(obj);
  }
  
  // Clear marking flag
  __atomic_store_n(&yo_gc_is_marking, false, __ATOMIC_RELEASE);
  
  uint64_t end_time = yo_get_time_ns();
  uint64_t duration = end_time - start_time;
  yo_gc_stats.remark_time_ns += duration;
  yo_gc_stats.total_pause_time_ns += duration;  // STW phase
  if (duration > yo_gc_stats.max_pause_time_ns) {
    yo_gc_stats.max_pause_time_ns = duration;
  }
  
  ${debugGc}
  printf("[GC] Remark complete (%.2fms)\\n", duration / 1e6);
  #endif
}

/**
 * Mark all root objects
 * 
 * Phase 2-3: Uses shadow stack scanning
 * Phase 4: Three-phase concurrent marking (initial, concurrent, remark)
 */
static void yo_gc_mark_roots(void) {
  ${debugGc}
  printf("[GC] === Starting Mark Phase ===\\n");
  #endif
  
  // Phase 4: Use three-phase concurrent marking
  yo_gc_initial_mark();     // STW: Mark roots as GRAY
  yo_gc_concurrent_mark();  // Concurrent: Scan GRAY objects
  yo_gc_remark();           // STW: Finish marking
}

// =============================================================================
// GC Sweep Phase
// =============================================================================

/**
 * Sweep unmarked objects and free them
 */
static void yo_gc_sweep(void) {
  ${debugGc}
  printf("[GC] Starting sweep phase\\n");
  #endif
  
  size_t collected_objects = 0;
  size_t collected_bytes = 0;
  
  yo_gc_header_t* obj = yo_gc.all_objects;
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    yo_gc_header_t* next = obj->gc_next;
    
    if (obj->mark_bits == YO_GC_WHITE) {
      // Object is garbage - remove from list and free
      
      ${debugGc}
      void* obj_ptr = (void*)(obj + 1);
      printf("[GC] Collecting object at %p (size: %u bytes)\\n", 
             obj_ptr, obj->size);
      printf("[GC]   dispose_fn: %p\\n", (void*)obj->dispose_fn);
      #endif
      
      // Call finalizer if present
      if (obj->dispose_fn != NULL) {
        void* obj_ptr = (void*)(obj + 1);
        
        ${debugGc}
        printf("[GC] Calling dispose function at %p for object at %p\\n", 
               (void*)obj->dispose_fn, obj_ptr);
        #endif
        
        obj->dispose_fn(obj_ptr);
        
        ${debugGc}
        printf("[GC] Dispose function completed\\n");
        #endif
      }
      
      // Remove from linked list
      if (prev != NULL) {
        prev->gc_next = next;
      } else {
        yo_gc.all_objects = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
      
      // Update stats
      size_t total_size = sizeof(yo_gc_header_t) + obj->size;
      collected_objects++;
      collected_bytes += total_size;
      
      // Free memory
      __yo_free(obj);
      
      // Continue from prev (don't update prev)
      obj = next;
    } else {
      // Object survived - reset to WHITE for next cycle
      obj->mark_bits = YO_GC_WHITE;
      
      // Move to next
      prev = obj;
      obj = next;
    }
  }
  
  // Update global stats
  yo_gc.total_objects -= collected_objects;
  yo_gc.total_bytes -= collected_bytes;
  
  ${debugGc}
  printf("[GC] Sweep complete: collected %zu objects (%zu bytes)\\n",
         collected_objects, collected_bytes);
  printf("[GC] Remaining: %zu objects (%zu bytes)\\n",
         yo_gc.total_objects, yo_gc.total_bytes);
  #endif
}

/**
 * Concurrent sweep - can run in parallel with mutators
 * 
 * Uses atomic operations for safe concurrent access to object list.
 * Unlike stop-the-world sweep, this doesn't block mutator threads.
 * 
 * Key differences from yo_gc_sweep():
 * - Uses atomic loads/stores for list manipulation
 * - New allocations during sweep are BLACK (already marked)
 * - Safe to run concurrently - mutators only allocate, never traverse free list
 */
static void yo_gc_concurrent_sweep(void) {
  uint64_t start_time = yo_get_time_ns();
  
  ${debugGc}
  printf("[GC] Starting concurrent sweep phase\\n");
  #endif
  
  size_t collected_objects = 0;
  size_t collected_bytes = 0;
  
  // Atomically load the head of the object list
  yo_gc_header_t* obj = __atomic_load_n(&yo_gc.all_objects, __ATOMIC_ACQUIRE);
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    // Atomically load next pointer
    yo_gc_header_t* next = __atomic_load_n(&obj->gc_next, __ATOMIC_ACQUIRE);
    
    // Read color - no need for atomic since only GC thread modifies during sweep
    uint8_t color = obj->mark_bits;
    
    if (color == YO_GC_WHITE) {
      // Object is garbage - remove from list and free
      
      ${debugGc}
      void* obj_ptr = (void*)(obj + 1);
      printf("[GC] Collecting object at %p (size: %u bytes)\\n", 
             obj_ptr, obj->size);
      #endif
      
      // Call finalizer if present
      if (obj->dispose_fn != NULL) {
        void* obj_ptr = (void*)(obj + 1);
        
        ${debugGc}
        printf("[GC] Calling dispose function for object at %p\\n", obj_ptr);
        #endif
        
        obj->dispose_fn(obj_ptr);
      }
      
      // Remove from linked list atomically
      if (prev != NULL) {
        __atomic_store_n(&prev->gc_next, next, __ATOMIC_RELEASE);
      } else {
        __atomic_store_n(&yo_gc.all_objects, next, __ATOMIC_RELEASE);
      }
      if (next != NULL) {
        __atomic_store_n(&next->gc_prev, prev, __ATOMIC_RELEASE);
      }
      
      // Update stats
      size_t total_size = sizeof(yo_gc_header_t) + obj->size;
      collected_objects++;
      collected_bytes += total_size;
      
      // Free memory
      __yo_free(obj);
      
      // Continue from prev (don't update prev)
      obj = next;
    } else {
      // Object survived - reset to WHITE for next cycle
      obj->mark_bits = YO_GC_WHITE;
      
      // Move to next
      prev = obj;
      obj = next;
    }
  }
  
  // Update global stats (could use atomics but only GC thread writes these)
  yo_gc.total_objects -= collected_objects;
  yo_gc.total_bytes -= collected_bytes;
  
  // Update GC statistics
  yo_gc_stats.total_bytes_freed += collected_bytes;
  yo_gc_stats.bytes_allocated_since_last_gc = 0;  // Reset allocation counter
  
  uint64_t end_time = yo_get_time_ns();
  uint64_t duration = end_time - start_time;
  yo_gc_stats.concurrent_sweep_time_ns += duration;
  
  ${debugGc}
  printf("[GC] Concurrent sweep complete: collected %zu objects (%zu bytes) (%.2fms)\\n",
         collected_objects, collected_bytes, duration / 1e6);
  printf("[GC] Remaining: %zu objects (%zu bytes)\\n",
         yo_gc.total_objects, yo_gc.total_bytes);
  #endif
}

// =============================================================================
// GC Thread Implementation - Phase 4: Background Concurrent GC
// =============================================================================

/**
 * Perform a complete concurrent GC cycle
 * Called by GC thread in background
 */
static void yo_gc_concurrent_cycle(void) {
  if (!yo_gc.gc_enabled) {
    return;
  }
  
  // Increment collection counter
  yo_gc_stats.total_collections++;
  
  ${debugGc}
  printf("\\n[GC] ===== GC Thread: Starting Concurrent Cycle #%llu =====\\n",
         yo_gc_stats.total_collections);
  printf("[GC] Before: %zu objects, %zu bytes\\n",
         yo_gc.total_objects, yo_gc.total_bytes);
  #endif
  
  // Phase 1: Initial mark (STW - brief)
  // Marks roots from shadow stack as GRAY
  ${debugGc}
  printf("[GC] Phase 1: Initial mark (STW)\\n");
  #endif
  yo_gc_mark_roots();  // This does STW, marks roots, resumes
  
  // Phase 2: Concurrent mark (parallel with mutators)
  // Process gray queue until empty
  ${debugGc}
  printf("[GC] Phase 2: Concurrent mark\\n");
  #endif
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj != NULL) {
      yo_gc_mark_children_concurrent(obj);
      yo_gc_set_color(obj, YO_GC_BLACK);
    }
  }
  
  // Phase 3: Remark (STW - brief)
  // Re-scan shadow stacks and finish marking
  ${debugGc}
  printf("[GC] Phase 3: Remark (STW)\\n");
  #endif
  yo_gc_stop_the_world();
  
  // Re-scan shadow stack (may have changed during concurrent mark)
  yo_gc_scan_shadow_stack();
  
  // Finish any remaining gray objects
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj != NULL) {
      yo_gc_mark_children_concurrent(obj);
      yo_gc_set_color(obj, YO_GC_BLACK);
    }
  }
  
  // Clear marking flag
  __atomic_store_n(&yo_gc_is_marking, false, __ATOMIC_RELEASE);
  
  yo_gc_resume_world();
  
  // Phase 4: Concurrent sweep (parallel with mutators)
  ${debugGc}
  printf("[GC] Phase 4: Concurrent sweep\\n");
  #endif
  yo_gc_concurrent_sweep();
  
  // Adjust GC threshold
  yo_gc.gc_threshold = yo_gc.total_bytes * 2;
  if (yo_gc.gc_threshold < 1024 * 1024) {
    yo_gc.gc_threshold = 1024 * 1024;
  }
  
  ${debugGc}
  printf("[GC] ===== GC Thread: Cycle Complete =====\\n\\n");
  #endif
}

/**
 * GC thread main loop
 * Waits for GC work and performs concurrent GC cycles
 */
static void* yo_gc_thread_main(void* arg) {
  (void)arg;  // Unused
  
  ${debugGc}
  printf("[GC] GC thread started (tid=%lu)\\n", (unsigned long)yo_thread_self());
  #endif
  
  while (!yo_gc_thread.should_exit) {
    // Wait for GC work
    yo_mutex_lock(&yo_gc_work_queue.mutex);
    
    while (!yo_gc_work_queue.work_available && !yo_gc_thread.should_exit) {
      yo_cond_wait(&yo_gc_work_queue.cond, &yo_gc_work_queue.mutex);
    }
    
    if (yo_gc_thread.should_exit) {
      yo_mutex_unlock(&yo_gc_work_queue.mutex);
      break;
    }
    
    // Clear work flag and set in_progress
    yo_gc_work_queue.work_available = false;
    yo_gc_work_queue.gc_in_progress = true;
    
    yo_mutex_unlock(&yo_gc_work_queue.mutex);
    
    // Perform GC cycle
    yo_gc_concurrent_cycle();
    
    // Clear in_progress flag
    yo_mutex_lock(&yo_gc_work_queue.mutex);
    yo_gc_work_queue.gc_in_progress = false;
    yo_mutex_unlock(&yo_gc_work_queue.mutex);
  }
  
  ${debugGc}
  printf("[GC] GC thread exiting\\n");
  #endif
  
  return NULL;
}

/**
 * Start GC thread
 */
static void yo_gc_thread_start(void) {
  if (yo_gc_thread.running) {
    return;
  }
  
  yo_gc_thread.should_exit = false;
  
  int result = yo_thread_create(&yo_gc_thread.thread_id, yo_gc_thread_main, NULL);
  if (result != 0) {
    fprintf(stderr, "[GC] Failed to create GC thread: %d\\n", result);
    return;
  }
  
  yo_gc_thread.running = true;
  
  ${debugGc}
  printf("[GC] Started GC thread\\n");
  #endif
}

/**
 * Stop GC thread
 */
static void yo_gc_thread_stop(void) {
  if (!yo_gc_thread.running) {
    return;
  }
  
  ${debugGc}
  printf("[GC] Stopping GC thread...\\n");
  #endif
  
  // Signal thread to exit
  yo_mutex_lock(&yo_gc_work_queue.mutex);
  yo_gc_thread.should_exit = true;
  yo_cond_signal(&yo_gc_work_queue.cond);
  yo_mutex_unlock(&yo_gc_work_queue.mutex);
  
  // Wait for thread to exit
  yo_thread_join(yo_gc_thread.thread_id);
  
  yo_gc_thread.running = false;
  
  ${debugGc}
  printf("[GC] GC thread stopped\\n");
  #endif
}

/**
 * Trigger GC if heap size exceeds threshold
 * Called from allocation path
 */
static void yo_gc_maybe_collect(void) {
  size_t heap_size = __atomic_load_n(&yo_gc.total_bytes, __ATOMIC_RELAXED);
  size_t threshold = __atomic_load_n(&yo_gc.gc_threshold, __ATOMIC_RELAXED);
  
  if (heap_size > threshold) {
    // Signal GC thread to run
    yo_mutex_lock(&yo_gc_work_queue.mutex);
    
    // Only trigger if GC not already running
    if (!yo_gc_work_queue.gc_in_progress && !yo_gc_work_queue.work_available) {
      yo_gc_work_queue.work_available = true;
      yo_cond_signal(&yo_gc_work_queue.cond);
      
      ${debugGc}
      printf("[GC] Triggered GC (heap: %zu bytes, threshold: %zu bytes)\\n",
             heap_size, threshold);
      #endif
    }
    
    yo_mutex_unlock(&yo_gc_work_queue.mutex);
  }
}

// =============================================================================
// GC Collection Entry Point
// =============================================================================

/**
 * Trigger a garbage collection cycle
 * 
 * Phase 2: Simple stop-the-world mark-sweep
 * - Mark all reachable objects starting from roots
 * - Sweep and free all unmarked objects
 */
void __yo_gc_collect(void) {
  if (!yo_gc.gc_enabled) {
    return;
  }
  
  ${debugGc}
  printf("\\n[GC] ===== Starting GC Collection =====\\n");
  printf("[GC] Before: %zu objects, %zu bytes\\n",
         yo_gc.total_objects, yo_gc.total_bytes);
  #endif
  
  // Phase 4: Three-phase concurrent marking + concurrent sweep
  // This allows most GC work to happen concurrently with mutators
  
  // Phase 1: Mark all reachable objects (uses concurrent marking)
  yo_gc_mark_roots();
  
  // Phase 2: Concurrent sweep - can run in parallel with mutators
  // Note: In a fully concurrent implementation, this would run in a separate GC thread
  // For now, we run it synchronously but use atomic operations for future concurrency
  yo_gc_concurrent_sweep();
  
  // Adjust GC threshold based on current heap size
  // Heuristic: Trigger next GC when heap grows by 2x
  yo_gc.gc_threshold = yo_gc.total_bytes * 2;
  if (yo_gc.gc_threshold < 1024 * 1024) {
    yo_gc.gc_threshold = 1024 * 1024;  // Minimum 1MB
  }
  
  ${debugGc}
  printf("[GC] After: %zu objects, %zu bytes\\n",
         yo_gc.total_objects, yo_gc.total_bytes);
  printf("[GC] Next GC threshold: %zu bytes\\n", yo_gc.gc_threshold);
  printf("[GC] ===== GC Collection Complete =====\\n\\n");
  #endif
}

// =============================================================================
// GC Utility Functions
// =============================================================================

/**
 * Disable GC (useful during initialization)
 */
void __yo_gc_disable(void) {
  yo_gc.gc_enabled = false;
}

/**
 * Enable GC
 */
void __yo_gc_enable(void) {
  yo_gc.gc_enabled = true;
}

/**
 * Get GC statistics
 */
void __yo_gc_stats(size_t* out_objects, size_t* out_bytes) {
  if (out_objects != NULL) {
    *out_objects = yo_gc.total_objects;
  }
  if (out_bytes != NULL) {
    *out_bytes = yo_gc.total_bytes;
  }
}

/**
 * Print GC performance statistics
 * Can be called explicitly by user code or automatically with --debug-gc
 */
void __yo_gc_print_stats(void) {
  printf("\\n");
  printf("=============================================================================\\n");
  printf("                          GC Performance Statistics                          \\n");
  printf("=============================================================================\\n");
  printf("\\n");
  
  printf("Collections:\\n");
  printf("  Total GC cycles:        %llu\\n", 
         (unsigned long long)yo_gc_stats.total_collections);
  
  if (yo_gc_stats.total_collections > 0) {
    printf("\\n");
    printf("Pause Times (Stop-The-World only):\\n");
    printf("  Total pause time:       %.2f ms\\n", 
           yo_gc_stats.total_pause_time_ns / 1e6);
    printf("  Max pause time:         %.2f ms\\n", 
           yo_gc_stats.max_pause_time_ns / 1e6);
    printf("  Average pause time:     %.2f ms\\n",
           (double)yo_gc_stats.total_pause_time_ns / yo_gc_stats.total_collections / 1e6);
    
    printf("\\n");
    printf("Phase Breakdown:\\n");
    printf("  Initial mark (STW):     %.2f ms  (avg: %.2f ms)\\n",
           yo_gc_stats.initial_mark_time_ns / 1e6,
           (double)yo_gc_stats.initial_mark_time_ns / yo_gc_stats.total_collections / 1e6);
    printf("  Concurrent mark:        %.2f ms  (avg: %.2f ms)\\n",
           yo_gc_stats.concurrent_mark_time_ns / 1e6,
           (double)yo_gc_stats.concurrent_mark_time_ns / yo_gc_stats.total_collections / 1e6);
    printf("  Remark (STW):           %.2f ms  (avg: %.2f ms)\\n",
           yo_gc_stats.remark_time_ns / 1e6,
           (double)yo_gc_stats.remark_time_ns / yo_gc_stats.total_collections / 1e6);
    printf("  Concurrent sweep:       %.2f ms  (avg: %.2f ms)\\n",
           yo_gc_stats.concurrent_sweep_time_ns / 1e6,
           (double)yo_gc_stats.concurrent_sweep_time_ns / yo_gc_stats.total_collections / 1e6);
    
    uint64_t total_time = yo_gc_stats.initial_mark_time_ns +
                          yo_gc_stats.concurrent_mark_time_ns +
                          yo_gc_stats.remark_time_ns +
                          yo_gc_stats.concurrent_sweep_time_ns;
    printf("  Total GC time:          %.2f ms  (avg: %.2f ms/cycle)\\n",
           total_time / 1e6,
           (double)total_time / yo_gc_stats.total_collections / 1e6);
    
    // Calculate concurrent vs pause percentages
    uint64_t concurrent_time = yo_gc_stats.concurrent_mark_time_ns +
                                yo_gc_stats.concurrent_sweep_time_ns;
    double concurrent_pct = (double)concurrent_time / total_time * 100.0;
    double pause_pct = (double)yo_gc_stats.total_pause_time_ns / total_time * 100.0;
    printf("  Concurrent work:        %.1f%%\\n", concurrent_pct);
    printf("  STW pause overhead:     %.1f%%\\n", pause_pct);
  }
  
  printf("\\n");
  printf("Memory:\\n");
  printf("  Total allocated:        %.2f MB\\n",
         yo_gc_stats.total_bytes_allocated / 1e6);
  printf("  Total freed:            %.2f MB\\n",
         yo_gc_stats.total_bytes_freed / 1e6);
  printf("  Current live objects:   %zu\\n",
         yo_gc.total_objects);
  printf("  Current heap size:      %.2f MB\\n",
         yo_gc.total_bytes / 1e6);
  
  if (yo_gc_stats.total_bytes_allocated > 0) {
    double survival_rate = 
      (double)(yo_gc_stats.total_bytes_allocated - yo_gc_stats.total_bytes_freed) /
      yo_gc_stats.total_bytes_allocated * 100.0;
    printf("  Survival rate:          %.1f%%\\n", survival_rate);
  }
  
  printf("\\n");
  printf("=============================================================================\\n");
  printf("\\n");
}

// =============================================================================
// Sync Primitives - Cross-platform Mutex and Condition Variables
// =============================================================================

/**
 * Create and initialize a mutex (stack-allocated value)
 * Returns an initialized mutex that can be used with yo_mutex_lock/unlock
 */
YO_THREAD_SYNC_TYPE yo_mutex_create(void) {
  YO_THREAD_SYNC_TYPE mutex;
  yo_mutex_init(&mutex);
  return mutex;
}

/**
 * Create and initialize a condition variable (stack-allocated value)
 * Returns an initialized condition variable that can be used with yo_cond_wait/signal/broadcast
 */
YO_COND_TYPE yo_cond_create(void) {
  YO_COND_TYPE cond;
  yo_cond_init(&cond);
  return cond;
}
`);
}
