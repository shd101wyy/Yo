# Isolated Type

`Iso(T)` moves a reference object that is NOT `Send` — a plain `ref(struct)` graph, an
`ArrayList`, a `HashMap` — to another thread, exactly once. It is the one way a non-atomic object
legitimately crosses a thread boundary. The rules are D2 of
`plans/reference/PARALLELISM_RULES.md`.

## The model

- **The wrapper is an atomic object.** An `Iso(T)` handle is atomically reference-counted, so
  copying it into a spawn closure and dropping the copies on two threads is safe.
- **The inner `T` keeps its own non-atomic reference counting.** It is never touched through
  the wrapper except by `extract()`, which hands it to exactly one thread.
- **`Iso(T)` is `Send` without `T <: Send`.** The argument is uniqueness: when the `Iso` is made,
  nothing else on the sending thread can reach any non-atomic object in the value's graph, and
  `extract()` gives the graph to exactly one thread — so every non-atomic reference count in it is
  only ever updated by one thread at a time.
- **Uniqueness is established at construction**, by the `^` operator, and it is DEEP: every
  non-atomic object reachable from the value must be uniquely owned.

## Constructing an `Iso`: the `^` operator

```rust
xs := ArrayList(i32).new();
xs.push(i32(1));
iso_opt := ^xs;                // Option(Iso(ArrayList(i32)))
match(
  iso_opt,
  .Some(iso) => { /* send it */ },
  .None => { /* something else still reaches the list: nothing was moved */ }
);
```

`^v` consumes `v` (a later use of `v` is "use of moved value") and answers `.None` rather than
panicking when the value is not unique. It performs:

1. **Compile-time checks on the variable** — `v` must own its reference-counted value, no other
   variable may alias it, and its type may not be able to form a reference cycle (a cycle would
   need the per-thread cycle collector, which the receiving thread does not run for it).
2. **A run-time walk of the whole graph** (`__yo_iso_unique`): every non-atomic object
   reachable from `v`, `v` included, must have a reference count of exactly 1. The walk goes
   through the same per-type traversal the cycle collector uses — struct and enum fields, and a
   container's elements through its `Trace` impl — with an explicit worklist, so a long list does
   not recurse. An ATOMIC object inside the value (an `Arc`, a `Mutex`, an `AtomicI32`) is shared
   by design and stops the walk: capturing a shared counter in an isolated graph is fine.

```rust
shared := ArrayList(i32).new();
w := Wrap(items : shared);     // Wrap :: ref(struct(items : ArrayList(i32)))
r := ^w;                       // .None: `shared` still reaches w.items
```

The cost is one walk over the value's graph, once per hand-off, on the sending thread.

**`T` must be a non-atomic reference object** (a `ref(struct)`, a `ref(enum)`, `ArrayList`,
`HashMap`, `Box`, ...). `Iso(i32)` or `Iso(SomeValueStruct)` is a compile error — a value is
copied on send, so pass it directly (or `Box` it). `Iso(Arc(T))`, `Iso(<atomic object>)` and
`Iso(Iso(T))` are compile errors too: those are already sendable as they are.

**The raw constructor `Iso(T)(v)`** is what `^` expands to, and it is not available in safe code
(a file without `pragma(Pragma.AllowUnsafe)`): it checks nothing inside the value. Use `^`.

## `extract`

```rust
inner := iso.extract();        // T
```

`extract()` returns the inner `T` directly (not an `Option`), marks the `Iso` extracted, and
panics if it is called a second time on any copy of the same `Iso`:

```
panic: Iso::extract() called on already-extracted Iso
```

The atomic one-shot flag is what gives the value exactly one owner after a hand-off: a sending
thread that kept a copy of the `Iso` can never extract it once the receiver has, and dropping that
copy then frees nothing. After extraction the value uses non-atomic reference counting: keep it
on the extracting thread. Dropping an `Iso` that was never extracted releases the inner value (on
whichever thread drops the last handle — sound, because that thread is then the only one that
can reach it).

## What is emitted

```c
typedef struct {
  __yo_ref_header_t header;   // atomic RC — the handle is an atomic object
  _Atomic bool extracted;     // the one-shot flag
  T value;                    // the inner object handle, non-atomic RC
} Iso_T_struct;

bool __yo_iso_unique_Iso_T(T value);  // the construction-time graph walk
T __yo_iso_extract_Iso_T(Iso_T iso) {
  if (atomic_exchange(&iso->extracted, true)) { /* panic: already extracted */ }
  return iso->value;
}
void __yo_iso_dispose_Iso_T(Iso_T iso) {
  if (!atomic_load(&iso->extracted)) { __yo_decr_rc((void*)iso->value); }
}
```

## Composition rules

- `Iso(Arc(T))`, `Iso(<atomic object>)` and `Iso(Iso(T))` are compile errors — send the value
  directly.
- `Arc(Iso(T))` is a compile error — `Arc` shares, `Iso` is unique.
- `Iso(T)` is `Acyclic` when `T` is.

## Example: hand a list built on a worker back to the main thread

```rust
{ Thread } :: import("std/thread");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");

build :: (fn() -> Option(Iso(ArrayList(String))))({
  xs := ArrayList(String).new();
  xs.push(`built on the worker`);
  ^xs
});

main :: (fn() -> unit)({
  t := Thread(Option(Iso(ArrayList(String)))).spawn((io : Io) => build());
  match(
    t.join(),
    .Some(iso) => {
      xs := iso.extract();     // the list now lives on the main thread
      // ...
    },
    .None => ()
  );
});
```

## Example: rejected at construction

```rust
x := box(i32(42));
y := x;
iso := ^x;                     // COMPILE ERROR: cannot isolate x, also owned by y
```
