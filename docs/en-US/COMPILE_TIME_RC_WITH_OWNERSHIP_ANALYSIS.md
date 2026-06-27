# Compile-time Reference Counting with Ownership and Lifetime Analysis

Yo uses non-atomic reference counting for heap-allocated objects, and employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

Non-atomic RC is sound in Yo because GC-managed objects are **thread-local** and cannot be shared across threads unless they are explicitly `Send` (see [PARALLELISM.md](./PARALLELISM.md)).

## Ownership Model

Yo uses a simplified ownership model with clear rules:

### 1. Variable Assignment: Always Own

Both `:=` (initialization) and `=` (reassignment) make the LHS **own** the value:

```rust
x := Point(3, 4);   // temp_var owns Point(3, 4), RC = 1
                    // ___dup(temp_var), x owns, RC = 2
y := x;             // ___dup(x), y owns, RC = 3
z = y;              // ___dup(y), ___drop(old z), z owns, RC = 4
// End of scope: ___drop(z), ___drop(y), ___drop(x), ___drop(temp_var)
```

**Rule:** Variables always own their values. Every assignment calls `___dup`, every scope exit calls `___drop`.

### 2. Function Parameters: Borrow by Default

Function parameters **borrow** by default (no reference count change). The absence of `own()` explicitly means the parameter borrows:

```rust
print_point :: (fn(p : Point) -> unit) {
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
move_point :: (fn(p : Point, dx : i32, dy : i32) -> unit) {
  p.x = (p.x + dx);  // ✅ OK: Mutating field through parameter
  p.y = (p.y + dy);  // ✅ OK: Mutating field through parameter
}

broken :: (fn(p : Point) -> unit) {
  p = Point(0, 0);   // ❌ ERROR: Cannot reassign parameter
}
```

**Rule:** Parameters are **not reassignable** to prevent ownership state changes.

### 4. Explicit Ownership Transfer: `own()` keyword

Use `own()` to transfer ownership to a function parameter.

**Move-ownership semantics:**

- If the argument already **owns** the GC value, the call **moves** ownership into the callee (the caller binding becomes consumed).
- If the argument is only **borrowed / non-owning** (e.g. a borrowed parameter), the compiler inserts `___dup` to materialize an owned temporary for the callee, and the original binding is still **consumed** (becomes unusable) to keep `own()` calls linear/consuming.

```rust
consume :: (fn(own(box): Box(i32)) -> unit) {
  printf("value: %d\n", box.(*));
  // box is dropped at end of function
}

b := box(42);      // b owns
consume(b);        // b cannot be used after this point

call_consume :: (fn(p : Box(i32)) -> unit) { // p borrows by default
  consume(p); // compiler inserts ___dup(p) to satisfy own(box)
  // p is NOT usable here (moved/consumed by the own() call)
}

call_consume_but_keep_using :: (fn(p : Box(i32)) -> unit) { // p borrows by default
  p2 := p;    // compiler inserts ___dup(p); p2 owns
  consume(p2); // p2 is consumed
  // p is still usable here
}
```

**Rule:** `own()` parameters take ownership; passing an owned value moves it, passing a borrowed value clones it via `___dup` and still consumes the argument binding.

## Basic Model

### Ownership and Reference Counting

Each heap allocated ARC value starts with a single owner. Its reference counter starts at 1.

```rust
Point :: ref(struct(x : i32, y : i32));

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
use_point :: (fn(p : Point) -> unit) {
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
arr(0) = p1;       // ___dup(p1), storing into array
```

### Rule 2: Passing to Constructors

**Always call `___dup` when passing to struct/enum/array constructors:**

```rust
p1 := Point(3, 4);           // p1 owns
data := Data(p1);            // ___dup(p1), data owns a copy
arr := [p1,];                 // ___dup(p1), array owns a copy
result := Result(Point).Ok(p1); // ___dup(p1), enum owns a copy
```

### Rule 3: Returning from Functions

**Call `___dup` when returning a borrowed parameter:**

```rust
identity :: (fn(p : Point) -> Point) {  // p borrows (parameter)
  return p;  // ___dup(p), return value owns a copy
}

create :: (fn() -> Point) {
  p := Point(3, 4);  // p owns
  return p;          // ___dup(p), return value owns a copy
  // ___drop(p) after return
}
```

### Rule 4: Scope Exit

**Call `___dup` when a value leaves its scope:**

**Begin blocks:**

```rust
x := box(1);
y := {
  ();
  x  // ___dup(x) when returning from begin block
};
// y now owns a copy, x still owns its copy
```

**Match expressions:**

```rust
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

**`own()` parameters take ownership (move if possible, otherwise dup):**

```rust
consume :: (fn(own(box): Box(i32)) -> unit) {
  printf("value: %d\n", box.(*));
  // box is dropped at end of function
}

b := box(42);      // b owns
consume(b);        // b is consumed
// b cannot be used after this point

// If the argument is borrowed/non-owning, the compiler inserts ___dup.
// Example: borrowed parameter passing to an own() parameter.
call_consume :: (fn(p : Box(i32)) -> unit) {
  consume(p); // inserts ___dup(p); p is consumed (not usable after this)
}
```

### Exception: Function Parameters (Borrow by Default)

**No `___dup` when passing to borrowed parameters (parameters without `own()`):**

```rust
print_point :: (fn(p : Point) -> unit) {  // p borrows (no own keyword)
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

while runtime(true), {
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

**Cost (before optimization):** 2 RC operations per iteration (dup + drop) + 1 initial dup + 1 final drop = 2N + 2 total for N iterations.

#### Loop Traversal Borrow Chain Optimization

The compiler now detects this traversal pattern and eliminates **all** RC operations (2N + 2 → 0). The key insight: every node accessed through the traversal variable is kept alive by the parameter's ownership of the entire data structure. The net RC effect across all iterations is zero for every node, so removing all dup/drop operations is safe.

**Pattern detection criteria:**

1. A variable is initialized from a parameter (or field of a parameter) that does not own the RC value (`isOwningTheRcValue: false`)
2. Inside a `while`-`match` loop, the variable is the match scrutinee
3. In one match branch, the variable is reassigned from a field of the match binding (traversal step)
4. The variable does not unwind the loop scope (no references after the loop except the begin block return value)

**What gets removed:**

- Initial `___dup` on the parameter expression
- Per-iteration `___dup` on the reassignment RHS
- Per-iteration `___drop` of the old value (save + drop pair)
- Scope-exit `___drop` at end of begin block
- Before-return `___drop` in early-exit branches

**Optimized output (0 RC operations):**

```c
void traverse(Node* head) {
    // current_opt = head (no dup)
    while (1) {
        if (current_opt.tag == None) {
            return;  // no drop
        }
        Node* current = current_opt.Some;
        current_opt = current->next;  // no dup, no drop of old
    }
    // no scope-exit drop
}
```

This optimization is implemented in `optimizeLoopTraversalBorrowChain` in `src/evaluator/exprs/begin.ts`.
