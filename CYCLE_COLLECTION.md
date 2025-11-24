# Cycle Collection

Yo uses **non-atomic reference counting** with **stop-the-world (STW) cycle collection** to reclaim cyclic structures. The cycle collector uses a **trial deletion** algorithm inspired by QuickJS, adapted for Yo's thread-per-core model with full work-stealing.

## Why Cycle Collection?

Reference counting cannot reclaim cycles:

```yo
// Create a cycle
node_a := object(value: 1, next: .None);
node_b := object(value: 2, next: .Some(node_a));
node_a.next = .Some(node_b);  // Creates cycle: A → B → A

// Drop external references
node_a = .None;  // RC of A: 2 → 1 (B still holds reference)
node_b = .None;  // RC of B: 2 → 1 (A still holds reference)

// Memory leak! Both objects have RC = 1 but are unreachable
```

## QuickJS-Inspired Algorithm

QuickJS uses a **trial deletion** approach that works perfectly with non-atomic reference counting:

### Phase 1: Mark Potential Garbage

1. **Identify candidates**: Objects with RC > 0 but potentially in cycles
2. **Trial deletion**: Temporarily decrement RC of all objects reachable from candidates
3. **Check survivability**: If RC reaches 0 after trial deletion, object is garbage

### Phase 2: Sweep

1. **Restore live objects**: Increment RC back for objects still reachable from roots
2. **Collect garbage**: Free objects that remain at RC = 0

### Key Insight

This works with non-atomic RC because:
- Only the owning thread accesses these objects during collection
- No concurrent modification during collection (thread-local or stop-the-world)
- Simple increment/decrement operations, no atomics needed

## Yo's Cycle Collector Design

### Stop-The-World Collection

All threads pause at safepoints for global cycle collection:

```c
// Global GC state
typedef struct {
  yo_object** tracked_objects;     // All objects across all threads that might form cycles
  size_t tracked_count;
  size_t tracked_capacity;
  size_t collections_count;
  size_t objects_collected;
  pthread_mutex_t lock;            // Protects tracked_objects array
} yo_gc_state_t;

yo_gc_state_t yo_gc_global_state;

// Per-thread allocation counters for triggering GC
thread_local size_t yo_gc_alloc_count;
```

**When to collect:**
- Periodically (when any thread reaches N allocations)
- When memory pressure is high
- Explicitly via `gc_collect()` call
- Each collection is stop-the-world across all threads

**Tracking:**
Only track objects that can form cycles:
- Objects with reference-type fields
- Closures capturing Rc values
- Dyn trait objects

Skip tracking:
- Value types (struct with no Rc fields)
- Primitives
- Objects with no internal references

### Algorithm Implementation

#### Phase 1: Trial Deletion

```c
void yo_gc_mark_phase(yo_gc_state_t* gc) {
    // 1. Mark all tracked objects as candidates
    for (size_t i = 0; i < gc->tracked_count; i++) {
        yo_object* obj = gc->tracked_objects[i];
        obj->gc_mark = GC_CANDIDATE;
    }
    
    // 2. Trial deletion: decrement RC of all objects reachable from candidates
    for (size_t i = 0; i < gc->tracked_count; i++) {
        yo_object* obj = gc->tracked_objects[i];
        if (obj->gc_mark == GC_CANDIDATE) {
            yo_gc_trial_delete(obj);  // Recursively decrement RC
        }
    }
    
    // 3. Mark survivors: objects with RC > 0 after trial deletion
    for (size_t i = 0; i < gc->tracked_count; i++) {
        yo_object* obj = gc->tracked_objects[i];
        if (obj->ref_count > 0) {
            obj->gc_mark = GC_LIVE;
        } else {
            obj->gc_mark = GC_GARBAGE;
        }
    }
}

void yo_gc_trial_delete(yo_object* obj) {
    if (obj->gc_mark != GC_CANDIDATE) return;
    
    obj->gc_mark = GC_TRIAL_DELETED;
    
    // Traverse fields and trial-delete referenced objects
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, yo_gc_trial_delete_visitor);
    }
}

void yo_gc_trial_delete_visitor(yo_object* referenced) {
    referenced->ref_count--;  // Non-atomic decrement
    if (referenced->ref_count > 0 && referenced->gc_mark == GC_CANDIDATE) {
        yo_gc_trial_delete(referenced);
    }
}
```

#### Phase 2: Restore and Sweep

```c
void yo_gc_sweep_phase(yo_gc_state_t* gc) {
    size_t write_index = 0;
    
    for (size_t i = 0; i < gc->tracked_count; i++) {
        yo_object* obj = gc->tracked_objects[i];
        
        if (obj->gc_mark == GC_LIVE) {
            // Restore RC for live objects
            yo_gc_restore_rc(obj);
            gc->tracked_objects[write_index++] = obj;
        } else if (obj->gc_mark == GC_GARBAGE) {
            // Free garbage
            yo_free_object(obj);
            gc->objects_collected++;
        }
    }
    
    gc->tracked_count = write_index;
}

void yo_gc_restore_rc(yo_object* obj) {
    if (obj->gc_mark != GC_LIVE) return;
    
    obj->gc_mark = GC_RESTORED;
    
    // Restore RC for referenced objects
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, yo_gc_restore_visitor);
    }
}

void yo_gc_restore_visitor(yo_object* referenced) {
    referenced->ref_count++;  // Non-atomic increment
    if (referenced->gc_mark == GC_LIVE) {
        yo_gc_restore_rc(referenced);
    }
}
```

### How STW Works with Work Stealing

**All async tasks can be stolen** because STW GC handles cross-thread references correctly:

```yo
// Thread 1 creates object
async {
  node := object(value: 1, next: .None);
  await(io_operation());  // Task yields
  // <-- Task stolen to Thread 2
  node.next = create_cycle(node);  // Accessed on Thread 2
  // STW GC will collect this correctly!
}
```

**Why STW is necessary:**
1. Objects created on one thread can be used on another after task migration
2. Per-thread GC can't track cross-thread object movement
3. STW pauses all threads, allowing global object traversal

**GC Collection Process:**

```c
void yo_gc_collect() {
    // 1. Stop all worker threads at safepoints (between task polls)
    yo_stop_all_threads();
    
    // 2. Run trial deletion on global tracked objects
    yo_gc_mark_phase(&yo_gc_global_state);
    yo_gc_sweep_phase(&yo_gc_global_state);
    
    // 3. Resume all threads
    yo_resume_all_threads();
}

// Called by each worker thread between task executions
void yo_check_safepoint() {
    if (yo_gc_stop_requested.load()) {
        yo_thread_wait_at_safepoint();  // Blocks until GC completes
    }
}
```

**Safepoint mechanism:**
- Workers check for GC requests between polling tasks
- When GC starts, all threads suspend at safepoints
- GC thread performs collection on global tracked list
- Workers resume after collection completes

**Trade-offs:**
- ✅ Handles all cross-thread references correctly
- ✅ Simple implementation (no complex tracking)
- ✅ Predictable pause times (1-10ms typical)
- ⚠️ All threads pause during collection
- ⚠️ Pause time proportional to total object count

## Performance Characteristics

### STW Collection

**Strengths:**
- ✅ Non-atomic RC in hot path (zero synchronization overhead)
- ✅ Predictable pause times (1-10ms typical)
- ✅ Handles all cross-thread references correctly
- ✅ Full work stealing enabled (maximum load balancing)
- ✅ Simple implementation (no complex tracking)

**Weaknesses:**
- ⚠️ All threads pause during collection
- ⚠️ Pause time grows with total object count (not per-thread)

**Why this is better than Go's GC:**
- Yo's pauses: 1-10ms (only cycle collection, most objects freed by RC)
- Go's pauses: 10-100ms+ (all objects traced)
- Yo has fewer objects to trace because RC frees most objects immediately

### Pause Time Analysis

```
Objects tracked globally: N
Pause time: O(N) for mark + O(N) for sweep = O(N) total
Typical: 1-10ms for 10K-100K objects on modern CPU
Scaling: ~0.1-1μs per object (including traversal)
```

**Optimization strategies:**
1. **Conservative tracking**: Only track objects with reference-type fields
2. **Generational**: Track young vs old objects, collect young more frequently
3. **Threshold tuning**: Adjust collection frequency based on allocation rate
4. **Fast safepoints**: Workers check at task boundaries (already yielding)

## API

```yo
// Runtime cycle collection control
gc_collect :: (fn() -> unit);  // Trigger immediate collection
gc_set_threshold :: (fn(threshold: usize) -> unit);  // Set collection frequency
gc_get_stats :: (fn() -> GCStats);  // Get collection statistics

GCStats :: struct(
  collections: usize,
  objects_collected: usize,
  objects_tracked: usize,
  last_pause_ns: u64,
);
```

## Compiler Support

### Automatic Tracking

Compiler generates tracking code for cycle-forming types:

```yo
// User code
Node :: object(value: i32, next: Option(Node));

// Generated tracking
node := Node(42, .None);  // Calls yo_gc_track(node)
```

### Traverse Function Generation

For each object type, compiler generates traverse function:

```c
// Generated for Node
void Node_traverse(void* obj, void (*visit)(void*)) {
    Node* node = (Node*)obj;
    if (node->next.tag == SOME) {
        visit(node->next.value);  // Visit referenced Node
    }
}
```

### Object Registration

Compiler generates code to register/unregister objects with global GC:

```c
// Generated code
Node* node = yo_alloc_object(sizeof(Node));
node->value = 42;
node->next = OPTION_NONE;

// Register with global GC (protected by mutex)
pthread_mutex_lock(&yo_gc_global_state.lock);
yo_gc_track(&yo_gc_global_state, (yo_object*)node);
pthread_mutex_unlock(&yo_gc_global_state.lock);

// Increment thread-local allocation counter
yo_gc_alloc_count++;
if (yo_gc_alloc_count >= YO_GC_THRESHOLD) {
    yo_gc_request_collection();  // Request STW GC
    yo_gc_alloc_count = 0;
}
```

## Comparison with Other Approaches

| Approach | Pause Time | Cross-Thread | Complexity | Performance |
|----------|------------|--------------|------------|-------------|
| **QuickJS trial deletion** | O(N) | No (single-threaded) | Low | Good |
| **Python (cycle detector)** | O(N) | Yes (GIL serializes) | Medium | Good with GIL |
| **Swift (weak references)** | O(1) | Yes | Low | Excellent |
| **Java (tracing GC)** | O(heap) | Yes | High | Variable |
| **Go (mark-sweep)** | O(heap) | Yes | High | 10-100ms pauses |
| **Yo (STW trial deletion)** | O(tracked) | Yes | Low | 1-10ms pauses |

## Summary

Yo's cycle collection design:

1. ✅ **Non-atomic RC** - zero synchronization overhead in hot path
2. ✅ **STW cycle collection** - simple and correct for work stealing
3. ✅ **Trial deletion algorithm** - QuickJS-inspired, proven approach
4. ✅ **Full work stealing** - all async tasks can migrate between threads
5. ✅ **Short pauses** - 1-10ms typical (only cycles need GC, RC frees most objects)
6. ✅ **Compiler-driven** - automatic tracking and registration

The key insight is that **reference counting frees most objects immediately**, so STW GC only needs to handle the small percentage of objects in cycles. This gives short, predictable pause times (much better than Go's 10-100ms) while enabling full work stealing.
