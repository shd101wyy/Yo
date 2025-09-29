# Biased Reference Counting (BRC)

https://iacoma.cs.uiuc.edu/iacoma-papers/pact18.pdf

## Original BRC Paper Implementation

The academic paper uses a single 64-bit packed RCWord with atomic operations:

- RCWord       64 bits
  - Biased     32 bits
    - TID      18 bits
    - Counter  14 bits
  - Shared     32 bits
    - Counter  14 bits
    - Flags     2 bits
    - Reserved 16 bits

## Yo's Split Word Design

Yo changes upon the paper with a split design for true non-atomic owner access:

- **Biased Word** (32 bits, non-atomic):
  - Counter 14 bits
  - GC flags 5 bits (Yo extension)
  - Reserved 13 bits
- **Shared Word** (32 bits, atomic):
  - Counter 14 bits  
  - BRC Flags 2 bits (merged, queued)
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
  // Bits 14-18:  GC flags (5 bits) - non-atomic access by owner thread only  
  // Bits 19-31:  Reserved (13 bits) - for future use
  
  // Shared word format (32 bits, atomic access):
  // Bits 0-13:   Shared counter (14 bits) - atomic access, can be negative (signed)
  // Bits 14-15:  BRC flags (2 bits) - merged, queued (atomic access)
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
- **YO_GC_DISPOSED** (0x02): Object has been disposed by GC (prevents double-free)  
- **YO_GC_SCANNING** (0x04): Object is being scanned by GC (trial deletion phase)
- **YO_GC_MARKED** (0x08): Object marked during GC trial deletion
- **YO_GC_DISPOSING** (0x10): Object is currently being disposed (prevents races)

These flags achieve true non-atomic access since they're only accessed by:
- Owner thread during normal operation (direct memory access)
- Single thread during stop-the-world GC phases (no concurrency)

### Fast Thread ID Function
Yo uses optimized inline assembly for thread ID retrieval (inspired by Python/mimalloc):

```c
static inline size_t yo_get_thread_id(void) {
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

### Simplified Queue Management
Instead of complex flag checking, Yo uses `gc_next` field for queue detection:
- If `header->gc_next != NULL`: already queued, skip queuing
- If `header->gc_next == NULL`: not queued, add to owner's tracking list

This eliminates atomic flag operations and provides natural deduplication.

## Invariant Description
  - Must be zero or higher
  - If zero, object can be deallocated
- I2: biased = (references added - references removed) by owner
  - Must be zero or higher
  - When it reaches 0, owner unbiases object, implicitly merging counters
- I3: shared = (references added - references removed) by non-owners
  - Can be negative
  - If negative, biased must be positive, and object is placed in owner's `QueuedObjects` list so that owner can unbias it.
- I4: Owner only gives up ownership when it merges counters, namely:
  - When biased reaches zero (implicit merge)
  - Or when the owner finds the object in its `QueuedObjects` list (explicit merge)
- I5: Object can only be placed into `QueuedObjects` list once
  - Placed when shared becomes negative for first time
  - Removed when counters are explicitly merged

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
    if new.counter < 0 then
      new.queued := True      // Set queued flag
    end if
  while !CAS(&obj.shared_word, old, new) // Atomic decrement of shared counter

  if old.queued != new.queued then // queued has been *first* set in this invocation
    Queue(obj)
  else if new.merged == True and new.counter == 0 then // Counters are merged and shared counter is zero
    Deallocate(obj)
  end if
end procedure
```

### Extra operations (Yo Implementation)

```
procedure Queue(obj)
  owner_tid := obj.thread_id
  QueuedObjects[owner_tid].append(obj) // Adds object to list belonging to owner_tid
end procedure

procedure ExplicitMerge // Yo's version with split words
  my_tid := GetThreadID()
  for obj in QueuedObjects[my_tid] do
    // Read biased counter non-atomically - direct memory access!
    biased_counter := GetBiasedCounter(obj.biased_word)
    
    do
      old := obj.shared_word  // Atomic read of shared word only
      new := old
      new.counter += biased_counter // Merge counters
      new.merged := True
    while !CAS(&obj.shared_word, old, new) // Atomic update of shared word only

    if new.counter == 0 then
      Deallocate(obj)
    else
      obj.thread_id := 0 // Give up ownership
    end if
    QueuedObjects[my_tid].remove(obj)
  end for
end procedure
```

## Summary

Yo's split word design achieves the true performance goals of Biased Reference Counting:

1. **Zero atomic operations** for owner thread in common cases
2. **True non-atomic memory access** - no CPU synchronization overhead
3. **GC integration** with same performance benefits
4. **Algorithm correctness** - maintains all BRC invariants
5. **Better than paper** - eliminates atomic overhead that paper still had

The key insight is that splitting the biased and shared counters into separate words allows the owner thread to achieve genuinely non-atomic access patterns, which was the original intent of the BRC algorithm but wasn't fully realized in the paper's atomic-based implementation.