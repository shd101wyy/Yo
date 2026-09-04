# Cycle Collection

Yo uses **non-atomic reference counting** with **thread-local cycle collection** to reclaim cyclic structures. The cycle collector uses **QuickJS's trial deletion algorithm**, which is simpler than [Nim's ORC coloring approach](https://nim-works.github.io/nimskull/gc.html) while providing similar performance. The implementation is adapted for Yo's **isolated spawn model** where each thread has complete isolation with no shared memory.

## Why Cycle Collection?

Reference counting cannot reclaim cycles:

```rust
// Create a cycle
node_a := ref(struct(value: 1, next: .None));
node_b := ref(struct(value: 2, next: .Some(node_a)));
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

### Thread-Local Collection

Each thread has its own cycle collector with complete isolation. No stop-the-world pauses are needed because Yo uses an **isolated spawn model** where threads share no memory.

```c
// Per-thread GC state
typedef struct __yo_thread_gc_state_t {
  __yo_ref_header_t* tracked_objects;  // Doubly-linked list of potentially cyclic objects
  size_t tracked_count;              // Number of tracked objects
  __YO_THREAD_TYPE thread_id;          // Owning thread
  size_t alloc_count;                // Allocations since last GC
  struct __yo_thread_gc_state_t* next; // For global thread list (cleanup only)
  struct __yo_thread_gc_state_t* prev;
} __yo_thread_gc_state_t;

static _Thread_local __yo_thread_gc_state_t* __yo_current_thread_gc;
```

### When to Collect: Adaptive Object Count Threshold

Yo uses an **adaptive tracked object count threshold** to trigger cycle collection:

1. **Initial threshold**: 256 objects
2. **Trigger**: When `tracked_count >= threshold`, run cycle collection
3. **Adaptive scaling**: After each collection, `threshold = max(256, 2 × remaining_objects)`

This approach is similar to QuickJS and balances several concerns:

- **Predictable**: Collects based on object count, not memory size
- **Efficient**: Avoids frequent collection with few objects
- **Adaptive**: Grows threshold for programs with many long-lived cyclic objects
- **Simple**: No need to track per-object sizes

**Example behavior:**

```
Initial: threshold = 256
After creating 256 objects → GC runs, 10 survive → threshold = max(256, 20) = 256
After creating 256 more objects → GC runs, 200 survive → threshold = max(256, 400) = 400
After creating 400 more objects → GC runs, 300 survive → threshold = max(256, 600) = 600
```

**Why object count over memory threshold:**

- Thread-local objects are typically similar sizes (no huge variance)
- Tracking object count is cheaper than tracking bytes
- Cycle collection cost is proportional to object count, not bytes
- Fits well with the thread-local isolation model

**Explicit collection** can also be triggered via `gc.collect()`:

```rust
import std/gc;

// Force cycle collection
gc.collect();

// Query tracked object count
count := gc.tracked_count();
```

**When to track:**
Only objects that can form cycles are tracked:

- Objects with reference-type fields
- Closures capturing reference-counted values
- Dyn trait objects

**Skip tracking:**

- Value types (struct with no Rc fields)
- Primitives
- Objects with no internal references

### Algorithm Implementation

#### Phase 1: Trial Deletion

```c
void __yo_gc_mark_phase(__yo_gc_state_t* gc) {
    // 1. Mark all tracked objects as candidates
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        obj->gc_mark = GC_CANDIDATE;
    }

    // 2. Trial deletion: decrement RC of all objects reachable from candidates
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        if (obj->gc_mark == GC_CANDIDATE) {
            __yo_gc_trial_delete(obj);  // Recursively decrement RC
        }
    }

    // 3. Mark survivors: objects with RC > 0 after trial deletion
    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];
        if (obj->ref_count > 0) {
            obj->gc_mark = GC_LIVE;
        } else {
            obj->gc_mark = GC_GARBAGE;
        }
    }
}

void __yo_gc_trial_delete(__yo_object* obj) {
    if (obj->gc_mark != GC_CANDIDATE) return;

    obj->gc_mark = GC_TRIAL_DELETED;

    // Traverse fields and trial-delete referenced objects
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, __yo_gc_trial_delete_visitor);
    }
}

void __yo_gc_trial_delete_visitor(__yo_object* referenced) {
    referenced->ref_count--;  // Non-atomic decrement
    if (referenced->ref_count > 0 && referenced->gc_mark == GC_CANDIDATE) {
        __yo_gc_trial_delete(referenced);
    }
}
```

#### Phase 2: Restore and Sweep

```c
void __yo_gc_sweep_phase(__yo_gc_state_t* gc) {
    size_t write_index = 0;

    for (size_t i = 0; i < gc->tracked_count; i++) {
        __yo_object* obj = gc->tracked_objects[i];

        if (obj->gc_mark == GC_LIVE) {
            // Restore RC for live objects
            __yo_gc_restore_rc(obj);
            gc->tracked_objects[write_index++] = obj;
        } else if (obj->gc_mark == GC_GARBAGE) {
            // Free garbage
            __yo_free_object(obj);
            gc->objects_collected++;
        }
    }

    gc->tracked_count = write_index;
}

void __yo_gc_restore_rc(__yo_object* obj) {
    if (obj->gc_mark != GC_LIVE) return;

    obj->gc_mark = GC_RESTORED;

    // Restore RC for referenced objects
    if (obj->traverse_fn) {
        obj->traverse_fn(obj, __yo_gc_restore_visitor);
    }
}

void __yo_gc_restore_visitor(__yo_object* referenced) {
    referenced->ref_count++;  // Non-atomic increment
    if (referenced->gc_mark == GC_LIVE) {
        __yo_gc_restore_rc(referenced);
    }
}
```

### Isolated Spawn Model

Yo uses **complete thread isolation** - spawned tasks run on separate threads with **no shared memory**. Communication happens exclusively through typed message passing (see `PARALLELISM.md`).

**Why this simplifies GC:**

1. Each thread has its own heap - no cross-thread references
2. Each thread has its own cycle collector - no coordination needed
3. No need to track which objects can be "stolen" - nothing moves between threads
4. Only value types can be sent between threads (copied, not shared)

```rust
// Parent thread
x := 42;
node := Node(1, .None);  // Cycle-forming type, stays on this thread

// Spawn an isolated OS thread — `Thread.spawn` from std/thread.
// (There is no `Task` type; the async API is `io.async` / `io.await` / `io.spawn`,
// which are single-threaded and do NOT create threads.)
handle := Thread.spawn((io) => {
  // The plain ref(...) `node` above is thread-local and cannot be captured here.
  // Only Send values cross: value types, Arc(T), and the std/imm structures.
  ()
});
handle.join();
```

**What can be sent between threads (value types only):**

| Type                             | Can Send? | Reason                          |
| -------------------------------- | --------- | ------------------------------- |
| Primitives (`i32`, `bool`, etc.) | ✅ Yes    | Value type, copied              |
| Value structs (`struct(...)`)    | ✅ Yes    | Value type, copied              |
| Tuples of value types            | ✅ Yes    | Value type, copied              |
| Enums with value payloads        | ✅ Yes    | Value type, copied              |
| `ref(struct(...))`               | ❌ No     | Reference counted, thread-local |
| Closures                         | ❌ No     | May capture references          |
| `*(T)` (pointers)                | ❌ No     | Not safe across threads         |

**Key Design Decision:** PLAIN (non-atomic) reference types (`ref(struct(...))`) are thread-local and never cross thread boundaries. The ATOMIC forms — `atomic(ref(...))`, i.e. `Arc`, `std/sync` and `std/imm` — are `Send` and are shared across threads with atomic RC (and are therefore not cycle-collected). This means:

- Each thread's GC only tracks objects created on that thread
- No cross-thread GC coordination needed
- No atomic reference counting needed
- Simple, predictable garbage collection

**Common patterns:**

```rust
{ Thread } :: import("std/thread");
{ Channel } :: import("std/sync/channel");

// ✅ Message passing with Send values, over a channel
main :: (fn(io : Io) -> unit)({
  // The main thread owns the cycle-forming structure; it stays here.
  tree := ComplexTree();

  ch := Channel(i32).new();
  worker := Thread.spawn((io) => {
    // Only Send values cross: value types, Arc(T), std/imm structures.
    ch.send(expensive_computation());
    ()
  });

  match(ch.recv(), .Some(result) => tree.update(result), .None => ());
  worker.join();
});
```

Each thread runs its own independent event loop, so a spawned thread can still
use `io.async` / `io.await` without contention. See `PARALLELISM.md`.

**GC Collection Process:**

```c
void __yo_gc_collect_thread_local() {
    // No synchronization needed - thread-local only
    __yo_gc_state_t* gc = &__yo_gc_state;

    // Run trial deletion on this thread's tracked objects
    __yo_gc_mark_phase(gc);
    __yo_gc_sweep_phase(gc);

    // Other threads continue running in parallel
}
```

**Benefits of isolated spawn for GC:**

- ✅ No stop-the-world pauses (each thread collects independently)
- ✅ Predictable per-thread pause times (O(thread's objects))
- ✅ Perfect scaling (threads don't interfere)
- ✅ No cross-thread coordination needed
- ✅ Non-atomic reference counting (zero synchronization overhead)
- ✅ Simple implementation (no stealability analysis needed)

## Performance Characteristics

### Thread-Local Collection

**Strengths:**

- ✅ Non-atomic RC in hot path (zero synchronization overhead)
- ✅ No stop-the-world pauses (each thread collects independently)
- ✅ Predictable per-thread pause times (O(thread's objects))
- ✅ Perfect scaling (N threads = N independent collectors)
- ✅ Complete thread isolation (no cross-thread GC concerns)
- ✅ Real-time friendly (no global synchronization)
- ✅ Simple implementation (no stealability tracking needed)

**Trade-offs:**

- ⚠️ Reference types cannot be shared between threads (must use message passing)
- ⚠️ Large data must be copied when sent between threads

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

## API

```rust
{ collect, tracked_count } :: import("std/gc");

collect();          // Trigger an immediate cycle collection
tracked_count();    // u64 — objects currently tracked by the collector
```

That is the whole surface (`std/gc.yo`). There is no statistics struct and no
threshold-setting function; collection frequency is tuned with environment
variables read by the emitted runtime:

| Variable | Effect |
|---|---|
| `YO_GC_THRESHOLD` | Raises the allocation threshold that triggers a collection — or DISABLES the collector entirely |
| `YO_GC_FULL_PCT` | Full-scan growth factor, as a percent of post-collection live set (default 200, i.e. 2x-live). Lower to cap peak memory; raise for fewer but larger scans |

## Compiler Support

### Automatic Tracking

Compiler generates tracking code for cycle-forming types:

```rust
// User code
Node :: ref(struct(value: i32, next: Option(Node)));

// Generated tracking
node := Node(42, .None);  // Calls __yo_gc_track(node)
```

### Traverse Function Generation

Every cycle-forming object carries a `traverse_fn` in its header. The collector calls
it during both trial deletion and restoration, passing a `visit` callback that must be
applied to **every managed reference the object directly holds**. Missing an edge only
ever leaks (conservative); visiting a wrong pointer is a use-after-free, so the
generated traversal is built to be exact.

The compiler generates this traversal **compositionally**. It descends inline through
value structure — nested value structs, value enums (including `Option`), tuples, and
inline arrays — and stops at each managed handle, which it visits:

```c
// Auto-derived for Node :: ref(struct(value : i32, next : Option(Node)))
void Node_traverse(void* obj, void (*visit)(void*)) {
    Node* node = (Node*)obj;
    // `Option(Node)` is nullable-pointer-optimized: visit the bare pointer when set.
    if (node->next != NULL) {
        visit(node->next);  // the directly-held managed Node
    }
}
```

This per-field descent is exactly the **auto-derived `Trace` behaviour** (see
[The `Trace` Trait](#the-trace-trait)). It works for every struct and enum because
their children live in named fields the compiler can see. It does **not** work for
containers like `ArrayList` or `HashMap`, whose elements live in a heap buffer behind a
raw pointer the field walk cannot follow — those types provide a hand-written `Trace`
impl, and their `traverse_fn` delegates to it.

### Object Registration

Compiler generates code to register objects with thread-local GC:

```c
// Generated code for object allocation
Node* node = __yo_alloc_object(sizeof(Node));
node->value = 42;
node->next = OPTION_NONE;

// Register with thread-local GC (no synchronization needed)
__yo_gc_track(&__yo_gc_state, (__yo_object*)node);

// Increment thread-local allocation counter
__yo_gc_state.alloc_count++;
if (__yo_gc_state.alloc_count >= __YO_GC_THRESHOLD) {
    __yo_gc_collect_thread_local();  // Collect this thread only
    __yo_gc_state.alloc_count = 0;
}
```

Since spawned tasks are completely isolated (no shared memory), there's no need to track "stealability" - each thread simply manages its own objects independently.

## The `Trace` Trait

Cycle collection rests on one contract: the collector must be able to enumerate the
managed references each object holds. That contract is the `Trace` trait, defined in
`std/prelude.yo`:

```rust
Trace :: trait(
  id := "Trace",
  trace : (fn(self : Self, tracer : GcTracer) -> unit),
  where(Self <: Rc)
);
```

A `trace` implementation calls `tracer.visit(...)` once per outgoing edge. The compiler
turns each type's `trace` into the `traverse_fn` stored in its object header.

### Auto-derived for structs, enums, and value types

You almost never write a `Trace` impl. The compiler **auto-derives** one for every
reference type whose children sit in named fields it can see:

- `ref(struct(...))` — visits each managed field; descends inline through value-typed
  fields.
- `ref(enum(...))` — switches on the tag and visits the active variant's managed fields.
- `Option`, tuples, nested value structs/enums, and inline arrays — traversed inline as
  part of their containing field.

So an `Option(Node)` field, a `(Node, i32)` tuple field, or a value struct holding a
`Node` all just work — no annotation, no impl.

### Hand-implemented for buffer-backed containers

The only types that need a hand-written `Trace` impl are containers that store their
elements in a heap buffer reached through a raw pointer (`ArrayList`, `HashMap`, …). The
auto-derived field walk stops at the raw buffer pointer and never reaches the elements,
so the container must trace each element slot itself. `ArrayList` (in
`std/collections/array_list.yo`):

```rust
impl(generic(T : Type), ArrayList(T),
  Trace(
    trace : (fn(self : Self, tracer : GcTracer) -> unit)({
      match(
        self._ptr,
        .Some(base) => {
          (i : usize) = usize(0);
          while(i < self._length, {
            tracer.visit(base.add(i));  // pass the element's SLOT POINTER
            i = (i + usize(1));
          });
        },
        .None => ()
      );
    })
  )
);
```

### `GcTracer` and the slot-pointer rule

`GcTracer` is an opaque handle that carries the collector's edge-registration callback:

```rust
GcTracer :: newtype(_callback : *(u8));

// (in `impl(GcTracer, ...)`)
visit : (fn(generic(T : Type), self : Self, slot : *(T)) -> unit)
```

`visit` takes a **pointer to where the child lives** (a struct field or a buffer slot),
never the child by value. This is the critical correctness rule: `visit` reads `*slot`
**without touching its reference count**, registers the edge if it is a managed handle,
and recurses inline through value structure otherwise. Passing the element by value
would dup it and then drop it when `trace` returns — freeing a live, RC-1 element in the
middle of a collection (a use-after-free). Passing the slot pointer keeps tracing
reference-count-neutral, matching the auto-derived `visit(&obj->field)` form.

When implementing `Trace` for a new container, the rules are simply:

1. Call `tracer.visit(slot)` for **every** element slot — missing one leaks; there is no
   crash risk.
2. Always pass a **pointer to the slot**, never the element by value.
3. You do not recurse into the elements yourself — `visit` handles whatever a slot holds
   (a managed handle, a value struct, a nested `Option`, …) compositionally.

## Comparison with Other Approaches

| Approach                              | Pause Time   | Cross-Thread         | Complexity  | Performance        |
| ------------------------------------- | ------------ | -------------------- | ----------- | ------------------ |
| **QuickJS trial deletion**            | O(N)         | No (single-threaded) | Low         | Good               |
| **Nim ORC (coloring)**                | O(N/threads) | No (thread affinity) | Medium-High | Excellent          |
| **Python (cycle detector)**           | O(N)         | Yes (GIL serializes) | Medium      | Good with GIL      |
| **Swift (weak references)**           | O(1)         | Yes                  | Low         | Excellent          |
| **Java (tracing GC)**                 | O(heap)      | Yes                  | High        | Variable           |
| **Go (mark-sweep)**                   | O(heap)      | Yes                  | High        | 10-100ms STW       |
| **Yo (QuickJS-style trial deletion)** | O(N/threads) | No (isolated)        | Low         | 0.5-5ms per thread |

## Performance: adaptive Bacon-Rajan (incremental + full-heap fallback)

> **Status:** IMPLEMENTED. The trial-deletion collector above is now the
> _thorough_ path (explicit `Gc.collect()`); the auto-trigger uses an incremental
> Bacon-Rajan collector with adaptive frequency. With GC on by default, the
> self-compile-class workload (`check ./std`) runs in ~5.7s (≈ GC-disabled, and
> faster than the TS host's 17s) instead of stalling.

### When the trial-deletion collector becomes a bottleneck

`__yo_gc_collect` walks the whole `tracked_objects` list across all of its phases
(mark-candidates → trial-delete-traverse → classify → scan-restore → dispose+free)
— i.e. **O(all tracked objects)** per collection, triggered whenever
`tracked_count` reaches the adaptive threshold (256, growing to 2× live). That is
fine when collections reclaim a meaningful fraction of the heap, but it degrades
badly when **most tracked objects are live and there are few cycles**: every
collection re-scans the entire live graph to reclaim almost nothing.

The compiler is the worst case — compiling a large program builds millions of
live, RC-managed AST / type / value / environment nodes with very few cycles.
Profiling the self-compile showed the process **stalled at ~8.7% CPU**, dominated
by `__yo_gc_trial_delete_visitor` / `traverse` / `__yo_gc_collect`. Disabling the
collector took the same run to **100% CPU** (no GC stalls), confirming the
collector — not the evaluator — was the throttle.

### Stopgap: `YO_GC_THRESHOLD`

A one-time env read (`__yo_init_thread_gc`, mirrors `YO_MAIN_STACK_MB`) lets a run
raise or disable auto-collection:

- **unset** — default adaptive 256 collector (unchanged).
- **`N`** — set the live threshold and adaptive floor to `N`.
- **`0`** — disable auto-collection (threshold = `SIZE_MAX`). Use for short-lived,
  allocation-heavy runs (e.g. the compiler) where cycles, if any, are reclaimed
  by the OS at process exit anyway.

### Peak-memory knob: `YO_GC_FULL_PCT`

The full-heap collector re-arms its trigger at a multiple of the **post-collection
live count** — by default `200` (2×-live), which bounds the tracked set to ~2× the
live working set between full scans. On a memory-constrained box a workload with a
large live set (e.g. the self-hosted compiler evaluating its own modules) can have
its 2×-live peak exceed physical RAM, causing swap-thrash or an OOM kill. A second
one-time env read (same `__yo_init_thread_gc` site) tunes this factor:

- **unset** — default `200` (2×-live), unchanged.
- **`N` (> 100)** — re-arm the full scan at `N`% of live. Lower values (e.g. `130`,
  `115`) cap peak memory at the cost of more frequent — and individually
  ~`O(heap)` — full scans. Values ≤ 100 are ignored (a factor ≤ 1 cannot make
  forward progress; the trigger always advances by at least one object).

This trades throughput for a lower memory ceiling; it cannot shrink the **live**
set itself, so a workload whose live working set alone exceeds available RAM still
needs a larger machine or a smaller live footprint.

### The fix: adaptive Bacon-Rajan possible-roots (auto) + full-heap (explicit)

The auto-trigger uses **Bacon-Rajan synchronous cycle collection**
(`__yo_gc_collect_incremental`). The key observation: only an object whose
reference count is **decremented to a non-zero value** can be the root of a
garbage _cycle_ (a "possible root"). So instead of scanning every tracked object,
the incremental collector processes only the **possible-roots buffer** and the
subgraph reachable from it:

1. **Buffer candidates in `__yo_decr_rc`.** When `--ref_count` leaves it `> 0`,
   add the object to a `possible_roots` list (an intrusive doubly-linked list so
   removal at free is O(1) and no dangling pointer can survive in the buffer) and
   color it _purple_. Acyclic garbage (RC → 0) is still freed eagerly, exactly as
   today.
2. **Trigger** a collection on `possible_roots` length (not `tracked_count`).
3. **Collect** over the roots only, using the classic colors (purple = buffered
   candidate, gray = trial-deleted, white = garbage, black = live):
   - **MarkGray** each purple root, trial-decrementing internal references over
     its reachable subgraph.
   - **Scan** each root: a gray object with RC > 0 is live → **ScanBlack**
     (restore counts); otherwise it is white (cycle garbage).
   - **CollectWhite** frees the white subgraph (dispose then free, in two passes
     so a member's traversal never touches an already-freed sibling), then clears
     the buffer.

Each incremental collection is **O(possible-roots + their reachable subgraph)**
rather than O(all tracked). Because a cycle collection still traverses that
reachable subgraph — which on a densely-connected, mostly-live heap (the compiler)
is ≈O(heap) — the trigger threshold is **adaptive**: a pass that reclaims nothing
grows it ×4 (capped), so dense cycle-poor workloads stop thrashing; a productive
pass resets to the floor.

**Move-formed cycles.** A cycle created purely by _moving_ a value into its own
field (`a.child = .Some(a)` where the codegen elides the incr+decr) produces no
"possible root" event, so the incremental collector cannot see it. The **explicit
`Gc.collect()`** path (`__yo_gc_collect`) remains a full-heap trial-deletion scan
and reclaims those; it also runs on demand. So the design is a hybrid: cheap
incremental on the hot (auto) path, thorough full-heap on the explicit path.

This keeps the collector on by default with no env override (the `YO_GC_THRESHOLD`
knob remains as a floor/disable). It is correctness-critical (it touches the free
path) and is validated against the cycle-collector tests
(`tests/cycle_collector.test.yo`, `tests/codegen-bootstrap/*_self_cycle.yo`,
`ref_enum_cycle.yo`) — 16/16 plus the `arc` / `closure_capture_rc_leak` /
`continue_rc_cleanup` / `ref_enum` suites — under AddressSanitizer.

## Summary

Yo's cycle collection design:

1. ✅ **Non-atomic RC** - zero synchronization overhead in hot path
2. ✅ **Thread-local cycle collection** - no stop-the-world pauses
3. ✅ **QuickJS trial deletion** - simple, proven algorithm (simpler than [Nim's coloring approach](https://nim-works.github.io/nimskull/gc.html))
4. ✅ **Isolated spawn model** - each thread has its own heap, no shared memory
5. ✅ **Short per-thread pauses** - 0.5-5ms typical per thread (only that thread's cycles)
6. ✅ **Simple implementation** - no cross-thread coordination or stealability tracking
7. ✅ **Real-time friendly** - predictable latency, no global synchronization

The key insights are:

- **Reference counting frees most objects immediately** - GC only handles cycles
- **Thread-local collection scales perfectly** - N threads = N independent collectors
- **Complete isolation eliminates complexity** - no need to track what can move between threads
- **No global pauses** - each thread collects independently while others continue
- **Value-type message passing** - safe inter-thread communication without sharing references

This design gives **excellent performance** (better than Go's 10-100ms STW pauses) and **predictable latency** for real-time applications, with a simpler implementation than work-stealing approaches.
