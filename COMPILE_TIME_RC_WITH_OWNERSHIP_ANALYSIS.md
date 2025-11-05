# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses automatic reference counting (ARC) for heap-allocated objects, but employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

## Ownership Model

Yo uses a simplified ownership model with clear rules:

### 1. Variable Assignment: Always Own

Both `:=` (initialization) and `=` (reassignment) make the LHS **own** the value:

```rust
x := Point(3, 4);   // ___dup(Point(3,4)), x owns
y := x;             // ___dup(x), y owns
z = y;              // ___dup(y), ___drop(old z), z owns
// End of scope: ___drop(z), ___drop(y), ___drop(x)
```

**Rule:** Variables always own their values. Every assignment calls `___dup`, every scope exit calls `___drop`.

### 2. Function Parameters: Borrow by Default

Function parameters **borrow** by default (no reference count change). The absence of `own()` explicitly means the parameter borrows:

```rust
fn print_point(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);  // Just reading, no RC overhead
}

point := Point(3, 4);
print_point(point);  // No ___dup at call site, p borrows point
```

**Rule:** Parameters borrow unless explicitly marked with `own()`. Not having `own()` means borrow.

**Destructuring also borrows:**

```rust
// Destructuring assignment borrows
Point(x, y) := point;  // x and y borrow from point, no dup

// Match destructuring borrows
match(result,
  .Ok(value) => printf("%d", value),  // value borrows from result
  .Err(e) => printf("error")
);
```

### 3. Parameter Mutation: Allowed, Reassignment: Forbidden

You can mutate **through** a parameter (modify fields), but cannot **reassign** the parameter itself:

```rust
fn move_point(p: Point, dx: i32, dy: i32) -> unit {
  p.x = (p.x + dx);  // ✅ OK: Mutating field through parameter
  p.y = (p.y + dy);  // ✅ OK: Mutating field through parameter
}

fn broken(p: Point) -> unit {
  p = Point(0, 0);   // ❌ ERROR: Cannot reassign parameter
}
```

**Rule:** Parameters are **not reassignable** to prevent ownership state changes.

### 4. Explicit Ownership Transfer: `own()` keyword

Use `own()` to transfer ownership to a function parameter. The caller must call `___dup` at the call site:

```rust
fn consume(own(box): Box(i32)) -> unit {
  printf("value: %d\n", box.(*));
  // box is dropped at end of function
}

b := box(42);      // b owns
consume(b);        // ___dup(b) at call site, ownership transferred to function
                   // b still owns its reference after the call
```

**Rule:** `own()` parameters take ownership via `___dup` at call site. The caller's variable remains valid.

## Basic Model

### Ownership and Reference Counting

Each heap allocated ARC value has a unique owner. Its reference counter starts at 1.

```rust
Point :: object(x : i32, y : i32);

Point(3, 4); // temp_var owns the Point(3, 4), RC = 1
```

### Assignment Creates Ownership

Using `:=` for initialization calls `___dup` to create a new owner:

```rust
p1 := Point(3, 4); // temp_var owns Point(3, 4), RC = 1
                   // ___dup(temp_var)
                   // p1 now owns the value, RC = 2
```

When an owned variable goes out of scope, we automatically call `___drop` on it:

```rust
p1 := Point(3, 4); // temp_var owns Point(3, 4), RC = 1
                   // ___dup(temp_var), p1 owns, RC = 2

// End of scope
___drop(p1);       // RC = 1
___drop(temp_var); // RC = 0, memory freed
```

### Function Parameters Borrow

Function parameters do not increment the reference count:

```rust
fn use_point(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);  // p borrows, no RC change
}

point := Point(3, 4);  // temp_var owns, RC = 1
                       // ___dup(temp_var), point owns, RC = 2
use_point(point);      // No ___dup, p borrows point
// End of scope: ___drop(point), ___drop(temp_var)
```

## The Lifetime Problem

**Critical Issue**: Naive borrowing without lifetime analysis leads to use-after-free bugs!

```rust
x := box(12);      // temp_var_x owns box(12), RC = 1
                   // ___dup(temp_var_x), x owns, RC = 2
{
  y := box(13);    // temp_var_y owns box(13), RC = 1
                   // ___dup(temp_var_y), y owns, RC = 2
  x = y;           // DANGER if x just borrows from y...

  // End of inner scope
  ___drop(y);           // RC = 1
  ___drop(temp_var_y);  // RC = 0, memory freed
};

printf("%d\n", x.*); // BUG: x would point to freed memory!
```

**Solution**: Always call `___dup` on assignment to maintain ownership.

With our model (assignments always own):

```rust
x := box(12);      // ___dup, x owns, RC = 2
{
  y := box(13);    // ___dup, y owns, RC = 2
  x = y;           // ___dup(y), ___drop(old x), x owns new value
                   // New box(13): RC = 3, old box(12): RC = 1

  ___drop(y);           // box(13): RC = 2
  ___drop(temp_var_y);  // box(13): RC = 1
  ___drop(temp_var_x);  // box(12): RC = 0, freed
};

printf("%d\n", x.*); // ✅ Safe: x owns box(13), RC = 1
___drop(x);          // box(13): RC = 0, freed
```

## Our Approach: Simple Ownership with Optimization

Yo prioritizes **safety and simplicity** with a path to optimization:

1. **Always safe**: Code never has use-after-free bugs
2. **Simple rules**: Assignments own, parameters borrow
3. **Predictable**: Easy to understand when dup/drop happens
4. **Optimizable**: Phase 2 analysis eliminates unnecessary operations

**Example - simple and safe:**

```rust
x := box(12);
{
  y := box(13);
  x = y;  // Always safe: ___dup(y), ___drop(old x)
}
printf("%d\n", x.*); // Always works: x owns a valid reference
```

**Trade-offs:**

- ✅ Simple mental model (assignments always own)
- ✅ Zero risk of memory safety bugs
- ✅ Parameters borrow by default (efficient for reads)
- ⚠️ May have RC overhead from assignments
- ✅ Can be optimized away through Phase 2 analysis

## When to call `___dup` to increase the reference count?

### Rule 1: On Assignment (`:=` and `=`)

**Always call `___dup` on the RHS when assigning ARC values:**

```rust
p1 := Point(3, 4); // ___dup(temp_var), p1 owns
p2 := Point(5, 6); // ___dup(temp_var2), p2 owns

p2 = p1;           // ___dup(p1), ___drop(old p2), p2 owns copy of p1's value

// End of scope
___drop(p2);       // Decrement RC
___drop(p1);       // Decrement RC
___drop(temp_var2);
___drop(temp_var);
```

**Field/index assignment also calls `___dup`:**

```rust
data.point = p1;   // ___dup(p1), storing into data structure
arr[0] = p1;       // ___dup(p1), storing into array
```

### Rule 2: Passing to Constructors

**Always call `___dup` when passing to struct/enum/array constructors:**

```rust
p1 := Point(3, 4);           // p1 owns
data := Data(p1);            // ___dup(p1), data owns a copy
arr := [p1];                 // ___dup(p1), array owns a copy
result := Result(Point).Ok(p1); // ___dup(p1), enum owns a copy
```

### Rule 3: Returning from Functions

**Call `___dup` when returning a borrowed parameter:**

```rust
fn identity(p: Point) -> Point {  // p borrows (parameter)
  return p;  // ___dup(p), return value owns a copy
}

fn create() -> Point {
  p := Point(3, 4);  // p owns
  return p;          // ___dup(p), return value owns a copy
  // ___drop(p) after return
}
```

### Rule 4: The `own()` Keyword

**`own()` parameters take ownership, caller must dup:**

```rust
fn consume(own(box): Box(i32)) -> unit {
  printf("value: %d\n", box.(*));
  // box is dropped at end of function
}

b := box(42);      // b owns
consume(b);        // ___dup(b) at call site, b is consumed
// b cannot be used after this point
```

### Exception: Function Parameters (Borrow by Default)

**No `___dup` when passing to borrowed parameters (parameters without `own()`):**

```rust
fn print_point(p: Point) -> unit {  // p borrows (no own keyword)
  printf("(%d, %d)", p.x, p.y);
}

point := Point(3, 4);  // point owns
print_point(point);    // No ___dup! p borrows point
```

**Destructuring in match expressions also borrows:**

```rust
match(optional,
  .Some(value) => {
    // `value` borrows from optional, no ___dup
    // `value` is also not reassignable.
    printf("%d", value);
  },
  .None => ()
);
```

## Special Case: Loops

In loops, assignments follow the same "always own" rule:

### Example: Linked List Traversal

```rust
current_opt := self.head;  // ___dup(self.head), current_opt owns

while runtval(true), {
  match(current_opt,
    .None => return false,
    .Some(current) => {
      current_opt = current.next;  // ___dup(current.next)
                                   // ___drop(old current_opt)
    }
  );
}

// End of scope: ___drop(current_opt)
```

**Analysis:**

- Initial: `___dup(self.head)` creates owned copy
- Each iteration: `___dup(current.next)` + `___drop(old current_opt)`
- End: `___drop(current_opt)` cleans up

**Cost:** 2 RC operations per iteration (dup + drop)

This is conservative but correct. Phase 2 optimization can eliminate these operations.

## Implementation Strategy

### Phase 1: Simple Ownership (Implemented ✅)

The straightforward "always own" model is now fully implemented:

**Rules:**

1. **Assignments (`:=` and `=`)**: Always call `___dup` on RHS, `___drop` on old LHS ✅
2. **Function parameters**: Borrow by default (no `own()` keyword), no `___dup` at call site ✅
3. **Parameters are not reassignable**: Prevent `param = value` (compile error) ✅
4. **Parameters can be mutated**: Allow `param.field = value` (calls dup) ✅
5. **`own()` parameters**: Call `___dup` at call site ✅
6. **Scope exit**: Call `___drop` on all owned variables ✅
7. **Deferred drops in branches**: All branching constructs (cond, match, while, for) properly emit drop calls ✅
8. **Destructuring borrows**: Both destructuring assignment and match destructuring borrow by default ✅

**Example:**

```rust
fn process(p: Point) -> unit {
  p.x = 10;        // ✅ OK: Mutate field (if Point is mutable)
  p = Point(0, 0); // ❌ ERROR: Cannot reassign parameter
}

x := Point(3, 4);  // ___dup, x owns
y := x;            // ___dup(x), y owns
process(y);        // No dup (y is borrowed by process)
z := y;            // ___dup(y), z owns

// ___drop(z), ___drop(y), ___drop(x), ___drop(temp_vars...)
```

**Benefits:**

- Simple to implement
- Always correct and safe
- Predictable behavior
- Clear mental model

### Phase 1.5: Basic Dup/Drop Optimization (Implemented ✅)

We've implemented a **same-value ownership tracking** optimization that eliminates redundant dup/drop pairs when variables share the same ARC value:

**Technique: `isOwningTheSameARCValueAs` Tracking**

When a variable is assigned from another variable, we track the ownership relationship:

```rust
x := Point(3, 4);   // x owns Point(3, 4)
y := x;             // y owns Point(3, 4), y.isOwningTheSameARCValueAs = x

// Before optimization:
// ___dup(x), ___drop(y), ___drop(x)

// After optimization:
// ___dup(x) and ___drop(y) are paired and cancelled!
// Only ___drop(x) remains
```

**How it works:**

1. **Track shared ownership**: When `y := x`, mark `y.isOwningTheSameARCValueAs = x`
2. **Find base variable**: Follow the chain to find the root owner
3. **Match dup/drop pairs**: Group dup calls by base variable ID, match with drop calls
4. **Cancel pairs**: Remove one dup/drop pair per match

**Applied during:**

- Variable reassignment in begin blocks
- Temporary variables from reassignments in branches (cond, match)

**Example with reassignment in branches:**

```rust
x := MyBox(42);
cond(
  some_cond() => { x = MyBox(100); },  // Creates temp for old value
  true => { x = MyBox(200); }          // Creates temp for old value
);
// Temps are tracked with isOwningTheSameARCValueAs = x
// Dup/drop pairs for temps are optimized away
```

**Implementation details:**

- `getBaseVariableId(variable)`: Follows `isOwningTheSameARCValueAs` chain to root
- `collectDupCallsConservatively(expr)`: Recursively finds all dup calls
- `removeDupCalls(expr)`: Removes optimized dup calls from AST
- Optimization runs at begin block scope exit

**Current limitations:**

- Only optimizes within single scope (begin blocks)
- Doesn't optimize across function boundaries
- Conservative: Falls back to dup/drop when uncertain

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
// Phase 1 (simple ownership):
current_opt := self.head;     // ___dup(self.head)

.Some(current) => {
  current_opt = current.next; // ___dup(current.next), ___drop(old current_opt)
}

// ___drop(current_opt)
// Cost: 1 initial dup + 2 RC operations per iteration + 1 final drop

// Phase 2 (Perceus-optimized):
current_opt := self.head;     // No dup! Eliminated (self outlives current_opt)

.Some(current) => {
  current_opt = current.next; // No dup/drop! Eliminated (same ownership chain)
}

// No drop! (current_opt was borrowing)
// Cost: 0 RC operations total
```

**Optimization techniques applied:**

1. **Ownership chain tracking**: `self.head` → `current.next` same chain
2. **Last-use analysis**: Old `current_opt` value not used after reassignment
3. **Borrowed parameter analysis**: `self` parameter outlives `current_opt`
4. **Destructive read**: Match destructures and reassigns in one operation

## Summary

Yo's compile-time reference counting uses a **simple ownership model** with **progressive optimization**:

**Phase 1 - Simple Ownership (Implemented ✅):**

- **Assignments always own**: `:=` and `=` always call dup/drop
- **Parameters borrow by default**: No RC overhead for function calls
- **Parameters are not reassignable**: Prevents ownership state changes
- **Parameters can be mutated**: Field mutation is allowed (`p.field = value`)
- **Explicit ownership with `own()`**: Clear when ownership transfers (not yet implemented)
- **Scope exit cleanup**: All owned variables call `___drop` at scope exit
- **Branch cleanup**: All branching constructs (cond, match, while, for) properly emit deferred drops

**Phase 1.5 - Basic Dup/Drop Optimization (Implemented ✅):**

- **Shared ownership tracking**: `isOwningTheSameARCValueAs` field tracks when variables own the same ARC value
- **Dup/drop cancellation**: Matching dup/drop pairs for the same base variable are eliminated
- **Scope-local optimization**: Works within begin blocks and branch bodies
- **Reassignment temps**: Optimizes temporary variables created during reassignments in branches

**Phase 2 - Perceus Optimizations (Future):**

- **Last-use analysis**: Transfer ownership instead of dup/drop
- **Ownership chain tracking**: Eliminate dup/drop when borrowing from same root
- **Borrowed parameter analysis**: Detect read-only vs stored parameters
- **Destructive reads**: Optimize pattern matching to reuse allocations

**Design Goals:**

- **Phase 1**: Simple, correct, safe - easy to implement and understand ✅
- **Phase 1.5**: Eliminate obvious dup/drop pairs without complex analysis ✅
- **Phase 2**: Fast, optimized - eliminate unnecessary RC operations transparently (future)
- **Overall**: Make Yo safe and ergonomic by default, with transparent performance optimizations
