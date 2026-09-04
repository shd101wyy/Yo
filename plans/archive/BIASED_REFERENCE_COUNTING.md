# Biased Reference Counting (BRC)
> **ARCHIVED 2026-09-04 — NOT ADOPTED.** No trace of the biased/split RC word exists in the
> compiler; the RC word is the plain atomic counter described in
> [`MEMORY_SAFETY.md`](../reference/MEMORY_SAFETY.md). Kept as the design
> exploration record.


https://iacoma.cs.uiuc.edu/iacoma-papers/pact18.pdf

## Original BRC Paper Implementation

The academic paper uses a single 64-bit packed RCWord with atomic operations:

- RCWord 64 bits
  - Biased 32 bits
    - TID 18 bits
    - Counter 14 bits
  - Shared 32 bits
    - Counter 14 bits
    - Flags 2 bits
    - Reserved 16 bits

## Yo's Split Word Design

Yo changes upon the paper with a split design for true non-atomic owner access:

- **Biased Word** (32 bits, non-atomic):
  - Counter 14 bits
  - GC flags 2 bits (Yo extension)
  - Reserved 16 bits
- **Shared Word** (32 bits, atomic):
  - Counter 14 bits
  - BRC flags 2 bits (merged, reserved)
  - Reserved 16 bits

This split design ensures that owner thread access to the biased counter and GC flags is truly non-atomic, achieving the core performance benefit of BRC.

For Yo language, we take Thread ID as a separate `size_t` field.

### Key Benefits of Split Design

The split word design provides several critical advantages:

1. **True Non-Atomic Fast Path**: Owner thread operations on `biased_word` are genuine non-atomic memory operations - no CPU synchronization overhead whatsoever.

2. **Cache Line Efficiency**: The biased word (frequently accessed by owner) and shared word (less frequently accessed) can be optimized separately by the CPU cache.

3. **Memory Ordering Relaxation**: Owner thread operations require no memory barriers, only regular load/store instructions.

4. **GC Flag Performance**: GC flags benefit from the same non-atomic access pattern, making cycle detection extremely fast.

5. **BRC Algorithm Compliance**: Perfectly matches the academic paper's intent of bias toward single-threaded access patterns.

```c
typedef struct {
  // Biased Reference Counting fields
  size_t thread_id;                                     // Thread ID that owns this object (0 = no owner/shared)
  uint32_t biased_word;                                 // Non-atomic biased word (owner thread only)
  _Atomic(uint32_t) shared_word;                        // Atomic shared word (cross-thread access)

  // Biased word format (32 bits, non-atomic access):
  // Bits 0-13:   Biased counter (14 bits) - non-atomic access by owner thread only
  // Bits 14-15:  GC flags (2 bits) - non-atomic access by owner thread only
  // Bits 16-31:  Reserved (16 bits) - for future use

  // Shared word format (32 bits, atomic access):
  // Bits 0-13:   Shared counter (14 bits) - atomic access, should never be negative in Yo
  // Bits 14-15:  BRC flags (2 bits) - merged (bit 0), reserved (bit 1) (atomic access)
  // Bits 16-31:  Reserved (16 bits) - for future use

  // GC object management fields
  struct yo_ref_header_t* gc_next;                      // Next object in thread-local GC tracking list
  void (*dispose_fn)(void*);                            // Dispose function for this object type (immutable after construction)
  void (*traverse_fn)(void*, void (*visit)(void*));    // Traversal function for GC marking (immutable after construction)
} yo_ref_header_t;
```

## Yo Language Extensions

### GC Flags Integration

GC flags are placed in the biased word for true non-atomic performance:

- **YO_GC_TRACKED** (0x01): Object is tracked by GC (might participate in cycles)
- **YO_GC_TRIAL_DECREMENTED** (0x02): Biased counter was decremented during trial deletion (vs shared counter)

These flags achieve true non-atomic access since they're only accessed by:

- Owner thread during normal operation (direct memory access)
- Single thread during stop-the-world GC phases (no concurrency)

### Fast Thread ID Function

Yo uses optimized inline assembly for thread ID retrieval (inspired by Python/mimalloc):

```c
static inline size_t __yo_get_thread_id(void) {
    uintptr_t tid;
#if defined(__x86_64__)
    __asm__("movq %%fs:0, %0" : "=r" (tid));  // x86_64 Linux, BSD uses FS
#elif defined(__MACH__) && defined(__x86_64__)
    __asm__("movq %%gs:0, %0" : "=r" (tid));  // x86_64 macOSX uses GS
    // ... more platform-specific implementations
#else
    tid = (uintptr_t)pthread_self();  // Fallback
#endif
    return (size_t)tid;
}
```

### Abort on Negative Counter

Yo follows the paper's algorithm for handling negative shared counters:

- If `shared_counter < 0`: Set the `queued` flag and queue the object to the owner thread
- The owner thread will perform explicit merge during the next GC cycle
- This handles cross-thread reference patterns correctly without aborting

The queued objects are processed during stop-the-world GC phases.

## Invariant Description

- Must be zero or higher
- If zero, object can be deallocated
- I2: biased = (references added - references removed) by owner
  - Must be zero or higher
  - When it reaches 0, owner unbiases object, implicitly merging counters
- I3: shared = (references added - references removed) by non-owners
  - **Can be negative** when decrements happen before increments in cross-thread scenarios
  - Negative values trigger the `queued` flag and object is added to owner's queue
  - Owner performs explicit merge during GC to resolve negative counters
- I4: Owner only gives up ownership when it merges counters, namely:
  - When biased reaches zero (implicit merge)
  - Or when the owner finds the object in its `QueuedObjects` list (explicit merge)
- I5: Queued flag indicates object needs explicit merge
  - Set when shared counter goes negative
  - Owner thread processes queued objects during GC stop-the-world phase
  - Explicit merge combines biased and shared counters, clears queue flag

## Algorithm Comparison

### Original Paper Implementation

#### Increment operation (Paper)

```
procedure Increment(obj) // Increment the reference count of obj
  owner_tid := obj.rcword.biased.tid
  my_tid := GetThreadID()
  if owner_tid == my_tid then
    FastIncrement(obj) // Owner access
  else
    SlowIncrement(obj) // Non-owner access
  end if
end procedure

procedure FastIncrement(obj)
  obj.rcword.biased.counter += 1 // Non-atomic increment of biased counter
end procedure

procedure SlowIncrement(obj)
  do
    old := obj.rcword.shared  // Read shared half-word
    new := old
    new.counter += 1
  while !CAS(&obj.rcword.shared, old, new) // Atomic increment of shared counter
end procedure
```

#### Decrement operation (Paper)

```
procedure Decrement(obj) // Decrement the reference count of obj
  owner_tid := obj.rcword.biased.tid
  my_tid := GetThreadID()
  if owner_tid == my_tid then
    FastDecrement(obj) // Owner access
  else
    SlowDecrement(obj) // Non-owner access
  end if
end procedure

procedure FastDecrement(obj)
  obj.rcword.biased.counter -= 1 // Non-atomic decrement of biased counter

  if obj.rcword.biased.counter > 0 then
    return
  end if

  do                             // biased counter is zero
    old := obj.rcword.shared     // Read shared half-word
    new := old
    new.merged := True           // Set merged flag
  while !CAS(&obj.rcword.shared, old, new) // Atomic update of shared half-word

  if new.counter == 0 then
    Deallocate(obj)
  else
    obj.rcword.biased.tid := 0 // Give up ownership
  end if
end procedure


procedure SlowDecrement(obj)
  do
    old := obj.rcword.shared  // Read shared half-word
    new := old
    new.counter -= 1
    if new.counter < 0 then
      new.queued := True      // Set queued flag
    end if
  while !CAS(&obj.rcword.shared, old, new) // Atomic decrement of shared counter

  if old.queued != new.queued then // queued has been *first* set in this invocation
    Queue(obj)
  else if new.merged == True and new.counter == 0 then // Counters are merged and shared counter is zero
    Deallocate(obj)
  end if
end procedure
```

### Extra operations (Paper)

```
procedure Queue(obj)
  owner_tid := obj.rcword.biased.tid
  QueuedObjects[owner_tid].append(obj) // Adds object to list belonging to owner_tid
end procedure

procedure ExplicitMerge
  my_tid := GetThreadID()
  for obj in QueuedObjects[my_tid] do
    do
      old := obj.rcword.shared  // Read shared half-word
      new := old
      new.counter += obj.rcword.biased.counter // Merge counters
      new.merged := True
    while !CAS(&obj.rcword.shared, old, new) // Atomic update of shared half-word

    if new.counter == 0 then
      Deallocate(obj)
    else
      obj.rcword.biased.tid := 0 // Give up ownership
    end if
    QueuedObjects[my_tid].remove(obj)
  end for
end procedure
```

### Yo's Split Word Implementation

#### Increment operation (Yo)

```
procedure Increment(obj) // Increment the reference count of obj
  owner_tid := obj.thread_id
  my_tid := GetThreadID()
  if owner_tid == my_tid then
    FastIncrement(obj) // Owner access - truly non-atomic!
  else
    SlowIncrement(obj) // Non-owner access
  end if
end procedure

procedure FastIncrement(obj) // Yo version - true non-atomic access!
  // Direct memory manipulation - no atomics, no barriers, no synchronization!
  biased_counter := GetBiasedCounter(obj.biased_word)
  obj.biased_word := SetBiasedCounter(obj.biased_word, biased_counter + 1)
end procedure

procedure SlowIncrement(obj)
  do
    old := obj.shared_word   // Atomic read of shared word only
    new := old
    new.counter += 1
  while !CAS(&obj.shared_word, old, new) // Atomic increment of shared counter
end procedure
```

#### Decrement operation (Yo)

```
procedure Decrement(obj) // Decrement the reference count of obj
  owner_tid := obj.thread_id
  my_tid := GetThreadID()
  if owner_tid == my_tid then
    FastDecrement(obj) // Owner access
  else
    SlowDecrement(obj) // Non-owner access
  end if
end procedure

procedure FastDecrement(obj) // Yo version - following paper's algorithm with split words
  // Direct non-atomic access to biased counter
  biased_counter := GetBiasedCounter(obj.biased_word)
  obj.biased_word := SetBiasedCounter(obj.biased_word, biased_counter - 1)

  if biased_counter - 1 > 0 then
    return // Still have biased references - zero atomic operations!
  end if

  // Biased counter reached zero - set merged flag (paper's algorithm)
  do
    old := obj.shared_word     // Atomic read of shared word
    new := old
    new.merged := True         // Set merged flag
  while !CAS(&obj.shared_word, old, new) // Atomic update of shared word

  if new.counter == 0 then
    Deallocate(obj)
  else
    obj.thread_id := 0 // Give up ownership
  end if
end procedure

procedure SlowDecrement(obj)
  do
    old := obj.shared_word  // Atomic read of shared word only
    new := old
    new.counter -= 1

    // If counter went negative, set queued flag (Yo follows paper's algorithm)
    if new.counter < 0 then
      new.queued := True
    end if
  while !CAS(&obj.shared_word, old, new) // Atomic decrement of shared counter

  // Check if queued flag was just set (first time)
  if old.queued != new.queued then
    Queue(obj)  // Queue to owner thread for explicit merge
  else if new.merged == True and new.counter == 0 then // Counters are merged and shared counter is zero
    Deallocate(obj)
  end if
end procedure
```

### BRC Operations Summary

Yo's implementation follows the BRC paper's algorithm:

- **Increment**: Fast path for owner thread, slow atomic path for non-owners
- **Decrement**: Fast path for owner thread, slow atomic path for non-owners
- **Queue on Negative**: When shared counter goes negative, set queued flag and add to owner's queue
- **Explicit Merge**: During GC, owner processes queued objects and merges counters

The explicit merge and queue operations ensure correctness for all cross-thread reference patterns.

## Summary

Yo's split word design achieves the true performance goals of Biased Reference Counting:

1. **Zero atomic operations** for owner thread in common cases
2. **True non-atomic memory access** - no CPU synchronization overhead
3. **GC integration** with same performance benefits
4. **Algorithm correctness** - maintains all BRC invariants
5. **Better than paper** - eliminates atomic overhead that paper still had

The key insight is that splitting the biased and shared counters into separate words allows the owner thread to achieve genuinely non-atomic access patterns, which was the original intent of the BRC algorithm but wasn't fully realized in the paper's atomic-based implementation.
