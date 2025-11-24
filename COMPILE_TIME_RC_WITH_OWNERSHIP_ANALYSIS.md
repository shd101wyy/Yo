# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses automatic reference counting (RC) for heap-allocated objects with compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

## Ownership Model

Yo uses an **ownership and borrowing** model with explicit borrow (`&`) and unborrow (`^`) operators:

### Core Concepts

**Owned values**: Variables that own their values, incrementing RC
**Borrowed values**: Temporary references via `&`, no RC change, not `Send`
**Move semantics**: Rc types (object, closure, dyn, future) move by default
**Copy semantics**: Value types (struct, primitives) copy by default

### 1. Move Semantics for Rc Types

Rc types move by default, transferring ownership without RC operations:

```yo
x := box(42);       // x owns the box, RC = 1
y := x;             // x is CONSUMED, y owns, NO RC operation (move)
// x is no longer valid!

p := &(y);          // y is CONSUMED, &(y) creates temporary pointer
                    // p := ..., assignment increments RC = 2
                    // p : *(Box(i32)), not Send!
p2 := p;            // p is copied (pointers are Copy)
                    // Assignment increments RC = 3, both p and p2 valid
```

**Rule:** Rc types move by default. Owned assignment transfers without RC. Pointer assignment increments RC.

### 2. Borrow Operator `&`

The `&` operator creates a temporary borrowed pointer. Assigning it increments RC:

```yo
x := box(42);       // x owns, RC = 1
p := &(x);          // x is CONSUMED, &(x) creates temp pointer
                    // p := ..., assignment increments RC = 2
                    // p : *(Box(i32))
// x is no longer valid!

// Pointer types are Copy and not Send
p2 := p;            // p is copied (pointers are Copy)
                    // Assignment increments RC = 3
                    // Both p and p2 valid
                    // Cannot send p or p2 across threads!
```

**Rule:** `&` creates temporary pointer. Assigning pointer to variable increments RC.

### 3. Unborrow Operator `^`

The `^` operator attempts to convert borrowed reference back to owned value:

```yo
p := &(box(42));    // &(box(42)) creates temp, p := ... increments RC = 2
owned := ^(p);      // p is CONSUMED, decrements RC
                    // owned : Option(Box(i32))
                    // Returns Some if RC == 1 after decrement, None if RC > 1

match(owned =>
  .Some(val) => /* val owns exclusively, RC = 1 */,
  .None => /* multiple references exist, RC restored */
)
```

**Rule:** `^` consumes pointer (decrements RC), returns `Some(T)` if RC == 1, else `None`.

### 4. Thread Safety via Send

Borrowed pointers are never `Send`, preventing use-after-free:

```yo
x := box(42);
p := &(x);          // p : *(Box(i32)), NOT Send!

spawn({ use(p); }); // ERROR: p is not Send!
                    // Cannot share borrowed references across threads
```

**Why this is safe:**
- Borrowed pointers cannot cross thread boundaries
- Only owned values can be sent
- `^` operator ensures exclusive ownership before sending

**Example - safe cross-thread:**
```yo
x := box(42);       // x owns, RC = 1
p := &(x);          // x consumed, p := ... increments RC = 2
owned := ^(p);      // p consumed, decrements RC = 1
                    // Check exclusive ownership

match(owned =>
  .Some(val) => {
    spawn({ use(val); });  // OK! val is owned, can be Send if T: Send
  },
  .None => {
    // Cannot send - multiple references exist (RC > 1)
  }
)
```

## Basic Model

### Ownership and Reference Counting

Heap-allocated Rc values start with RC = 1. Variables can own or borrow these values:

```yo
Point :: object(x : i32, y : i32);

p := Point(3, 4);   // p owns Point, RC = 1
```

### Move Semantics (Default for Rc Types)

Assignment moves ownership without RC operations:

```yo
p1 := Point(3, 4);  // p1 owns, RC = 1
p2 := p1;           // p1 CONSUMED, p2 owns, NO RC change (move)
// p1 is no longer valid!
```

When an owned variable goes out of scope, call `___drop`:

```yo
p := Point(3, 4);   // p owns, RC = 1
// End of scope: ___drop(p), RC = 0, freed
```

### Borrow with `&`

The `&` operator creates a temporary pointer. Assigning it increments RC:

```yo
p := Point(3, 4);   // p owns, RC = 1
ptr := &(p);        // p CONSUMED, &(p) creates temp pointer
                    // ptr := temp increments RC = 2
                    // ptr : *(Point), not Send
// End of scope: ___drop(&(p)), ___drop(ptr), RC = 0
// Optimization: ___drop(&(p)) and ptr's dup can be cancelled!
```

### Function Parameters Are Borrowed by Default

Function parameters are borrowed (not owned), so no RC operations on pass:

```yo
print_point :: (fn(p: *(Point)) -> unit) {
  printf("(%d, %d)", p.*.x, p.*.y);  // Dereference with .*
  // No ___drop(p) - p is borrowed, not owned
};

point := Point(3, 4);  // point owns, RC = 1
ptr := &(point);       // point consumed, ptr := temp, RC = 2
print_point(ptr);      // ptr borrowed (copied but not owned)
                       // No RC change during call
// End of scope: ___drop(&(point)), ___drop(ptr), RC = 0
// Optimization: These can cancel out!
```

**For owned parameters, use explicit move:**

```yo
consume_point :: (fn(p: Point) -> unit) {
  printf("(%d, %d)", p.x, p.y);
  // ___drop(p) at end - p is owned
};

point := Point(3, 4);  // point owns, RC = 1
consume_point(point);  // point MOVED to function, no RC change
// point is no longer valid!
// End of function: ___drop(p), RC = 0
```

## When to Increment RC?

### Rule 1: Pointer Assignment

**Assigning a pointer to a variable increments RC:**

```yo
x := box(42);       // x owns, RC = 1
p := &(x);          // x consumed, &(x) creates temp
                    // p := temp increments RC = 2
p2 := p;            // p copied, p2 := p increments RC = 3
```

### Rule 2: Explicit Duplication

**`dup` function explicitly creates new owned reference:**

```yo
p := Point(3, 4);   // p owns, RC = 1
p2 := dup(p);       // Explicit dup, RC = 2
                    // Both p and p2 are valid and owned
```

### Rule 3: Storing Pointers in Data Structures

**Storing pointer in field/array increments RC:**

```yo
p := Point(3, 4);       // p owns, RC = 1
ptr := &(p);            // p consumed, ptr := ... increments RC = 2
data.point_ptr = ptr;   // ptr copied, assignment increments RC = 3
arr[0] = ptr;           // ptr copied, assignment increments RC = 4
```

### Rule 4: Owned Values Use Move Semantics

**Owned assignment/passing moves without RC change:**

```yo
p1 := Point(3, 4);      // p1 owns, RC = 1
p2 := p1;               // MOVE: p1 consumed, p2 owns, RC still 1

data.point = p2;        // MOVE: p2 consumed, stored in data, RC still 1

consume :: (fn(p: Point) {  // p owns
  // use p
});  // ___drop(p), RC = 0

consume(data.point);    // MOVE: field moved to parameter, RC still 1
```

### Rule 5: Returning Values

**Return moves ownership without RC change:**

```yo
create_point :: (fn() -> Point) {
  p := Point(3, 4);  // p owns, RC = 1
  return p;          // MOVE: p moved to return value, RC still 1
};

// To return while keeping local:
create_and_keep :: (fn() -> Point) {
  p := Point(3, 4);       // p owns, RC = 1
  result := dup(p);       // Explicit dup, RC = 2
  // do something with p
  return result;          // MOVE: result to return value
};  // ___drop(p), RC = 1 for returned value
```

## Special Case: Loops

In loops, move semantics apply naturally:

### Example: Linked List Traversal

```yo
current_opt := self.head;  // Move self.head to current_opt, no dup

while(true => {
  match(current_opt =>
    .None => return false,
    .Some(current) => {
      // current moved from current_opt
      current_opt = current.next;  // Move next to current_opt
      // current dropped at end of branch
    }
  );
})
```

**Analysis:**

- Initial: Move from `self.head`, no RC change
- Each iteration:
  - Match: Move from `current_opt` into `current`
  - Assignment: Move `current.next` to `current_opt`
  - End of branch: Drop `current`
- End: Drop `current_opt`

**Cost:** Zero RC operations! Pure move semantics.

### With Borrowing for Reference Counting

```yo
current_ptr := &(self.head);  // self.head consumed, RC incremented

while(true => {
  match(current_ptr.* =>
    .None => return false,
    .Some(current) => {
      // Borrow next field
      next_ptr := &(current.next);  // Create new pointer, RC incremented
      // ___drop(current_ptr) - decrements RC
      current_ptr = next_ptr;       // MOVE pointer
    }
  );
})

// ___drop(current_ptr) - decrements RC
```

**Cost:** One RC increment per iteration (for new pointer), one decrement (drop old pointer).

## Optimization Opportunities

### Canceling Dup/Drop Pairs

The temporary pointers created by `&` can be optimized away:

```yo
p := Point(3, 4);   // p owns, RC = 1
ptr := &(p);        // Creates temp, ptr := temp increments RC = 2

// Before optimization:
// - RC increment on ptr assignment
// - ___drop(&(p)) at scope end
// - ___drop(ptr) at scope end
// Total: 1 increment, 2 decrements

// After optimization:
// - Cancel ptr's increment with ___drop(&(p))
// - Only ___drop(ptr) remains
// Total: 0 increments, 1 decrement (same as move!)
```

**Pattern:** When `&(owned)` is immediately assigned, the increment can be cancelled with temp's drop.

### Multiple Pointer Copies

```yo
p := Point(3, 4);   // p owns, RC = 1
ptr1 := &(p);       // p consumed, temp created, ptr1 := temp, RC = 2
ptr2 := ptr1;       // ptr1 copied, RC = 3
ptr3 := ptr1;       // ptr1 copied, RC = 4

// Scope end: ___drop(&(p)), ___drop(ptr1), ___drop(ptr2), ___drop(ptr3)
// RC path: 1 → 2 → 3 → 4 → 3 → 2 → 1 → 0

// Optimization: Keep minimum to maintain correctness
// Keep ___drop(&(p)) and ___drop(ptr3) only
// All other increments/decrements cancelled
```

### Optimization Strategy

Similar to the previous "Phase 1.5" optimization:

1. **Track pointer sources**: When `ptr := &(owned)`, track that ptr came from owned
2. **Count operations**: Increments from assignment, decrements from drops
3. **Cancel pairs**: Match increments with corresponding drops
4. **Keep minimum**: Ensure RC never goes to 0 prematurely

**Result:** Pointer borrowing becomes nearly zero-cost for simple patterns!

## Summary

Yo's ownership model with explicit borrowing:

**Core Rules:**

1. **Move by default**: Rc types (object, closure, dyn, future) use move semantics
2. **Pointer assignment increments RC**: Assigning `&(value)` to variable increments RC
3. **Pointer copy increments RC**: Copying pointer variables increments RC  
4. **Not Send**: Borrowed pointers (`*T`) cannot cross thread boundaries
5. **Unborrow with `^`**: Convert pointer back to owned value if RC == 1
6. **Explicit dup**: Use `dup(value)` to explicitly create owned copy

**Benefits:**

- ✅ Zero-cost moves for owned values
- ✅ Predictable RC increments (only on pointer assignment/copy)
- ✅ Thread-safe (pointers not Send, `^` checks RC == 1)
- ✅ Simple mental model
- ✅ Enables work-stealing for non-cycle-forming captures

**Design Goals:**
