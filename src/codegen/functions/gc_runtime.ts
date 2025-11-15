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
 * Mark an object and its children (tri-color marking)
 * 
 * Phase 2: Simple recursive marking (no shadow stack yet)
 * Phase 3: Will use shadow stack for roots
 */
static void yo_gc_mark_object(void* obj_ptr) {
  if (obj_ptr == NULL) {
    return;
  }
  
  // Get header from object pointer
  yo_gc_header_t* header = ((yo_gc_header_t*)obj_ptr) - 1;
  
  // Already marked? Skip
  if (header->mark_bits != YO_GC_WHITE) {
    return;
  }
  
  // Mark as GRAY (will scan children)
  header->mark_bits = YO_GC_GRAY;
  
  ${debugGc}
  printf("[GC] Marking object at %p (size: %u bytes)\\n", obj_ptr, header->size);
  #endif
  
  // TODO Phase 3: Traverse children using type_descriptor
  // For now, we have no way to find pointers in objects
  // This will be implemented when we add type descriptors
  
  // Mark as BLACK (children scanned)
  header->mark_bits = YO_GC_BLACK;
}

/**
 * Mark all root objects
 * 
 * Phase 2: No roots yet (no shadow stack)
 * Phase 3: Will scan shadow stack for roots
 */
static void yo_gc_mark_roots(void) {
  ${debugGc}
  printf("[GC] Marking roots (Phase 2: no shadow stack yet)\\n");
  #endif
  
  // TODO Phase 3: Scan shadow stack
  // For now, we have no roots, so nothing will be marked
  // This means GC will collect everything (which is wrong, but safe for testing)
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
      #endif
      
      // Call finalizer if present
      if (obj->dispose_fn != NULL) {
        void* obj_ptr = (void*)(obj + 1);
        obj->dispose_fn(obj_ptr);
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
