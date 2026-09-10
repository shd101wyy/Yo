# Thread-local storage

**Status:** BACKLOG — designed here, not started. Written 2026-09-10; the std
row it blocks is `rand`'s missing `thread_rng`.

## The problem

Yo has no thread-local storage. `std/rand.yo` records the consequence at the
point where it bites (`std/rand.yo:225`):

> **This is NOT Rust's `thread_rng`, and is deliberately not named that.**

and `plans/STD_API_STABILIZATION.md`:

> `thread_rng`: Yo has no thread-local storage, so per-thread generators are
> not expressible; the doc says to take an own `Rng.from_entropy()` in a hot
> loop instead.

So the process-global generator is shared, and a caller who wants a
non-contended one must construct and carry it. The same absence is why
`std/encoding/html`'s entity tables were an unsynchronised lazy global (a §3
P0 row), and why `Once` exists at all.

## What it blocks

| want | today |
| --- | --- |
| `rand.thread_rng()` — a per-thread generator, no contention, no plumbing | a process-global generator plus advice to construct your own |
| per-thread scratch buffers (a formatter's, a hasher's) | allocate per call, or thread a buffer parameter through |
| per-thread caches in the COMPILER (`src/`) — the evaluator's memo tables are process-global | `_Thread_local` in emitted C, reachable only from codegen |

The third is worth noting: the emitted C runtime already uses
`_Thread_local` (`src/codegen/async/runtime_io_common.yo` declares
`static _Thread_local __yo_poll_t* __yo_active_polls`), so the C-level
mechanism is in the tree and proven. What is missing is a Yo-level spelling.

## Design

### The declaration

A module-level binding marked thread-local, initialized lazily per thread:

```rust
thread_local(rng : Rng) = Rng.from_entropy();
```

- **Module-level only.** A thread-local inside a function has no meaning Yo
  needs, and restricting it keeps the lowering trivial.
- **Lazily initialized, per thread, on first access.** This is what makes
  `Rng.from_entropy()` legal as an initializer — it is a syscall, and running
  it eagerly for every thread at spawn would be both wasteful and a
  first-touch hazard. Rust's `thread_local!` has the same semantics.
- **Access is ordinary.** Reading `rng` reads this thread's instance. No
  `.with(|r| …)` closure dance: Yo has no borrow checker to appease, which is
  the reason Rust needs the closure.

### The lowering

`_Thread_local` on the emitted C global, plus a per-thread `bool` init flag
and the initializer inlined behind it:

```c
static _Thread_local Rng __yo_tl_rng;
static _Thread_local bool __yo_tl_rng__init = false;
static inline Rng* __yo_tl_rng__get(void) {
  if (!__yo_tl_rng__init) { __yo_tl_rng = /* initializer */; __yo_tl_rng__init = true; }
  return &__yo_tl_rng;
}
```

`_Thread_local` is C11 and available on every target Yo ships
(`plans/reference/TARGET_TRIPLES.md`), including the wasm targets — with a
caveat below.

### Destruction

This is the hard part, and the design should NOT pretend otherwise.

A thread-local holding an RC value (`String`, `ArrayList`, any `ref` struct)
must be released when the thread exits, or every spawned thread leaks its
instance. C11 `_Thread_local` has no destructor hook;
`pthread_key_create`'s destructor does, and Windows has
`FlsAlloc`/`FlsSetValue`.

Three options:

1. **Restrict to `Acyclic`, non-RC value types** (integers, floats, plain
   structs of them). No destruction needed, so nothing to get wrong. Covers
   `thread_rng` — `Rng` is a plain state struct — and the scratch-integer
   cases, and nothing else.
2. **`pthread_key_create` + `FlsAlloc` with a generated destructor** per
   thread-local whose type has a `Dispose` or an RC field. Correct, and the
   full feature; it also means every access goes through
   `pthread_getspecific` rather than a direct `_Thread_local` read, which is
   slower.
3. **`_Thread_local` for the trivial case, keyed storage for the rest**,
   chosen by the declared type. Fast where it can be, correct where it must
   be, and the compiler decides — no user-visible difference.

**Recommend (1) first, then (3).** Option 1 closes the `thread_rng` row in a
small, obviously-correct change, and refuses everything it cannot release
with a diagnostic that names the restriction. Option 3 is the eventual shape,
and Option 1's restriction is exactly the condition Option 3 branches on, so
the first is not wasted work.

### WASM

`emscripten` supports `_Thread_local` only with pthreads enabled;
`wasm32-wasip1` is single-threaded in Yo's configuration. On both, a
thread-local can lower to an ordinary global — correct, because there is one
thread. That must be an explicit branch in codegen with a comment, not an
accident.

## Implementation sketch

1. **Parser** — `thread_local(name : T) = init;` as a module-level form, next
   to where `(g : T) = v` runtime globals are parsed. A new `ExprInfo` flag
   rather than a new node type, if the existing global path can carry it.
2. **Evaluator** — treat it as a runtime global for typing and name
   resolution; reject a non-module-level declaration; under Option 1, reject
   a type that is not `Acyclic` and RC-free, naming the restriction.
3. **Codegen** — emit `_Thread_local` storage, the init flag and the accessor;
   route reads through the accessor. Single global on the WASM targets.
4. **`std/rand.yo`** — `thread_rng()` returning a pointer/reference to this
   thread's generator, and the module doc's "deliberately not named that"
   paragraph replaced by the real thing.

## Acceptance

- Two threads each drawing from `thread_rng()` produce independent sequences,
  and neither observes the other's state. The test must SPAWN
  (`tests/thread*.test.yo` style) — a single-threaded test proves nothing.
- A thread-local read from the main thread before any spawn works (first
  touch initializes).
- `comptime_expect_error` on a thread-local of a type carrying an RC field,
  under Option 1's restriction.
- The wasm32 legs pass, exercising the single-global branch.
