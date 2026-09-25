# Isolated Type

`Iso(T)` moves a value that is NOT `Send` — a plain `ref(struct)` graph, an `ArrayList`, a
`String` — to another thread, exactly once. It is the one way a non-atomic object legitimately
crosses a thread boundary.

## The model

- **The wrapper is an atomic object.** An `Iso(T)` handle is atomically reference-counted, so
  copying it into a spawn closure and dropping the copies on two threads is safe.
- **The inner `T` keeps its own non-atomic reference counting.** It is never touched through
  the wrapper except by `extract()`, which hands it to exactly one thread.
- **`Iso(T)` is `Send` without `T <: Send`.** The argument is uniqueness: at the moment of
  `extract()` at most one thread can reach the inner value, so its non-atomic reference counts
  are only ever updated by one thread.
- **Uniqueness is established at construction**, by the `^` operator, and is where the safety
  rests. The rule being brought in by `plans/reference/PARALLELISM_RULES.md` D2 makes it DEEP
  (every reachable non-atomic object must be uniquely owned); today it is shallow (see below).

## Constructing an `Iso`: the `^` operator

```rust
data := box(i32(42));
iso_opt := ^data;              // Option(Iso(Box(i32)))
match(
  iso_opt,
  .Some(iso) => { /* send it */ },
  .None => { /* `data` was shared: nothing was moved */ }
);
```

`^v` consumes `v` (a later use of `v` is "use of moved value") and answers `.None` rather than
panicking when the value is not unique. It performs:

1. **Compile-time checks on the variable** — `v` must own its reference-counted value, no other
   variable may alias it, and its type may not be able to form a reference cycle (a cycle would
   need the per-thread cycle collector, which the receiving thread does not run for it).
2. **A run-time uniqueness check**, `Isolation.can_isolate(v)`. Today only `Box(T)`
   implements `Isolation` (`rc(self) == 1`); a user type implements it by hand:

```rust
Data :: ref(struct(v : i32));
Point :: ref(struct(x : Data, y : Data));
impl(Data, Isolation(can_isolate : (self -> (rc(self) == 1))));
impl(
  Point,
  Isolation(
    can_isolate : (self -> ((rc(self) == 1) && self.x.can_isolate() && self.y.can_isolate()))
  )
);
```

The `Point` impl shows what "deep" means and why a hand-written shallow one is a bug: if
`can_isolate` looked only at `rc(self)`, a `Point` whose `x` is shared with a local would be
moved while the local keeps mutating `x`. D2 replaces this hand-written walk with a generated
one (`__yo_iso_unique_<T>`) and keeps `Isolation` as an optional fast path.

**The raw constructor `Iso(T)(v)`** exists and is what the compiler emits for `^`. Calling it
directly runs the compile-time checks only when the argument is a named variable, and nothing
at run time; D2 removes it from safe code. Do not use it in new code.

## `extract`

```rust
inner := iso.extract();        // T
```

`extract()` returns the inner `T` directly (not an `Option`), marks the `Iso` extracted, and
panics if it is called a second time on any copy of the same `Iso`:

```
panic: Iso::extract() called on already-extracted Iso
```

After extraction the value uses non-atomic reference counting: keep it on the extracting
thread. Dropping an `Iso` that was never extracted releases the inner value (on whichever
thread drops the last handle — sound, because that thread is then the only one that can reach
it).

D2 adds a second check to `extract()`: the wrapper's own reference count must be 1, so a
sending thread that still holds a copy of the `Iso` gets a panic instead of a second owner.
Today that check does not exist; the sentence "extract verifies rc == 1" that older material
repeats describes the intended design, not the emitted code.

## What is emitted

```c
typedef struct {
  __yo_ref_header_t header;   // atomic RC — the handle is an atomic object
  _Atomic bool extracted;     // the one-shot flag
  T value;                    // the inner value, non-atomic RC
} Iso_T_struct;

T __yo_iso_extract_T(Iso_T iso) {
  if (atomic_exchange(&iso->extracted, true)) { /* panic: already extracted */ }
  return iso->value;
}
void __yo_iso_dispose_T(Iso_T iso) {
  if (!atomic_load(&iso->extracted)) { __yo_decr_rc((void*)iso->value); }
}
```

## Composition rules

- `Iso(Arc(T))` is a compile error — an `Arc` is already `Send`; send it directly.
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

(`^xs` on an `ArrayList` compiles only once D2 lands — today it needs an `Isolation` impl,
which `ArrayList` does not have; the raw constructor works but is unchecked.)

## Example: rejected at construction

```rust
x := box(i32(42));
y := x;
iso := ^x;                     // COMPILE ERROR: cannot isolate x, also owned by y
```

## Known gaps (2026-09-25)

`issues/iso-constructor-is-unchecked-and-extract-verifies-no-uniqueness.md` and
`issues/iso-checks-only-the-wrapper-refcount-not-the-interior.md`: the interior of the value is
not checked, the raw constructor accepts a literal argument and a scalar `T`, and `extract()`
checks no reference count. `plans/PARALLELISM_SOUNDNESS.md` Phase 2 closes them.
