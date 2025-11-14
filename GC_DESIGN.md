# Garbage Collection Design for Yo

This document describes a garbage collection system for Yo that replaces the biased reference counting model. The design enables work-stealing concurrency while maintaining C interoperability through a hybrid value/reference type system.

## Design Philosophy

### Core Principles

1. **Hybrid Type System**: Value types (C-compatible) + GC types (heap-managed)
2. **Zero-copy C Interop**: Value types can be passed to/from C without marshaling
3. **Work-Stealing Concurrency**: No thread affinity constraints
4. **Predictable Performance**: Concurrent GC with bounded pause times
5. **Simple Mental Model**: Clear rules about what gets GC'd and what doesn't

### Trade-offs Accepted

- ✅ **Better concurrency** - Work-stealing enabled, no thread affinity
- ✅ **Zero overhead on mutation** - No dup/drop operations
- ✅ **Simpler code generation** - No RC tracking needed
- ✅ **Natural cycle handling** - GC collects cycles automatically
- ⚠️ **Non-deterministic destructors** - Cannot rely on RAII for GC types
- ⚠️ **GC pause times** - Mitigated by concurrent GC
- ⚠️ **Higher memory usage** - Objects live until GC runs

## Type System: Value vs GC Types

### Value Types (No GC)

**Value types are copied, not referenced. They live on the stack or are embedded in other types.**

```yo
// Primitive value types
i8, i16, i32, i64, isize
u8, u16, u32, u64, usize
f32, f64
boolean
rune
unit

// Composite value types
struct(...)     // C-compatible structs
[T; N]          // Fixed-size arrays (if T is value type)
(T, U, V)       // Tuples (if all elements are value types)
union(...)      // C-compatible unions
```

**Characteristics:**
- Stored inline (stack or embedded)
- Copied on assignment
- No pointers to track
- C-compatible memory layout
- Deterministic destruction (stack unwinding)

**Example:**
```yo
Point :: struct(x: i32, y: i32);
Rectangle :: struct(top_left: Point, bottom_right: Point);

p1 := Point(x: 10, y: 20);    // Lives on stack
p2 := p1;                         // Copied (no GC involved)
rect := Rectangle(top_left: p1, bottom_right: p2);  // Points embedded
```

### GC Types (Heap-Allocated)

**GC types are heap-allocated and managed by the garbage collector.**

```yo
object(...)     // Heap-allocated objects (GC-managed)
fn(...) -> T    // Closures with captures (GC-managed)
dyn(...)        // Dynamic dispatch trait objects (GC-managed)
[T]             // Dynamic arrays (slices, GC-managed)
Box(T)          // Explicit heap boxing (GC-managed)
String          // Heap-allocated strings (GC-managed)
```

**Characteristics:**
- Stored on GC heap
- Passed by reference (pointer copy)
- Tracked by GC
- Can form cycles (GC handles this)
- Non-deterministic destruction (finalized by GC)

**Example:**
```yo
Node :: object(
  value: i32,
  next: Option(Node)  // Can form cycles
);

list := Node(value: 1, next: .Some(Node(value: 2, next: .None)));
// list is GC'd when no longer reachable
```

### Hybrid: Value Types Containing GC References

**Value types can contain GC pointers, but they're still copied:**

```yo
// Value type containing a GC reference
Container :: struct(
  id: i32,           // Value field
  data: Node         // GC reference field
);

c1 := Container(id: 1, data: some_node);
c2 := c1;  // Shallow copy: id copied, data pointer copied (both point to same Node)
```

**Rule**: Copying a value type that contains GC pointers is a **shallow copy** - the pointers are copied, not the objects they point to.

## Memory Management Rules

### Assignment and Passing

**Value Types:**
```yo
p1 := Point(x: 1, y: 2);  // Stack allocation
p2 := p1;                     // Deep copy (entire struct copied)
f(p1);                        // Pass by copy (struct copied to function)
```

**GC Types:**
```yo
node := Node(value: 42, next: .None);  // Heap allocation (GC-managed)
node2 := node;                             // Shallow copy (both point to same object)
f(node);                                   // Pass by reference (pointer copied)
```

### Ownership Semantics

**There is no "ownership" with GC - only reachability:**

- **Reachable**: Object is accessible from GC roots (stack, globals, other reachable objects)
- **Unreachable**: Object cannot be accessed from any GC root
- **GC invariant**: Unreachable objects are eventually collected

**Example:**
```yo
{
  node := Node(value: 1, next: .None);  // node is reachable (on stack)
  {
    node2 := node;  // Both node and node2 point to same object (reachable)
  }
  // node2 out of scope, but object still reachable via node
}
// node out of scope, object now unreachable → eligible for GC
```

### Destructors and Finalization

**Value types can have deterministic destructors:**

```yo
File :: struct(
  fd: i32,
  ___drop: fn(self: &mut Self) -> unit = {
    cond(
      (self.fd != ((0 - 1) : i32)) => {
        close(self.fd);
        self.fd = ((0 - 1) : i32);
      },
      true => ()
    );
  }
);

{
  file := File(fd: open("data.txt"));
  // Use file...
}  // file.___drop() called here (deterministic)
```

**GC types cannot have deterministic destructors:**

```yo
// WRONG: Don't rely on finalization for resources
Resource :: object(
  handle: i32,
  ___finalize: fn(self: &Self) -> unit = {  // Called by GC (non-deterministic!)
    close(self.handle);  // ⚠️ Might run much later!
  }
);

// CORRECT: Use value type wrapper for RAII
ResourceHandle :: struct(
  resource: Resource,  // GC object
  ___drop: fn(self: &mut Self) -> unit = {
    close_resource(self.resource);  // Deterministic cleanup
  }
);
```

**Rule**: Use value types with `___drop` for deterministic resource management. GC types should not manage non-memory resources.

## GC Algorithm: Concurrent Mark-Sweep

### Why Concurrent Mark-Sweep?

1. **Low pause times**: Most GC work happens concurrently with mutator threads
2. **Predictable**: Bounded pause times (unlike generational GC's major collections)
3. **Simple**: No object movement → stable pointers (important for C interop)
4. **Work-stealing friendly**: No per-object thread ownership
5. **Proven**: Used successfully in Go, Boehm GC, etc.

### GC Phases

**1. Mark Phase (Concurrent)**

- GC threads mark reachable objects concurrently with mutator threads
- Uses tri-color marking: White (unmarked), Gray (marked, children unscanned), Black (marked, children scanned)
- Write barrier ensures no objects are missed during concurrent marking

**2. Sweep Phase (Concurrent)**

- GC threads scan heap and free unmarked (white) objects
- Reclaim memory for future allocations
- Can be done concurrently or in parallel

**3. Short STW Pauses**

- Root scanning: Scan stacks and globals (brief pause)
- Write barrier sync: Ensure write barrier consistency (brief pause)

### Tri-Color Marking

```
Initial:  All objects WHITE (unmarked)
         
GC Root Scan:  
         Stack objects → GRAY (marked, pending scan)
         
Concurrent Mark:
         For each GRAY object:
           - Mark all WHITE children as GRAY
           - Mark object as BLACK (fully scanned)
         
End of Mark:
         BLACK objects → reachable (keep)
         WHITE objects → unreachable (collect)
```

### Write Barrier

**Problem**: Mutator threads modify object graph during concurrent marking, potentially hiding reachable objects.

**Solution**: Write barrier intercepts pointer writes and marks newly-referenced objects.

**Write Barrier Type**: Dijkstra-style insertion barrier

```c
// Every time a GC pointer field is written:
void write_barrier(void** slot, void* new_value) {
  *slot = new_value;
  
  // If GC is running and new_value is WHITE, mark it GRAY
  if (gc_is_active && get_color(new_value) == WHITE) {
    mark_gray(new_value);
  }
}
```

**Code generation:**
```yo
// Source:
obj.field = new_obj;

// Generated C with write barrier:
___write_barrier(&obj->field, new_obj);
obj->field = new_obj;
```

**Overhead**: One check + potential mark per GC pointer write (only during GC mark phase).

## GC Heap Layout

### Object Header

Every GC object has a header with metadata:

```c
typedef struct {
  uint8_t mark_bits;     // Tri-color marking: 00=WHITE, 01=GRAY, 10=BLACK
  uint8_t type_tag;      // Type information for scanning
  uint16_t flags;        // Misc flags (pinned, finalized, etc.)
  uint32_t size;         // Object size in bytes
  void* type_info;       // Pointer to type descriptor (for scanning pointers)
} YoGCHeader;

// Every GC object:
// [YoGCHeader | object data...]
```

### Type Descriptors

Each GC type has a descriptor that tells the GC where pointers are:

```c
typedef struct {
  const char* name;           // Type name (for debugging)
  size_t size;                // Object size
  size_t pointer_count;       // Number of GC pointers in object
  size_t* pointer_offsets;    // Offsets of GC pointer fields
  void (*finalizer)(void*);   // Optional finalizer function
} YoTypeDescriptor;
```

**Example:**
```yo
Node :: object(
  value: i32,        // Offset 0, not a pointer
  next: Option(Node) // Offset 8 (after i32 + padding), is a pointer
);

// Generated type descriptor:
static size_t Node_pointer_offsets[] = { 8 };
static YoTypeDescriptor Node_descriptor = {
  .name = "Node",
  .size = 16,  // i32 (4) + padding (4) + pointer (8)
  .pointer_count = 1,
  .pointer_offsets = Node_pointer_offsets,
  .finalizer = NULL
};
```

### Allocation

```c
void* yo_gc_alloc(YoTypeDescriptor* type_desc) {
  size_t total_size = sizeof(YoGCHeader) + type_desc->size;
  
  void* mem = malloc(total_size);  // Or bump allocator
  YoGCHeader* header = (YoGCHeader*)mem;
  
  header->mark_bits = WHITE;
  header->type_tag = OBJECT_TAG;
  header->size = type_desc->size;
  header->type_info = type_desc;
  
  return (void*)(header + 1);  // Return pointer after header
}
```

## Stack Scanning and GC Roots

### GC Roots

**GC roots are starting points for reachability analysis:**

1. **Stack variables**: Local variables in all thread stacks
2. **Global variables**: Module-level bindings
3. **Registers**: CPU registers (during stack scanning)

### Stack Scanning Strategies

**Problem**: When compiling to C, we don't have built-in stack maps showing pointer locations.

Languages handle this in different ways:

#### **Approach 1: Conservative Stack Scanning (Recommended for Phase 1)**

**Used by**: D language, Boehm GC (C/C++), early Go versions

**Strategy**: Scan entire stack and treat anything that looks like a heap pointer as a pointer.

```c
void scan_stack_conservative(void* stack_bottom, void* stack_top) {
  // Align to pointer size
  uintptr_t* p = (uintptr_t*)((uintptr_t)stack_top & ~(sizeof(void*) - 1));
  uintptr_t* end = (uintptr_t*)stack_bottom;
  
  for (; p < end; p++) {
    void* potential_ptr = (void*)*p;
    
    // Check if this looks like a valid heap pointer
    if (is_pointer_aligned(potential_ptr) && 
        is_in_heap_bounds(potential_ptr) &&
        is_valid_gc_object(potential_ptr)) {
      mark_gray(potential_ptr);
    }
  }
}

bool is_pointer_aligned(void* ptr) {
  return ((uintptr_t)ptr & (sizeof(void*) - 1)) == 0;
}

bool is_in_heap_bounds(void* ptr) {
  return ptr >= heap_start && ptr < heap_end;
}

bool is_valid_gc_object(void* ptr) {
  // Check if pointer points to valid GC object header
  YoGCHeader* header = (YoGCHeader*)ptr - 1;
  return header->type_tag == OBJECT_TAG;  // Validate magic number
}
```

**Pros:**
- ✅ Simple to implement (Phase 1)
- ✅ Works immediately with C interop
- ✅ No compiler changes needed
- ✅ Battle-tested (Boehm GC: 30+ years, D language: 20+ years)
- ✅ False positives are rare in practice (<1% memory overhead)

**Cons:**
- ⚠️ May keep some garbage alive (if integers look like pointers)
- ⚠️ Can't move objects during compaction (pointers might be disguised integers)

**Why this works well:**
- Most stack values are small integers, not heap addresses
- Heap is allocated in specific address ranges, easy to check bounds
- Object headers can be validated to reduce false positives
- False positives only delay collection, don't break correctness

#### **Approach 2: Shadow Stack (Explicit Root Tracking)**

**Used by**: Some LLVM-based runtimes, WebAssembly GCs

**Strategy**: Maintain a separate stack tracking all GC pointers.

```c
typedef struct ShadowStackFrame {
  struct ShadowStackFrame* prev;
  void** roots;     // Array of pointers to GC objects in this frame
  size_t num_roots;
} ShadowStackFrame;

__thread ShadowStackFrame* shadow_stack_top = NULL;

// Generated code for function with GC pointers:
void example_function() {
  // Setup shadow frame
  ShadowStackFrame frame;
  void* roots[2];  // This function has 2 GC-allocated locals
  frame.prev = shadow_stack_top;
  frame.roots = roots;
  frame.num_roots = 2;
  shadow_stack_top = &frame;
  
  // Function body
  YoNode* node1 = yo_gc_alloc(...);
  YoNode* node2 = yo_gc_alloc(...);
  roots[0] = &node1;  // Register with shadow stack
  roots[1] = &node2;
  
  // ... use node1, node2 ...
  
  // Cleanup on exit
  shadow_stack_top = frame.prev;
}

// GC scans shadow stack instead of real stack
void scan_shadow_stack() {
  for (ShadowStackFrame* frame = shadow_stack_top; 
       frame != NULL; 
       frame = frame->prev) {
    for (size_t i = 0; i < frame->num_roots; i++) {
      mark_gray(*frame->roots[i]);
    }
  }
}
```

**Pros:**
- ✅ Precise - no false positives
- ✅ Enables moving/compacting GC
- ✅ Can track exact pointer types

**Cons:**
- ❌ Overhead on every function call (~5-10% slowdown)
- ❌ Complex codegen (track all GC pointers)
- ❌ More code size (frame setup/teardown)

#### **Approach 3: Compiler-Generated Stack Maps (Precise)**

**Used by**: Modern Go, Java HotSpot, .NET CoreCLR

**Strategy**: Compiler generates metadata describing pointer locations at every GC safepoint.

```typescript
// Compiler generates:
interface StackMap {
  functionName: string;
  instructionOffset: number;   // PC offset within function
  stackSize: number;
  pointerOffsets: number[];    // Offsets of GC pointers on stack
}

// Example generated metadata:
const stackMaps: StackMap[] = [
  {
    functionName: "process_nodes",
    instructionOffset: 42,  // After call to yo_gc_alloc
    stackSize: 64,
    pointerOffsets: [8, 16, 24]  // node1 at [rbp-8], node2 at [rbp-16], etc.
  }
];
```

**Generated C with embedded metadata:**
```c
// Compiler emits stack map metadata
static YoStackMap process_nodes_maps[] = {
  { .pc_offset = 42, .num_pointers = 3, .offsets = {8, 16, 24} }
};

void process_nodes() {
  YoNode* node1;  // [rbp-8]
  YoNode* node2;  // [rbp-16]
  YoNode* node3;  // [rbp-24]
  
  // Safepoint: GC can scan using stack map
  yo_safepoint();  // GC knows exactly where pointers are
  
  // ...
}
```

**Pros:**
- ✅ Precise - no false positives
- ✅ Enables moving/compacting GC
- ✅ Zero runtime overhead (no shadow stack)
- ✅ Minimal memory overhead (compact metadata)

**Cons:**
- ❌ Complex compiler implementation
- ❌ Requires tracking all GC allocation sites
- ❌ Harder to debug (metadata correctness)
- ❌ More maintenance burden

### **Recommended Strategy for Yo**

**Phase 1**: Start with **conservative scanning** (like D/Boehm)
- Simple, proven, works with C interop
- Get GC working quickly
- Measure actual false positive rate

**Phase 2**: Add **hybrid approach**
- Conservative scanning by default
- Optional precise tracking for performance-critical code
- Compiler flag: `--precise-gc` for stack maps

**Phase 3**: Full **precise stack maps** (if needed)
- Only implement if profiling shows conservative scanning is a bottleneck
- Most programs won't need this

**Rationale**: 
- D language has used conservative scanning successfully for 20+ years
- Boehm GC is widely used in production C/C++ code
- False positives are rare in practice (typically <1% of heap)
- Simplicity enables faster development and easier debugging

## Concurrency Model with GC

### Work-Stealing Enabled

**With GC, tasks can migrate between threads freely:**

```yo
// Work-stealing scheduler
Scheduler :: object(
  workers: [Worker],
  global_queue: Queue(Task)
);

Worker :: object(
  id: usize,
  local_queue: Deque(Task),  // Can steal from other workers
  scheduler: &Scheduler
);

Task :: object(
  closure: fn() -> unit,  // GC-managed closure
  state: TaskState
);

// Worker can steal tasks from others
fn worker_run(worker: Worker) -> unit {
  loop({
    task_opt := worker.local_queue.pop();
    
    task := cond(
      match(task_opt,
        .Some(t) => t,
        .None => {
          // Try to steal from other workers
          steal_task(worker)  // ✅ Works because tasks are GC'd!
        }
      )
    );
    
    execute_task(task);
  });
}
```

**Key insight**: GC objects don't have thread affinity, so stealing work is safe!

### Per-Thread Allocation Buffers

**Reduce allocation contention with thread-local allocation:**

```c
typedef struct {
  void* buffer_start;
  void* buffer_end;
  void* bump_ptr;
} ThreadLocalBuffer;

__thread ThreadLocalBuffer tlab;

void* yo_gc_alloc_fast(size_t size) {
  void* ptr = tlab.bump_ptr;
  void* new_ptr = ptr + size;
  
  if (new_ptr <= tlab.buffer_end) {
    tlab.bump_ptr = new_ptr;
    return ptr;  // Fast path: no synchronization!
  }
  
  return yo_gc_alloc_slow(size);  // Slow path: refill buffer
}
```

### GC Safepoints

**Threads must reach safepoints for GC to scan their stacks:**

```c
// Insert safepoint checks at:
// - Function entry
// - Loop back-edges
// - Long-running operations

void yo_safepoint() {
  if (gc_requested) {
    // Stop at safepoint, let GC scan our stack
    park_for_gc();
  }
}
```

**Code generation:**
```yo
// Source:
while cond(), {
  body();
}

// Generated C:
while (cond()) {
  yo_safepoint();  // Check for GC request
  body();
}
```

## C Interoperability

### Value Types: Zero-Cost C Interop

**Value types have C-compatible layout and can be passed to C directly:**

```yo
Point :: struct(x: i32, y: i32);

foreign fn c_draw_point(p: Point) -> unit = "draw_point";

p := Point(x: 10, y: 20);
c_draw_point(p);  // ✅ Passed directly, no conversion needed
```

**Generated C:**
```c
typedef struct {
  int32_t x;
  int32_t y;
} Point;

extern void draw_point(Point p);

Point p = { .x = 10, .y = 20 };
draw_point(p);  // Direct call, zero overhead
```

### GC Types: Requires Pinning

**GC objects can move during compaction (future) or be collected, so C must not hold long-lived pointers.**

**Solution 1: Pin objects during C calls**

```yo
Node :: object(value: i32, next: Option(Node));

foreign fn c_process_node(node: &Node) -> unit = "process_node";

node := Node(value: 42, next: .None);
c_process_node(___pin(node));  // Pin during C call
```

**Generated C:**
```c
YoNode* node = yo_gc_alloc(&YoNode_descriptor);
yo_gc_pin(node);              // Prevent collection
process_node(node);           // C can safely use pointer
yo_gc_unpin(node);            // Allow collection again
```

**Solution 2: Copy to C-compatible format**

```yo
// For complex GC objects, copy to value type
NodeData :: struct(value: i32, has_next: boolean);

fn node_to_data(node: Node) -> NodeData {
  NodeData(
    value: node.value,
    has_next: match(node.next, .Some(_) => true, .None => false)
  )
}

foreign fn c_process(data: NodeData) -> unit = "process";

c_process(node_to_data(my_node));  // Safe: value type copy
```

**Rule**: Never pass GC pointers to C functions that store them long-term. Either pin, copy, or use handles.

## Cycle Collection

**GC naturally collects cycles - no special handling needed:**

```yo
// Create a cycle
a := Node(value: 1, next: .None);
b := Node(value: 2, next: .Some(a));
a.next = .Some(b);  // a -> b -> a (cycle!)

// Drop references
a = Node(value: 0, next: .None);
b = Node(value: 0, next: .None);

// ✅ GC will collect the cycle automatically
```

**No need for weak pointers in most cases**, but can still provide them for performance:

```yo
Weak(T) :: struct(
  ptr: *const T,  // Raw pointer, not traced by GC
  generation: usize  // To detect if object was collected
);
```

## Performance Characteristics

### GC Overhead Breakdown

**Allocation:**
- Fast path: ~5-10 cycles (TLAB bump allocation)
- Slow path: ~100-500 cycles (refill TLAB or fallback)

**Write Barrier:**
- ~5-10 cycles per GC pointer write (only during mark phase)
- Zero overhead when GC is not running

**Collection Pause:**
- Root scan: 0.1-1ms per thread (stack scanning)
- Sync pause: <0.1ms (write barrier sync)
- Concurrent mark/sweep: No pause (runs alongside mutators)

**Total pause time: <2ms for typical workloads**

### Memory Overhead

**Per-object overhead:**
- GC header: 16 bytes per object
- Type descriptor: Shared across all objects of same type

**Heap overhead:**
- GC typically keeps heap at 2x live data size
- Configurable: trade memory for fewer collections

**Example:**
```
100 MB live data → 200 MB heap size → 100 MB overhead
```

## Implementation Strategy

### Phase 1: Basic Mark-Sweep GC

**Minimal viable GC:**

1. ✅ Simple stop-the-world mark-sweep
2. ✅ Conservative stack scanning
3. ✅ No write barriers (pause during mark)
4. ✅ Single-threaded GC
5. ✅ Manual GC trigger or allocation threshold

**Goals:**
- Prove GC works with hybrid type system
- Enable work-stealing concurrency
- Establish baseline performance

### Phase 2: Concurrent GC

**Add concurrency:**

1. ✅ Tri-color marking with write barriers
2. ✅ Concurrent mark and sweep
3. ✅ Multiple GC threads
4. ✅ Safepoints for stack scanning
5. ✅ Per-thread allocation buffers (TLABs)

**Goals:**
- Reduce pause times to <2ms
- Scale GC work with mutator threads
- Maintain work-stealing capability

### Phase 3: Optimizations

**Performance tuning:**

1. ✅ Precise stack maps (replace conservative scanning)
2. ✅ Generational GC (most objects die young)
3. ✅ Compacting GC (reduce fragmentation)
4. ✅ Parallel GC (multi-threaded mark/sweep)
5. ✅ Write barrier elision (escape analysis)

**Goals:**
- Minimize GC overhead
- Reduce memory footprint
- Optimize for common allocation patterns

## Migration Path from Biased RC

### Code Changes Required

**1. Remove all RC operations:**

```yo
// Before (with RC):
x := point;  // ___dup(point)
// ___drop(x) at scope exit

// After (with GC):
x := point;  // Just copy pointer, no dup
// No drop needed
```

**2. Update type definitions:**

```yo
// No change needed! Syntax stays the same:
Node :: object(value: i32, next: Option(Node));

// But semantics change:
// - Before: RC-managed, thread-affine
// - After: GC-managed, no thread affinity
```

**3. Remove `own()` keyword:**

```yo
// Before:
fn consume(own(x): Node) -> unit { ... }  // Takes ownership

// After:
fn consume(x: Node) -> unit { ... }  // Just passes reference
```

**4. Replace deterministic destructors for GC types:**

```yo
// Before (WRONG with GC):
File :: object(
  fd: i32,
  ___drop: fn(self: &mut Self) -> unit = { close(self.fd); }  // Non-deterministic!
);

// After (CORRECT):
FileHandle :: struct(  // Value type!
  fd: i32,
  ___drop: fn(self: &mut Self) -> unit = { close(self.fd); }  // Deterministic!
);
```

### Compiler Changes Required

**1. Remove RC code generation:**
- Remove `___dup` calls on assignment
- Remove `___drop` calls at scope exit
- Remove `isOwningTheSameARCValueAs` tracking
- Remove biased RC infrastructure

**2. Add GC infrastructure:**
- Generate type descriptors for all GC types
- Emit `yo_gc_alloc` calls for object/closure/dyn creation
- Insert write barriers on GC pointer writes
- Insert safepoint checks in loops and function calls

**3. Update codegen:**
```typescript
// Before:
emitAssignment(lhs, rhs) {
  emit(`___dup(${rhs});`);
  emit(`${lhs} = ${rhs};`);
}

// After:
emitAssignment(lhs, rhs) {
  if (isGCPointer(lhs)) {
    emit(`___write_barrier(&${lhs}, ${rhs});`);
  }
  emit(`${lhs} = ${rhs};`);
}
```

### Runtime Changes Required

**1. Replace mimalloc with GC allocator:**
- Implement GC heap management
- Add mark-sweep algorithm
- Add write barrier support

**2. Update concurrency runtime:**
- Remove thread affinity from task scheduler
- Implement work-stealing scheduler
- Add GC safepoint support to async runtime

**3. Add GC runtime API:**
```c
void* yo_gc_alloc(YoTypeDescriptor* type_desc);
void yo_gc_write_barrier(void** slot, void* value);
void yo_gc_collect(void);
void yo_gc_pin(void* ptr);
void yo_gc_unpin(void* ptr);
```

## Comparison: RC vs GC

### Reference Counting (Current)

**Pros:**
- ✅ Deterministic destructors (RAII)
- ✅ Predictable memory usage
- ✅ No GC pauses
- ✅ Simple mental model (ownership)

**Cons:**
- ❌ Overhead on every mutation (dup/drop)
- ❌ Atomic operations in multithreading
- ❌ Cannot handle cycles (needs weak pointers)
- ❌ Thread affinity (no work-stealing)
- ❌ Complex optimization (biased RC)

### Garbage Collection (Proposed)

**Pros:**
- ✅ Zero mutation overhead (no dup/drop)
- ✅ Work-stealing concurrency enabled
- ✅ Handles cycles naturally
- ✅ Simpler code generation
- ✅ Better throughput for allocation-heavy code

**Cons:**
- ❌ Non-deterministic destructors (no RAII for GC types)
- ❌ GC pauses (~2ms with concurrent GC)
- ❌ Higher memory usage (2x live data)
- ❌ Write barrier overhead during GC
- ❌ More complex runtime

### Recommendation

**Use GC if:**
- Work-stealing concurrency is critical
- High allocation rate (many short-lived objects)
- Cyclic data structures are common
- Pause times <2ms are acceptable
- RAII is not required for most types

**Use RC if:**
- Deterministic destructors are essential (RAII everywhere)
- Predictable latency is critical (no pauses)
- Memory usage must be minimal
- Thread affinity is acceptable
- Allocation rate is moderate

## Summary

This GC design for Yo provides:

1. **Hybrid type system** - Value types (C-compatible) + GC types (heap-managed)
2. **Work-stealing concurrency** - No thread affinity, tasks can migrate
3. **Low pause times** - Concurrent mark-sweep with <2ms pauses
4. **C interoperability** - Value types have zero-cost interop, GC types use pinning
5. **Simple mental model** - Reachability-based collection, no ownership tracking

**The key trade-off**: Lose deterministic destructors for GC types, gain work-stealing and zero mutation overhead.

**Next steps:**
1. Implement Phase 1 (basic mark-sweep GC)
2. Update concurrency runtime to use work-stealing
3. Benchmark against RC implementation
4. Add concurrent GC (Phase 2) if pause times are too high
