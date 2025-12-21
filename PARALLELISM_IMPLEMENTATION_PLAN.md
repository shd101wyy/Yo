# Parallelism Implementation Plan

## Overview

This document outlines the implementation plan for Yo's parallelism features based on `PARALLELISM.md`. The goal is to enable isolated multi-threaded execution using the `Worker` type with message passing.

## Key Design Decisions

### 1. Single `__yo_worker_t` Type (Symmetric Design)

Both parent and child use the **same** `__yo_worker_t` type. This simplifies the design:

```
Parent's __yo_worker_t:              Child's __yo_worker_t:
┌─────────────────────┐            ┌─────────────────────┐
│ send_channel ───────┼────────────┼─► recv_channel      │
│ recv_channel ◄──────┼────────────┼── send_channel      │
│ self_alive ─────────┼──► child   │ self_alive ─────────┼──► parent reads
│ other_alive ◄───────┼── child    │ other_alive ◄───────┼── parent sets
└─────────────────────┘            └─────────────────────┘
```

- Channels are "flipped" between parent and child
- Each worker tracks its own liveness (`self_alive`)
- Each worker has a pointer to the other's liveness (`other_alive`)

### 2. Reference Counted Workers

Workers are reference counted for proper lifecycle management:
- `__yo_worker_dup(worker)` - increment ref count
- `__yo_worker_drop(worker)` - decrement ref count, free if zero

When a worker is dropped:
- Sets `self_alive = false` (other side can detect this)
- Closes channels (wakes up any blocked operations)

### 3. No `join` and `kill` as First-Class Operations

**`join`**: Can be achieved via message passing:
```yo
// Child sends completion message
child.send(.Done);

// Parent waits
match(worker.recv(), .Ok(.Done) => /* done */, _ => /* error */);
```

**`kill`**: Too dangerous (memory leaks, dangling refs). Use cooperative cancellation instead.

However, we provide `__yo_worker_join` for convenience during development.

## Implementation Phases

### Phase 1: `spawn_local` - Dedicated OS Thread

**Goal:** Spawn a worker on a dedicated OS thread (not from thread pool).

#### Runtime Data Structures

```c
// Channel for inter-thread communication
typedef struct __yo_channel_t {
  YO_THREAD_SYNC_TYPE mutex;
  YO_COND_TYPE not_empty, not_full;
  void** buffer;
  size_t capacity, head, tail, count;
  _Atomic bool closed;
} __yo_channel_t;

// Worker handle - same type for parent and child
typedef struct __yo_worker_t {
  size_t ref_count;                // Reference count
  __yo_channel_t* send_channel;      // Send TO the other side
  __yo_channel_t* recv_channel;      // Receive FROM the other side
  _Atomic bool self_alive;         // Am I alive? (other reads)
  _Atomic bool* other_alive;       // Is other alive? (points to other's self_alive)
  YO_THREAD_TYPE thread;           // OS thread handle
  bool owns_thread;                // Parent owns, child doesn't
} __yo_worker_t;
```

#### Runtime Functions

```c
// Channel
__yo_channel_t* yo_channel_create(size_t capacity);
void __yo_channel_destroy(__yo_channel_t* ch);
bool __yo_channel_send(__yo_channel_t* ch, void* msg);
void* __yo_channel_recv(__yo_channel_t* ch);
void __yo_channel_close(__yo_channel_t* ch);

// Worker
__yo_worker_t* __yo_worker_spawn_local(callback, closure);
void __yo_worker_join(__yo_worker_t* worker);
bool __yo_worker_is_other_alive(__yo_worker_t* worker);
void __yo_worker_dup(__yo_worker_t* worker);
void __yo_worker_drop(__yo_worker_t* worker);
```

#### Yo Interface

```yo
extern "Yo",
  __yo_worker_t : Type,
  __yo_worker_spawn_local : (fn(callback, closure) -> *(__yo_worker_t)),
  __yo_worker_join : (fn(worker : *(__yo_worker_t)) -> unit),
  __yo_worker_is_other_alive : (fn(worker : *(__yo_worker_t)) -> bool),
  __yo_worker_dup : (fn(worker : *(__yo_worker_t)) -> unit),
  __yo_worker_drop : (fn(worker : *(__yo_worker_t)) -> unit)
;
```

### Phase 2: `send` and `recv` - Message Passing

**Goal:** Enable bidirectional type-safe communication.

#### Sendable Types (Phase 2a: Primitives Only)

- `i32`, `i64`, `u32`, `u64`, `f32`, `f64`
- `bool`, `rune`
- `usize`, `isize`

#### Runtime Functions (Per-Type)

```c
bool __yo_worker_send_i32(__yo_worker_t* worker, int32_t value);
int32_t __yo_worker_recv_i32(__yo_worker_t* worker, bool* ok);
// ... for each primitive type
```

#### Phase 2b: Value Structs

For structs composed entirely of sendable fields, generate:
```c
bool __yo_worker_send_MyStruct(__yo_worker_t* worker, MyStruct value);
MyStruct __yo_worker_recv_MyStruct(__yo_worker_t* worker, bool* ok);
```

### Phase 3: Thread Pool (Future)

**Goal:** Implement `spawn` (vs `spawn_local`) with thread-per-core affinity.

- Fixed number of OS threads (= CPU cores)
- Workers assigned round-robin
- Thread affinity for cache locality
- No work stealing (workers stay on assigned thread)

## Implementation Order

1. **Phase 1a: Basic Infrastructure** ✅
   - [x] Channel data structure and operations
   - [x] Worker type with ref counting
   - [x] `__yo_worker_spawn_local` runtime function
   - [x] Thread-local GC initialization in worker

2. **Phase 1b: Testing**
   - [ ] Test spawn_local with simple callback
   - [ ] Verify thread IDs are different
   - [ ] Verify `other_alive` tracking works
   - [ ] Verify worker cleanup on drop

3. **Phase 2a: Primitive Send/Recv**
   - [ ] Implement `__yo_worker_send_i32` etc.
   - [ ] Test bidirectional i32 communication
   - [ ] Add Result type returns

4. **Phase 2b: Yo Worker Module**
   - [ ] Create `std/worker.yo` with Worker type
   - [ ] Wrap extern functions in nice API
   - [ ] Support generic `Worker(SendType, RecvType)`

## Files Modified

- `src/codegen/parallelism/runtime.ts` - Runtime C code generation
- `src/codegen/functions/generation.ts` - Include parallelism runtime
- `src/tests/examples/fixme.yo` - Test file

## Files to Create

- `std/worker.yo` - High-level Worker API
- `std/channel.yo` - Optional: expose Channel separately

## Open Questions

1. **Channel buffer size**: Fixed 16 for now, configurable later?
2. **Blocking vs async**: Phase 2 is blocking, future may integrate with async/await
3. **Memory for messages**: Currently malloc/free per message, could optimize with arena
