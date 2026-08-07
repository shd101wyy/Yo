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

1. **Construction check**: `Iso(T)(v)` requires `v` has no aliases (checked via `isOwningTheSameRcValueAs`)
2. **Atomic operations**: Once wrapped, all RC operations use atomic instructions
3. **Normal semantics**: After construction, `Iso(T)` can be freely copied and shared

## Isolation trait

The `Isolation` trait provides function to check if a type can isolate.

```rust
Isolation :: trait(
  can_isolate : (fn(self : Self) -> bool)
);
```

The user should implement this trait for their own types to indicate if the type can isolate.
For example:

```rust
Data :: ref(struct(v : i32));
Point :: ref(struct(x : Data, y : Data));

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

   - Check: `v.isOwningTheRcValue == true`
   - Check: `v.isOwningTheSameRcValueAs == undefined`
   - Check: No other variable has `isOwningTheSameRcValueAs == v.id`

2. **Recursive isolation** (for reference types):
   - If `T` contains nested objects, they must also be uniquely owned
   - Checked via `v.can_isolate()` method (see Isolation trait below)

```rust
// ❌ Rejected: x has alias y
x := box(1);
y := x;                    // y.isOwningTheSameRcValueAs = x
iso := Iso(Box(i32))(x);   // COMPILE ERROR: x has aliases

// ✅ Accepted: x is unique
x := box(1);               // x owns, no aliases
iso := Iso(Box(i32))(x);   // OK: constructs Iso with atomic RC

// ✅ Can freely copy after construction
iso2 := iso;               // Atomic dup - safe!
```

## `extract` method

The `__yo_iso_extract` builtin extracts the inner value from an `Iso(T)`, returning `Option(T)`.

```rust
iso := Iso(Box(i32))(box(42));
val_opt := __yo_iso_extract(iso);    // val_opt : Option(Box(i32))

match(val_opt,
  .Some(val) => {
    // Extract succeeds
    // val now uses non-atomic RC, keep it in this thread!
    printf("Got value: %d\n", val.(*));
  },
  .None => {
    // Extraction can potentially return None for stateful extraction
    printf("No value\n");
  }
);
```

**Implementation:** `__yo_iso_extract(iso)` returns the wrapped value of type `Option(T)`:

- Returns `.Some(inner_value)` with the inner value
- Can potentially return `.None` for stateful extraction semantics (not yet implemented)

**Important:** Once extracted, the inner `T` uses non-atomic RC. The value should remain in the extracting thread to avoid data races on its non-atomic reference counter.

**Note:** Currently, the extraction doesn't consume the `Iso(T)` argument to allow the reference counting drop logic to work correctly. Multiple extractions may be possible (returns the same value), but this behavior may change in future implementations to enforce single extraction.

## The `^` Macro

For convenience, use the `^` macro to isolate values with automatic type inference:

### Basic Usage

```rust
x := Data(12);
iso_opt := ^(x);  // Returns Option(Iso(Data))

match(iso_opt,
  .Some(iso) => {
    // Successfully isolated
    spawn(() => { /* use iso */ });
  },
  .None => {
    // Isolation failed (aliased or rc > 1)
  }
);
```

## Atomic Reference Counting Implementation

`Iso(T)` uses atomic operations for all reference counting:

```c
// Regular object: non-atomic RC
typedef struct {
  size_t ref_count;        // Non-atomic counter
  void (*dispose_fn)(void*);
  T value;
} Object_T;

// Isolated object: atomic RC
typedef struct {
  _Atomic size_t ref_count;  // Atomic counter (thread-safe)
  void (*dispose_fn)(void*);
  T value;                   // Inner value (non-atomic RC!)
} Iso_T;

// Constructor: Creates with ref_count = 1
Iso_T* __yo_create_iso_T(T inner_value) {
  Iso_T* iso = (Iso_T*)__yo_alloc(sizeof(Iso_T));
  atomic_init(&iso->ref_count, 1);
  iso->dispose_fn = NULL;  // No dispose function needed
  iso->value = inner_value;
  return iso;
}

// Dup uses atomic increment
void __yo_incr_rc_atomic(Iso_T* iso) {
  atomic_fetch_add(&iso->ref_count, 1);  // Thread-safe increment
}

// Drop uses atomic decrement
void __yo_decr_rc_atomic(Iso_T* iso) {
  size_t old_count = atomic_fetch_sub(&iso->ref_count, 1);
  if (old_count == 1) {
    // Last reference, free memory
    if (iso->dispose_fn) {
      iso->dispose_fn(iso);  // Clean up inner value if needed
    }
    __yo_free(iso);
  }
}

// Extract: Returns Option(T) with inner value
Option_T __yo_iso_extract_T(Iso_T* iso) {
  // Currently returns Some(value)
  // Future: Could add atomic extracted flag for single-extraction semantics
  return Option_Some_T(iso->value);
}
```

## Example: Thread-Safe Usage

```rust
// Create isolated string
s := String("Hello");
iso := Iso(String)(s);    // s has no aliases, OK

// Can freely copy (atomic RC)
iso2 := iso;              // Atomic dup

// Send to thread safely
spawn(() => {
  iso3 := iso2;           // Atomic dup across threads - safe!
  msg_opt := __yo_iso_extract(iso3);  // Extract String
  match(msg_opt,
    .Some(msg) => printf("%s\n", msg),
    .None => printf("No value\n")
  );
});

// Can still use original (atomic RC handles safety)
msg2_opt := __yo_iso_extract(iso);
match(msg2_opt,
  .Some(msg2) => printf("%s\n", msg2),
  .None => printf("No value\n")
);
```

````

## Example: Invalid Isolation

```rust
// ❌ Cannot isolate: has alias
x := box(42);
y := x;                    // y.isOwningTheSameRcValueAs = x
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
