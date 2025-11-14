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

### 2. Function Parameters: Always Own

Function parameters **always own** their values. The caller must call `___dup` at the call site:

```rust
fn print_point(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);
  // p is dropped at end of function
}

point := Point(3, 4);
print_point(point);  // ___dup(point) at call site, p owns a copy
// point is still valid after the call
```

**Rule:** Parameters always own their values. Every function call creates independent ownership via `___dup`.

**Destructuring also owns:**

```rust
// Destructuring assignment owns
Point(x, y) := point;  // ___dup fields from point, x and y own

// Match destructuring owns
match(result,
  .Ok(value) => printf("%d", value),  // ___dup from result, value owns
  .Err(e) => printf("error")          // ___dup from result, e owns
);
```

**Why always own?** This prevents use-after-free bugs in multi-threaded environments:

```rust
x := Container(a: box(42));  // x owns the container

// Thread 1:
func1(x.a);  // ___dup(x.a), func1's param owns a separate reference
  // Inside func1, param has RC ≥ 2 (caller still holds reference)

// Thread 2 (concurrent):
x.a = box(100);  // ___dup(box(100)), ___drop(old x.a)
  // The old box(42) RC decrements but stays ≥ 1 (func1 still owns it)

// Back in Thread 1:
// func1's param still points to VALID MEMORY ✅ Safe!
// When func1 returns, ___drop(param) finally frees the old box(42)
```

## Basic Model

### Ownership and Reference Counting

Each heap allocated ARC value can have multiple owners through reference counting. Its reference counter starts at 1.

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

### Function Parameters Own

Function parameters always increment the reference count via `___dup` at call site:

```rust
fn use_point(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);
  // p is dropped at end of function
}

point := Point(3, 4);  // temp_var owns, RC = 1
                       // ___dup(temp_var), point owns, RC = 2
use_point(point);      // ___dup(point) at call site, p owns, RC = 3
                       // ___drop(p) at end of use_point, RC = 2
// End of scope: ___drop(point), ___drop(temp_var)
```

## Our Approach: Simple Ownership with Optimization

Yo prioritizes **safety and simplicity** with a path to optimization:

1. **Always safe**: Code never has use-after-free bugs
2. **Simple rules**: Everything always owns (assignments, parameters, destructuring)
3. **Predictable**: Easy to understand when dup/drop happens
4. **Optimizable**: Compiler analysis eliminates unnecessary operations

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

- ✅ Simple mental model (everything always owns)
- ✅ Zero risk of memory safety bugs
- ✅ Thread-safe by construction (RC ≥ 2 prevents premature free)
- ⚠️ RC overhead from function calls and assignments
- ✅ Can be optimized away through compiler analysis

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

**Call `___dup` when returning a parameter:**

```rust
fn identity(p: Point) -> Point {  // p owns (parameter always owns)
  return p;  // ___dup(p), return value owns a copy
  // ___drop(p) after return
}

fn create() -> Point {
  p := Point(3, 4);  // p owns
  return p;          // ___dup(p), return value owns a copy
  // ___drop(p) after return
}
```

### Rule 4: Function Calls

**Always call `___dup` when passing arguments to function parameters:**

```rust
fn print_point(p: Point) -> unit {  // p owns (parameter always owns)
  printf("(%d, %d)", p.x, p.y);
  // ___drop(p) at end of function
}

point := Point(3, 4);  // point owns
print_point(point);    // ___dup(point) at call site, p owns a copy
                       // point is still valid after call
```

### Rule 5: Destructuring

**Destructuring always calls `___dup` to create owned copies:**

```rust
// Destructuring assignment owns
Point(x, y) := point;  // ___dup fields, x and y own copies

// Match destructuring owns
match(optional,
  .Some(value) => {
    // ___dup from optional, value owns a copy
    printf("%d", value);
    // ___drop(value) at end of branch
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
      // ___dup from current_opt, current owns
      current_opt = current.next;  // ___dup(current.next)
                                   // ___drop(old current_opt)
      // ___drop(current) at end of branch
    }
  );
}

// End of scope: ___drop(current_opt)
```

**Analysis:**

- Initial: `___dup(self.head)` creates owned copy
- Each iteration:
  - Match destructuring: `___dup(current)` from current_opt
  - Assignment: `___dup(current.next)` + `___drop(old current_opt)`
  - End of branch: `___drop(current)`
- End: `___drop(current_opt)` cleans up

**Cost:** 3 RC operations per iteration (2 dups + 1 drop)

This is conservative but correct. Compiler optimization can eliminate these operations.

## Implementation Strategy

### Phase 1: Simple Ownership (Implemented ✅)

The straightforward "everything always owns" model is now fully implemented:

**Rules:**

1. **Assignments (`:=` and `=`)**: Always call `___dup` on RHS, `___drop` on old LHS ✅
2. **Function parameters**: Always own, call `___dup` at call site ✅
3. **Parameters are not reassignable**: Language-level constraint (applies to all bindings) ✅
4. **Scope exit**: Call `___drop` on all owned variables ✅
5. **Deferred drops in branches**: All branching constructs (cond, match, while, for) properly emit drop calls ✅
6. **Destructuring owns**: Both destructuring assignment and match destructuring call `___dup` ✅

**Example:**

```rust
fn process(p: Point) -> unit {
  printf("(%d, %d)", p.x, p.y);
  // ___drop(p) at end of function
}

x := Point(3, 4);  // ___dup, x owns
y := x;            // ___dup(x), y owns
process(y);        // ___dup(y), process's p owns a copy
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

### Phase 2: Thread-Safe Dup/Drop Optimization (Proposed)

A more sophisticated optimization that **maintains RC > 1** throughout a variable's lifetime, ensuring thread-safety while eliminating unnecessary operations:

**Algorithm: Smart Dup/Drop Balancing**

For each variable in a scope, count all `___dup` and `___drop` operations, then apply these rules:

1. **Balanced (dup_count == drop_count)**: Keep one pair minimum
   - Keep the **earliest dup** (establishes ownership)
   - Keep the **latest drop** (cleanup at scope end)
   - Remove all other dup/drop operations
   - **Guarantees**: RC ≥ 2 during lifetime (thread-safe!)

2. **More dups (dup_count > drop_count)**: Keep earliest dup only
   - Keep the **earliest dup** (establishes ownership)
   - Remove all other dup operations
   - Remove all drop operations
   - **Guarantees**: RC ≥ 2 during lifetime (thread-safe!)

3. **More drops (dup_count < drop_count)**: Keep latest drop only
   - Remove all dup operations
   - Keep the **latest drop** (cleanup at scope end)
   - Remove all other drop operations
   - **Guarantees**: RC ≥ 2 during lifetime (thread-safe!)

**Example 1: Balanced case**

```rust
x := Point(3, 4);   // temp_var owns, RC = 1
                    // ___dup(temp_var), x owns, RC = 2  [EARLIEST DUP - KEEP]
y := x;             // ___dup(x), y owns, RC = 3         [REMOVE]
z := x;             // ___dup(x), z owns, RC = 4         [REMOVE]
// ___drop(z)       // RC = 3                            [REMOVE]
// ___drop(y)       // RC = 2                            [REMOVE]
// ___drop(x)       // RC = 1                            [LATEST DROP - KEEP]
// ___drop(temp_var) // RC = 0, freed

// After optimization:
// Only ___dup(temp_var) and ___drop(x) remain!
// x's RC stays at 2 throughout its lifetime (thread-safe)
```

**Example 2: More dups than drops**

```rust
x := Point(3, 4);   // temp_var owns, RC = 1
                    // ___dup(temp_var), x owns, RC = 2  [EARLIEST DUP - KEEP]
y := x;             // ___dup(x), y owns, RC = 3         [REMOVE]
process(x);         // ___dup(x), param owns, RC = 4     [REMOVE]
                    // ___drop(param), RC = 3
// ___drop(y)       // RC = 2                            [REMOVE]
// ___drop(x)       // RC = 1                            [REMOVE]
// ___drop(temp_var) // RC = 0, freed

// After optimization:
// Only ___dup(temp_var) remains!
// x's RC stays at 2+ throughout its lifetime (thread-safe)
```

**Example 3: More drops than dups (unusual but possible)**

```rust
// Passed from outer scope, no local dup
fn process(x: Point) -> unit {
  // x owns, but no dup in this scope
  y := x;             // ___dup(x), y owns              [REMOVE]
  // ___drop(y)       // cleanup                        [REMOVE]
  // ___drop(x)       // cleanup                        [LATEST DROP - KEEP]
}

// After optimization:
// Only ___drop(x) remains!
```

**Why this is thread-safe:**

By keeping at least one `___dup` or ensuring RC starts ≥ 2, we guarantee that:
- The reference count never drops to 1 during the variable's active lifetime
- Even if another thread drops its reference, RC stays ≥ 1
- No use-after-free in multi-threaded environments

**Implementation strategy:**

1. Collect all `___dup` and `___drop` calls for each variable in a scope
2. Track the position (earliest/latest) of each operation
3. Apply the balancing algorithm based on dup/drop counts
4. Remove optimized-away operations from the AST

**Benefits:**

- ✅ Dramatically reduces RC overhead (eliminates most dup/drop pairs)
- ✅ Maintains thread-safety (RC > 1 invariant)
- ✅ Predictable and verifiable optimization
- ✅ Works within scope boundaries without complex lifetime analysis

## Future Optimizations

The proposed implementation (Phase 1 + Phase 1.5 + Phase 2) provides an **excellent balance** of safety, simplicity, and performance:

- ✅ Zero memory safety bugs
- ✅ Simple "everything always owns" model
- ✅ Eliminates most dup/drop pairs while maintaining thread-safety (RC > 1)
- ✅ Predictable and verifiable optimization algorithm

**For zero-cost iteration**, the proper solution is **pointer types**, not RC optimization:

```rust
// With pointer types (future feature):
current_ptr := &(self.head);  // Borrow pointer, no RC operations

while runtval(true), {
  match(current_ptr.*,
    .None => return false,
    .Some(current) => {
      current_ptr = &(current.next);  // Pointer reassignment, no RC!
    }
  );
}
```

**Why pointer types are necessary:**

Attempting to eliminate `___dup` on assignments breaks the "assignments always own" invariant:

```rust
// Problem: Inconsistent ownership semantics
current_opt := self.head;     // If we skip dup → current_opt borrows

// Later in code:
local := Node(42, .None);
current_opt = local;          // Should this dup or not?
                              // - If it dups: inconsistent (initial borrowed, now owns)
                              // - If it doesn't dup: use-after-free (local drops, current_opt invalid)
```

**The choice is binary:**
1. **Always own** (current model): Safe, simple, some RC overhead
2. **Explicit borrowing** (pointer types): Zero overhead, requires lifetime tracking

Trying to optimize RC while maintaining "assignments always own" leads to inconsistent or unsound behavior. The correct solution is to introduce proper pointer types with borrow checking, similar to how Rust uses `&T` for borrowed pointers.

**Note on Nim's approach:**

Nim uses ARC with a similar "assignments own" model. For iteration, Nim relies on:
1. The `lent T` type for temporary borrows (compiler-checked, limited scope)
2. `var T` parameters for mutable borrows (function parameters only)
3. Cursor inference to detect last-use and eliminate RC operations in simple cases

However, Nim's optimizations are heuristic-based and can be unpredictable. Our approach prioritizes simplicity and predictability, with explicit pointer types as the solution for zero-cost traversal patterns.

## Summary

Yo's compile-time reference counting uses a **simple ownership model** with **progressive optimization**:

**Phase 1 - Simple Ownership (Implemented ✅):**

- **Everything always owns**: Variables, parameters, destructured values - all use `___dup` to own
- **Assignments always own**: `:=` and `=` always call dup/drop
- **Function calls always dup**: Call site performs `___dup` for each argument
- **Destructuring always owns**: Both assignment and match destructuring call `___dup`
- **Scope exit cleanup**: All owned variables call `___drop` at scope exit
- **Branch cleanup**: All branching constructs (cond, match, while, for) properly emit deferred drops

**Phase 1.5 - Basic Dup/Drop Optimization (Implemented ✅):**

- **Shared ownership tracking**: `isOwningTheSameARCValueAs` field tracks when variables own the same ARC value
- **Dup/drop cancellation**: Matching dup/drop pairs for the same base variable are eliminated
- **Scope-local optimization**: Works within begin blocks and branch bodies
- **Reassignment temps**: Optimizes temporary variables created during reassignments in branches

**Phase 2 - Thread-Safe Dup/Drop Optimization (Proposed):**

- **Smart dup/drop balancing**: Count-based algorithm keeps minimal operations while maintaining RC > 1
- **Three optimization cases**: Balanced (keep earliest dup + latest drop), more dups (keep earliest dup), more drops (keep latest drop)
- **Thread-safety guarantee**: Always maintains RC ≥ 2 during variable's active lifetime
- **Dramatic RC reduction**: Eliminates most dup/drop operations without complex analysis
- **Predictable and verifiable**: Simple counting algorithm, easy to understand and validate

**Future Direction:**

For zero-cost iteration and traversal, the solution is **pointer types** with borrow checking, not RC optimization. Attempting to optimize away `___dup` while maintaining "assignments always own" leads to inconsistent ownership semantics. See "Future Optimizations" section above for details.

**Design Goals:**

- **Phase 1**: Simple "everything owns" model - easy to implement and understand ✅
- **Phase 1.5**: Eliminate obvious dup/drop pairs without complex analysis ✅
- **Phase 2**: Smart balancing algorithm that maintains thread-safety (RC > 1) while minimizing operations
- **Future**: Add pointer types for zero-cost borrowing patterns
- **Overall**: Make Yo safe and ergonomic by default, thread-safe by construction, with transparent and aggressive performance optimizations
