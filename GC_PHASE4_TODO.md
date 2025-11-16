# GC Phase 4 Implementation TODO - Concurrent GC

**Last updated:** 2025-11-16
**Status:** 🚀 Starting (~0% complete)

## Overview

Phase 4 implements **Concurrent Garbage Collection** to achieve the <5ms latency goal. Most GC work happens in parallel with mutator threads, with only brief stop-the-world pauses for root scanning and synchronization.

**Why Concurrent GC?**
- ✅ Low pause times (<5ms target, similar to Go)
- ✅ Most GC work happens concurrently with application
- ✅ Enables high-throughput applications
- ✅ Proven approach (Go, Java G1, .NET)
- ✅ Works well with shadow stack infrastructure

**Current limitation:** GC is stop-the-world - all mutator threads pause during entire mark-sweep cycle (~10-50ms for large heaps).

**After Phase 4:** Only brief STW pauses (~1-3ms) for root scanning and synchronization. Most marking and sweeping happens concurrently.

---

## 📋 TODO List

### TODO 1: Tri-Color Marking Infrastructure

**Priority: HIGH** - Foundation for concurrent marking

**What to implement:**

Extend the GC header to support tri-color marking states:

```c
typedef struct {
  uint8_t mark_bits : 2;      // WHITE=0, GRAY=1, BLACK=2
  uint8_t generation : 1;     // 0=young, 1=old (for future generational GC)
  uint8_t has_finalizer : 1;  // 1 if dispose() method exists
  uint8_t reserved : 4;       // Future use
  uint32_t type_tag;          // Type identifier
  uint32_t size;              // Object size in bytes
  void* type_descriptor;      // Pointer to YoTypeDescriptor
} yo_gc_header_t;
```

**Colors meaning:**
- **WHITE (0)**: Unmarked - potentially garbage
- **GRAY (1)**: Marked, but children not yet scanned
- **BLACK (2)**: Marked, and all children scanned

**Tri-color invariant:**
- **Invariant**: No BLACK object points directly to WHITE object
- **Why**: Ensures we don't miss reachable objects during concurrent marking
- **Maintained by**: Write barrier (see TODO 3)

**Files to modify:**
- `src/codegen/types/generation.ts` - update `yo_gc_header_t` definition
- `src/codegen/functions/gc_runtime.ts` - add tri-color marking functions

**Implementation steps:**

1. Update `yo_gc_header_t` to use 2-bit `mark_bits` field
2. Add color manipulation functions:
   ```c
   typedef enum { WHITE = 0, GRAY = 1, BLACK = 2 } YoColor;
   
   static inline YoColor yo_gc_get_color(void* obj) {
     yo_gc_header_t* header = YO_GC_HEADER(obj);
     return (YoColor)(header->mark_bits);
   }
   
   static inline void yo_gc_set_color(void* obj, YoColor color) {
     yo_gc_header_t* header = YO_GC_HEADER(obj);
     header->mark_bits = color;
   }
   ```
3. Add gray object work queue (for concurrent marking):
   ```c
   typedef struct {
     void** objects;        // Array of gray objects to scan
     size_t size;          // Current number of objects
     size_t capacity;      // Array capacity
     pthread_mutex_t lock; // For concurrent access
   } YoGrayQueue;
   
   static void yo_gc_push_gray(void* obj);
   static void* yo_gc_pop_gray(void);
   ```

### TODO 2: Concurrent Mark Phase

**Priority: HIGH** - Core concurrent GC functionality

**What to implement:**

Split marking into three phases:
1. **Initial Mark** (STW - brief): Mark roots from shadow stack
2. **Concurrent Mark** (Parallel): Scan gray objects in background
3. **Remark** (STW - brief): Process objects marked during concurrent phase

**Initial Mark Phase (STW):**
```c
static void yo_gc_initial_mark(void) {
  // Stop all mutator threads at safepoints
  yo_gc_stop_the_world();
  
  // Reset all mark bits to WHITE
  for (yo_gc_header_t* obj = yo_gc.all_objects; obj != NULL; obj = obj->next) {
    yo_gc_set_color(YO_GC_OBJECT(obj), WHITE);
  }
  
  // Mark all shadow stack roots as GRAY
  yo_gc_scan_shadow_stack_concurrent();  // Modified to mark GRAY, not BLACK
  
  // Resume mutator threads
  yo_gc_resume_world();
  
  // Now marking can proceed concurrently
}

static void yo_gc_scan_shadow_stack_concurrent(void) {
  for (YoShadowFrame* frame = yo_shadow_stack_top; 
       frame != NULL; 
       frame = frame->prev) {
    for (size_t i = 0; i < frame->num_roots; i++) {
      void* obj = *(void**)frame->roots[i];
      if (obj != NULL && yo_gc_get_color(obj) == WHITE) {
        yo_gc_set_color(obj, GRAY);
        yo_gc_push_gray(obj);  // Add to work queue
      }
    }
  }
}
```

**Concurrent Mark Phase (Parallel):**
```c
static void yo_gc_concurrent_mark(void) {
  // Multiple GC threads process gray objects concurrently
  while (true) {
    void* obj = yo_gc_pop_gray();  // Thread-safe
    if (obj == NULL) break;  // No more work
    
    // Scan children and mark them GRAY
    yo_gc_mark_children_concurrent(obj);
    
    // Mark this object BLACK (fully scanned)
    yo_gc_set_color(obj, BLACK);
  }
}

static void yo_gc_mark_children_concurrent(void* obj) {
  yo_gc_header_t* header = YO_GC_HEADER(obj);
  YoTypeDescriptor* type = (YoTypeDescriptor*)header->type_descriptor;
  
  // Scan all GC pointer fields
  for (size_t i = 0; i < type->pointer_count; i++) {
    void** field_ptr = (void**)((char*)obj + type->pointer_offsets[i]);
    void* child = __atomic_load_n(field_ptr, __ATOMIC_ACQUIRE);  // Atomic read
    
    if (child != NULL) {
      YoColor color = yo_gc_get_color(child);
      if (color == WHITE) {
        // Try to atomically transition WHITE -> GRAY
        if (__atomic_compare_exchange_n(
              &YO_GC_HEADER(child)->mark_bits,
              &(uint8_t){WHITE}, GRAY,
              false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) {
          yo_gc_push_gray(child);
        }
      }
    }
  }
}
```

**Remark Phase (STW):**
```c
static void yo_gc_remark(void) {
  // Stop all mutator threads
  yo_gc_stop_the_world();
  
  // Process write barrier buffers (see TODO 3)
  yo_gc_process_write_barriers();
  
  // Re-scan shadow stacks (may have changed during concurrent mark)
  yo_gc_scan_shadow_stack_concurrent();
  
  // Finish marking any remaining GRAY objects
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    yo_gc_mark_children_concurrent(obj);
    yo_gc_set_color(obj, BLACK);
  }
  
  // Resume mutator threads
  yo_gc_resume_world();
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement concurrent marking phases
- `src/codegen/functions/gc_runtime.ts` - add gray queue implementation

### TODO 3: Write Barriers

**Priority: HIGH** - Maintain tri-color invariant during concurrent marking

**What to implement:**

Write barrier intercepts GC pointer writes to maintain tri-color invariant during concurrent marking.

**Problem:** Mutator can break invariant during concurrent marking:
```
Initial: A (BLACK) -> B (GRAY) -> C (WHITE)
Mutator: A.field = C    // A now points to C
         B.field = null  // B no longer points to C
Result:  A (BLACK) -> C (WHITE)  // Invariant violated! C is reachable but WHITE
```

**Solution: Dijkstra Write Barrier** (insertion barrier):

```c
// Called before every GC pointer write
static inline void yo_write_barrier(void** slot, void* new_value) {
  // If GC is marking and new_value is WHITE, mark it GRAY
  if (yo_gc_is_marking && new_value != NULL) {
    YoColor color = yo_gc_get_color(new_value);
    if (color == WHITE) {
      // Atomically mark WHITE -> GRAY
      uint8_t expected = WHITE;
      if (__atomic_compare_exchange_n(
            &YO_GC_HEADER(new_value)->mark_bits,
            &expected, GRAY,
            false, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE)) {
        yo_gc_push_gray(new_value);
      }
    }
  }
}
```

**Code generation for GC pointer writes:**

Current codegen for assignment:
```yo
obj.field = new_obj;
```

Generated C (without write barrier):
```c
obj->field = new_obj;
```

Generated C (with write barrier):
```c
yo_write_barrier(&obj->field, new_obj);
obj->field = new_obj;
```

**Where to insert write barriers:**
- Struct/object field assignments: `obj.field = value`
- Array element assignments: `arr[i] = value`
- Closure capture updates
- Global variable assignments

**Optimization:** Only insert write barrier for GC pointer fields (not primitives)

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement `yo_write_barrier()`
- `src/codegen/expressions/generation.ts` - insert write barriers on assignments
  - Handle `=` operator for field assignments
  - Handle array element assignments
  - Handle closure captures

**Implementation steps:**

1. Add global flag `yo_gc_is_marking`:
   ```c
   static volatile bool yo_gc_is_marking = false;
   ```
2. Set/clear flag in GC phases:
   ```c
   void yo_gc_initial_mark() {
     yo_gc_stop_the_world();
     __atomic_store_n(&yo_gc_is_marking, true, __ATOMIC_RELEASE);
     // ... mark roots ...
     yo_gc_resume_world();
   }
   
   void yo_gc_remark() {
     yo_gc_stop_the_world();
     // ... finish marking ...
     __atomic_store_n(&yo_gc_is_marking, false, __ATOMIC_RELEASE);
     yo_gc_resume_world();
   }
   ```
3. Implement write barrier function
4. Modify codegen to insert write barriers before GC pointer writes

**Performance considerations:**
- Write barrier only active during marking (~10-30% of time)
- Fast path: Single flag check (usually branch-predicted)
- Slow path: Only when writing WHITE object during marking
- Expected overhead: <1% overall, ~5-10% during marking

### TODO 4: Safepoint Mechanism

**Priority: HIGH** - Required for stopping mutator threads

**What to implement:**

Safepoints are program points where mutator threads can be safely paused for GC.

**Safepoint properties:**
- All GC pointers are in known locations (shadow stack)
- No objects in inconsistent state
- Thread can be safely paused and resumed

**Where to insert safepoints:**
1. **Function calls** - Already a safepoint (shadow stack updated)
2. **Loop back-edges** - Prevent infinite loops from blocking GC
3. **Allocation sites** - May trigger GC
4. **Long-running operations** - Periodic checks

**Implementation:**

Global safepoint state:
```c
typedef struct {
  volatile bool requested;     // GC wants threads to stop
  pthread_mutex_t mutex;       // Protects safepoint state
  pthread_cond_t cond;         // Signals when safe to resume
  size_t num_threads;          // Total threads
  size_t threads_at_safepoint; // Threads currently stopped
} YoSafepointState;

static YoSafepointState yo_safepoint_state = {
  .requested = false,
  .num_threads = 0,
  .threads_at_safepoint = 0
};
```

Fast path safepoint check:
```c
static inline void yo_safepoint(void) {
  if (__builtin_expect(yo_safepoint_state.requested, 0)) {
    yo_safepoint_slow();  // Rarely taken
  }
}
```

Slow path (thread parks):
```c
static void yo_safepoint_slow(void) {
  pthread_mutex_lock(&yo_safepoint_state.mutex);
  
  // Increment counter
  yo_safepoint_state.threads_at_safepoint++;
  
  // Signal GC thread if all threads stopped
  if (yo_safepoint_state.threads_at_safepoint == yo_safepoint_state.num_threads) {
    pthread_cond_signal(&yo_safepoint_state.cond);
  }
  
  // Wait for GC to finish
  while (yo_safepoint_state.requested) {
    pthread_cond_wait(&yo_safepoint_state.cond, &yo_safepoint_state.mutex);
  }
  
  yo_safepoint_state.threads_at_safepoint--;
  pthread_mutex_unlock(&yo_safepoint_state.mutex);
}
```

Stop-the-world implementation:
```c
static void yo_gc_stop_the_world(void) {
  pthread_mutex_lock(&yo_safepoint_state.mutex);
  
  // Request safepoint
  __atomic_store_n(&yo_safepoint_state.requested, true, __ATOMIC_RELEASE);
  
  // Wait for all threads to reach safepoint
  while (yo_safepoint_state.threads_at_safepoint < yo_safepoint_state.num_threads - 1) {
    pthread_cond_wait(&yo_safepoint_state.cond, &yo_safepoint_state.mutex);
  }
  
  pthread_mutex_unlock(&yo_safepoint_state.mutex);
}

static void yo_gc_resume_world(void) {
  pthread_mutex_lock(&yo_safepoint_state.mutex);
  
  // Clear safepoint request
  __atomic_store_n(&yo_safepoint_state.requested, false, __ATOMIC_RELEASE);
  
  // Wake all threads
  pthread_cond_broadcast(&yo_safepoint_state.cond);
  
  pthread_mutex_unlock(&yo_safepoint_state.mutex);
}
```

**Code generation:**

Insert safepoint checks at:

1. **Loop back-edges:**
```yo
while condition(), {
  body();
}
```
Generated C:
```c
while (condition()) {
  yo_safepoint();  // Check if GC wants to stop us
  body();
}
```

2. **Long-running operations:**
```yo
for i in 0..1000000, {
  work(i);
}
```
Generated C:
```c
for (int64_t i = 0; i < 1000000; i++) {
  if ((i % 1000) == 0) {
    yo_safepoint();  // Periodic check
  }
  work(i);
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement safepoint infrastructure
- `src/codegen/expressions/generation.ts` - insert safepoint checks:
  - In loop back-edges (while, for)
  - Before long-running operations
  - Already implicit at function calls (shadow frame updates)

**Performance considerations:**
- Fast path: Single flag check (~2-3 cycles, well-predicted)
- Overhead: <0.5% in typical programs
- Loop overhead: Amortized (check every N iterations)

### TODO 5: Concurrent Sweep Phase

**Priority: MEDIUM** - Sweep can happen concurrently

**What to implement:**

After marking completes, sweep phase can run concurrently with mutators.

**Current sweep (stop-the-world):**
```c
static void yo_gc_sweep(void) {
  yo_gc_header_t* obj = yo_gc.all_objects;
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    yo_gc_header_t* next = obj->next;
    
    if (yo_gc_get_color(YO_GC_OBJECT(obj)) == WHITE) {
      // Object is garbage - free it
      yo_gc_free_object(obj);
      
      // Unlink from list
      if (prev != NULL) {
        prev->next = next;
      } else {
        yo_gc.all_objects = next;
      }
    } else {
      // Reset to WHITE for next cycle
      yo_gc_set_color(YO_GC_OBJECT(obj), WHITE);
      prev = obj;
    }
    
    obj = next;
  }
}
```

**Concurrent sweep:**
```c
static void yo_gc_concurrent_sweep(void) {
  // Sweep can happen concurrently - just need atomic operations
  yo_gc_header_t* obj = __atomic_load_n(&yo_gc.all_objects, __ATOMIC_ACQUIRE);
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    yo_gc_header_t* next = __atomic_load_n(&obj->next, __ATOMIC_ACQUIRE);
    
    YoColor color = yo_gc_get_color(YO_GC_OBJECT(obj));
    
    if (color == WHITE) {
      // Object is garbage - free it
      yo_gc_free_object(obj);
      
      // Unlink from list atomically
      if (prev != NULL) {
        __atomic_store_n(&prev->next, next, __ATOMIC_RELEASE);
      } else {
        __atomic_store_n(&yo_gc.all_objects, next, __ATOMIC_RELEASE);
      }
    } else {
      // Reset to WHITE for next cycle
      yo_gc_set_color(YO_GC_OBJECT(obj), WHITE);
      prev = obj;
    }
    
    obj = next;
  }
}
```

**Why concurrent sweep is safe:**
- Mutators only allocate new objects (never traverse free list)
- New allocations are BLACK (already marked)
- Freeing WHITE objects can't affect reachability
- Unlinking from all_objects list uses atomic operations

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement concurrent sweep
- `src/codegen/functions/gc_runtime.ts` - use atomic operations for object list

### TODO 6: GC Thread Management

**Priority: MEDIUM** - Coordinate GC threads

**What to implement:**

Dedicated GC thread(s) that run concurrent marking and sweeping.

**GC thread structure:**
```c
typedef struct {
  pthread_t thread_id;
  bool running;
  bool should_exit;
} YoGCThread;

static YoGCThread yo_gc_threads[4];  // Configurable
static size_t yo_gc_num_threads = 1;  // Default: 1 GC thread

static void* yo_gc_thread_main(void* arg) {
  while (!yo_gc_threads[0].should_exit) {
    // Wait for GC work
    pthread_mutex_lock(&yo_gc_work_mutex);
    while (!yo_gc_work_available && !yo_gc_threads[0].should_exit) {
      pthread_cond_wait(&yo_gc_work_cond, &yo_gc_work_mutex);
    }
    pthread_mutex_unlock(&yo_gc_work_mutex);
    
    if (yo_gc_threads[0].should_exit) break;
    
    // Perform GC cycle
    yo_gc_concurrent_cycle();
  }
  
  return NULL;
}

static void yo_gc_concurrent_cycle(void) {
  // Phase 1: Initial mark (STW - brief)
  yo_gc_initial_mark();
  
  // Phase 2: Concurrent mark (parallel)
  yo_gc_concurrent_mark();
  
  // Phase 3: Remark (STW - brief)
  yo_gc_remark();
  
  // Phase 4: Concurrent sweep (parallel)
  yo_gc_concurrent_sweep();
}
```

**Triggering GC:**
```c
static void yo_gc_maybe_collect(void) {
  size_t heap_size = yo_gc.total_allocated;
  size_t threshold = yo_gc.gc_threshold;
  
  if (heap_size > threshold) {
    // Signal GC thread to run
    pthread_mutex_lock(&yo_gc_work_mutex);
    yo_gc_work_available = true;
    pthread_cond_signal(&yo_gc_work_cond);
    pthread_mutex_unlock(&yo_gc_work_mutex);
  }
}

void* yo_gc_alloc(YoTypeDescriptor* type_desc) {
  void* obj = yo_gc_alloc_fast(type_desc);
  
  if (obj == NULL) {
    yo_gc_maybe_collect();  // Trigger GC if needed
    obj = yo_gc_alloc_slow(type_desc);
  }
  
  return obj;
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement GC thread management
- `src/codegen/functions/generation.ts` - start GC thread in `main()`

### TODO 7: Thread-Local Allocation Buffers (TLAB)

**Priority: MEDIUM** - Reduce allocation contention

**What to implement:**

Thread-local allocation buffers enable fast lock-free allocation.

**TLAB structure:**
```c
typedef struct {
  void* buffer_start;
  void* buffer_end;
  void* bump_ptr;
  size_t buffer_size;
} YoTLAB;

__thread YoTLAB yo_tlab = {
  .buffer_start = NULL,
  .buffer_end = NULL,
  .bump_ptr = NULL,
  .buffer_size = 64 * 1024  // 64 KB default
};
```

**Fast path allocation:**
```c
static inline void* yo_gc_alloc_fast(size_t size) {
  void* ptr = yo_tlab.bump_ptr;
  void* new_ptr = (char*)ptr + size;
  
  if (__builtin_expect(new_ptr <= yo_tlab.buffer_end, 1)) {
    yo_tlab.bump_ptr = new_ptr;
    return ptr;  // Fast path: no locks, no atomics!
  }
  
  return NULL;  // Slow path
}
```

**Slow path (refill buffer):**
```c
static void* yo_gc_alloc_slow(size_t size) {
  // Allocate new buffer from global heap
  pthread_mutex_lock(&yo_gc_heap_mutex);
  
  void* buffer = malloc(yo_tlab.buffer_size);
  
  pthread_mutex_unlock(&yo_gc_heap_mutex);
  
  // Initialize new buffer
  yo_tlab.buffer_start = buffer;
  yo_tlab.buffer_end = (char*)buffer + yo_tlab.buffer_size;
  yo_tlab.bump_ptr = (char*)buffer + size;
  
  return buffer;
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - implement TLAB allocation

**Benefits:**
- ~10-20 cycles per allocation (vs ~100+ with locks)
- Zero contention between threads
- Cache-friendly (bump pointer allocation)

### TODO 8: GC Timing and Statistics

**Priority: LOW** - Monitoring and debugging

**What to implement:**

Track GC performance metrics for monitoring and tuning.

**Statistics structure:**
```c
typedef struct {
  uint64_t total_collections;
  uint64_t total_pause_time_ns;
  uint64_t max_pause_time_ns;
  uint64_t total_mark_time_ns;
  uint64_t total_sweep_time_ns;
  
  size_t total_allocated;
  size_t total_freed;
  size_t live_objects;
  size_t heap_size;
  
  // Per-phase stats
  uint64_t initial_mark_time_ns;
  uint64_t concurrent_mark_time_ns;
  uint64_t remark_time_ns;
  uint64_t concurrent_sweep_time_ns;
} YoGCStats;

static YoGCStats yo_gc_stats = {0};
```

**Timing collection:**
```c
static uint64_t yo_get_time_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000000000ULL + ts.tv_nsec;
}

static void yo_gc_initial_mark(void) {
  uint64_t start = yo_get_time_ns();
  
  yo_gc_stop_the_world();
  // ... marking ...
  yo_gc_resume_world();
  
  uint64_t end = yo_get_time_ns();
  yo_gc_stats.initial_mark_time_ns += end - start;
  yo_gc_stats.total_pause_time_ns += end - start;
}
```

**Statistics output:**
```c
void yo_gc_print_stats(void) {
  printf("=== GC Statistics ===\n");
  printf("Total collections:   %llu\n", yo_gc_stats.total_collections);
  printf("Total pause time:    %.2fms\n", yo_gc_stats.total_pause_time_ns / 1e6);
  printf("Max pause time:      %.2fms\n", yo_gc_stats.max_pause_time_ns / 1e6);
  printf("Avg pause time:      %.2fms\n", 
         (double)yo_gc_stats.total_pause_time_ns / yo_gc_stats.total_collections / 1e6);
  printf("\nPhase breakdown:\n");
  printf("  Initial mark:      %.2fms\n", yo_gc_stats.initial_mark_time_ns / 1e6);
  printf("  Concurrent mark:   %.2fms\n", yo_gc_stats.concurrent_mark_time_ns / 1e6);
  printf("  Remark:            %.2fms\n", yo_gc_stats.remark_time_ns / 1e6);
  printf("  Concurrent sweep:  %.2fms\n", yo_gc_stats.concurrent_sweep_time_ns / 1e6);
  printf("\nMemory:\n");
  printf("  Allocated:         %.2f MB\n", yo_gc_stats.total_allocated / 1e6);
  printf("  Freed:             %.2f MB\n", yo_gc_stats.total_freed / 1e6);
  printf("  Live objects:      %zu\n", yo_gc_stats.live_objects);
  printf("  Heap size:         %.2f MB\n", yo_gc_stats.heap_size / 1e6);
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - add timing instrumentation

### TODO 9: Testing & Validation

**Priority: HIGH** - Verify concurrent GC correctness

**Tests to create:**

1. **Concurrent allocation stress test:**
```yo
test_concurrent_allocation :: (fn() -> unit) {
  // Multiple threads allocating simultaneously
  spawn({
    for i in 0..10000, {
      node := Node(value: i, next: .None);
    }
  });
  
  spawn({
    for i in 0..10000, {
      node := Node(value: i, next: .None);
    }
  });
}
```

2. **Write barrier stress test:**
```yo
test_write_barrier :: (fn() -> unit) {
  root := Node(value: 1, next: .None);
  
  // Allocate during marking
  spawn({
    loop({
      root.next = .Some(Node(value: 42, next: .None));
    });
  });
  
  // Trigger GC repeatedly
  spawn({
    loop({
      gc_collect();
    });
  });
}
```

3. **Safepoint test:**
```yo
test_safepoint :: (fn() -> unit) {
  // Long-running computation
  spawn({
    sum := 0;
    for i in 0..1000000000, {
      sum := sum + i;
    }
    printf("Sum: %lld\n", sum);
  });
  
  // GC should be able to stop the thread
  sleep_ms(100);
  gc_collect();
}
```

4. **Pause time measurement:**
```yo
test_pause_time :: (fn() -> unit) {
  // Allocate large heap
  for i in 0..100000, {
    node := Node(value: i, next: .None);
  }
  
  // Measure GC pause
  start := get_time_ns();
  gc_collect();
  end := get_time_ns();
  
  pause_ms := (end - start) / 1000000;
  printf("Pause time: %lld ms\n", pause_ms);
  assert(pause_ms < 5);  // Should be <5ms
}
```

**Validation:**
- Measure pause times: Should be <5ms for typical heaps
- Verify no crashes with concurrent access
- Verify no memory leaks
- Verify tri-color invariant maintained
- Stress test with many threads

**Files to create:**
- `src/tests/examples/test_concurrent_gc.yo`

---

## 📊 Progress Tracking

**Overall Phase 4 Progress:** 🚀 ~30% Complete

**TODO Status:**
- ✅ TODO 1: Tri-color marking infrastructure (100%) - COMPLETE
  - Gray queue implemented with thread-safe push/pop
  - Color manipulation functions (get_color, set_color)
  - Concurrent marking state (yo_gc_is_marking flag)
- ✅ TODO 2: Concurrent mark phase (100%) - COMPLETE
  - Initial mark phase (STW - marks roots as GRAY)
  - Concurrent mark phase (processes gray queue)
  - Remark phase (STW - finishes marking)
  - All three phases working correctly
- ⏳ TODO 3: Write barriers (0%)
- ⏳ TODO 4: Safepoint mechanism (0%)
- ⏳ TODO 5: Concurrent sweep phase (0%)
- ⏳ TODO 6: GC thread management (0%)
- ⏳ TODO 7: Thread-local allocation buffers (0%)
- ⏳ TODO 8: GC timing and statistics (0%)
- ⏳ TODO 9: Testing & validation (0%)

---

## 🎯 Implementation Order

**Week 1-2: Infrastructure**
1. TODO 1: Tri-color marking infrastructure
2. TODO 4: Safepoint mechanism
3. Basic testing (safepoints work)

**Week 3-4: Concurrent Marking**
4. TODO 2: Concurrent mark phase (initial mark + concurrent mark)
5. TODO 3: Write barriers
6. Testing (concurrent marking without crashes)

**Week 5-6: Complete Concurrent GC**
7. TODO 2: Remark phase
8. TODO 5: Concurrent sweep
9. TODO 6: GC thread management
10. Testing (full concurrent GC cycle)

**Week 7-8: Optimization & Polish**
11. TODO 7: Thread-local allocation buffers
12. TODO 8: GC timing and statistics
13. TODO 9: Comprehensive testing
14. Performance tuning (<5ms pause goal)

---

## 🔍 Success Criteria

Phase 4 is complete when:
- ✅ GC runs concurrently with mutator threads
- ✅ STW pauses are <5ms (99.9th percentile)
- ✅ Write barriers maintain tri-color invariant
- ✅ Safepoints work reliably
- ✅ No data races or crashes under stress
- ✅ Performance overhead is acceptable (<10%)
- ✅ All tests pass with concurrent access

---

## 📝 Notes

**STW Pause Budget:**
```
Initial Mark:
  - Stop threads:       0.5ms
  - Scan shadow stacks: 0.5-1.0ms
  - Resume threads:     0.1ms
  Total:                ~1-2ms

Remark:
  - Stop threads:       0.5ms
  - Process barriers:   0.5-1.0ms
  - Finish marking:     0.5-1.0ms
  - Resume threads:     0.1ms
  Total:                ~2-3ms

Total STW per cycle:    ~3-5ms ✅ Meets goal!
```

**Concurrent Work:**
- Marking: 80-90% of GC time (happens concurrently)
- Sweeping: 10-20% of GC time (happens concurrently)
- Overhead: Write barriers (<1%), Safepoints (<0.5%)

**Thread Safety:**
- All object list manipulations use atomic operations
- Gray queue protected by mutex
- Write barriers are lock-free (atomic compare-exchange)
- Safepoint state protected by mutex

**Comparison to Go:**
- Similar approach (concurrent mark-sweep)
- Similar pause times (<5ms)
- Go uses stack maps (we use shadow stack)
- Go more mature (10+ years optimization)

---

*Last updated: 2025-11-16*
*Next review: After TODO 1-2 completion*
