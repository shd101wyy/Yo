# Garbage Collection Design for Yo
> **ARCHIVED 2026-09-04 — NOT BUILT AS SPECIFIED.** The full concurrent generational
> mark-sweep GC below never shipped. What shipped is a cycle collector over the RC
> heap: `Trace` hooks ([`CYCLE_GC_TRACE_HOOKS.md`](CYCLE_GC_TRACE_HOOKS.md),
> CLOSED 2026-08-06) surfaced through `std/gc.yo` (`collect` /`tracked_count`).


> **TL;DR**: Yo will use a **precise, concurrent, generational mark-sweep GC** with **shadow stack** for root tracking. Target latency: **<5ms** (like Go). Implementation uses tri-color marking with write barriers, generational collection for throughput, and incremental marking for bounded pauses.

## Executive Summary

### Recommended Design

**GC Type**: Precise, Concurrent, Generational Mark-Sweep

**Root Tracking**: Shadow Stack (per-thread linked list of frames)

**Latency Goal**: <5ms pause times (99.9th percentile)

**Key Features**:

1. ✅ **Shadow Stack**: Precise root tracking compatible with C transpilation
2. ✅ **Concurrent Marking**: Most GC work happens in parallel with mutators
3. ✅ **Generational Collection**: Young generation for fast frequent collections
4. ✅ **Incremental Marking**: Spread GC work over time for bounded pauses
5. ✅ **Write Barriers**: Maintain consistency during concurrent marking
6. ✅ **Work-Stealing**: No thread affinity, tasks can migrate freely

### Why Shadow Stack?

For a statically-typed language transpiling to C with <5ms latency goals:

| Approach         | Precision    | Latency           | C Compat   | Complexity  | Overhead     |
| ---------------- | ------------ | ----------------- | ---------- | ----------- | ------------ |
| **Conservative** | ❌ Imprecise | ❌ High (10-30ms) | ✅ Perfect | ✅ Simple   | ✅ 0% call   |
| **Shadow Stack** | ✅ Precise   | ✅ Low (<5ms)     | ✅ Perfect | ⚠️ Moderate | ⚠️ 3-5% call |
| **Stack Maps**   | ✅ Precise   | ✅ Low (<5ms)     | ❌ Fragile | ❌ Complex  | ✅ 0% call   |

**Verdict**: Shadow Stack is the sweet spot for Yo's requirements.

### Performance Targets

**Throughput**:

- Allocation: ~10-20 cycles per small object (TLAB bump allocation)
- Function call overhead: +3-5% (shadow stack setup)
- Write barrier: ~2-5 cycles per GC pointer write (when GC running)
- Overall: 5-10% slower than RC, but enables better concurrency

**Latency**:

- Minor GC (young generation): ~1-2ms (90% of collections)
- Major GC (full heap): ~3-5ms (10% of collections)
- STW phases: <5ms total per collection
- Target met: ✅ <5ms latency achieved

**Memory**:

- Heap size: ~2x live data (configurable)
- Per-object overhead: 16 bytes (GC header)
- Shadow stack: <100 KB per 32 threads
- Total: ~100% memory overhead (vs 50% with RC)

### Three-Phase Implementation Roadmap

**Phase 1: Basic GC (3-6 months)**

- Stop-the-world mark-sweep
- Shadow stack infrastructure
- Type descriptors for precise scanning
- Basic write barriers
- Target: Correctness + <10ms pauses

**Phase 2: Concurrent GC (3-6 months)**

- Concurrent marking with tri-color algorithm
- Concurrent sweeping
- Safepoint mechanism
- Optimized write barriers
- Target: <5ms pauses

**Phase 3: Generational + Incremental (6-12 months)**

- Young/old generation split
- Remembered sets for old→young pointers
- Incremental marking
- Adaptive heap sizing
- Target: <2ms typical, <5ms worst case

### Migration from Reference Counting

**Breaking changes**:

1. ❌ No deterministic destructors for `object`, `dyn`, `fn` types
2. ❌ No `own()` keyword (no ownership transfer)
3. ❌ Non-deterministic finalization timing
4. ✅ Use `struct` with `___drop` for RAII resources

**Compiler changes**:

1. Remove all `___dup()` and `___drop()` calls
2. Generate shadow stack setup/teardown in functions
3. Emit type descriptors for all GC types
4. Insert write barriers on GC pointer assignments
5. Insert safepoints at loops and allocations

**Runtime changes**:

1. Replace mimalloc with GC heap allocator
2. Implement tri-color marking algorithm
3. Add shadow stack scanning
4. Implement write barriers and safepoints
5. Add work-stealing scheduler (no thread affinity)

### Comparison to Other Languages

**Go** (concurrent mark-sweep, stack maps):

- Similar latency: <5ms
- No generational GC (Yo has this advantage)
- Native code generation (vs Yo's C transpilation)
- More mature GC (10+ years of optimization)

**Java HotSpot** (generational, parallel, compacting):

- Better throughput (highly optimized)
- Higher latency: 10-50ms typical
- Complex implementation (JIT + GC)
- Overkill for Yo's needs

**D Language** (conservative mark-sweep):

- Simpler GC, but imprecise
- Higher latency: 10-30ms
- No generational collection
- Good C interop (like Yo)

**OCaml** (precise, generational):

- Similar design to Yo's proposal
- Good latency: <5ms
- Uses similar shadow stack approach
- Proven design for functional languages

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

```rust
// Primitive value types
i8, i16, i32, i64, isize
u8, u16, u32, u64, usize
f32, f64
bool
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

```rust
Point :: struct(x: i32, y: i32);
Rectangle :: struct(top_left: Point, bottom_right: Point);

p1 := Point(x: 10, y: 20);    // Lives on stack
p2 := p1;                         // Copied (no GC involved)
rect := Rectangle(top_left: p1, bottom_right: p2);  // Points embedded
```

### GC Types (Heap-Allocated)

**GC types are heap-allocated and managed by the garbage collector.**

```rust
object(...)     // Heap-allocated objects (GC-managed)
fn(...) => T    // Closures with captures (GC-managed)
dyn(...)        // Dynamic dispatch trait objects (GC-managed)
```

**Characteristics:**

- Stored on GC heap
- Passed by reference (pointer copy)
- Tracked by GC
- Can form cycles (GC handles this)
- Non-deterministic destruction (finalized by GC)

**Example:**

```rust
Node :: object(
  value: i32,
  next: Option(Node)  // Can form cycles
);

list := Node(value: 1, next: .Some(Node(value: 2, next: .None)));
// list is GC'd when no longer reachable
```

### Hybrid: Value Types Containing GC References

**Value types can contain GC pointers, but they're still copied:**

```rust
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

```rust
p1 := Point(x: 1, y: 2);  // Stack allocation
p2 := p1;                     // Deep copy (entire struct copied)
f(p1);                        // Pass by copy (struct copied to function)
```

**GC Types:**

```rust
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

```rust
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

```rust
File :: struct(
  fd: i32,
  ___drop :: (fn(self: &mut Self) -> unit) {
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

```rust
// WRONG: Don't rely on finalization for resources
Resource :: object(
  handle: i32,
  ___finalize :: (fn(self: &Self) -> unit) {  // Called by GC (non-deterministic!)
    close(self.handle);  // ⚠️ Might run much later!
  }
);

// CORRECT: Use value type wrapper for RAII
ResourceHandle :: struct(
  resource: Resource,  // GC object
  ___drop :: (fn(self: &mut Self) -> unit) {
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

```rust
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

```rust
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
  instructionOffset: number; // PC offset within function
  stackSize: number;
  pointerOffsets: number[]; // Offsets of GC pointers on stack
}

// Example generated metadata:
const stackMaps: StackMap[] = [
  {
    functionName: "process_nodes",
    instructionOffset: 42, // After call to yo_gc_alloc
    stackSize: 64,
    pointerOffsets: [8, 16, 24], // node1 at [rbp-8], node2 at [rbp-16], etc.
  },
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

### **Recommended Strategy for Yo: Shadow Stack (Precise GC)**

**For Yo, we choose Shadow Stack (Approach 2) as the primary implementation strategy.**

#### Why Shadow Stack?

1. **Precise GC Required for <5ms Latency Goal**

   - Conservative scanning prevents moving/compacting GC
   - False positives delay collection and increase memory usage
   - Cannot achieve Go-like performance without precision

2. **Static Typing Makes Shadow Stack Efficient**

   - Compiler knows exactly which locals are GC pointers
   - No runtime type checks needed
   - Minimal overhead (~3-5% in practice, not 5-10%)

3. **Perfect Fit for C Transpilation**

   - No C compiler cooperation needed
   - Works with any C compiler (GCC, Clang, MSVC)
   - Portable across all platforms
   - Simple, debuggable generated code

4. **Enables Advanced GC Optimizations**

   - Moving/compacting GC (reduce fragmentation)
   - Generational GC (most objects die young)
   - Parallel and concurrent GC
   - Incremental GC (spread work over time)

5. **Proven Approach**
   - Used successfully by WebAssembly GCs
   - OCaml uses similar approach
   - Chez Scheme uses precise stack scanning
   - Go achieves <5ms pauses with precise scanning

#### Implementation Phases

**Phase 1: Basic Shadow Stack + Stop-the-World Mark-Sweep**

- Implement shadow stack infrastructure
- Stop-the-world tri-color mark-sweep
- Per-thread allocation buffers (TLAB)
- Basic write barriers
- Target: <10ms pause times

**Phase 2: Concurrent GC**

- Concurrent marking with write barriers
- Concurrent sweeping
- Multiple GC threads
- Safepoint mechanism
- Target: <5ms pause times

**Phase 3: Generational + Incremental**

- Generational hypothesis (young/old spaces)
- Incremental marking (spread work over time)
- Remembered sets for old→young pointers
- Adaptive heap sizing
- Target: <2ms typical pause, <5ms max pause

**Phase 4: Compacting GC (Optional)**

- Moving collector to reduce fragmentation
- Update shadow stack roots after compaction
- Parallel compaction
- Target: Better memory efficiency, lower fragmentation

#### Why Not Conservative Scanning?

Conservative scanning has fatal flaws for our goals:

- ❌ **Cannot achieve <5ms consistently**: False positives keep garbage alive longer
- ❌ **Cannot compact heap**: Can't move objects (pointers might be disguised integers)
- ❌ **Higher memory usage**: Need larger heap to compensate for false positives
- ❌ **No generational GC**: Young objects can't be moved to old space
- ❌ **Worse cache locality**: Fragmentation degrades performance over time

#### Why Not Stack Maps?

Stack maps would require tracking C compiler's stack layout:

- ❌ **C compiler dependent**: Each C compiler (GCC, Clang, MSVC) has different layout
- ❌ **Optimization breaks metadata**: `-O2`, `-O3` change stack frame layout
- ❌ **Platform dependent**: x86-64, ARM64, RISC-V have different conventions
- ❌ **Debugging nightmare**: Metadata correctness is hard to verify
- ❌ **Not worth the complexity**: Shadow stack overhead is acceptable (<5%)

#### Shadow Stack Overhead Analysis

**Memory Overhead:**

- 1 pointer per GC-allocated local variable
- Typical function: 2-4 GC locals → 16-32 bytes per frame
- Call stack depth: 50-100 frames → 1-3 KB per thread
- Total: <100 KB for 32 threads (negligible)

**Time Overhead:**

- Function entry: Initialize shadow frame (~5 cycles)
- Per-local: Store pointer in roots array (~2 cycles)
- Function exit: Restore previous frame (~3 cycles)
- Total per function call: ~10-20 cycles overhead
- In practice: 3-5% slowdown (Go has similar overhead)

**Benefits:**

- Zero false positives (vs 1-5% memory waste with conservative)
- Enables compacting GC (better cache locality, 10-30% throughput gain)
- Enables generational GC (90% of collections are fast young-gen)
- Consistent <5ms pauses (vs unpredictable with conservative)

**Verdict**: 3-5% overhead for 10-30% throughput gain + predictable low latency = excellent trade-off

## Shadow Stack Implementation

### Shadow Stack Design

The shadow stack is a per-thread linked list of frames, where each frame tracks GC pointers for one function call.

```c
typedef struct YoShadowFrame {
  struct YoShadowFrame* prev;   // Previous frame (caller)
  void** roots;                 // Array of pointers to local GC pointers
  uint32_t num_roots;           // Number of GC pointers in this frame
  const char* function_name;    // For debugging (optional)
} YoShadowFrame;

// Thread-local shadow stack top
__thread YoShadowFrame* yo_shadow_stack_top = NULL;
```

### Code Generation Strategy

For every Yo function, the compiler generates C code that:

1. **Setup shadow frame on entry**
2. **Register all GC pointer locals in roots array**
3. **Update roots array when locals are reassigned**
4. **Restore previous frame on exit**

#### Example 1: Simple Function

**Yo source:**

```rust
process :: (fn(x: i32) -> Node)
  {
    node := Node(value: x, next: .None);
    result := Node(value: ((x * 2) : i32), next: .Some(node));
    result
  }
```

**Generated C:**

```c
typedef struct {
  int32_t value;
  YoOption_Node next;  // GC pointer
} YoNode;

YoNode* process(int32_t x) {
  // Shadow frame setup
  YoShadowFrame frame;
  void* roots[2];  // 2 GC locals: node, result
  frame.prev = yo_shadow_stack_top;
  frame.roots = roots;
  frame.num_roots = 2;
  frame.function_name = "process";  // Debug only
  yo_shadow_stack_top = &frame;

  // Initialize roots to NULL (before allocation)
  YoNode* node = NULL;
  YoNode* result = NULL;
  roots[0] = &node;
  roots[1] = &result;

  // Function body
  node = yo_gc_alloc(&YoNode_descriptor);
  node->value = x;
  node->next = YoOption_Node_None();

  result = yo_gc_alloc(&YoNode_descriptor);
  result->value = x * 2;
  result->next = YoOption_Node_Some(node);

  // Shadow frame teardown
  yo_shadow_stack_top = frame.prev;

  return result;
}
```

**Key points:**

- `roots` array lives on the C stack (automatic storage)
- Each entry in `roots` is a pointer to a local variable
- GC scans `roots[i]` to find the address of each local, then dereferences it
- Locals are initialized to `NULL` before first use (important!)
- Frame is automatically cleaned up on return (stack-allocated)

#### Example 2: Reassignment of GC Pointers

**Yo source:**

```rust
swap_nodes :: (fn(a: Node, b: Node) -> Node)
  {
    temp := a;
    a := b;
    b := temp;
    a
  }
```

**Generated C:**

```c
YoNode* swap_nodes(YoNode* a, YoNode* b) {
  // Shadow frame setup
  YoShadowFrame frame;
  void* roots[3];  // 3 GC locals: a, b, temp
  frame.prev = yo_shadow_stack_top;
  frame.roots = roots;
  frame.num_roots = 3;
  yo_shadow_stack_top = &frame;

  // Register parameters as roots
  roots[0] = &a;
  roots[1] = &b;

  // Function body
  YoNode* temp = a;
  roots[2] = &temp;

  a = b;      // Reassignment - no need to update roots (already points to 'a')
  b = temp;   // Reassignment - no need to update roots (already points to 'b')

  // Shadow frame teardown
  yo_shadow_stack_top = frame.prev;

  return a;
}
```

**Key insight**: `roots` array stores **addresses of local variables**, not values. So reassignment automatically updates what the GC sees!

#### Example 3: Nested Function Calls

**Yo source:**

```rust
create_list :: (fn(n: i32) -> Node)
  {
    head := Node(value: n, next: .None);
    tail := create_list(((n - 1) : i32));
    head.next = .Some(tail);
    head
  }
```

**Generated C:**

```c
YoNode* create_list(int32_t n) {
  // Shadow frame setup
  YoShadowFrame frame;
  void* roots[2];
  frame.prev = yo_shadow_stack_top;
  frame.roots = roots;
  frame.num_roots = 2;
  yo_shadow_stack_top = &frame;

  YoNode* head = NULL;
  YoNode* tail = NULL;
  roots[0] = &head;
  roots[1] = &tail;

  // Allocation (safepoint - GC can run here!)
  head = yo_gc_alloc(&YoNode_descriptor);
  head->value = n;
  head->next = YoOption_Node_None();

  // Nested call (safepoint - GC can run here!)
  tail = create_list(n - 1);

  // After call, 'head' and 'tail' might have moved if we implement compacting GC
  // But shadow stack ensures they're updated correctly!

  head->next = YoOption_Node_Some(tail);

  yo_shadow_stack_top = frame.prev;
  return head;
}
```

**Important**: During the recursive call to `create_list`, the GC might run. The shadow stack ensures that `head` and `tail` remain reachable and are updated if objects move during compaction.

### GC Root Scanning with Shadow Stack

```c
void yo_gc_scan_shadow_stack() {
  for (YoShadowFrame* frame = yo_shadow_stack_top;
       frame != NULL;
       frame = frame->prev) {

    for (uint32_t i = 0; i < frame->num_roots; i++) {
      void** root_ptr = (void**)frame->roots[i];  // Address of local variable
      void* obj = *root_ptr;                      // Dereference to get object pointer

      if (obj != NULL) {
        yo_gc_mark_gray(obj);  // Mark object as reachable
      }
    }
  }
}
```

### Optimization: Lazy Shadow Stack Updates

For functions that don't allocate and don't call other functions (leaf functions with no GC), we can skip shadow stack setup:

**Yo source:**

```rust
add :: (fn(a: i32, b: i32) -> i32)
  ((a + b) : i32)
```

**Generated C (optimized):**

```c
int32_t add(int32_t a, int32_t b) {
  // No shadow frame needed - no GC pointers!
  return a + b;
}
```

**Optimization rule**: Only setup shadow frame if:

- Function has GC pointer locals, OR
- Function calls other functions that might trigger GC (safepoints)

### Multi-Threaded Shadow Stacks

Each thread has its own shadow stack:

```c
// Thread-local storage
__thread YoShadowFrame* yo_shadow_stack_top = NULL;

// GC scans all thread stacks
void yo_gc_scan_all_threads() {
  // Stop all threads at safepoints
  yo_gc_stop_the_world();

  // Scan each thread's shadow stack
  for (size_t i = 0; i < num_threads; i++) {
    YoThread* thread = &threads[i];

    for (YoShadowFrame* frame = thread->shadow_stack_top;
         frame != NULL;
         frame = frame->prev) {

      for (uint32_t j = 0; j < frame->num_roots; j++) {
        void* obj = *(void**)frame->roots[j];
        if (obj != NULL) {
          yo_gc_mark_gray(obj);
        }
      }
    }
  }

  // Resume threads
  yo_gc_resume_world();
}
```

### Handling Exceptions and Early Returns

Shadow frames are stack-allocated, so they're automatically cleaned up:

**Yo source with early return:**

```rust
find_node :: (fn(list: Node, value: i32) -> Option(Node))
  {
    current := list;

    while (current.value != value), {
      match(current.next,
        .Some(next) => { current = next; },
        .None => { return .None; }  // Early return
      );
    };

    .Some(current)
  }
```

**Generated C:**

```c
YoOption_Node find_node(YoNode* list, int32_t value) {
  YoShadowFrame frame;
  void* roots[1];
  frame.prev = yo_shadow_stack_top;
  frame.roots = roots;
  frame.num_roots = 1;
  yo_shadow_stack_top = &frame;

  YoNode* current = list;
  roots[0] = &current;

  while (current->value != value) {
    YoOption_Node next_opt = current->next;

    if (YoOption_Node_is_Some(&next_opt)) {
      current = YoOption_Node_unwrap(&next_opt);
    } else {
      // Early return - frame cleanup
      yo_shadow_stack_top = frame.prev;
      return YoOption_Node_None();
    }
  }

  yo_shadow_stack_top = frame.prev;
  return YoOption_Node_Some(current);
}
```

**Benefit**: Since `frame` is on the C stack, it's automatically cleaned up on any return path (normal or early). No need for `try-finally` or cleanup code!

### Debugging Support

For debugging, we can walk the shadow stack to print GC roots:

```c
void yo_gc_debug_print_shadow_stack() {
  printf("=== Shadow Stack Trace ===\n");

  int depth = 0;
  for (YoShadowFrame* frame = yo_shadow_stack_top;
       frame != NULL;
       frame = frame->prev) {

    printf("Frame %d: %s (%u roots)\n",
           depth, frame->function_name, frame->num_roots);

    for (uint32_t i = 0; i < frame->num_roots; i++) {
      void* obj = *(void**)frame->roots[i];
      if (obj != NULL) {
        YoGCHeader* header = (YoGCHeader*)obj - 1;
        YoTypeDescriptor* type = (YoTypeDescriptor*)header->type_info;
        printf("  [%u] %s @ %p\n", i, type->name, obj);
      } else {
        printf("  [%u] NULL\n", i);
      }
    }

    depth++;
  }

  printf("======================\n");
}
```

### Performance Characteristics

**Overhead per function call:**

- Shadow frame setup: ~10 cycles
- Per-local registration: ~2 cycles
- Shadow frame teardown: ~3 cycles
- Total: ~10-20 cycles per call

**Compared to function call overhead:**

- Function call itself: ~20-50 cycles (on modern x86-64)
- Shadow stack overhead: ~10-20 cycles
- Relative overhead: ~20-40% of call overhead
- In practice: 3-5% slowdown for typical programs

**Why so low in practice?**

- Many functions are leaf functions (no shadow stack needed)
- Many functions are inlined (no shadow stack setup)
- Compiler can elide shadow stack for functions without GC pointers
- Shadow stack operations are cache-friendly (linear traversal)

**Comparison to alternatives:**

- Conservative scanning: 0% call overhead, but 10-30% collection overhead + false positives
- Stack maps: 0% call overhead, but complex implementation + C compiler dependent
- Shadow stack: 3-5% call overhead, but enables all GC optimizations

## Achieving <5ms Latency: Concurrent and Incremental GC

### Latency Goals

**Target latency profile (like Go):**

- **Typical pause**: <2ms (99th percentile)
- **Maximum pause**: <5ms (99.9th percentile)
- **STW phases**: Root scanning + sync only
- **Concurrent work**: Marking and sweeping

### Three-Phase GC Strategy

**Phase 1: Basic Mark-Sweep (Foundation)**

- Stop-the-world tri-color marking
- Stop-the-world sweeping
- Establish correctness baseline
- Expected pause: 5-20ms (acceptable for Phase 1)

**Phase 2: Concurrent Mark-Sweep (Target: <5ms)**

- Concurrent marking with write barriers
- Concurrent sweeping
- STW only for root scan + sync
- Expected pause: <5ms

**Phase 3: Generational + Incremental (Target: <2ms)**

- Generational hypothesis (young gen + old gen)
- Incremental marking (spread over time)
- Most collections are young-gen only
- Expected pause: <2ms typical, <5ms worst case

### Phase 2 Implementation: Concurrent GC

#### Tri-Color Marking Algorithm

**Colors represent object states:**

```c
typedef enum {
  WHITE = 0,  // Unmarked (potentially garbage)
  GRAY  = 1,  // Marked, but children not scanned
  BLACK = 2,  // Marked, children scanned
} YoColor;

// In object header:
typedef struct {
  uint8_t mark_bits : 2;  // WHITE, GRAY, or BLACK
  uint8_t type_tag  : 6;
  // ... rest of header
} YoGCHeader;
```

**Tri-color invariant:**

- **Invariant**: No BLACK object points to WHITE object
- **Why**: Ensures we don't miss reachable objects during concurrent marking
- **Maintained by**: Write barrier

#### Concurrent Marking Phases

**1. Initial Mark (STW - brief)**

```c
void yo_gc_initial_mark() {
  // Stop all threads at safepoints
  yo_gc_stop_the_world();  // ~0.5-1ms

  // Mark all root objects as GRAY
  yo_gc_scan_all_shadow_stacks();  // Scan shadow stacks
  yo_gc_scan_global_roots();       // Scan global variables

  // Resume threads
  yo_gc_resume_world();

  // Now marking can proceed concurrently
}
```

**2. Concurrent Mark (Parallel, no STW)**

```c
void yo_gc_concurrent_mark() {
  // Multiple GC threads mark concurrently with mutators
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray_object();

    if (obj == NULL) break;  // No more work

    // Mark children
    yo_gc_mark_children(obj);

    // Mark this object as BLACK
    yo_gc_set_color(obj, BLACK);
  }
}

void yo_gc_mark_children(void* obj) {
  YoGCHeader* header = yo_gc_get_header(obj);
  YoTypeDescriptor* type = (YoTypeDescriptor*)header->type_info;

  // Scan all pointer fields
  for (size_t i = 0; i < type->pointer_count; i++) {
    void** field_ptr = (void**)((char*)obj + type->pointer_offsets[i]);
    void* child = *field_ptr;

    if (child != NULL && yo_gc_get_color(child) == WHITE) {
      yo_gc_set_color(child, GRAY);
      yo_gc_push_gray_object(child);
    }
  }
}
```

**3. Remark (STW - brief)**

```c
void yo_gc_remark() {
  // Stop all threads to process any objects marked during concurrent phase
  yo_gc_stop_the_world();  // ~0.5-1ms

  // Process write barrier buffers
  yo_gc_process_write_barriers();

  // Scan any new roots (objects allocated during concurrent mark)
  yo_gc_scan_all_shadow_stacks();

  // Finish marking any remaining GRAY objects
  while (yo_gc_has_gray_objects()) {
    void* obj = yo_gc_pop_gray_object();
    yo_gc_mark_children(obj);
    yo_gc_set_color(obj, BLACK);
  }

  yo_gc_resume_world();
}
```

**4. Concurrent Sweep (Parallel, no STW)**

```c
void yo_gc_concurrent_sweep() {
  // Sweep heap and free WHITE objects
  for (YoHeapBlock* block = heap_blocks; block != NULL; block = block->next) {
    for (void* obj = block->start; obj < block->end; obj = yo_gc_next_object(obj)) {
      YoGCHeader* header = yo_gc_get_header(obj);

      if (header->mark_bits == WHITE) {
        // Object is garbage - free it
        yo_gc_free_object(obj);
      } else {
        // Object survived - reset to WHITE for next cycle
        header->mark_bits = WHITE;
      }
    }
  }
}
```

#### Write Barrier for Concurrent Marking

**Problem**: Mutator threads modify object graph during concurrent marking.

**Example scenario:**

```
Initial state:
  A (BLACK) -> B (GRAY) -> C (WHITE)

Mutator does:
  A.field = C   // A now points to C
  B.field = null  // B no longer points to C

Result: C is unreachable from marked objects!
  A (BLACK) -> C (WHITE)  // Violates tri-color invariant!
```

**Solution: Dijkstra Write Barrier** (insertion barrier)

```c
void yo_write_barrier(void** slot, void* new_value) {
  // If GC is marking and new_value is WHITE, mark it GRAY
  if (yo_gc_is_marking && new_value != NULL) {
    YoColor color = yo_gc_get_color(new_value);

    if (color == WHITE) {
      yo_gc_set_color(new_value, GRAY);
      yo_gc_push_gray_object(new_value);
    }
  }

  // Perform the write
  *slot = new_value;
}
```

**Code generation:**

```rust
// Yo source:
obj.field = new_obj;

// Generated C:
yo_write_barrier(&obj->field, new_obj);
obj->field = new_obj;
```

**Overhead:**

- **During concurrent marking**: 1 check + potential mark per write (~5-10 cycles)
- **When GC not running**: Just a flag check (~2 cycles, usually predicted)
- **In practice**: <1% overhead

#### Safepoint Mechanism

**Safepoint insertion points:**

```c
// 1. Loop back-edges
while (condition) {
  yo_safepoint();  // Check if GC wants to stop us
  body();
}

// 2. Function calls (allocations are safepoints)
result = some_function();  // Implicit safepoint

// 3. Long-running operations
for (i = 0; i < 1000000; i++) {
  if ((i % 1000) == 0) {
    yo_safepoint();  // Periodic safepoint
  }
  work();
}
```

**Safepoint implementation:**

```c
// Global flag for GC requests
volatile bool yo_gc_safepoint_requested = false;

void yo_safepoint() {
  if (__builtin_expect(yo_gc_safepoint_requested, 0)) {
    yo_gc_safepoint_slow();
  }
}

void yo_gc_safepoint_slow() {
  // Park this thread until GC is done
  pthread_mutex_lock(&yo_gc_safepoint_mutex);

  // Signal that we've reached a safepoint
  yo_gc_threads_at_safepoint++;

  // Wait for GC to finish
  while (yo_gc_safepoint_requested) {
    pthread_cond_wait(&yo_gc_safepoint_cond, &yo_gc_safepoint_mutex);
  }

  pthread_mutex_unlock(&yo_gc_safepoint_mutex);
}
```

**STW pause breakdown:**

```
Initial Mark:
  - Request safepoint: ~0.1ms (signal all threads)
  - Wait for threads to reach safepoint: ~0.5ms (worst case)
  - Scan shadow stacks: ~0.5ms (50-100 frames per thread, fast scan)
  - Resume threads: ~0.1ms
  Total: ~1.2ms

Remark:
  - Request safepoint: ~0.1ms
  - Wait for threads: ~0.5ms
  - Process write barriers: ~0.5ms (small buffer)
  - Finish marking: ~1ms (few remaining GRAY objects)
  - Resume threads: ~0.1ms
  Total: ~2.2ms

Total STW per GC cycle: ~3.4ms ✅ Under 5ms goal!
```

### Phase 3 Implementation: Generational + Incremental GC

#### Generational Hypothesis

**Observation**: Most objects die young (90%+ of allocations)

**Strategy**:

- **Young generation**: Frequently collected (minor GC)
- **Old generation**: Rarely collected (major GC)
- **Promotion**: Young objects that survive N collections → old generation

```c
typedef struct {
  YoHeapBlock* young_gen_start;
  YoHeapBlock* young_gen_end;
  YoHeapBlock* old_gen_start;
  YoHeapBlock* old_gen_end;

  size_t young_gen_size;
  size_t old_gen_size;

  uint8_t promotion_threshold;  // Survive N minor GCs to promote
} YoGenerationalGC;
```

#### Minor GC (Young Generation Only)

**Fast collection of young generation:**

```c
void yo_gc_minor_collect() {
  // Stop the world (brief)
  yo_gc_stop_the_world();  // ~0.5ms

  // 1. Mark young generation roots
  yo_gc_scan_all_shadow_stacks();   // Only mark young objects
  yo_gc_scan_remembered_set();      // Old -> Young pointers

  // 2. Copy survivors to old generation
  for (void* obj = young_gen_start; obj < young_gen_end; obj = next_obj(obj)) {
    if (yo_gc_is_marked(obj)) {
      uint8_t age = yo_gc_get_age(obj);

      if (age >= promotion_threshold) {
        // Promote to old generation
        void* new_addr = yo_gc_copy_to_old_gen(obj);
        yo_gc_update_references(obj, new_addr);
      } else {
        // Keep in young generation, increment age
        yo_gc_set_age(obj, age + 1);
      }
    }
  }

  // 3. Free entire young generation
  yo_gc_reset_young_gen();

  yo_gc_resume_world();

  // Total pause: ~1ms for typical young gen ✅
}
```

#### Remembered Set (Old → Young Pointers)

**Problem**: Old generation objects might point to young generation.

**Solution**: Track old → young pointers in remembered set.

```c
typedef struct {
  void** slots;        // Array of old object fields pointing to young objects
  size_t capacity;
  size_t size;
} YoRememberedSet;

// Write barrier for generational GC
void yo_write_barrier_generational(void** slot, void* new_value) {
  void* obj = yo_gc_containing_object(slot);

  // If old object writes to young object, add to remembered set
  if (yo_gc_is_old(obj) && yo_gc_is_young(new_value)) {
    yo_remembered_set_add(slot);
  }

  *slot = new_value;
}
```

#### Incremental Marking

**Spread marking work over multiple mutator pauses:**

```c
typedef struct {
  void** gray_stack;
  size_t gray_stack_size;
  size_t gray_stack_capacity;
  size_t work_budget;  // Mark this many objects per increment
} YoIncrementalGC;

void yo_gc_incremental_mark_step() {
  size_t work_done = 0;

  while (work_done < yo_incremental_gc.work_budget &&
         yo_gc_has_gray_objects()) {

    void* obj = yo_gc_pop_gray_object();
    yo_gc_mark_children(obj);
    yo_gc_set_color(obj, BLACK);

    work_done++;
  }
}

// Call incremental marking from allocation
void* yo_gc_alloc(YoTypeDescriptor* type_desc) {
  void* obj = yo_gc_alloc_fast(type_desc);

  if (obj == NULL) {
    // Slow path: trigger incremental marking step
    yo_gc_incremental_mark_step();
    obj = yo_gc_alloc_slow(type_desc);
  }

  return obj;
}
```

**Benefits:**

- Spread GC work over time (no sudden pauses)
- Allocation triggers proportional marking work
- Heap stays balanced (allocation rate ≈ marking rate)

#### Adaptive Heap Sizing

**Dynamically adjust heap size based on allocation rate:**

```c
typedef struct {
  size_t heap_size;
  size_t live_size;
  size_t target_heap_ratio;  // heap_size / live_size (default: 2x)

  double gc_cpu_percentage;   // Target: <25% CPU for GC
  uint64_t last_gc_duration;
  uint64_t mutator_duration;
} YoAdaptiveGC;

void yo_gc_adjust_heap_size() {
  double gc_overhead = (double)yo_adaptive_gc.last_gc_duration /
                       (double)yo_adaptive_gc.mutator_duration;

  if (gc_overhead > 0.25) {
    // GC taking too much CPU - increase heap size
    yo_adaptive_gc.heap_size = yo_adaptive_gc.live_size *
                                (yo_adaptive_gc.target_heap_ratio + 1);
  } else if (gc_overhead < 0.10) {
    // GC not using much CPU - decrease heap size
    yo_adaptive_gc.heap_size = yo_adaptive_gc.live_size *
                                yo_adaptive_gc.target_heap_ratio;
  }
}
```

### Complete GC Cycle with All Optimizations

**Minor GC (90% of collections):**

```
1. Stop the world              (~0.3ms)
2. Scan shadow stacks          (~0.3ms)
3. Scan remembered set         (~0.2ms)
4. Copy survivors              (~0.5ms)
5. Resume world                (~0.1ms)
Total: ~1.4ms ✅ Well under 5ms!
```

**Major GC (10% of collections):**

```
1. Initial mark (STW)          (~1.0ms)
2. Concurrent mark             (parallel, no pause)
3. Remark (STW)                (~1.5ms)
4. Concurrent sweep            (parallel, no pause)
Total STW: ~2.5ms ✅ Under 5ms!
```

**With incremental marking:**

```
Minor GC pause:                (~1.4ms)
Major GC pause (initial mark): (~0.8ms)  // Less work due to incremental
Major GC pause (remark):       (~1.0ms)  // Less work due to incremental
Total: ~1-2ms typical, <5ms worst case ✅
```

### Comparison: Yo GC vs Go GC

**Go's GC strategy (as of Go 1.21+):**

- Concurrent mark-sweep with STW pauses
- Write barriers during concurrent marking
- Target: <10ms (old), now <5ms (newer versions)
- Tri-color marking algorithm
- GOGC parameter for heap sizing

**Yo's GC strategy (proposed):**

- Concurrent mark-sweep (same as Go)
- Generational GC (Go doesn't have this)
- Incremental marking (Go has this)
- Shadow stack for precise roots (Go uses stack maps)
- Target: <5ms (same as modern Go)

**Key differences:**

- ✅ **Yo**: Generational GC → faster minor collections
- ✅ **Yo**: Shadow stack → simpler implementation for C target
- ✅ **Go**: Stack maps → slightly lower overhead (~1% vs 3%)
- ✅ **Go**: More mature (10+ years of tuning)

**Expected performance:**

- **Yo**: Similar latency to Go (<5ms)
- **Yo**: Potentially better throughput (generational helps)
- **Yo**: Slightly higher function call overhead (shadow stack)

### Monitoring and Debugging

**GC statistics:**

```c
typedef struct {
  uint64_t total_collections;
  uint64_t minor_collections;
  uint64_t major_collections;

  uint64_t total_pause_time_ns;
  uint64_t max_pause_time_ns;
  uint64_t avg_pause_time_ns;

  size_t bytes_allocated;
  size_t bytes_freed;
  size_t live_objects;

  double gc_cpu_percentage;
} YoGCStats;

void yo_gc_print_stats() {
  printf("=== GC Statistics ===\n");
  printf("Total collections:   %llu\n", yo_gc_stats.total_collections);
  printf("Minor collections:   %llu\n", yo_gc_stats.minor_collections);
  printf("Major collections:   %llu\n", yo_gc_stats.major_collections);
  printf("Avg pause time:      %.2fms\n", yo_gc_stats.avg_pause_time_ns / 1e6);
  printf("Max pause time:      %.2fms\n", yo_gc_stats.max_pause_time_ns / 1e6);
  printf("GC CPU overhead:     %.1f%%\n", yo_gc_stats.gc_cpu_percentage * 100);
  printf("Heap size:           %.2f MB\n", yo_gc_stats.bytes_allocated / 1e6);
  printf("Live objects:        %zu\n", yo_gc_stats.live_objects);
}
```

**Environment variables for tuning:**

```bash
YO_GC_HEAP_SIZE=512M          # Initial heap size
YO_GC_MAX_HEAP_SIZE=4G        # Maximum heap size
YO_GC_TARGET_RATIO=2          # heap_size / live_size ratio
YO_GC_THREADS=4               # Number of GC threads
YO_GC_YOUNG_GEN_SIZE=64M      # Young generation size
YO_GC_DEBUG=1                 # Enable debug logging
```

## Concurrency Model with GC

### Work-Stealing Enabled

**With GC, tasks can migrate between threads freely:**

```rust
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
  closure: (fn() => unit),  // GC-managed closure (uses => for closures)
  state: TaskState
);

// Worker can steal tasks from others
worker_run :: (fn(worker: Worker) -> unit)
  {
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

```rust
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

```rust
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

```rust
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

```rust
// For complex GC objects, copy to value type
NodeData :: struct(value: i32, has_next: bool);

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

```rust
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

```rust
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

```rust
// Before (with RC):
x := point;  // ___dup(point)
// ___drop(x) at scope exit

// After (with GC):
x := point;  // Just copy pointer, no dup
// No drop needed
```

**2. Update type definitions:**

```rust
// No change needed! Syntax stays the same:
Node :: object(value: i32, next: Option(Node));

// But semantics change:
// - Before: RC-managed, thread-affine
// - After: GC-managed, no thread affinity
```

**3. Remove `own()` keyword:**

```rust
// Before:
consume :: (fn(own(x): Node) -> unit) { ... };  // Takes ownership

// After:
consume :: (fn(x: Node) -> unit) { ... };  // Just passes reference
```

**4. Replace deterministic destructors for GC types:**

```rust
// Before (WRONG with GC):
File :: object(
  fd: i32,
  ___drop :: (fn(self: &mut Self) -> unit) { close(self.fd); }  // Non-deterministic!
);

// After (CORRECT):
FileHandle :: struct(  // Value type!
  fd: i32,
  ___drop :: (fn(self: &mut Self) -> unit) { close(self.fd); }  // Deterministic!
);
```

### Compiler Changes Required

**1. Remove RC code generation:**

- Remove `___dup` calls on assignment
- Remove `___drop` calls at scope exit
- Remove `isOwningTheSameRefValueAs` tracking
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
