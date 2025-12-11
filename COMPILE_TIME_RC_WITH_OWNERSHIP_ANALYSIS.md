# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses non-atomic reference counting for heap-allocated objects, and employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

## Ownership Model

Yo uses a simplified ownership model with clear rules:

### 1. Variable Assignment: Own by default, unless marked with `ref()`

Both `:=` (initialization) and `=` (reassignment) make the LHS **own** the value:

```rust
x := Point(3, 4);   // ___dup(Point(3, 4)), x owns
y := x;             // ___dup(x), y owns
z = y;              // ___dup(y), ___drop(old z), z owns
// End of scope: ___drop(z), ___drop(y), ___drop(x), __drop(Point(3, 4))
```

Unless marked with `ref()` to borrow:

```rust
x := Point(3, 4);           // ___dup(Point(3, 4), x owns
ref(y) := x;                // y borrows from x, no dup
ref(z) = y;                 // z borrows from y, no dup
// End of scope: ___drop(x), __drop(Point(3, 4))
```

**Rule:** Variables always own their values. Every assignment calls `___dup`, every scope exit calls `___drop`.

### 2. Function Parameters: Own by default, unless marked with `ref()`

- **own**

  ```rust
  fn print_point(p: Point) -> unit {
    printf("(%d, %d)", p.x, p.y);
    // Drop p at end of function
  }

  point := Point(3, 4);
  print_point(point);  // Call site does ___dup(point), p owns copy
  ```

- **ref**

  ```rust
  fn print_point(ref(p) : Point) -> unit {
    printf("(%d, %d)", p.x, p.y);  // Just reading, no RC overhead
    // No drop on p at end of function
  }

  point := Point(3, 4);
  print_point(point);  // No ___dup at call site, p borrows point
  ```

### 3. Destructuring: Own by default, unless marked with `ref()`

```rust
// Destructuring assignment borrows
_(x, y) := point;  // x and y own from point, calls dup.

_(ref(x), ref(y)) := point;  // x and y borrow from point, no dup.

// Match destructuring own by default
match(result,
  .Ok(value) => printf("%d", value),  // value borrows from result
  .Err(e) => printf("error")
);

// Unless marked with ref
match(result,
  .Ok(ref(value)) => printf("%d", value),  // value borrows from result
  .Err(e) => printf("error")
);
```

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

### Rule 3: Passing to Functions

**Call `___dup` when passing an owned variable to a function parameter:**

```rust
fn process(p: Point) -> unit {
  // p owns a copy of the argument
}
p1 := Point(3, 4);   // p1 owns
process(p1);         // ___dup(p1), p owns copy
```

### Rule 4: Destructuring

**Call `___dup` when destructuring into owned variables:**

```rust
point := Point(3, 4);        // point owns
_(x, y) := point;            // ___dup(point), x and y own copies
```

### Rule 5: Returning from Functions

**Call `___dup` when returning a borrowed parameter:**

```rust
fn identity(ref(p): Point) -> Point {  // p borrows (parameter)
  return p;  // ___dup(p), return value owns a copy
}

fn create() -> Point {
  p := Point(3, 4);  // p owns
  return p;          // ___dup(p), return value owns a copy
  // ___drop(p) after return
}
```

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

## Future Optimizations

The current implementation (Phase 1 + Phase 1.5) provides a **good balance** of safety, simplicity, and performance:

- ✅ Zero memory safety bugs
- ✅ Simple "assignments always own" model
- ✅ Eliminates redundant dup/drop pairs within scopes
- ✅ Parameters borrow by default (no RC overhead on calls)

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

**Future Direction:**

For zero-cost iteration and traversal, the solution is **pointer types** with borrow checking, not RC optimization. Attempting to optimize away `___dup` while maintaining "assignments always own" leads to inconsistent ownership semantics. See "Future Optimizations" section above for details.

**Design Goals:**

- **Phase 1**: Simple, correct, safe - easy to implement and understand ✅
- **Phase 1.5**: Eliminate obvious dup/drop pairs without complex analysis ✅
- **Future**: Add pointer types for zero-cost borrowing patterns
- **Overall**: Make Yo safe and ergonomic by default, with transparent performance optimizations
