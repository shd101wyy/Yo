# Isolated Type

`Iso(T)` is a thread-safe wrapper for isolated values using **atomic reference counting**.

## Key Properties

- **Atomic RC**: `Iso(T)` uses atomic reference counting, not regular non-atomic RC
- **Thread-safe sharing**: Can be safely copied and passed across threads
- **No move semantics**: Behaves like a normal object (can be stored, matched on, etc.)
- **Isolation at construction**: `Iso(T)(v)` requires `v` to be uniquely owned (no aliases)
- **Implements `Send` automatically**: Safe to send across threads

## Design Rationale

Instead of introducing move semantics, we ensure isolation at construction time and use atomic RC for thread safety:

1. **Construction check**: `Iso(T)(v)` requires `v` has no aliases (checked via `isOwningTheSameGcValueAs`)
2. **Atomic operations**: Once wrapped, all RC operations use atomic instructions
3. **Normal semantics**: After construction, `Iso(T)` can be freely copied and shared

## Isolation module

The `Isolation` module provides function to check if a type can isolate.

```rust
Isolation :: module(
  can_isolate : (fn(self : Self) -> bool)
);
```

The user should implement this module for their own types to indicate if the type can isolate.
For example:

```rust
Data :: object(v : i32);
Point :: object(x : Data, y : Data);

impl(Data, Isolation(
  can_isolate : ((self) -> rc(self) == 1)
));

impl(Point, Isolation(
  can_isolate : ((self) ->
    (rc(self) == 1) &&
    (self.x.can_isolate()) &&
    (self.y.can_isolate())
  )
));
```

In the future, we will support the `derive` keyword to automatically generate `Isolation` implementations for user-defined types.

## Construction Constraints

`Iso(T)(v)` constructor requires:

1. **Unique ownership**: `v` must not have any aliases

   - Check: `v.isOwningTheGcValue == true`
   - Check: `v.isOwningTheSameGcValueAs == undefined`
   - Check: No other variable has `isOwningTheSameGcValueAs == v.id`

2. **Recursive isolation** (for reference types):
   - If `T` contains nested objects, they must also be uniquely owned
   - Checked via `v.can_isolate()` method (see Isolation module below)

```yo
// ❌ Rejected: x has alias y
x := box(1);
y := x;                    // y.isOwningTheSameGcValueAs = x
iso := Iso(Box(i32))(x);   // COMPILE ERROR: x has aliases

// ✅ Accepted: x is unique
x := box(1);               // x owns, no aliases
iso := Iso(Box(i32))(x);   // OK: constructs Iso with atomic RC

// ✅ Can freely copy after construction
iso2 := iso;               // Atomic dup - safe!
```

## `extract` method

The `extract` method extracts the inner value from an `Iso(T)` **exactly once**.

```yo
fn some_func(iso : Iso(T)) -> unit {
  val_opt := iso.extract();    // val_opt : Option(T)

  match(val_opt,
    .Some(val) => {
      // First extract succeeds
      // val now uses non-atomic RC, keep it in this thread!
      printf("Got value\n");
    },
    .None => {
      // Already extracted, or extraction failed
      printf("Already extracted\n");
    }
  );
}
```

**Important:** `extract()` returns `Option(T)` and can only succeed once:

- First call: Returns `.Some(inner_value)`, inner value is moved out
- Subsequent calls: Return `.None`, the value has already been extracted

**Why?** The inner `T` uses non-atomic RC. Once extracted, it cannot be safely shared across threads. By ensuring single extraction, we prevent data races on the inner value's non-atomic reference counter.

## Atomic Reference Counting Implementation

`Iso(T)` uses atomic operations for all reference counting:

```c
// Regular object: non-atomic RC
typedef struct {
  size_t rc;        // Non-atomic counter
  T value;
} Object_T;

// Isolated object: atomic RC
typedef struct {
  _Atomic size_t arc;      // Atomic counter (thread-safe)
  _Atomic bool extracted;  // Has value been extracted?
  T value;                 // Inner value (non-atomic RC!)
} Iso_T;

// Operations use atomic instructions
void ___dup_iso(Iso_T* iso) {
  atomic_fetch_add(&iso->arc, 1);  // Thread-safe increment
}

void ___drop_iso(Iso_T* iso) {
  if (atomic_fetch_sub(&iso->arc, 1) == 1) {
    // Last reference, free memory
    if (!atomic_load(&iso->extracted)) {
      // Value not extracted yet, drop it
      ___drop(&iso->value);
    }
    free(iso);
  }
}

Option_T extract_iso(Iso_T* iso) {
  // Atomically check and set extracted flag
  bool already_extracted = atomic_exchange(&iso->extracted, true);

  if (already_extracted) {
    return Option_None();  // Already extracted
  } else {
    return Option_Some(iso->value);  // First extraction, return value
  }
}
```

\*\*Patch(iso3.extract(), // Only one thread can extract!
.Some(msg) => printf("%s\n", msg),
.None => printf("Already extracted\n")
);
});

// Original might fail if other thread extracted first
match(iso.extract(),
.Some(msg) => printf("%s\n", msg),
.None => printf("Already extracted by other thread\n")
ello");
iso := Iso(String)(s); // s has no aliases, OK

// Can freely copy (atomic RC)
iso2 := iso; // Atomic dup

// Send to thread safely
spawn(() => {
iso3 := iso2; // Atomic dup across threads - safe!
msg := iso3.extract(); // Extract String
printf("%s\n", msg);
});

// Can still use original (atomic RC handles safety)
msg2 := iso.extract();
printf("%s\n", msg2);

````

## Example: Invalid Isolation

```yo
// ❌ Cannot isolate: has alias
x := box(42);
y := x;                    // y.isOwningTheSameGcValueAs = x
iso := Iso(Box(i32))(x);   // COMPILE ERROR: Cannot isolate x, also owned by y

// ✅ Fix: Don't create aliases
x := box(42);              // x is unique
iso := Iso(Box(i32))(x);   // OK

// ✅ Alternative fix: Drop alias first
x := box(42);
y := x;
drop(y);                   // Explicitly drop y
iso := Iso(Box(i32))(x);   // OK if compiler can prove y is dead
````
