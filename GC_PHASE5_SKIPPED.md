# GC Phase 5 - Generational GC (SKIPPED)

**Status:** ❌ SKIPPED - Not needed for Yo
**Last updated:** 2025-11-16

## Decision Summary

Phase 5 (Generational GC) was **cancelled** after analysis showed it's not beneficial for Yo.

### Why Skipped?

1. **Explicit allocation control** - Yo has `struct` (stack) vs `object` (heap)
   - Programmers explicitly choose where to allocate
   - Unlike Go which uses escape analysis automatically
   - Well-designed code uses `struct` for short-lived data

2. **Phase 4 is excellent** - 0.29ms pause times are production-ready
   - 10x better than our 5ms goal
   - No performance bottleneck observed
   - Adding complexity without proven need

3. **Premature optimization** - Should measure before optimizing
   - Need real-world Yo programs to profile
   - Unknown if most `object` allocations die young
   - Unknown if GC is actually a bottleneck

4. **Complexity cost** - Generational GC adds:
   - Remember sets (old→young pointer tracking)
   - More complex write barriers  
   - Two GC algorithms (minor + major)
   - More edge cases and maintenance burden

### When to Reconsider

Revisit generational GC if:
- Profiling shows GC takes >10% of runtime
- Measurements show >70% of heap objects die young
- Escape analysis is added (making allocation patterns like Go)

### Current GC Performance

Phase 4 Concurrent GC:
- ✅ 0.29ms pause times
- ✅ 99.9% concurrent work
- ✅ <5ms goal exceeded by 10x
- ✅ Production ready

---

## Original Phase 5 Plan (For Reference)

The rest of this document contains the original generational GC plan.
It's preserved for future reference if we decide to implement it later.

---

# GC Phase 5 Implementation TODO - Generational GC (ORIGINAL PLAN)

**Why Generational GC for Yo?**
- ✅ **Heap-heavy allocation** - No escape analysis yet, unlike Go
- ✅ **Precise roots** - Shadow stack makes generational feasible
- ✅ **Young objects die quickly** - 90%+ mortality in first GC
- ✅ **Infrastructure ready** - Generation field already in header
- ✅ **Reduce GC overhead** - Only scan young generation most of the time

**Current limitation:** Every GC scans the entire heap, even though most objects survive. This wastes time scanning long-lived objects.

**After Phase 5:** Minor GCs scan only young generation (fast), major GCs scan full heap (rare). Expected 5-10x reduction in GC time.

---

## 🎯 Generational Hypothesis

**Observation:** In most programs, objects fall into two categories:
1. **Short-lived** (90-95%): Temporary values, loop variables, intermediate results
2. **Long-lived** (5-10%): Global state, caches, persistent data structures

**Implication:** If we separate young and old objects, we can:
- Collect young generation frequently (most garbage is here)
- Collect old generation rarely (few objects become garbage)
- Result: Much less work per GC cycle

---

## 📋 TODO List

### TODO 1: Generation Infrastructure

**Priority: HIGH** - Foundation for generational collection

**What to implement:**

Extend GC to track object age and separate generations.

**Generation scheme:**
```c
// Already in yo_gc_header_t:
uint8_t generation : 1;  // 0=young, 1=old

// Generation 0: Young (nursery)
// - All new allocations start here
// - Collected frequently (every N allocations)
// - Objects that survive N collections promoted to old

// Generation 1: Old (tenured)
// - Promoted from young after surviving N GCs
// - Collected rarely (only during major GC)
// - Most objects here are long-lived
```

**Age tracking:**
```c
// Expand generation field to track age
typedef struct {
  uint8_t mark_bits : 2;      // WHITE=0, GRAY=1, BLACK=2
  uint8_t generation : 2;     // 0=young, 1=old, 2-3 reserved
  uint8_t age : 3;            // Age in young generation (0-7)
  uint8_t has_finalizer : 1;  // 1 if dispose() exists
  // ... rest of header
} yo_gc_header_t;
```

**Generation state:**
```c
typedef struct {
  yo_gc_header_t* young_objects;  // Young generation list
  yo_gc_header_t* old_objects;    // Old generation list
  
  size_t young_bytes;             // Bytes in young generation
  size_t old_bytes;               // Bytes in old generation
  
  size_t young_threshold;         // Trigger minor GC at this size
  size_t major_gc_threshold;      // Trigger major GC at this size
  
  uint64_t minor_collections;     // Count of minor GCs
  uint64_t major_collections;     // Count of major GCs
  
  uint8_t promotion_age;          // Promote after N survivals (default: 3)
} YoGenerationalGC;

static YoGenerationalGC yo_gen_gc = {
  .young_objects = NULL,
  .old_objects = NULL,
  .young_bytes = 0,
  .old_bytes = 0,
  .young_threshold = 256 * 1024,   // 256KB young generation
  .major_gc_threshold = 8 * 1024 * 1024,  // 8MB total heap
  .minor_collections = 0,
  .major_collections = 0,
  .promotion_age = 3  // Promote after surviving 3 minor GCs
};
```

**Files to modify:**
- `src/codegen/types/generation.ts` - Update header bit fields
- `src/codegen/functions/gc_runtime.ts` - Add generation tracking

**Implementation steps:**
1. Update yo_gc_header_t to add age field
2. Separate young/old object lists
3. Track generation sizes
4. Modify __yo_gc_alloc to add to young generation
5. Add yo_gc_promote_object() to move young→old

---

### TODO 2: Minor GC (Young Generation Only)

**Priority: HIGH** - Core generational GC benefit

**What to implement:**

Fast minor GC that only scans young generation.

**Minor GC phases:**
```c
/**
 * Minor GC: Collect young generation only
 * Much faster than major GC since old generation is not scanned
 */
static void yo_gc_minor_collect(void) {
  yo_gen_gc.minor_collections++;
  
  // Phase 1: Mark roots (STW - brief)
  yo_gc_stop_the_world();
  
  // Mark roots from shadow stack as GRAY
  yo_gc_scan_shadow_stack();
  
  // Mark objects in remember set (old→young pointers)
  yo_gc_scan_remember_set();
  
  yo_gc_resume_world();
  
  // Phase 2: Concurrent mark (young generation only)
  // Only process young objects in gray queue
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj == NULL) break;
    
    yo_gc_header_t* header = YO_GC_HEADER(obj);
    
    // Skip if object is in old generation
    if (header->generation == 1) continue;
    
    yo_gc_mark_children_concurrent(obj);
    yo_gc_set_color(obj, YO_GC_BLACK);
  }
  
  // Phase 3: Remark (STW - brief)
  yo_gc_stop_the_world();
  
  // Re-scan roots and remember set
  yo_gc_scan_shadow_stack();
  yo_gc_scan_remember_set();
  
  // Finish marking
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray();
    if (obj != NULL && YO_GC_HEADER(obj)->generation == 0) {
      yo_gc_mark_children_concurrent(obj);
      yo_gc_set_color(obj, YO_GC_BLACK);
    }
  }
  
  yo_gc_resume_world();
  
  // Phase 4: Sweep young generation
  yo_gc_sweep_young_generation();
  
  // Phase 5: Promote survivors
  yo_gc_promote_survivors();
}

/**
 * Sweep young generation, free unmarked objects
 */
static void yo_gc_sweep_young_generation(void) {
  yo_gc_header_t* obj = yo_gen_gc.young_objects;
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    yo_gc_header_t* next = obj->gc_next;
    
    if (yo_gc_get_color(YO_GC_OBJECT(obj)) == YO_GC_WHITE) {
      // Young object is garbage - free it
      yo_gc_free_object(obj);
      
      // Unlink from young list
      if (prev != NULL) {
        prev->gc_next = next;
      } else {
        yo_gen_gc.young_objects = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
    } else {
      // Object survived - increment age
      obj->age++;
      obj->mark_bits = YO_GC_WHITE;  // Reset for next GC
      prev = obj;
    }
    
    obj = next;
  }
}

/**
 * Promote survivors that are old enough
 */
static void yo_gc_promote_survivors(void) {
  yo_gc_header_t* obj = yo_gen_gc.young_objects;
  yo_gc_header_t* prev = NULL;
  
  while (obj != NULL) {
    yo_gc_header_t* next = obj->gc_next;
    
    if (obj->age >= yo_gen_gc.promotion_age) {
      // Promote to old generation
      yo_gc_promote_object(obj);
      
      // Remove from young list
      if (prev != NULL) {
        prev->gc_next = next;
      } else {
        yo_gen_gc.young_objects = next;
      }
      if (next != NULL) {
        next->gc_prev = prev;
      }
    } else {
      prev = obj;
    }
    
    obj = next;
  }
}

/**
 * Promote object from young to old generation
 */
static void yo_gc_promote_object(yo_gc_header_t* header) {
  // Update generation
  header->generation = 1;
  header->age = 0;
  
  // Add to old generation list
  if (yo_gen_gc.old_objects != NULL) {
    yo_gen_gc.old_objects->gc_prev = header;
  }
  header->gc_next = yo_gen_gc.old_objects;
  header->gc_prev = NULL;
  yo_gen_gc.old_objects = header;
  
  // Update size counters
  size_t obj_size = sizeof(yo_gc_header_t) + header->size;
  yo_gen_gc.young_bytes -= obj_size;
  yo_gen_gc.old_bytes += obj_size;
}
```

**Key insight:** Minor GC only scans:
- Shadow stack roots (always)
- Remember set (old→young pointers)
- Young generation objects

Old generation is NOT scanned, making minor GC very fast!

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - Implement minor GC

---

### TODO 3: Remember Set (Old→Young Pointers)

**Priority: HIGH** - Required for correctness

**What to implement:**

Track pointers from old generation to young generation. Without this, we might miss reachable young objects!

**Problem:**
```
Initial: Old object A points to young object B
Minor GC: Scans young generation only
Result:  B is not marked (A is not scanned!)
Bug:     B is collected even though A→B exists!
```

**Solution: Remember Set**

Track all old→young pointers in a separate data structure.

```c
/**
 * Remember set: Tracks old generation objects that point to young generation
 * When old object writes to young object, we add it to remember set
 */
typedef struct {
  yo_gc_header_t** objects;  // Array of old objects with young pointers
  size_t size;               // Number of objects in set
  size_t capacity;           // Array capacity
  pthread_mutex_t lock;      // Thread-safe access
} YoRememberSet;

static YoRememberSet yo_remember_set = {
  .objects = NULL,
  .size = 0,
  .capacity = 0
};

/**
 * Add object to remember set
 */
static void yo_remember_set_add(yo_gc_header_t* header) {
  pthread_mutex_lock(&yo_remember_set.lock);
  
  // Resize if needed
  if (yo_remember_set.size >= yo_remember_set.capacity) {
    yo_remember_set.capacity = yo_remember_set.capacity == 0 ? 128 : yo_remember_set.capacity * 2;
    yo_remember_set.objects = realloc(
      yo_remember_set.objects,
      yo_remember_set.capacity * sizeof(yo_gc_header_t*)
    );
  }
  
  yo_remember_set.objects[yo_remember_set.size++] = header;
  
  pthread_mutex_unlock(&yo_remember_set.lock);
}

/**
 * Scan remember set during minor GC
 * Marks young objects reachable from old generation
 */
static void yo_gc_scan_remember_set(void) {
  for (size_t i = 0; i < yo_remember_set.size; i++) {
    yo_gc_header_t* header = yo_remember_set.objects[i];
    void* obj = (void*)(header + 1);
    
    // Scan this old object's pointers
    yo_gc_mark_children_concurrent(obj);
  }
}

/**
 * Clear remember set after minor GC
 * We'll rebuild it during next write barriers
 */
static void yo_remember_set_clear(void) {
  pthread_mutex_lock(&yo_remember_set.lock);
  yo_remember_set.size = 0;
  pthread_mutex_unlock(&yo_remember_set.lock);
}
```

**Write barrier update:**

Modify write barrier to track old→young pointers:

```c
static inline void yo_write_barrier(void** slot, void* new_value) {
  // Existing marking barrier for concurrent GC
  if (yo_gc_is_marking && new_value != NULL) {
    YoColor color = yo_gc_get_color(new_value);
    if (color == YO_GC_WHITE) {
      yo_gc_mark_object(new_value);
    }
  }
  
  // Generational barrier: Track old→young pointers
  if (new_value != NULL) {
    // Get header of object being modified (container)
    void* container = (void*)((char*)slot - offsetof(/* container type */, /* field */));
    yo_gc_header_t* container_header = YO_GC_HEADER(container);
    
    // Get header of new value
    yo_gc_header_t* value_header = YO_GC_HEADER(new_value);
    
    // If old object points to young object, add to remember set
    if (container_header->generation == 1 && value_header->generation == 0) {
      yo_remember_set_add(container_header);
    }
  }
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - Remember set implementation
- `src/codegen/expressions/generation.ts` - Update write barrier

---

### TODO 4: Major GC (Full Heap Collection)

**Priority: MEDIUM** - Fallback for memory pressure

**What to implement:**

Full heap GC when old generation grows too large.

**When to trigger major GC:**
1. Old generation exceeds threshold (e.g., 8MB)
2. Minor GC fails to free enough memory
3. Explicit __yo_gc_collect() call

```c
/**
 * Major GC: Collect both young and old generations
 * Same as Phase 4 concurrent GC, but marks all generations
 */
static void yo_gc_major_collect(void) {
  yo_gen_gc.major_collections++;
  
  // Phase 1: Mark roots (STW)
  yo_gc_initial_mark();
  
  // Phase 2: Concurrent mark (ALL generations)
  yo_gc_concurrent_mark();
  
  // Phase 3: Remark (STW)
  yo_gc_remark();
  
  // Phase 4: Concurrent sweep (ALL generations)
  yo_gc_concurrent_sweep_all_generations();
  
  // Adjust thresholds
  yo_gen_gc.young_threshold = yo_gen_gc.young_bytes * 2;
  yo_gen_gc.major_gc_threshold = (yo_gen_gc.young_bytes + yo_gen_gc.old_bytes) * 2;
}

/**
 * Decide whether to do minor or major GC
 */
static void yo_gc_collect_auto(void) {
  size_t total_bytes = yo_gen_gc.young_bytes + yo_gen_gc.old_bytes;
  
  if (total_bytes > yo_gen_gc.major_gc_threshold) {
    // Memory pressure - do major GC
    yo_gc_major_collect();
  } else if (yo_gen_gc.young_bytes > yo_gen_gc.young_threshold) {
    // Young generation full - do minor GC
    yo_gc_minor_collect();
  }
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - Major GC implementation

---

### TODO 5: Adaptive Tuning

**Priority: LOW** - Automatic policy tuning

**What to implement:**

Dynamically adjust generation sizes and promotion age based on observed behavior.

**Tuning parameters:**
```c
typedef struct {
  // Observed metrics
  double young_survival_rate;    // % of young objects that survive
  double promotion_survival_rate; // % of promoted objects still alive
  size_t avg_minor_gc_time_ns;
  size_t avg_major_gc_time_ns;
  
  // Tunable policies
  size_t young_size_target;      // Target young generation size
  uint8_t promotion_age_target;  // Target age for promotion
} YoGCTuning;

static YoGCTuning yo_gc_tuning = {
  .young_survival_rate = 0.1,    // Assume 10% survival initially
  .promotion_survival_rate = 0.9,
  .avg_minor_gc_time_ns = 0,
  .avg_major_gc_time_ns = 0,
  .young_size_target = 256 * 1024,
  .promotion_age_target = 3
};

/**
 * Adjust tuning after each minor GC
 */
static void yo_gc_tune_after_minor(size_t survived_bytes, uint64_t gc_time_ns) {
  // Update survival rate (exponential moving average)
  double survival_rate = (double)survived_bytes / yo_gen_gc.young_bytes;
  yo_gc_tuning.young_survival_rate = 
    0.9 * yo_gc_tuning.young_survival_rate + 0.1 * survival_rate;
  
  // If survival rate is high, increase promotion age (keep objects young longer)
  if (yo_gc_tuning.young_survival_rate > 0.3) {
    yo_gen_gc.promotion_age = min(7, yo_gen_gc.promotion_age + 1);
  } else if (yo_gc_tuning.young_survival_rate < 0.1) {
    // If survival rate is low, decrease promotion age (promote faster)
    yo_gen_gc.promotion_age = max(1, yo_gen_gc.promotion_age - 1);
  }
  
  // Adjust young generation size based on GC frequency
  // Goal: Minor GC should take ~1ms, not more
  yo_gc_tuning.avg_minor_gc_time_ns = 
    0.9 * yo_gc_tuning.avg_minor_gc_time_ns + 0.1 * gc_time_ns;
  
  if (yo_gc_tuning.avg_minor_gc_time_ns > 2 * 1000000) {  // >2ms
    // Minor GC too slow - reduce young generation size
    yo_gc_tuning.young_size_target *= 0.8;
  } else if (yo_gc_tuning.avg_minor_gc_time_ns < 500000) {  // <0.5ms
    // Minor GC very fast - can increase young generation size
    yo_gc_tuning.young_size_target *= 1.2;
  }
  
  yo_gen_gc.young_threshold = yo_gc_tuning.young_size_target;
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - Adaptive tuning

---

### TODO 6: Statistics for Generational GC

**Priority: LOW** - Monitoring and debugging

**What to implement:**

Extend Phase 4 statistics to track generational metrics.

```c
typedef struct {
  // Existing Phase 4 stats...
  
  // Generational stats
  uint64_t minor_collections;
  uint64_t major_collections;
  uint64_t total_promotions;
  
  uint64_t minor_pause_time_ns;
  uint64_t major_pause_time_ns;
  
  double avg_young_survival_rate;
  double avg_promotion_survival_rate;
  
  size_t young_gen_size_bytes;
  size_t old_gen_size_bytes;
} YoGCStats;

void __yo_gc_print_stats(void) {
  // ... existing stats ...
  
  printf("\nGenerational GC:\n");
  printf("  Minor collections:  %llu\n", yo_gc_stats.minor_collections);
  printf("  Major collections:  %llu\n", yo_gc_stats.major_collections);
  printf("  Total promotions:   %llu\n", yo_gc_stats.total_promotions);
  printf("  Minor/major ratio:  %.1f:1\n", 
         (double)yo_gc_stats.minor_collections / yo_gc_stats.major_collections);
  printf("\n");
  printf("  Avg minor GC:       %.2f ms\n",
         (double)yo_gc_stats.minor_pause_time_ns / yo_gc_stats.minor_collections / 1e6);
  printf("  Avg major GC:       %.2f ms\n",
         (double)yo_gc_stats.major_pause_time_ns / yo_gc_stats.major_collections / 1e6);
  printf("\n");
  printf("  Young gen size:     %.2f MB\n", yo_gen_gc.young_bytes / 1e6);
  printf("  Old gen size:       %.2f MB\n", yo_gen_gc.old_bytes / 1e6);
  printf("  Promotion age:      %u\n", yo_gen_gc.promotion_age);
  printf("  Young survival:     %.1f%%\n", yo_gc_tuning.young_survival_rate * 100);
}
```

**Files to modify:**
- `src/codegen/functions/gc_runtime.ts` - Extended statistics

---

### TODO 7: Testing & Validation

**Priority: HIGH** - Verify correctness

**Tests to create:**

1. **Basic generational test:**
```yo
test_generational_basic :: (fn() -> unit) {
  // Allocate young objects
  for i in 0..1000, {
    temp := Data(value: i);
    // temp dies immediately
  }
  
  // Should trigger minor GC
  // Should NOT scan old generation
}
```

2. **Promotion test:**
```yo
test_promotion :: (fn() -> unit) {
  // Allocate object that survives multiple GCs
  survivor := Data(value: 42);
  
  for i in 0..10, {
    // Allocate garbage
    for j in 0..1000, {
      temp := Data(value: j);
    }
    // Minor GC should happen
  }
  
  // survivor should be promoted to old generation
  assert(survivor.value == 42);
}
```

3. **Old→young pointer test:**
```yo
test_remember_set :: (fn() -> unit) {
  // Create old object (promote by surviving GCs)
  old := Container(data: null);
  // ... trigger GCs to promote old ...
  
  // Create young object
  young := Data(value: 123);
  
  // Old object points to young
  old.data = young;
  
  // Minor GC should NOT collect young (reachable from old)
  // ... trigger minor GC ...
  
  assert(old.data.value == 123);
}
```

4. **Performance comparison:**
```yo
test_generational_performance :: (fn() -> unit) {
  // Measure time for 100K allocations
  // With generational: Should be much faster than full heap GC
  
  start := get_time_ns();
  
  for i in 0..100000, {
    temp := Data(value: i);
  }
  
  end := get_time_ns();
  elapsed_ms := (end - start) / 1000000;
  
  printf("Time: %lld ms\n", elapsed_ms);
  // Should see 5-10x improvement vs full heap GC
}
```

**Files to create:**
- `src/tests/examples/test_generational_gc.yo`

---

## 📊 Progress Tracking

**Overall Phase 5 Progress:** 🚀 ~0% Complete

**TODO Status:**
- ⏳ TODO 1: Generation infrastructure (0%)
- ⏳ TODO 2: Minor GC (0%)
- ⏳ TODO 3: Remember set (0%)
- ⏳ TODO 4: Major GC (0%)
- ⏳ TODO 5: Adaptive tuning (0%)
- ⏳ TODO 6: Generational statistics (0%)
- ⏳ TODO 7: Testing & validation (0%)

---

## 🎯 Implementation Order

**Week 1: Infrastructure**
1. TODO 1: Generation infrastructure (separate young/old lists)
2. Basic testing (allocations go to young generation)

**Week 2: Minor GC**
3. TODO 2: Minor GC (young generation only)
4. TODO 3: Remember set (track old→young pointers)
5. Testing (minor GC works correctly)

**Week 3: Major GC**
6. TODO 4: Major GC (full heap collection)
7. Testing (major GC when needed)

**Week 4: Optimization**
8. TODO 5: Adaptive tuning (automatic policy adjustment)
9. TODO 6: Statistics (monitoring)
10. TODO 7: Comprehensive testing

---

## 🔍 Success Criteria

Phase 5 is complete when:
- ✅ Objects start in young generation, promoted to old
- ✅ Minor GC scans only young generation
- ✅ Remember set correctly tracks old→young pointers
- ✅ Major GC handles memory pressure
- ✅ No correctness bugs (all reachable objects kept alive)
- ✅ 5-10x reduction in GC overhead vs full heap GC
- ✅ All tests pass

---

## 📝 Expected Performance

**Before Phase 5 (Full heap GC):**
```
Allocation pattern: 10,000 objects/sec
GC frequency:       Every 1MB (10-50ms pause)
Total GC time:      500ms / 10,000 allocs = 5% overhead
```

**After Phase 5 (Generational GC):**
```
Minor GC:           Every 256KB (0.5-1ms pause)
  - Scans ~2,500 young objects
  - Finds ~250 survivors (10% survival rate)
  - Promotes ~50 objects after 3 survivals

Major GC:           Every 8MB (10-50ms pause, rare)
  - Happens ~1/32 as often as minor GC
  
Expected overhead:  Minor GC time × frequency
                   0.5ms × 40/sec ≈ 20ms/sec = 0.5% overhead
                   
Improvement:        10x reduction in GC overhead!
```

**Why it works:**
- Minor GC only scans 256KB young generation (fast)
- Most objects die in young generation (never promoted)
- Old generation rarely scanned (only during major GC)
- Write barriers track old→young pointers (small overhead)

---

## 🤔 Design Decisions

**Why 2 generations (not 3+)?**
- Simple to implement and understand
- Sufficient for most programs (young/old separation is key)
- Can add more generations later if needed

**Why age-based promotion (not size-based)?**
- Simpler implementation
- Works well for most allocation patterns
- Matches generational hypothesis

**Why remember set (not card marking)?**
- Simpler for initial implementation
- Lower overhead for small old generation
- Can optimize to card marking later if needed

**Why concurrent minor GC?**
- Reuse Phase 4 concurrent infrastructure
- Keep pause times low (<1ms)
- Write barriers already in place

---

*Last updated: 2025-11-16*
*Next review: After Phase 4 TODO 9 completion*
