# Generational References Memory Management for Yo
> **ARCHIVED 2026-09-04 — NOT ADOPTED.** Yo shipped the RC + dup/drop model instead
> ([`MEMORY_SAFETY.md`](../reference/MEMORY_SAFETY.md)); no generational-reference
> checking exists in the compiler. Kept as the design exploration record.


**Inspired by Vale language's generational references approach.**

This document describes a memory management system based on generational references that combines:

- **Single ownership** (linear types) - owning references
- **Generational checking** - borrow references
- **Zero mutation overhead** - no RC operations
- **Deterministic destruction** - RAII works!
- **Work-stealing enabled** - no thread affinity

## Why Generational References?

### Problems with Current Approaches

**Reference Counting (Current):**

- ❌ Overhead on every mutation (`___dup`/`___drop`)
- ❌ Atomic operations expensive in multithreading
- ❌ Thread affinity (biased RC) prevents work-stealing
- ❌ Cannot handle cycles without weak pointers
- ✅ Deterministic destructors
- ✅ Simple mental model

**Garbage Collection (Considered):**

- ✅ Zero mutation overhead
- ✅ Work-stealing enabled
- ✅ Handles cycles naturally
- ❌ Non-deterministic destructors (breaks RAII)
- ❌ GC pauses (~2ms)
- ❌ Higher memory usage (2x live data)
- ❌ Complex runtime

**Generational References (Proposed):** ✨

- ✅ Zero mutation overhead
- ✅ Work-stealing enabled
- ✅ Deterministic destructors (RAII works!)
- ✅ Simple implementation
- ✅ Can optimize checks to zero with linear style
- ⚠️ Needs weak pointers for cycles (same as RC)
- ⚠️ Check overhead on borrow dereference (but optimizable!)

### Performance Comparison (from Vale benchmarks)

| Approach                          | Overhead |
| --------------------------------- | -------- |
| Unsafe C++ (baseline)             | 0%       |
| Reference Counting                | +25.29%  |
| Generational References (basic)   | +10.84%  |
| Gen Refs + Linear Style + Regions | ~0%      |

**Generational references are 2.3x faster than RC!**

## Core Concept

### The Generation Number

Every heap-allocated object has a **generation number** stored before it:

```c
// Memory layout of a heap object:
// [generation (8 bytes)] [object data...]
//  ^                      ^
//  |                      |
//  Generation counter     Pointer that user code sees
```

When allocated:

- Generation = random 64-bit number (or incremented counter)

When freed:

- Generation = 0

### Two Types of References

**1. Owning Reference (Linear Type)**

- Just a raw pointer
- No generation needed
- Owns the object
- Must be used exactly once (linear type)
- Automatically freed when out of scope

**2. Borrowing Reference (Generational Reference)**

- Pointer + remembered generation
- Does NOT own the object
- Must check generation before dereferencing
- Can be copied freely

## Type System

### Owning References

```rust
// object(...) creates an owning reference type
Node :: object(
  value: i32,
  next: Option(Node)
);

// node is an owning reference (linear type)
node := Node(value: 42, next: .None);

// Owning reference is linear:
// - Must be used exactly once
// - Cannot copy
// - Automatically freed at scope exit
```

**Properties:**

- Stored as raw pointer (8 bytes)
- No generation check needed (we own it!)
- Linear type: must move, cannot copy
- Deterministic destruction via `___drop`

### Borrowing References

```rust
// &T creates a borrowing reference type
fn print_value(n: *(Node)) -> unit {
  // n is a borrow reference
  // Implicit __check(n) before each dereference
  printf("%d\n", n.value);
}

node := Node(value: 42, next: .None);
print_value(&(node));  // &(node) creates a borrow
```

**Properties:**

- Stored as `{ ptr: *T, generation: u64 }` (16 bytes)
- Generation check before each dereference
- Can be copied freely (cheap copy)
- Does NOT own the object

### Creating Borrows

```rust
node := Node(value: 42, next: .None);  // owning reference

// Create borrow with & operator
borrow := &(node);  // borrow: *(Node)

// Borrows can be passed to functions
process(&(node));

// Multiple borrows are allowed
b1 := &(node);
b2 := &(node);
b3 := &(node);
```

## Runtime Implementation

### Memory Layout

```c
// Generation stored before object
typedef struct {
  uint64_t generation;  // Random number or counter
  char object_data[];
} YoAllocation;

// Owning reference: just pointer to object data
typedef void* YoOwn;

// Borrowing reference: pointer + generation
typedef struct {
  void* ptr;             // Points to object data (after generation)
  uint64_t remembered_generation;
} YoBorrow;
```

### Allocation

```c
void* yo_alloc(size_t object_size) {
  // Allocate generation + object
  size_t total_size = sizeof(uint64_t) + object_size;
  void* mem = malloc(total_size);

  uint64_t* gen_ptr = (uint64_t*)mem;
  *gen_ptr = random_u64();  // Or increment global counter

  // Return pointer to object data (after generation)
  return (void*)(gen_ptr + 1);
}
```

### Deallocation

```c
void yo_free(void* ptr) {
  // Get generation pointer
  uint64_t* gen_ptr = (uint64_t*)ptr - 1;

  // Set generation to 0 (marks as freed)
  *gen_ptr = 0;

  // Free memory
  free(gen_ptr);
}
```

### Creating a Borrow

```c
YoBorrow yo_borrow(void* own_ptr) {
  // Get current generation
  uint64_t* gen_ptr = (uint64_t*)own_ptr - 1;
  uint64_t current_gen = *gen_ptr;

  YoBorrow borrow = {
    .ptr = own_ptr,
    .remembered_generation = current_gen
  };

  return borrow;
}
```

### Checking a Borrow

```c
void __check(YoBorrow borrow) {
  // Get current generation from object
  uint64_t* gen_ptr = (uint64_t*)borrow.ptr - 1;
  uint64_t current_gen = *gen_ptr;

  // Compare with remembered generation
  if (current_gen != borrow.remembered_generation) {
    // Object was freed! Panic!
    fprintf(stderr, "ERROR: Use-after-free detected!\n");
    fprintf(stderr, "Expected generation: %llu\n", borrow.remembered_generation);
    fprintf(stderr, "Current generation: %llu\n", current_gen);
    abort();
  }
}
```

## Code Generation

### Owning References

```rust
// Source:
node := Node(value: 42, next: .None);
printf("%d\n", node.value);

// Generated C:
YoNode* node = yo_alloc(sizeof(YoNode));
node->value = 42;
node->next = /* ... */;

// No check needed! We own it!
printf("%d\n", node->value);

// Auto-free at scope exit
yo_free(node);
```

### Borrowing References

```rust
// Source:
fn print_node(n: *(Node)) -> unit {
  printf("%d\n", n.value);
}

// Generated C:
void print_node(YoBorrow n) {
  __check(n);  // Check before dereference
  YoNode* n_ptr = (YoNode*)n.ptr;
  printf("%d\n", n_ptr->value);
}
```

### Creating Borrows

```rust
// Source:
node := Node(value: 42, next: .None);
print_node(&(node));

// Generated C:
YoNode* node = yo_alloc(sizeof(YoNode));
/* initialize node... */

YoBorrow node_borrow = yo_borrow(node);
print_node(node_borrow);

yo_free(node);
```

## Optimization: Eliminating Checks

The beauty of generational references is that checks can be eliminated in many cases!

### 1. Owning References Never Need Checks

```rust
node := Node(value: 42, next: .None);
// No check! We own it!
printf("%d\n", node.value);
```

**Generated C:**

```c
YoNode* node = yo_alloc(sizeof(YoNode));
// No __check! Direct access!
printf("%d\n", node->value);
```

### 2. Linear Style (Move Ownership)

```rust
fn process(own_node: Node) -> unit {
  // own_node is owned by this function
  // No check needed!
  printf("%d\n", own_node.value);

  // Passes ownership to another function
  consume(own_node);
}

fn consume(node: Node) -> unit {
  // No check needed!
  printf("%d\n", node.value);
}  // node freed here
```

**Key insight**: By moving ownership instead of borrowing, we eliminate ALL checks!

### 3. Thread-Safe Checking: Always Check Borrows

**CRITICAL: In multithreading environments, we MUST check on every dereference!**

```rust
fn process(n: *(Node)) -> unit {
  __check(n);  // Check #1
  printf("%d\n", n.value);

  __check(n);  // Check #2 - REQUIRED!
  printf("%d\n", n.next);
}
```

**Why both checks are necessary:**

- Another thread might free the object between checks
- Even in the same function, concurrent access can invalidate borrows
- Redundant check elimination is **UNSAFE** in multithreaded code

**Generated C:**

```c
void process(YoBorrow n) {
  __check(n);  // Check before first access
  YoNode* n_ptr = (YoNode*)n.ptr;
  printf("%d\n", n_ptr->value);

  __check(n);  // Check again before second access!
  n_ptr = (YoNode*)n.ptr;  // Reload pointer after check
  printf("%d\n", n_ptr->next);
}
```

**Multithreading scenario that breaks "redundant check elimination":**

```rust
// Thread 1:
fn thread1(n: *(Node)) -> unit {
  __check(n);  // ✅ Passes
  printf("%d\n", n.value);

  // ⚠️ Thread 2 frees the object HERE!

  // If we skip this check, we access freed memory!
  __check(n);  // ✅ REQUIRED - catches use-after-free!
  printf("%d\n", n.next);
}

// Thread 2:
fn thread2(node: Node) -> unit {
  // Frees the object
  drop(node);  // Generation set to 0
}
```

### 4. Single-Threaded Optimization (Future)

**Only safe in provably single-threaded contexts:**

```rust
// Compiler can prove this is single-threaded
single_threaded fn calculate(n: *(Node)) -> i32 {
  __check(n);  // Check once at entry
  // All internal accesses skip checks (safe - no other threads)
  return (n.value * 2);
}
```

**Requirements for this optimization:**

- Explicit `single_threaded` annotation or compiler proof
- No concurrent access possible
- Object cannot be freed by another thread
- **Not implemented yet - future optimization**

**Trade-off:**

- Multithreaded code: Always check (safe, ~10% overhead)
- Single-threaded code: Can optimize (requires proof)

## Comparison: Memory Safety Approaches

| Aspect                        | RC                      | GC                | Gen Refs                           |
| ----------------------------- | ----------------------- | ----------------- | ---------------------------------- |
| **Mutation overhead**         | ❌ High (dup/drop)      | ✅ Zero           | ✅ Zero                            |
| **Dereference overhead**      | ✅ Zero                 | ✅ Zero           | ⚠️ Check (optimizable to zero!)    |
| **Deterministic destructors** | ✅ Yes                  | ❌ No             | ✅ Yes                             |
| **RAII support**              | ✅ Yes                  | ❌ No             | ✅ Yes                             |
| **Work-stealing**             | ❌ No (thread affinity) | ✅ Yes            | ✅ Yes                             |
| **Cycles**                    | ⚠️ Weak ptrs            | ✅ Auto           | ⚠️ Weak ptrs                       |
| **Memory per object**         | 8 bytes (RC)            | 16 bytes (header) | 8 bytes (gen)                      |
| **Pointer size**              | 8 bytes                 | 8 bytes           | 16 bytes (borrow) or 8 bytes (own) |
| **Complexity**                | Medium                  | High              | Low                                |
| **False positives**           | N/A                     | N/A               | Extremely rare (1 in 2^64)         |

## Safety Guarantees

### Use-After-Free Protection

```rust
// Scenario: Borrow outlives owner
{
  borrow := {
    node := Node(value: 42, next: .None);
    &(node)  // Create borrow
  };  // node freed here, generation set to 0

  // Attempt to use borrow
  printf("%d\n", borrow.value);  // 💥 PANIC! Generation mismatch!
}
```

**What happens:**

1. `node` is freed, generation set to 0
2. `borrow.remembered_generation` still has old value
3. `__check(borrow)` compares: `0 != old_value` → **PANIC**

**Result**: Memory safety violation detected immediately!

### Double-Free Protection

```rust
node := Node(value: 42, next: .None);
yo_free(node);  // Generation set to 0
yo_free(node);  // Generation already 0, but malloc will catch this
```

**Protection**: Standard malloc double-free detection + generation checking.

### Random Generations: Statistical Safety

Instead of incrementing generations, use **random numbers**:

```c
uint64_t random_u64() {
  // Simple PRNG or real random source
  static uint64_t state = 0x12345678;
  state = state * 6364136223846793005ULL + 1;
  return state;
}
```

**Why random?**

- Object can live anywhere (stack, heap, custom allocators)
- No need to track generation counter
- Reuse memory locations freely
- Statistical safety: 1 in 2^64 chance of false negative

**Safety analysis** (from Vale):

- 64-bit generation: 1/2^64 chance of collision per check
- If 6 million checks fail per second: **73,250 years** on average until unsafety
- Comfortable odds!

## Integration with Yo's Type System

### Value Types (No Generation)

```rust
// Value types don't need generation numbers
Point :: struct(x: i32, y: i32);

p := Point(x: 10, y: 20);  // Lives on stack
// No generation, no checks, just copy!
```

### Linear Types (With Generation)

```rust
// Object types are heap-allocated with generation
Node :: object(value: i32, next: Option(Node));

node := Node(value: 42, next: .None);  // Heap + generation
```

### Mixing Value and Linear Types

```rust
Container :: struct(
  id: i32,           // Value type
  data: Node         // Linear type (owning reference)
);

c := Container(id: 1, data: Node(value: 42, next: .None));
// c lives on stack
// c.data points to heap-allocated Node with generation
```

## Thread-Safety Guarantee

### Why We Always Check Borrowed References

**Critical insight**: In a multithreaded environment, we MUST check on every dereference:

```rust
// Thread 1: Uses borrowed reference
fn reader(n: *(Node)) -> unit {
  __check(n);  // ✅ Passes - object alive
  printf("%d\n", n.value);

  // ⚠️ Thread 2 might free the object HERE!

  __check(n);  // ✅ Required - might catch use-after-free!
  printf("%d\n", n.next);
}

// Thread 2: Frees the object
fn owner(node: Node) -> unit {
  // ... use node ...
  drop(node);  // Object freed, generation = 0
}
```

**Race condition:**

1. Thread 1 checks, generation matches ✅
2. Thread 1 uses `n.value` ✅
3. **Thread 2 frees the object** → generation = 0
4. Thread 1 checks again → generation mismatch ❌ **PANIC!**

**Without the second check**: Thread 1 would access freed memory → undefined behavior!

### The Safety Guarantee

**Generational references provide thread-safe memory safety:**

- ✅ **Owning references**: Only one owner, thread-safe by construction
- ✅ **Borrowing references**: Check before EVERY dereference (thread-safe)
- ✅ **Use-after-free**: Always detected (generation mismatch → panic)
- ✅ **Data races**: Prevented by Yo's type system (separate from memory safety)

**Trade-off**: ~10% overhead for borrowed references, but guaranteed thread-safe memory safety!

## Concurrency: Work-Stealing Enabled!

Unlike biased RC, generational references have **no thread affinity**:

```rust
// Task can move between threads freely!
Task :: object(
  work: fn() -> unit,
  data: Node  // Owning reference, no thread affinity!
);

Scheduler :: object(
  workers: [Worker],
  task_queue: Queue(Task)
);

Worker :: object(
  id: usize,
  local_queue: Deque(Task)
);

fn worker_run(worker: Worker) -> unit {
  loop({
    task := match worker.local_queue.pop(),
      .Some(t) => t,
      .None => steal_from_others(worker)  // ✅ Can steal!
    ;

    // Execute task on any thread
    task.work();
  });
}
```

**Why this works:**

- No per-object reference counter
- No thread ownership
- Generation checks work on any thread
- Stealing just moves pointers

## Implementation Phases

### Phase 1: Basic Generational References

**Implement:**

1. ✅ Allocation with generation (`yo_alloc`)
2. ✅ Deallocation with generation zeroing (`yo_free`)
3. ✅ Borrow creation (`yo_borrow`)
4. ✅ Generation checking (`__check`)
5. ✅ Codegen for owning and borrowing references
6. ✅ Automatic check insertion before borrow dereferences

**Goals:**

- Prove memory safety works
- Measure baseline overhead
- Replace biased RC

**Expected overhead:** ~10% (from Vale benchmarks)

### Phase 2: Check Elimination Optimizations

**Implement:**

1. ✅ Linear style support (move semantics) - **Safe: no borrowing, no checks needed**
2. ✅ Ownership transfer tracking (compiler knows when we own vs borrow)
3. ⚠️ Single-threaded proof (future: only optimize if provably single-threaded)
4. ⚠️ Redundant check elimination (future: only safe in single-threaded contexts)

**Goals:**

- Reduce checks to zero for linear style code (safe via ownership)
- Keep thread-safety for borrowed references

**Expected overhead:**

- Borrowed refs: ~10% (always check for thread-safety)
- Owned refs: 0% (no checks needed)

### Phase 3: Advanced Optimizations

**Implement:**

1. ✅ Region-based borrow checking (eliminate checks in safe regions)
2. ✅ Stack allocation for objects (generation on stack)
3. ✅ Inline objects in structs (embedded generations)
4. ✅ Pre-checking for loops (check once, use many times)

**Goals:**

- Match C++ performance for optimized code
- Zero overhead for linear style + regions

**Expected overhead:** 0-2% (with full optimizations)

## Migration from Biased RC

### Code Changes

**Before (RC):**

```rust
node := Node(value: 42, next: .None);  // ___dup at assignment
node2 := node;  // ___dup
// ___drop(node2), ___drop(node) at scope exit
```

**After (Gen Refs):**

```rust
node := Node(value: 42, next: .None);  // No dup, just alloc + generation
node2 := &(node);  // Borrow, no dup!
// Only yo_free(node) at scope exit, no drops
```

**Changes:**

- Remove ALL `___dup` and `___drop` calls
- Replace copies with borrows (`&`)
- Let compiler insert `__check` calls

### Compiler Changes

**Remove:**

- `___dup` codegen on assignment
- `___drop` codegen at scope exit
- `isOwningTheSameRefValueAs` tracking
- Biased RC infrastructure

**Add:**

- Generation allocation/deallocation
- Borrow creation codegen
- `__check` insertion before borrow dereferences
- Linear type checking (already have!)

### Runtime Changes

**Replace:**

```typescript
// Before:
function emitAssignment(lhs, rhs) {
  emit(`___dup(${rhs});`);
  emit(`${lhs} = ${rhs};`);
}

// After:
function emitAssignment(lhs, rhs) {
  if (isOwningReference(lhs)) {
    // Just assign pointer, no dup!
    emit(`${lhs} = ${rhs};`);
  } else if (isBorrowReference(lhs)) {
    // Create borrow
    emit(`${lhs} = yo_borrow(${rhs});`);
  }
}
```

## Debugging and Error Messages

### Use-After-Free Detection

```rust
{
  borrow := {
    node := Node(value: 42, next: .None);
    &(node)
  };  // node freed here

  printf("%d\n", borrow.value);  // 💥 Panic!
}
```

**Error message:**

```
ERROR: Use-after-free detected!
  at: example.yo:6:3
  Expected generation: 12345678
  Current generation: 0 (freed)

Stack trace:
  #0 __check at runtime.c:42
  #1 main at example.c:10
```

### Borrow Checker Errors (Compile-Time)

```rust
fn broken() -> *(Node) {
  node := Node(value: 42, next: .None);
  return &(node);  // ❌ ERROR: Cannot return borrow of local variable
}
```

**Error message:**

```
ERROR: Cannot return reference to local variable
  at: example.yo:3:10

  note: `node` is freed at the end of this function
  note: Returned borrow would be invalid

  help: Consider returning an owning reference:
        fn broken() -> Node { ... }
```

## Safety vs Performance Trade-offs

### Always Safe (Default) - Thread-Safe

```rust
// Every borrow dereference has __check (thread-safe!)
fn process(n: *(Node)) -> unit {
  printf("%d\n", n.value);  // __check(n) before access
  printf("%d\n", n.next);   // __check(n) again before access
}
```

**Overhead:** ~10% (from Vale benchmarks)

**Why we always check:**

- Thread-safe: Another thread might free the object at any time
- Cannot eliminate "redundant" checks in multithreaded code
- Simple and safe: works in all scenarios

**This is the ONLY safe approach for multithreaded code!**

### Optimized (Linear Style)

```rust
// Zero checks by moving ownership
fn process(n: Node) -> Node {  // Takes ownership
  printf("%d\n", n.value);  // No check!
  printf("%d\n", n.next);   // No check!
  return n;  // Return ownership
}
```

**Overhead:** ~0%

### Unsafe (Opt-In)

```rust
// Skip checks for hot paths (at your own risk!)
// Use the *!(Node) syntax
fn hot_loop(n: *!(Node)) -> unit {
  foreach _ in 0..1000000, {
    // Use unsafe dereference to skip check
    printf("%d\n", unchecked(n).value);
  }
}
```

**Overhead:** 0% (but unsafe!)

**Note**: `unchecked()` is opt-in and clearly marked.

## Summary

Generational references provide the best of all worlds:

| Feature                   | RC  | GC  | Gen Refs               |
| ------------------------- | --- | --- | ---------------------- |
| Zero mutation overhead    | ❌  | ✅  | ✅                     |
| Deterministic destructors | ✅  | ❌  | ✅                     |
| Work-stealing             | ❌  | ✅  | ✅                     |
| Simple implementation     | ✅  | ❌  | ✅                     |
| Zero-overhead possible    | ❌  | ❌  | ✅ (with linear style) |

**Performance** (from Vale):

- Basic: +10.84% overhead (vs unsafe)
- Optimized: ~0% overhead (with linear style + regions)
- 2.3x faster than reference counting!

**Safety:**

- Use-after-free: Detected (panic)
- Double-free: Detected (malloc + generation)
- Memory leaks: Impossible (linear types)
- Data races: Prevented (borrow checking)

**Developer Experience:**

- Simple mental model: "own or borrow"
- Fast by default (10% overhead acceptable)
- Can optimize to zero when needed
- Clear error messages

## Recommendation

**YES! Use generational references for Yo!**

This is the perfect memory management strategy because:

1. ✅ **Simplifies everything** - no complex RC or GC runtime
2. ✅ **Fast by default** - 10% overhead, optimizable to 0%
3. ✅ **Enables work-stealing** - no thread affinity
4. ✅ **RAII works** - deterministic destructors
5. ✅ **Integrates with linear types** - you already have the foundation!
6. ✅ **Simple to implement** - much easier than RC or GC

Vale has proven this approach works in practice. Let's do it!

## References

- [Vale's Generational References](https://verdagon.dev/blog/generational-references) - Original article
- [Vale Benchmarks](https://github.com/Verdagon/BenchmarkRL/tree/master/vale) - Performance numbers
- [Linear Types in Vale](https://verdagon.dev/blog/linear-types-borrowing) - Linear style explanation
- [Single Ownership without Borrow Checking](https://verdagon.dev/blog/single-ownership-without-borrow-checking-rc-gc) - Ownership model
