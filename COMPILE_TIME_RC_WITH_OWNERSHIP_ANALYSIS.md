# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses automatic reference counting (ARC) for heap-allocated objects, but employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

## Basic Model

Each heap allocated ARC value has a unique owner. Its reference counter starts at 1.

```rust
Point :: object(x : i32, y : i32);

Point(3, 4); // temp_var owns the Point(3, 4)
```

Using `:=` for initialization will not increase the reference count. The variable on the left side of `:=` will borrow the value on the right side, not owning.

```rust
p1 := Point(3, 4); // temp_var owns the Point(3, 4)
// p1 borrows the temp_var
// we will not increment the reference count when := is used
```

When an owned variable goes out of scope, we automatically call `___drop` on it.

```rust
p1 := Point(3, 4); // temp_var owns the Point(3, 4)
// p1 borrows the temp_var
// we will not increment the reference count

// End of scope of temp_var
___drop(temp_var); // <= This is automatically inserted by the compiler

// NOTE: We will not call ___drop(p1) because p1 does not own the value
```

## The Lifetime Problem

**Critical Issue**: Naive L-value borrowing without lifetime analysis leads to use-after-free bugs!

```rust
x := box(12);      // temp_var_x owns box(12), x borrows from temp_var_x
{
  y := box(13);    // temp_var_y owns box(13), y borrows from temp_var_y
  x = y;           // DANGER: If x just borrows from y...
  
  // End of inner scope
  ___drop(temp_var_y); // temp_var_y is dropped, y's value is freed
};

printf("%d\n", x.*); // BUG: x now points to freed memory!
```

**Solution**: Use lifetime analysis to automatically insert `___dup`/`___drop` operations when needed for safety.

## Our Approach: Conservative Safety with Optimization

Yo prioritizes **safety and ergonomics** over maximum performance:

1. **Always safe**: Code never has use-after-free bugs
2. **Automatic**: Programmers don't manage lifetimes manually
3. **Optimizable**: Sophisticated analysis eliminates unnecessary operations

**Example - automatically safe:**
```rust
x := box(12);
{
  y := box(13);
  x = y;  // Compiler inserts ___dup(y) and ___drop(old_x)
          // to handle the lifetime mismatch
}
printf("%d\n", x.*); // Safe: x owns a valid reference
```

**Trade-offs:**
- ✅ Code "just works" without manual lifetime annotations
- ✅ Zero risk of memory safety bugs
- ⚠️ May have runtime overhead from reference counting operations
- ✅ Can be optimized away through analysis (Phase 2)

## When to call `___dup` to increase the reference count?

1. On the right side of `=` assignment:

   **Case 1a: LHS is a variable AND RHS outlives or has the same lifetime as LHS**
   
   No `___dup` needed - LHS borrows from RHS.

   ```rust
   p1 := Point(3, 4); // temp_var owns the Point(3, 4)
   p2 := Point(5, 6); // temp_var2 owns the Point(5, 6)

   p2 = p1; // Will not call ___dup on p1 because:
           // 1. p2 is a variable
           // 2. p1 (and its owner temp_var) outlives p2
           // p2 now borrows from temp_var

   // End of scope of temp_var and temp_var2
   __drop(temp_var2); // <= temp_var2 is dropped (p2 was borrowing, so no drop)
   __drop(temp_var); // <= temp_var is dropped
   ```

   **Case 1b: LHS is a variable AND RHS lifetime ends before LHS**
   
   Must call `___dup` on RHS to prevent use-after-free.

   ```rust
   x := box(12);      // temp_var_x owns box(12)
   {
     y := box(13);    // temp_var_y owns box(13)
     x = y;           // MUST call ___dup(y) because:
                      // 1. x is a variable
                      // 2. BUT y (temp_var_y) will be dropped before x goes out of scope
                      // x becomes the new owner of a duplicated reference
     
     __drop(temp_var_y); // <= This will decrement RC
   };
   printf("%d\n", x.*); // x is still valid here
   __drop(x);           // <= x must be dropped because it now owns the value
   ```

   **Case 1c: LHS is not a variable (field/index access)**
   
   Always call `___dup` because we're storing into a data structure.

   ```rust
   test :: (fn(data: Data)-> unit) {
     p1 := Point(3, 4); // temp_var owns the Point(3, 4)
     data.point = p1;   // Will call ___dup on p1, because LHS is not a variable.

     __drop(temp_var); // <= This is automatically inserted by the compiler
   };
   ```

2. Passing to `struct` (`object`, `newtype`), `enum`, `union`, `array`, `dyn`, `closure` constructors.

   ```rust
   p1 := Point(3, 4); // temp_var owns the Point(3, 4)
   data := Data(p1); // Will call ___dup on p1, because we are passing to a struct constructor
   arr := [p1]; // Will call ___dup on p1, because we are passing to an array constructor
   result := Result(Point).Ok(p1); // Will call ___dup on p1, because we are passing to an enum constructor
   ```

3. Returning a borrowed variable from a block/function.

   ```rust
   get_point :: (fn() -> Point) {
     p1 := Point(3, 4); // `temp_var` owns the Point(3, 4)
     // `p1` borrows the `temp_var`

     return p1; // Will call ___dup on p1, because p1 is not an owned variable.
     // ___drop(temp_var); // <= This is automatically inserted by the compiler
     // ___dup(p1) and ___drop(temp_var) cancelled out because p1 and temp_var are the same reference.
   };

   get_point2 :: (fn(p : Point) -> Point) { // p here is a borrowed variable, not owned.
     return p; // Will call ___dup, because p is not an owned variable.
   };

   {
     p1 := get_point(); // temp_var owns the return value

     // End of scope of temp_var
     ___drop(temp_var); // <= This is automatically inserted by the compiler
   };

   {
     p1 := Point(3, 4); // temp_var owns the Point(3, 4)
     p2 := get_point2(p1); // temp_var2 owns the return value

     // End of scope of temp_var and temp_var2
     ___drop(temp_var2); // <= This is automatically inserted by the compiler
     ___drop(temp_var); // <= This is automatically inserted by the compiler
   };
   ```

4. The `own` keyword

   ```rust
   use_my_box :: (fn(own(box) : MyBox) -> unit) {
     printf("Using MyBox with value: %d\n", box.(*));

     // Expected the `box` to be disposed here.
   };

   main :: (fn() -> unit) {
     box := MyBox(42);
     use_my_box(box); // will call ___dup on `box`

     printf("Back in main.\n");
     // Expected the `box` not to be disposed here.
   };
   ```

## Special Case: Loops and Lifetime Analysis

In loops, we can optimize away `___dup` and `___drop` when reassigning a variable to borrow from a field that's guaranteed to outlive the variable.

### Example: Linked List Traversal

```rust
current_opt := self.head;  // current_opt borrows from self.head

while runtval(true), {
  match(current_opt,
    .None => return false,
    .Some(current) => {
      current_opt = current.next;  // Reassignment within the loop
    }
  );
};
```

**Lifetime Analysis:**

1. `current_opt` is a local variable in the function scope
2. `current.next` is a field access - it borrows from `current`
3. `current` comes from unwrapping `current_opt` within the match arm
4. The assignment `current_opt = current.next`:
   - LHS: `current_opt` (outer scope - function/loop)
   - RHS: `current.next` (inner scope - match arm)

**Lifetime mismatch detected:**
- `current` only lives within the `.Some` match arm
- `current.next` borrows from `current`
- When the match arm ends, `current` goes out of scope
- But `current_opt` continues to live in the outer loop

**Therefore, we MUST insert `___dup` and `___drop` for safety:**

```rust
.Some(current) => {
  // current.next is from inner scope (match arm)
  // current_opt is from outer scope (function/loop)
  // Must use reference counting to extend lifetime
  
  ___dup(current.next);      // Increment RC of new value
  ___drop(current_opt);      // Decrement RC of old value (or use temp variable)
  current_opt = current.next; // Assign new value
}
```

### Optimization Opportunity: Ownership Chain Tracking

However, if we can prove that:
1. The variable being reassigned always borrows from the same ultimate owner
2. The ultimate owner outlives the variable
3. We're just "moving the borrow" along a chain

Then we could optimize to just transfer the borrow without dup/drop.

**In the linked list case:**
- `self.head` owns the entire linked list chain
- Each `node.next` is part of the same chain
- All nodes in the chain are transitively owned by `self.head`
- `self` (the receiver parameter) outlives `current_opt`

**Advanced Optimization:**
If we track that `current_opt` is borrowing from a chain owned by `self.head`, and we're reassigning to another element in the same ownership chain, we can skip dup/drop:

```rust
.Some(current) => {
  // Recognize that current.next is part of the same ownership chain as current_opt
  // Both borrow from self.head, so we can just "move the borrow"
  current_opt = current.next;  // No dup/drop needed!
}
```

**Requirements for this optimization:**
1. **Ownership chain tracking**: Track that values are part of the same ownership tree
2. **Lifetime dominance**: Prove that the root owner outlives the borrowing variable
3. **Conservative fallback**: If unsure, always insert dup/drop for safety

## Implementation Strategy

### Phase 1: Conservative Lifetime Analysis (Current)

For now, implement the **conservative approach** with simple lifetime checking:

1. **Variable-to-Variable Assignment (`x = y`)**:
   - Check if RHS is defined in the same scope or outer scope as LHS
   - If YES: Transfer borrow, no dup/drop
   - If NO (RHS is in inner scope): Call dup/drop
   
2. **Field/Index Assignment (`x.field = y` or `arr[i] = y`)**:
   - Always call dup/drop

3. **Track scope depth** for each variable to make lifetime comparisons

**Example decisions:**
```rust
// Same scope - no dup/drop
x := box(1);
y := box(2);
x = y;  // OK, both in same scope, x borrows from y's owner

// RHS in inner scope - must dup/drop
x := box(1);
{
  y := box(2);
  x = y;  // MUST dup/drop - y's owner will be dropped first
}

// Loop iteration - RHS doesn't outlive LHS - must dup/drop
current := self.head;
while true, {
  match(current,
    .Some(node) => {
      current = node.next;  // node is in match arm scope, current in loop scope
                            // MUST dup/drop
    }
  );
}
```

### Phase 2: Advanced Optimization (Future)

Implement **ownership chain tracking** and **Perceus-inspired optimizations** to eliminate dup/drop in safe cases.

#### Perceus Algorithm Insights

The [Perceus algorithm](https://www.microsoft.com/en-us/research/publication/perceus-garbage-free-reference-counting-with-reuse/) from Koka provides several key optimization techniques:

**1. Last-Use Analysis**

Track the last use of each variable to transfer ownership instead of dup/drop:

```rust
x := Point(3, 4);   // temp_var owns Point(3, 4)
y := x;             // Last use of x - transfer ownership
z := y;             // Last use of y - transfer ownership

// Without last-use: ___dup(x), ___drop(x), ___dup(y), ___drop(y)
// With last-use:    Just pointer moves, no RC operations!
```

**2. Borrowed Parameter Analysis**

Distinguish between parameters that are only read vs. stored:

```rust
// Read-only access - no dup needed
fn print_point(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);  // Just reading, not storing
}

// Storing access - dup needed
fn store_point(p: Point, container: Container) -> unit {
  container.point = p;  // Storing, needs dup
}
```

**3. Ownership Chain Tracking**

Track field access chains to prove same-root ownership:

```rust
current_opt := self.head;
// Path: current_opt → self.head → owned by self parameter

current_opt = current.next;
// New path: current_opt → current.next → same chain (self.head)
// Same root owner (self) → no dup/drop needed!
```

**4. Destructive Reads in Pattern Matching**

Optimize pattern matching by recognizing destructive field access:

```rust
match(current_opt,
  .Some(current) => {
    // Perceus insight: 
    // - Deconstructing current_opt to get current
    // - Accessing current.next (same ownership chain)
    // - Reassigning current_opt
    // Optimization: Just move the pointer, reuse the Some wrapper
    current_opt = current.next;  // No dup/drop!
  }
)
```

#### Phase 2 Implementation Plan

1. **Last-use tracking**:
   - Perform dataflow analysis to find last use of each variable
   - At last use, mark as "transfer ownership" instead of "borrow"
   - Eliminate dup/drop pairs for ownership transfers

2. **Ownership path analysis**:
   - Track field access chains (e.g., `self.head` → `node.next` → `next_node.next`)
   - Maintain "root owner" for each borrowed value
   - When reassigning to value with same root owner, skip dup/drop

3. **Borrowed vs owned parameter tracking**:
   - Analyze function bodies to determine if parameters are only read
   - Mark read-only parameters as "borrowed" (no dup on pass)
   - Mark stored parameters as "owned" (dup required)

4. **Pattern matching optimization**:
   - Recognize destructive reads in match expressions
   - Reuse enum/struct wrappers when possible
   - Eliminate allocation/deallocation pairs

**Benefits:**
- Eliminates dup/drop in linked list traversals
- Eliminates dup/drop in tree traversals
- Reduces function call overhead
- More efficient code without sacrificing safety

**Complexity:**
- Requires sophisticated dataflow analysis
- Needs to handle aliasing correctly
- Conservative fallback when analysis is uncertain

#### Example: Optimized Linked List Traversal

```rust
// Phase 1 (conservative):
.Some(current) => {
  ___dup(current.next);      // +1 RC
  ___drop(current_opt);      // -1 RC
  current_opt = current.next;
}
// Cost: 2 RC operations per iteration

// Phase 2 (Perceus-optimized):
.Some(current) => {
  current_opt = current.next;  // Just pointer update
}
// Cost: 0 RC operations
// Why: Same ownership chain (self.head), last use of old current_opt
```

## Summary

Yo's compile-time reference counting uses **ownership analysis** and **lifetime analysis**:

**Ownership Analysis:**
- Track which temp variable owns each heap allocation
- Variables borrow from temp variables by default
- Constructors and field assignments require explicit dup

**Lifetime Analysis:**
- Detect when borrowed values outlive their owners
- Insert `___dup`/`___drop` to prevent use-after-free
- Optimize away unnecessary operations when provably safe

**Two-Phase Approach:**
- **Phase 1 (Conservative)**: Simple scope-based lifetime checking - always safe, may have overhead
- **Phase 2 (Optimized)**: Ownership chain tracking - eliminates unnecessary dup/drop in hot paths

**Goal:** Make Yo safe and ergonomic by default, with transparent optimizations for performance.
