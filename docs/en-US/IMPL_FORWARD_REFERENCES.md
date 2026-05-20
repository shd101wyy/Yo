# Forward References in `impl` Blocks

Yo supports **forward references between sibling fields inside a single
`impl(...)` block**. Methods may call each other regardless of source order,
which enables natural mutual recursion without holder workarounds.

## Example

```rust
P :: struct(x : i32, y : i32);

impl(P,
  // `caller` references `callee` defined later in the same impl block.
  caller : (fn(inout(self) : Self) -> i32)(
    self.callee()
  ),
  callee : (fn(inout(self) : Self) -> i32)(
    self.x
  )
);
```

Mutual recursion across two methods works the same way:

```rust
N :: struct(value : i32);

impl(N,
  is_even : (fn(inout(self) : Self, n : i32) -> bool)(
    cond(
      (n == i32(0)) => true,
      true => self.is_odd((n - i32(1)))
    )
  ),
  is_odd : (fn(inout(self) : Self, n : i32) -> bool)(
    cond(
      (n == i32(0)) => false,
      true => self.is_even((n - i32(1)))
    )
  )
);
```

## Scope of forward references

Forward references currently work for:

- **Method-style fields** with the canonical shape
  `name : (fn(<sig>) -> R)(<body>)` — the form used by every `impl` in the
  standard library.
- **Both anonymous-trait impls and named-trait impls.** Methods inside
  `impl(T, SomeTrait( ... ))` can also call each other in any order.
- **Calls via `self.method(...)` and `Self.method(...)`.** Both
  instance-style (`self.X`) and type-style (`Self.X`) dispatch resolve
  forward references. Use bare-name reference is not supported (see below).

They do **not** apply to:

- **Bare-name references** to sibling methods (e.g. `callee()` instead of
  `self.callee()` or `Self.callee()`). Bare names are not forward-bound —
  use `self.X` or `Self.X` instead. This avoids accidentally shadowing
  local variables in sibling method bodies.
- **Cross-impl-block forward references.** Two separate `impl(P, ...)`
  blocks cannot forward-reference each other. Merge them into one block.
- **Top-level `name :: value` definitions.** No forward references between
  free top-level bindings yet.
- **Non-method field shapes.** Lambda bodies, `Impl(Fn(...))(...)` wrappers,
  and direct value bindings won't be forward-declared.

## How it works

`evaluateImplFieldList` runs in two passes:

1. **Pre-pass** — for each method-shaped field, evaluate just the
   `fn(<sig>) -> R` head to obtain the full `FunctionType` (including
   any explicit effect parameters). Allocate a real `FunctionValue` shell with
   the unevaluated body attached and a stable `funcId`. Register the shell
   in the receiver type's trait so that `self.method(...)` lookups resolve.
2. **Main pass** — evaluate each method body. When the body refers to a
   sibling method via `self.X` or `Self.X`, the lookup hits the pre-pass
   shell. After evaluation, fill the shell **in place** (preserving its
   `funcId`, `funcName`, and any specializations already created during
   sibling body evaluation).

Because the pre-pass produces real shells with real types and the original
body attached, specialization triggered by sibling body evaluation works
correctly — the shell has everything needed to clone and specialize.

The pre-pass deliberately skips:

- Non-method fields (associated types like `Item : Type`).
- Fields whose value isn't a `(fn(...) -> R)(body)` literal.
- Fields whose `fn(...)` head fails to evaluate (e.g. references unresolved
  symbols). These fall through to the main pass for the proper error.

## Why not bare-name forward refs?

Binding the pre-pass shell as a local variable would shadow names inside
sibling method bodies. For example:

```rust
impl(MyType,
  len : (fn(inout(self) : Self) -> usize) self.items.len(),
  // body declaring a local `len` would conflict with the sibling field
  trim : (fn(inout(self) : Self) -> Self) {
    len := usize(0); // would shadow the sibling
    // ...
  }
);
```

To avoid this footgun, sibling method references go through the receiver
trait via `self.method(...)` or `Self.method(...)`. This also makes
dispatch explicit and matches the code shape used everywhere else in the
standard library.

## Example: `Self.method` (type-style dispatch)

```rust
N :: struct(value : i32);

impl(N,
  is_even : (fn(n : i32) -> bool)(
    cond(
      (n == i32(0)) => true,
      true => Self.is_odd((n - i32(1)))
    )
  ),
  is_odd : (fn(n : i32) -> bool)(
    cond(
      (n == i32(0)) => false,
      true => Self.is_even((n - i32(1)))
    )
  )
);

// Call site uses the type name:
N.is_even(i32(10)) // true
```
