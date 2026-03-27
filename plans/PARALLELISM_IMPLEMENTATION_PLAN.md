# Parallelism Implementation Plan

## Overview

This document outlines the implementation plan for Yo's parallelism features based on the simplified `PARALLELISM.md`.

## New Design (Simplified)

**Thread** = Dedicated OS thread wrapper

- `Thread.spawn(fn)` → spawns a dedicated OS thread
- `Thread.join()` → wait for completion

**Worker** = Thread pool task (fire-and-forget)

- `Worker.spawn(fn)` → runs on thread pool with thread affinity
- No handle returned

**Channel** = Separate abstraction (future)

- Not part of Thread/Worker, implemented separately

## Implementation Phases

### Phase 1: Thread (Dedicated OS Thread) ✅ In Progress

**Goal:** Simple pthread wrapper with spawn and join.

#### C Runtime Types

```c
// Thread handle (value type, stack allocated)
typedef struct __yo_thread_t {
  __YO_THREAD_TYPE handle;  // OS thread handle (pthread_t)
} __yo_thread_t;

// Thread callback type (function + closure)
typedef void (*__yo_thread_fn)(void* closure);
```

#### C Runtime Functions

```c
// Spawn a new OS thread (returns by value)
__yo_thread_t __yo_thread_spawn(__yo_thread_fn fn, void* closure);

// Wait for thread to complete
void __yo_thread_join(__yo_thread_t thread);
```

#### Yo Interface

```rust
// Low-level extern declarations
extern "Yo",
  __yo_thread_t : Type,
  __yo_thread_spawn : (fn(f : Impl(Fn() -> unit, Send)) -> __yo_thread_t),
  __yo_thread_join : (fn(t : __yo_thread_t) -> unit)
;

// High-level wrapper
Thread :: struct(
  handle : __yo_thread_t,

  spawn :: (fn(f : Impl(Fn() -> unit, Send)) -> Self)({
    Self(__yo_thread_spawn(f))
  }),

  join :: (fn(self : Self) -> unit)(
    __yo_thread_join(self.handle)
  )
);
```

### Phase 2: Worker (Thread Pool)

**Goal:** Thread pool with thread-per-core and thread affinity.

#### C Runtime

```c
// Thread pool (global singleton)
typedef struct __yo_thread_pool_t {
  __YO_THREAD_TYPE* threads;     // Array of OS threads
  size_t num_threads;          // Number of threads (= CPU cores)
  __yo_task_queue_t* queues;   // Per-thread task queues
  _Atomic bool shutdown;       // Shutdown flag
} __yo_thread_pool_t;

// Initialize thread pool (called once at startup)
void __yo_thread_pool_init(void);

// Spawn task on thread pool
void __yo_worker_spawn(__yo_thread_fn fn);
```

#### Yo Interface

```rust
Worker :: module(
  spawn :: (fn(f : (fn() -> unit)) -> unit)(
    __yo_worker_spawn(f)
  )
);
```

### Phase 3: Channel (Future)

**Goal:** Type-safe inter-thread communication.

Separate implementation, not tied to Thread/Worker.

## Implementation Order

1. **Phase 1a: Thread Runtime** ✅

   - [x] `__yo_thread_t` structure (value type)
   - [x] `__yo_thread_spawn` function (with closure support)
   - [x] `__yo_thread_join` function
   - [x] Thread-local GC initialization
   - [ ] Codegen support for `Impl(Fn() -> unit, Send)` parameters

2. **Phase 1b: Thread Yo Wrapper**

   - [ ] `Thread` struct in fixme.yo
   - [ ] Test spawn/join

3. **Phase 2: Worker Runtime**

   - [ ] Thread pool initialization
   - [ ] Per-thread task queues
   - [ ] Round-robin task assignment
   - [ ] `__yo_worker_spawn` function

4. **Phase 3: Channel (Future)**
   - [ ] `Channel(T)` type
   - [ ] `send`/`recv`/`close`

## Files

- `src/codegen/parallelism/runtime.ts` - C runtime generation
- `src/codegen/functions/generation.ts` - Include runtime
- `src/tests/examples/fixme.yo` - Test file
- `std/thread.yo` - High-level Thread API (future)
- `std/worker.yo` - High-level Worker API (future)
- `std/channel.yo` - Channel API (future)

## Design Decisions

1. **No channels in Thread/Worker** - Channels are separate, can be used with either
2. **Thread uses struct** - Simple value type with handle
3. **Worker is fire-and-forget** - No handle, just spawn and forget
4. **Kill is cooperative** - Sets flag, thread must check and exit
