# Compile-time Reference Counting with Ownership and Lifetime Analysis

> **Status (2026-10-05).** This page describes today's compiler. Yo is moving
> to unique ownership with explicit copies
> ([`plans/VALUES_BY_DEFAULT.md`](../../plans/VALUES_BY_DEFAULT.md) §0, §3.14).
> - **What goes away:**
>   - The rule that every assignment, constructor argument, return and block
>     tail inserts `___dup`, and the dup/drop pair optimizer that cancels
>     those dups.
>   - The `___dup` that `own()` inserts for a borrowed argument, and `own`
>     itself. Parameters become by value by default: a copy for plain data,
>     a move for owning values. Borrows are spelled `imm(x)` (read-only)
>     and `mut(x)` (exclusive, today's `inout`), as decided in decision 30.
>   - A `String`, a collection, `Box` and `Dyn` will move at their last use
>     and otherwise need `.clone()`. Copying an `Rc`/`Arc` handle will need
>     `.clone()` too.
> - **What stays:** borrowing, now spelled `imm`/`mut`, scope-end drops and
>   use-after-move. E0908 stays as "an `imm` borrow is read-only" (§3.14).
> - **What changes for aliasing:**
>   - Stage 0's +1 is replaced by a shared borrow mark on the `Rc` cells an
>     argument is reached through (decision 28).
>   - The runtime borrow flag narrows to `Rc`/`Arc` cells.
>   - Module-level roots keep a static check.
>
> This page is edited as each phase lands, and becomes an "ownership and
> moves" page when `ref(...)` is removed.

Yo uses non-atomic reference counting for heap-allocated objects, and employs compile-time **ownership analysis** and **lifetime analysis** to eliminate unnecessary reference counting operations.

Non-atomic RC is sound in Yo because GC-managed objects are **thread-local** and cannot be shared across threads unless they are explicitly `Send` (see [PARALLELISM.md](./PARALLELISM.md)).

## Ownership Model

Yo uses a simplified ownership model with clear rules:

### 1. Variable Assignment: Always Own

Both `:=` (initialization) and `=` (reassignment) make the LHS **own** the value:

```rust
x := Point(x : i32(3), y : i32(4)); // the constructor's result moves into x, RC = 1
y := x; // ___dup(x), y owns, RC = 2
z = y; // ___dup(y), ___drop(old z), z owns, RC = 3
// End of scope: ___drop(z), ___drop(y), ___drop(x)
```

**Rule:** Variables always own their values. Assigning from a named variable calls `___dup`; a fresh value (a constructor or call result) moves in with no dup. Every scope exit calls `___drop`.

### 2. Function Parameters: Borrow by Default

Function parameters **borrow** by default (no reference count change). The absence of `own()` explicitly means the parameter borrows:

```rust
print_point :: (fn(p : Point) -> unit)({
  printf("(%d, %d)", p.x, p.y); // Just reading, no RC overhead
});

point := Point(x : i32(3), y : i32(4));
print_point(point); // No ___dup at call site, p borrows point
```

**Rule:** Parameters borrow unless explicitly marked with `own()`. Not having `own()` means borrow.

**Destructuring also borrows:**

```rust
// Destructuring assignment borrows
{ x, y } := point; // x and y borrow from point, no dup
// Match destructuring borrows
match(
  result,
  .Ok(value) => printf("%d", value),
  // value borrows from result
  .Err(e) => printf("error")
);
```

### 3. Parameter Mutation: Allowed, Reassignment: Forbidden

You can mutate **through** a parameter (modify fields), but cannot **reassign** the parameter itself:

```rust
move_point :: (fn(p : Point, dx : i32, dy : i32) -> unit)({
  p.x = (p.x + dx); // ✅ OK: Mutating field through parameter
  p.y = (p.y + dy); // ✅ OK: Mutating field through parameter
});

broken :: (fn(p : Point) -> unit)({
  p = Point(x : i32(0), y : i32(0)); // ❌ ERROR: Cannot reassign parameter
});
```

**Rule:** Parameters are **not reassignable** to prevent ownership state changes.

A by-value parameter borrows its value: its storage is a copy of the caller's, and a field
write changes only that copy. A field whose old value holds RC data (a `String`, a
collection, a `Box`, …) cannot be written through it, because the write would release data
the caller still holds (E0908). The same holds for a `match` or `for` binding, and for
passing such a place to an `inout` parameter the callee may write, including calling an
`inout(self)` method such as `push_str` on it: the write would land in the borrowed copy
alone. Read-only `inout(self)` methods (`clone`, `to_string`) and indexing stay allowed.
Take the parameter as `own(p) : T` or `inout(p) : T`, or copy it into a local first:

```rust
Named :: struct(s : String, n : i32);
rename :: (fn(p : Named) -> Named)({
  p.n = (p.n + i32(1)); // ✅ OK: no RC data in the old value
  // p.s = String.from("x"); // ❌ E0908: the caller still holds the old string
  // p.s.push_str("!"); // ❌ E0908: push_str writes the borrowed copy
  q := p; // an owned copy
  q.s = String.from("x"); // ✅ OK
  q
});
```

### 4. Explicit Ownership Transfer: `own()` keyword

Use `own()` to transfer ownership to a function parameter.

**Move-ownership semantics:**

- If the argument already **owns** the GC value, the call **moves** ownership into the callee (the caller binding becomes consumed).
- If the argument is only **borrowed / non-owning** (e.g. a borrowed parameter), the compiler inserts `___dup` to materialize an owned temporary for the callee, and the original binding is still **consumed** (becomes unusable) to keep `own()` calls linear/consuming.

```rust
consume :: (fn(own(box) : Box(i32)) -> unit)({
  printf("value: %d\n", box.*);
  // box is dropped at end of function
});

b := box(42); // b owns
consume(b); // b cannot be used after this point
call_consume :: (fn(p : Box(i32)) -> unit)({
  // p borrows by default
  consume(p); // compiler inserts ___dup(p) to satisfy own(box)
  // p is NOT usable here (moved/consumed by the own() call)
});

call_consume_but_keep_using :: (fn(p : Box(i32)) -> unit)({
  // p borrows by default
  p2 := p; // compiler inserts ___dup(p); p2 owns
  consume(p2); // p2 is consumed
  // p is still usable here
});
```

**Rule:** `own()` parameters take ownership; passing an owned value moves it, passing a borrowed value clones it via `___dup` and still consumes the argument binding.

## Basic Model

### Ownership and Reference Counting

Each heap allocated ARC value starts with a single owner. Its reference counter starts at 1.

```rust
Point :: ref(struct(x : i32, y : i32));

Point(x : i32(3), y : i32(4)); // temp_var owns the Point(x: i32(3), y: i32(4)), RC = 1
```

### Reading the Count: `ref_count(x)`

The builtin `ref_count(x)` returns the current reference count of the cell `x` holds, as a `usize`. For a value type (a plain `struct`, an integer) it is always `1`, known at compile time. Atomically counted handles (`Arc(T)`, `atomic(ref(...))`, `Iso`) are read with an atomic load.

```rust
b := Box(i32)(3);
assert(ref_count(b) == usize(1), "one owner");
```

The count reflects the compiler's dup/drop optimizations, so a copy the optimizer cancelled does not show up; it is meant for uniqueness checks (copy-on-write) and tests, not program logic.

`rc` is not the count. It is an ordinary prelude function that allocates a reference-counted cell: `rc(v)` takes ownership of `v` and returns a handle whose `ref_count` is `1`. Today it is the same as `box(v)` and returns a `Box(T)`, since Yo's `Box` is already reference counted.

```rust
a := rc(i32(42));
assert(ref_count(a) == usize(1), "a fresh cell has one owner");
```

Like every prelude name, `rc` cannot be redefined: a module-level or local definition named `rc` is a shadowing error. A function parameter or a `match` pattern binding named `rc` is allowed and shadows the prelude's `rc` inside its scope.

### Assignment Creates Ownership

A fresh value moves into its first binding; initializing from a named variable calls `___dup` to create a new owner:

```rust
p1 := Point(x : i32(3), y : i32(4)); // the constructor's result moves into p1, RC = 1
p2 := p1; // ___dup(p1), p2 is a second owner, RC = 2
```

When an owned variable goes out of scope, we automatically call `___drop` on it:

```rust
p1 := Point(x : i32(3), y : i32(4)); // p1 owns, RC = 1
// End of scope
___drop(p1); // RC = 0, memory freed
```

### Function Parameters Borrow

Function parameters do not increment the reference count:

```rust
use_point :: (fn(p : Point) -> unit)({
  printf("(%d, %d)", p.x, p.y); // p borrows, no RC change
});

point := Point(x : i32(3), y : i32(4)); // point owns, RC = 1
use_point(point); // No ___dup, p borrows point
// End of scope: ___drop(point)
```

## The Lifetime Problem

**Critical Issue**: Naive borrowing without lifetime analysis leads to use-after-free bugs!

```rust
x := box(12); // x owns box(12), RC = 1
{
  y := box(13); // y owns box(13), RC = 1
  x = y; // DANGER if x just borrows from y...
  // End of inner scope
  ___drop(y); // RC = 0, memory freed
};

printf("%d\n", x.*); // BUG: x would point to freed memory!
```

**Solution**: Always call `___dup` on assignment to maintain ownership.

With our model (assignments always own):

```rust
x := box(12); // x owns box(12), RC = 1
{
  y := box(13); // y owns box(13), RC = 1
  x = y; // ___dup(y), ___drop(old x), x owns new value
  // box(13): RC = 2; old box(12): RC = 0, freed
  ___drop(y); // box(13): RC = 1
};

printf("%d\n", x.*); // ✅ Safe: x owns box(13), RC = 1
___drop(x); // box(13): RC = 0, freed
```

## Our Approach: Simple Ownership with Optimization

Yo prioritizes **safety and simplicity** with a path to optimization:

1. **Always safe**: Code never has use-after-free bugs
2. **Simple rules**: Assignments own, parameters borrow
3. **Predictable**: Easy to understand when dup/drop happens
4. **Optimizable**: the ownership analysis eliminates unnecessary operations

**Example - simple and safe:**

```rust
x := box(12);
{
  y := box(13);
  x = y; // Always safe: ___dup(y), ___drop(old x)
};
printf("%d\n", x.*); // Always works: x owns a valid reference
```

**Trade-offs:**

- ✅ Simple mental model (assignments always own)
- ✅ Parameters borrow by default (efficient for reads)
- ⚠️ May have RC overhead from assignments
- ✅ Can be optimized away by the ownership analysis
- ✅ **Borrowed-argument aliasing is closed** (2026-08, Lobster-style borrow
  inference in two stages). A borrowed parameter used to be invalidated when the
  callee mutated the same field through another handle **inside a loop**
  (straight-line code was already protected by old-value drop deferral; loop drops
  cannot defer across iterations).

  - **Stage 0** — an RC-typed field **projection** passed to a **borrowing**
    parameter gets a caller-owned `+1` for the call. Plain locals stay `+0` (the
    caller's binding keeps them alive), as do owned temps, `inout` parameters, and
    extern/builtin callees (no Yo code runs inside them).
  - **Stage 1** — per-callee **mutation summaries** (`src/evaluator/effects/mutation_summary.yo`)
    ask "may this call transitively mutate RC container storage?"; the read-only
    majority get the `+0` borrow back. Stage 0 alone cost +23% self-compile time;
    Stage 1 returns all of it and more (45.3 s → 55.2 s → 38.5 s on
    `check ./std`), so the hole is closed at no runtime cost.

    A callee counts as **may-mutate** if it (transitively) assigns to an
    RC-typed place, performs an **explicit RC decrement** (`___drop`,
    `__yo_decr_rc` and friends — any of which can release the container-held
    reference a borrow depends on), calls an extern that is the
    runtime/allocator family, a libc `free`/`realloc`, or takes a callback,
    yields to the event loop via an io builtin, is a control function, or
    calls anything the compiler cannot resolve. It is a MAY-analysis:
    anything unrecognised counts as mutating. Compiler-_generated_ drops are
    not a hazard — they only ever target variables that own their value, and
    a borrow is non-owning by definition.

  See `issues/fixed/borrowed-arg-invalidated-by-aliased-container-mutation.md` for the
  reproducer, the staged design, and the landing logs.

## When to call `___dup` to increase the reference count?

### Rule 1: On Assignment (`:=` and `=`)

**Always call `___dup` on the RHS when assigning ARC values:**

```rust
p1 := Point(x : i32(3), y : i32(4)); // the result moves into p1 (no dup)
p2 := Point(5, 6); // moves into p2
p2 = p1; // ___dup(p1), ___drop(old p2), p2 shares p1's value
// End of scope
___drop(p2); // Decrement RC
___drop(p1); // Decrement RC
```

**Field/index assignment also calls `___dup`:**

```rust
data.point = p1; // ___dup(p1), storing into data structure
arr(0) = p1; // ___dup(p1), storing into array
```

### Rule 2: Passing to Constructors

**Always call `___dup` when passing to struct/enum/array constructors:**

```rust
p1 := Point(x : i32(3), y : i32(4)); // p1 owns
data := Data(p1); // ___dup(p1), data owns a copy
arr := [p1,]; // ___dup(p1), array owns a copy
result := Result(Point).Ok(p1); // ___dup(p1), enum owns a copy
```

### Rule 3: Returning from Functions

**Call `___dup` when returning a borrowed parameter:**

```rust
identity :: (fn(p : Point) -> Point)({
  // p borrows (parameter)
  return(p); // ___dup(p), return value owns a copy
});

create :: (fn() -> Point)({
  p := Point(x : i32(3), y : i32(4)); // p owns
  return(p); // ___dup(p), return value owns a copy
  // ___drop(p) after return
});
```

### Rule 4: Scope Exit

**Call `___dup` when a value leaves its scope:**

**Begin blocks:**

```rust
x := box(1);
y := {
  ();
  x // ___dup(x) when returning from begin block
};
// y now owns a copy, x still owns its copy
```

**Match expressions:**

```rust
optional := Option(Box(i32)).Some(box(42)); // optional owns
x := match(
  optional,
  // `value` here is borrowed, not owned
  // ___dup(value) inserted here
  .Some(value) => value,
  .None => box(0)
);
```

**Note:** The dup/drop pair optimizer (`_optimize_dup_drop_pairs`) often cancels these dup calls when they're paired with corresponding drop calls, effectively transferring ownership rather than creating unnecessary copies.

#### Soundness condition for dup/drop cancellation

Cancelling a dup against the scope-end drop is a **move**: the dup disappears AND the
variable is marked consumed, so no path drops it. That is sound **only if the dup
executes unconditionally on every path that reaches the scope end**. The optimizer
(`_optimize_dup_drop_pairs` in `src/evaluator/exprs/begin.yo`) therefore:

- collects dups **branch-aware** for `cond`/`match`: a dup present in only SOME
  fallthrough arms flags the variable (`vars_with_partial_branch_dups`) and the pair is
  preserved — dup on the taken arm, scope-end drop on every path;
- counts a dup in EVERY arm once per arm, so a runtime dup count above 1 also preserves the
  pair;
- follows `ExprInfo.macro_expansion` instead of the raw macro-call args, because `if(...)`
  keeps its macro head in the AST and only its recorded `cond` expansion exposes the
  branch structure. Walking the raw args treated an arm-internal dup as unconditional
  and cancelled it — leaking one reference on every path that skipped the arm
  (`issues/fixed/where-constraints-arraylist-96b-leak.md`, fixed 2026-08-06);
- never optimizes across `while` bodies (a loop-body dup executes N times, the
  scope-end drop once);
- skips `io.async` captures (the state machine needs both the dup and the drop).

### Rule 5: The `own()` Keyword

**`own()` parameters take ownership (move if possible, otherwise dup):**

```rust
consume :: (fn(own(box) : Box(i32)) -> unit)({
  printf("value: %d\n", box.*);
  // box is dropped at end of function
});

b := box(42); // b owns
consume(b); // b is consumed
// b cannot be used after this point
// If the argument is borrowed/non-owning, the compiler inserts ___dup.
// Example: borrowed parameter passing to an own() parameter.
call_consume :: (fn(p : Box(i32)) -> unit)({
  consume(p); // inserts ___dup(p); p is consumed (not usable after this)
});
```

### Exception: Function Parameters (Borrow by Default)

**No `___dup` when passing to borrowed parameters (parameters without `own()`):**

```rust
print_point :: (fn(p : Point) -> unit)({
  // p borrows (no own keyword)
  printf("(%d, %d)", p.x, p.y);
});

point := Point(x : i32(3), y : i32(4)); // point owns
print_point(point); // No ___dup! p borrows point
```

**Destructuring in match expressions also borrows:**

```rust
match(
  optional,
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
current_opt := self.head; // ___dup(self.head), current_opt owns
while(true, {
  match(
    current_opt,
    .None => return(false),
    .Some(current) => {
      current_opt = current.next; // ___dup(current.next)
      // ___drop(old current_opt)
    }
  );
});
// End of scope: ___drop(current_opt)
```

**Analysis:**

- Initial: `___dup(self.head)` creates owned copy
- Each iteration: `___dup(current.next)` + `___drop(old current_opt)`
- End: `___drop(current_opt)` cleans up

**Cost:** 2 RC operations per iteration (dup + drop) + 1 initial dup + 1 final drop = 2N + 2 total for N iterations.

#### No traversal optimization in the self-hosted compiler

The retired TypeScript compiler recognized this loop and removed all of its
RC operations (2N + 2 → 0). That optimization was never ported to the
self-hosted compiler (the note in `src/evaluator/exprs/begin.yo` beside the
pair optimizer), so each iteration pays the dup and the drop above.
`issues/fixed/loop-traversal-borrow-chain-mutation-uaf.md` records the
use-after-free its mutation guard had to close. Under unique ownership the
language replaces it: a local borrow re-pointed into the node it already
borrows walks the list (`plans/VALUES_BY_DEFAULT.md`, decision 25). Over
`Box` nodes the walk has no count traffic; over `Rc` nodes each step pins the
entered cell, one increment and one decrement.
