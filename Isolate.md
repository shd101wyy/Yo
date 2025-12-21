# Isolate Type

`Iso(T)` means `T` is an isolate type.
- If `T` is value type, then it is always an isolate type.
- If `T` is a reference type, then `Iso(T)` means `T` should have RC=1, recursively.

`Iso(T)` has move semantics. It can only be assigned to a variable, or passed to a function by move.
It cannot be used in `match`, passed to value constructor like `Array`, stored in data structure like `struct`, `enum`, etc.  

`Iso(T)` implements `Send` automatically.  

## Isolate module

The `Isolate` module provides function to check if a type can isolate.

```rust
Isolate :: module(
  can_isolate : (fn(self : Self) -> bool)
);
```

The user should implement this module for their own types to indicate if the type can isolate.
For example:

```rust
Data :: object(v : i32);
Point :: object(x : Data, y : Data);

impl(Data, Isolate(
  can_isolate : ((self) -> rc(self) == 1)
));

impl(Point, Isolate(
  can_isolate : ((self) -> 
    (rc(self) == 1) && 
    (self.x.can_isolate()) &&
    (self.y.can_isolate())
  )
));
```

## `^` operator

Something like below:

```rust
^ :: (fn(forall(T : Type), consume(v) : T, where(T <: Isolate)) -> Option(Iso(T)))(
  cond(
    Type.contains_gc_type(T) => cond(
      Type.can_form_gc_cycle(T) => .None, // cannot isolate
      v.can_isolate() => .Some(Iso(T)(v)),
      true => .None
    ),
    true => .Some(Iso(T)(v))
  )
);
```

## Example

```rust
x := ^(String.from("Hello")).unwrap(); // s : Iso(String)
// Then s can be sent to another thread safely.
y := x; // `x` is consumed here. `x` cannot be used anymore.

spawn(()=> {
  z := y; // `y` is moved here.
});

// `y` cannot be used anymore.
```