# Arc(T) — Atomic Reference Counted Shared Ownership

Arc(T) is a compiler built-in type for **shared ownership** with **atomic reference counting**. Unlike `Iso(T)` (unique ownership), multiple `Arc(T)` values can point to the same data. Arc is **Send-safe**, enabling cross-thread data sharing.

## Usage

### Creating an Arc

```rust
// Using the arc() helper function
a := arc(i32(42));

// Using the type constructor directly
a := Arc(i32)(i32(42));
```

### Dereferencing

Access the inner value with `.*`, which returns a **borrowed** reference:

```rust
a := arc(i32(42));
val := a.*;       // val : i32 = 42
```

For objects, method delegation works through `.*`:

```rust
Counter :: object(count : i32);
impl(Counter,
  get_count : ((fn(self : Self) -> i32) self.count)
);

c := arc(Counter(i32(10)));
c.*.get_count()    // returns 10
```

### Sharing (Copy semantics)

Assigning an Arc to another variable increments the reference count:

```rust
a := arc(i32(42));
b := a;              // refcount: 1 → 2
c := b;              // refcount: 2 → 3
// All three share the same underlying data
assert(a.* == b.*);
```

### Cross-thread sharing

Arc implements `Send`, so it can be captured in thread/worker closures:

```rust
{ Thread } :: import "std/thread";
{ Channel } :: import "std/sync/channel";

// Share a channel across threads
ch := arc(Channel(i32).new(usize(10)));

producer := Thread.spawn(() => {
  ch.*.send(i32(42));
});

val := ch.*.recv().unwrap();
producer.join();
```

## Comparison with Iso(T)

| Feature         | `Arc(T)`                      | `Iso(T)`                        |
| --------------- | ----------------------------- | ------------------------------- |
| Ownership       | Shared (multiple refs)        | Unique (single owner)           |
| Reference count | Atomic (`_Atomic`)            | Atomic (`_Atomic`)              |
| Copy behavior   | Increments refcount           | Extracts (moves) value          |
| Mutability      | Read-only via `.*` (borrowed) | Full ownership via `.(^)`       |
| Send            | Yes (always)                  | Yes (always)                    |
| Use case        | Cross-thread shared reads     | Cross-thread ownership transfer |

## Implementation details

- **C representation**: `struct { __yo_ref_header_t header; T value; }` — pointer type allocated on heap.
- **Refcount ops**: Uses `__yo_incr_rc_atomic` / `__yo_decr_rc_atomic` (atomic increment/decrement).
- **Disposal**: When refcount hits 0, the inner value's `___drop` is called (if it has one), then the Arc allocation is freed.
- **Closure capture**: When captured in a closure, the Arc pointer is **duped** (refcount incremented). The closure and the outer scope each hold independent references.
