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
  
  // Traverse children using type descriptor
  if (header->type_descriptor != NULL) {
    YoTypeDescriptor* desc = (YoTypeDescriptor*)header->type_descriptor;
    
    ${debugGc}
    printf("[GC]   Type: %s, pointer_count: %zu\\n", desc->name, desc->pointer_count);
    #endif
    
    // Scan all GC pointer fields in this object
    for (size_t i = 0; i < desc->pointer_count; i++) {
      // Calculate pointer to the field using offset
      void** field_ptr = (void**)((char*)obj_ptr + desc->pointer_offsets[i]);
      void* child = *field_ptr;
      
      ${debugGc}
      printf("[GC]   Field[%zu] at offset %zu: %p\\n", 
             i, desc->pointer_offsets[i], child);
      #endif
      
      // Recursively mark child object
      if (child != NULL) {
        yo_gc_mark_object(child);
      }
    }
  }
  
  // Mark as BLACK (children fully scanned)
  header->mark_bits = YO_GC_BLACK;
}

/**
 * Mark all root objects
 * 
 * Phase 3: Scan shadow stack for roots
 */
static void yo_gc_mark_roots(void) {
  ${debugGc}
  printf("[GC] Marking roots from shadow stack\\n");
  #endif
  
  // Scan shadow stack to find all GC pointer locals
  yo_gc_scan_shadow_stack();
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
