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
// Concurrent GC - Phase 4: Tri-Color Marking
// =============================================================================

/**
 * Gray queue for concurrent marking
 * Tracks objects marked GRAY (pending scan) during concurrent marking phase
 */
typedef struct {
  void** objects;        // Array of gray objects to scan
  size_t size;          // Current number of objects
  size_t capacity;      // Array capacity
  pthread_mutex_t lock; // For concurrent access
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
    pthread_mutex_init(&yo_gray_queue.lock, NULL);
  }
  yo_gray_queue.size = 0;
}

/**
 * Push object to gray queue (thread-safe)
 */
static void yo_gc_push_gray(void* obj) {
  pthread_mutex_lock(&yo_gray_queue.lock);
  
  // Resize if needed
  if (yo_gray_queue.size >= yo_gray_queue.capacity) {
    yo_gray_queue.capacity *= 2;
    yo_gray_queue.objects = (void**)realloc(
      yo_gray_queue.objects,
      yo_gray_queue.capacity * sizeof(void*)
    );
  }
  
  yo_gray_queue.objects[yo_gray_queue.size++] = obj;
  
  pthread_mutex_unlock(&yo_gray_queue.lock);
}

/**
 * Pop object from gray queue (thread-safe)
 * Returns NULL if queue is empty
 */
static void* yo_gc_pop_gray(void) {
  pthread_mutex_lock(&yo_gray_queue.lock);
  
  void* obj = NULL;
  if (yo_gray_queue.size > 0) {
    obj = yo_gray_queue.objects[--yo_gray_queue.size];
  }
  
  pthread_mutex_unlock(&yo_gray_queue.lock);
  return obj;
}

/**
 * Check if gray queue has objects
 */
static bool yo_gc_has_gray_objects(void) {
  pthread_mutex_lock(&yo_gray_queue.lock);
  bool has_objects = yo_gray_queue.size > 0;
  pthread_mutex_unlock(&yo_gray_queue.lock);
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
    printf(\"[GC] Write barrier: marked %p as GRAY\\\\n\", new_value);
    #endif
  }
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
  void** roots;                 // Array of pointers to GC pointer locals
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
  
  ${debugGc}
  printf("[GC] Scanned shadow stack: %zu frames, %zu total roots\\n",
         total_frames, total_roots);
  #endif
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
  header->generation = 0;  // Young generation
  header->has_finalizer = 0;
  header->reserved = 0;
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
  
  ${debugGc}
  printf("[GC] Allocated %zu bytes at %p (total: %zu objects, %zu bytes)\\n",
         size, (void*)(header + 1), yo_gc.total_objects, yo_gc.total_bytes);
  #endif
  
  // Trigger GC if threshold exceeded
  if (yo_gc.gc_enabled && yo_gc.total_bytes > yo_gc.gc_threshold) {
    ${debugGc}
    printf("[GC] Threshold exceeded (%zu > %zu), triggering collection\\n",
           yo_gc.total_bytes, yo_gc.gc_threshold);
    #endif
    __yo_gc_collect();
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
  
  ${debugGc}
  printf("[GC] Initial mark complete, %zu objects in gray queue\\n",
         yo_gray_queue.size);
  #endif
}

/**
 * Phase 2: Concurrent Mark (Parallel)
 * Process gray objects and mark their children
 * TODO: Currently runs in main thread, will be concurrent in future
 */
static void yo_gc_concurrent_mark(void) {
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
  
  ${debugGc}
  printf("[GC] Concurrent mark complete, scanned %zu objects\\n",
         objects_scanned);
  #endif
}

/**
 * Phase 3: Remark (STW - brief)
 * Re-scan roots and finish marking any remaining GRAY objects
 * TODO: Process write barriers when implemented
 */
static void yo_gc_remark(void) {
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
  
  ${debugGc}
  printf("[GC] Remark complete\\n");
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
  
  // Phase 1: Mark all reachable objects
  yo_gc_mark_roots();
  
  // Phase 2: Sweep and free unmarked objects
  yo_gc_sweep();
  
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
`);
}
