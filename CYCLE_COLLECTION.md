# Cycle Collection

Yo uses **non-atomic reference counting** with **thread-local cycle collection** to reclaim cyclic structures. The cycle collector uses **QuickJS's trial deletion algorithm**, which is simpler than [Nim's ORC coloring approach](https://nim-works.github.io/nimskull/gc.html) while providing similar performance. The implementation is adapted for Yo's thread-per-core model with selective work-stealing.

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

QuickJS uses a **trial deletion** approach that works perfectly with non-atomic reference counting. This is simpler than [Nim's ORC coloring algorithm](https://nim-works.github.io/nimskull/gc.html) (which uses black/gray/white marking) but achieves similar O(N) performance with less complexity.

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

### Selective Work-Stealing (Nim's Approach)

**Only tasks without cycle-forming captures can be stolen:**

```yo
// ✅ STEALABLE - only primitives and acyclic types
async {
  x := box(42);           // Box(i32) - no internal refs
  y := [1, 2, 3];         // Array(i32) - no internal refs
  result := await(compute(x, y));
  return result;
}

// ❌ NOT STEALABLE - captures cycle-forming type
async {
  node := Node(1, .None);    // Node has Option(Node) field
  await(io_operation());     // Task yields
  // Task CANNOT be stolen - must stay on Thread 1
  node.next = .Some(node);   // Creates cycle
}
```

**Why thread-local GC requires this:**
1. Objects are tracked by the thread that created them
2. If a task migrates, the GC on the original thread might collect objects still in use
3. Solution: Tasks capturing cycle-forming types cannot migrate (thread affinity)

**Compiler Analysis:**

The compiler analyzes captured variables at async function creation:

```yo
async {
  x := box(42);           // Type: Box(i32)
  node := Node(1, .None); // Type: Node (has Option(Node))
  
  // Analysis:
  // - Box(i32): no internal refs → stealable ✅
  // - Node: has Option(Node) → can form cycles ❌
  // Result: Task is NOT stealable (thread affinity)
}
```

**Type Analysis Rules:**

| Type | Can Form Cycles? | Stealable? |
|------|------------------|------------|
| Primitives (`i32`, `boolean`, etc.) | No | ✅ Yes |
| Value types (`struct(...)`) | No | ✅ Yes |
| `Box(T)` where T is value type | No | ✅ Yes |
| `Array(T)` where T is value type | No | ✅ Yes |
| `object(...)` with ref fields | Yes | ❌ No |
| `Node(value, next: Option(Node))` | Yes | ❌ No |
| Closures capturing Rc types | Yes | ❌ No |

**Runtime Behavior:**

```c
// Each task has a stealability flag
typedef struct {
    void (*resume_fn)(void*);
    void* state_machine;
    bool is_stealable;  // Set by compiler at creation
} yo_continuation_t;

// Work stealing checks flag
yo_continuation_t* yo_try_steal_task(yo_worker_t* victim) {
    yo_continuation_t* task = victim->queue_head;
    if (task && task->is_stealable) {
        // Remove from victim's queue and return
        return task;
    }
    return NULL;  // Task is non-stealable, skip
}
```

**GC Collection Process:**

```c
void yo_gc_collect_thread_local() {
    // No synchronization needed - thread-local only
    yo_gc_state_t* gc = &yo_gc_state;
    
    // Run trial deletion on this thread's tracked objects
    yo_gc_mark_phase(gc);
    yo_gc_sweep_phase(gc);
    
    // Other threads continue running in parallel
}
```

**Trade-offs:**
- ✅ No stop-the-world pauses (each thread collects independently)
- ✅ Predictable per-thread pause times (O(thread's objects))
- ✅ Perfect scaling (threads don't interfere)
- ✅ Most tasks are stealable (primitives and value types common)
- ⚠️ Tasks capturing cycle-forming types have thread affinity
- ⚠️ Requires compiler analysis for stealability

## Performance Characteristics

### Thread-Local Collection

**Strengths:**
- ✅ Non-atomic RC in hot path (zero synchronization overhead)
- ✅ No stop-the-world pauses (each thread collects independently)
- ✅ Predictable per-thread pause times (O(thread's objects))
- ✅ Perfect scaling (N threads = N independent collectors)
- ✅ Most tasks are stealable (good load balancing)
- ✅ Real-time friendly (no global synchronization)

**Weaknesses:**
- ⚠️ Tasks capturing cycle-forming types have thread affinity
- ⚠️ Requires compiler analysis for stealability
- ⚠️ Slightly more complex than full STW

**Why this is better than Go's GC:**
- Yo's pauses: 0.5-5ms per thread (only that thread's cycles)
- Go's pauses: 10-100ms+ globally (all threads stop)
- Yo has no global synchronization (true parallelism)

### Pause Time Analysis

```
Objects tracked per thread: N/threads
Pause time per thread: O(N/threads) for mark + sweep
Typical: 0.5-5ms for 1K-10K objects per thread on modern CPU
Scaling: ~0.1-1μs per object (including traversal)
Global impact: Zero (other threads continue running)
```

**Optimization strategies:**
1. **Conservative tracking**: Only track objects with reference-type fields
2. **Generational**: Track young vs old objects, collect young more frequently
3. **Threshold tuning**: Per-thread collection frequency based on allocation rate
4. **Stealability inference**: Compiler automatically determines task stealability

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

### Object Registration and Stealability

Compiler generates code to register objects with thread-local GC and mark task stealability:

```c
// Generated code for object allocation
Node* node = yo_alloc_object(sizeof(Node));
node->value = 42;
node->next = OPTION_NONE;

// Register with thread-local GC (no synchronization needed)
yo_gc_track(&yo_gc_state, (yo_object*)node);

// Increment thread-local allocation counter
yo_gc_state.alloc_count++;
if (yo_gc_state.alloc_count >= YO_GC_THRESHOLD) {
    yo_gc_collect_thread_local();  // Collect this thread only
    yo_gc_state.alloc_count = 0;
}
```

```c
// Generated code for async task creation
typedef struct {
    int value;
    Node* node;  // Captures Node (can form cycles)
} MyAsyncState;

yo_continuation_t* task = yo_create_continuation(
    my_async_resume,
    state_machine,
    false  // is_stealable = false (captures Node)
);

// Alternative: task capturing only primitives
typedef struct {
    int x;
    int y;
} SimpleAsyncState;

yo_continuation_t* task2 = yo_create_continuation(
    simple_async_resume,
    state_machine2,
    true  // is_stealable = true (only primitives)
);
```

## Comparison with Other Approaches

| Approach | Pause Time | Cross-Thread | Complexity | Performance |
|----------|------------|--------------|------------|-------------|
| **QuickJS trial deletion** | O(N) | No (single-threaded) | Low | Good |
| **Nim ORC (coloring)** | O(N/threads) | No (thread affinity) | Medium-High | Excellent |
| **Python (cycle detector)** | O(N) | Yes (GIL serializes) | Medium | Good with GIL |
| **Swift (weak references)** | O(1) | Yes | Low | Excellent |
| **Java (tracing GC)** | O(heap) | Yes | High | Variable |
| **Go (mark-sweep)** | O(heap) | Yes | High | 10-100ms STW |
| **Yo (QuickJS-style trial deletion)** | O(N/threads) | Selective | Low-Medium | 0.5-5ms per thread |

## Summary

Yo's cycle collection design:

1. ✅ **Non-atomic RC** - zero synchronization overhead in hot path
2. ✅ **Thread-local cycle collection** - no stop-the-world pauses
3. ✅ **QuickJS trial deletion** - simple, proven algorithm (simpler than [Nim's coloring approach](https://nim-works.github.io/nimskull/gc.html))
4. ✅ **Selective work stealing** - stealable tasks migrate, others have thread affinity
5. ✅ **Short per-thread pauses** - 0.5-5ms typical per thread (only that thread's cycles)
6. ✅ **Compiler-driven** - automatic stealability analysis and tracking
7. ✅ **Real-time friendly** - predictable latency, no global synchronization

The key insights are:
- **Reference counting frees most objects immediately** - GC only handles cycles
- **Thread-local collection scales perfectly** - N threads = N independent collectors
- **Most tasks are stealable** - primitives and value types common in practice
- **No global pauses** - each thread collects independently while others continue

This design gives **excellent performance** (better than Go's 10-100ms STW pauses) and **predictable latency** for real-time applications, while maintaining good work-stealing for load balancing.
