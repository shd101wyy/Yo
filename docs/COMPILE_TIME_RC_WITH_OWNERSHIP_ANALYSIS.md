# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses non-atomic reference counting for heap-allocated objects, and employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

## Ownership Model

Yo uses a simplified ownership model with clear rules:

### 1. Variable Assignment: Always Own

Both `:=` (initialization) and `=` (reassignment) make the LHS **own** the value:

```yo
x := Point(3, 4);   // temp_var owns Point(3, 4), RC = 1
                    // ___dup(temp_var), x owns, RC = 2
y := x;             // ___dup(x), y owns, RC = 3
z = y;              // ___dup(y), ___drop(old z), z owns, RC = 4
// End of scope: ___drop(z), ___drop(y), ___drop(x), ___drop(temp_var)
```

**Rule:** Variables always own their values. Every assignment calls `___dup`, every scope exit calls `___drop`.

### 2. Function Parameters: Borrow by Default

Function parameters **borrow** by default (no reference count change). The absence of `own()` explicitly means the parameter borrows:

```yo
fn print_point(p : Point) -> unit {
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

```yo
fn move_point(p : Point, dx : i32, dy : i32) -> unit {
  p.x = (p.x + dx);  // ✅ OK: Mutating field through parameter
  p.y = (p.y + dy);  // ✅ OK: Mutating field through parameter
}

fn broken(p : Point) -> unit {
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

```yo
Point :: object(x : i32, y : i32);

Point(3, 4); // temp_var owns the Point(3, 4), RC = 1
```

### Assignment Creates Ownership

Using `:=` for initialization calls `___dup` to create a new owner:

```yo
p1 := Point(3, 4); // temp_var owns Point(3, 4), RC = 1
                   // ___dup(temp_var)
                   // p1 now owns the value, RC = 2
```

When an owned variable goes out of scope, we automatically call `___drop` on it:

```yo
p1 := Point(3, 4); // temp_var owns Point(3, 4), RC = 1
                   // ___dup(temp_var), p1 owns, RC = 2

// End of scope
___drop(p1);       // RC = 1
___drop(temp_var); // RC = 0, memory freed
```

### Function Parameters Borrow

Function parameters do not increment the reference count:

```yo
fn use_point(p : Point) -> unit {
  printf("(%d, %d)", p.x, p.y);  // p borrows, no RC change
}

point := Point(3, 4);  // temp_var owns, RC = 1
                       // ___dup(temp_var), point owns, RC = 2
use_point(point);      // No ___dup, p borrows point
// End of scope: ___drop(point), ___drop(temp_var)
```

## The Lifetime Problem

**Critical Issue**: Naive borrowing without lifetime analysis leads to use-after-free bugs!

```yo
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

```yo
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

```yo
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

```yo
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

```yo
data.point = p1;   // ___dup(p1), storing into data structure
arr(0) = p1;       // ___dup(p1), storing into array
```

### Rule 2: Passing to Constructors

**Always call `___dup` when passing to struct/enum/array constructors:**

```yo
p1 := Point(3, 4);           // p1 owns
data := Data(p1);            // ___dup(p1), data owns a copy
arr := [p1,];                 // ___dup(p1), array owns a copy
result := Result(Point).Ok(p1); // ___dup(p1), enum owns a copy
```

### Rule 3: Returning from Functions

**Call `___dup` when returning a borrowed parameter:**

```yo
fn identity(p : Point) -> Point {  // p borrows (parameter)
  return p;  // ___dup(p), return value owns a copy
}

fn create() -> Point {
  p := Point(3, 4);  // p owns
  return p;          // ___dup(p), return value owns a copy
  // ___drop(p) after return
}
```

### Rule 4: Scope Exit
**Call `___dup` when a value leaves its scope:**

**Begin blocks:**
```yo
x := box(1);
y := {
  ();
  x  // ___dup(x) when returning from begin block
};
// y now owns a copy, x still owns its copy
```

**Match expressions:**
```yo
optional := Option(Box(i32)).Some(box(42)); // optional owns
x := match(optional,
  .Some(value) => // `value` here is borrowed, not owned
    value
    // ___dup(value) inserted here
  ,
  .None => {
    // Handle None case
    box(0)
  }
)
```

**Note:** The Phase 1.5 optimization often cancels these dup calls when they're paired with corresponding drop calls, effectively transferring ownership rather than creating unnecessary copies.

### Rule 5: The `own()` Keyword

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

```yo
fn print_point(p : Point) -> unit {  // p borrows (no own keyword)
  printf("(%d, %d)", p.x, p.y);
}

point := Point(3, 4);  // point owns
print_point(point);    // No ___dup! p borrows point
```

**Destructuring in match expressions also borrows:**

```yo
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

```yo
fn process(p : Point) -> unit {
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

**Technique: `isOwningTheSameGcValueAs` Tracking**

When a variable is assigned from another variable, we track the ownership relationship:

```yo
x := Point(3, 4);   // x owns Point(3, 4)
y := x;             // y owns Point(3, 4), y.isOwningTheSameGcValueAs = x

// Before optimization:
// ___dup(x), ___drop(y), ___drop(x)

// After optimization:
// ___dup(x) and ___drop(y) are paired and cancelled!
// Only ___drop(x) remains
```

**How it works:**

1. **Track shared ownership**: When `y := x`, mark `y.isOwningTheSameGcValueAs = x`
2. **Find base variable**: Follow the chain to find the root owner
3. **Match dup/drop pairs**: Group dup calls by base variable ID, match with drop calls
4. **Cancel pairs**: Remove one dup/drop pair per match

**Applied during:**

- Variable reassignment in begin blocks
- Temporary variables from reassignments in branches (cond, match)

**Example with reassignment in branches:**

```yo
x := MyBox(42);
cond(
  some_cond() => { x = MyBox(100); },  // Creates temp for old value
  true => { x = MyBox(200); }          // Creates temp for old value
);
// Temps are tracked with isOwningTheSameGcValueAs = x
// Dup/drop pairs for temps are optimized away
```

**Implementation details:**

- `getBaseVariableId(variable)`: Follows `isOwningTheSameGcValueAs` chain to root
- `collectDupCallsConservatively(expr)`: Recursively finds all dup calls
- `removeDupCalls(expr)`: Removes optimized dup calls from AST
- Optimization runs at begin block scope exit

**Current limitations:**

- Only optimizes within single scope (begin blocks)
- Doesn't optimize across function boundaries
- Conservative: Falls back to dup/drop when uncertain

**Important: Value Type Semantics**

The optimization must respect C's value type semantics. When assigning value types in C (structs, unions, arrays), the assignment performs a **shallow copy (memcpy)**:

```yo
// Value type (struct) with RC field:
x := { box(42) };   // temp owns struct, x.isOwningTheSameGcValueAs = temp
y := x;             // y.isOwningTheSameGcValueAs = x

// In C codegen:
// struct_type x = temp;     // memcpy - both x and temp exist!
// struct_type y = x;        // memcpy - both y and x exist!
```

After the memcpy, **both the source and destination exist as separate values**. Each needs its own drop call to decrement the RC of inner fields. Therefore:

**Rule:** Don't optimize dup/drop pairs for **value types** (structs, enums, arrays) that contain RC fields.
**Rule:** Only optimize for **pointer types** (`object(...)`) where assignment copies the pointer, not the data.

```typescript
// In begin.ts optimization:
const isValueTypeWithRCFields =
  !isObjectType(baseVariable.type) &&  // Not a pointer type
  typeContainsGcType(baseVariable.type);  // Contains RC fields

if (dupCalls && dupCalls.length > 0 && !isValueTypeWithRCFields) {
  // Safe to optimize: either pointer type or no RC fields
}
```

**Why this matters:**

- **Pointer types**: `x = ptr` copies the pointer → only one value exists → optimize ✅
- **Value types with RC fields**: `x = struct` does memcpy → two values exist → don't optimize ❌
- **Value types without RC fields**: Safe to optimize, but the check prevents it conservatively

## Future Optimizations

The current implementation (Phase 1 + Phase 1.5) provides a **good balance** of safety, simplicity, and performance:

- ✅ Zero memory safety bugs
- ✅ Simple "assignments always own" model
- ✅ Eliminates redundant dup/drop pairs within scopes
- ✅ Respects C value type semantics for correctness
- ✅ Parameters borrow by default (no RC overhead on calls)

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

- **Shared ownership tracking**: `isOwningTheSameGcValueAs` field tracks when variables own the same ARC value
- **Dup/drop cancellation**: Matching dup/drop pairs for the same base variable are eliminated
- **Scope-local optimization**: Works within begin blocks and branch bodies
- **Reassignment temps**: Optimizes temporary variables created during reassignments in branches

**Design Goals:**

- **Phase 1**: Simple, correct, safe - easy to implement and understand ✅
- **Phase 1.5**: Eliminate obvious dup/drop pairs without complex analysis ✅
- **Future**: Add pointer types for zero-cost borrowing patterns
- **Overall**: Make Yo safe and ergonomic by default, with transparent performance optimizations
