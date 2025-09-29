# Concurrency using Actor

It's using with non-atomic reference counting.

```rust
Worker :: actor
  x : i32,
  add :: ((fn(self : Self, y : i32) -> i32) {
    return self.x + y;
  })
;

worker1 := Worker(10); // spawn a new thread
worker2 := Worker(20); // spawn a new thread
// worker1 and worker2 run concurrently
// each thread has its own state and is isolated from others

result1 := worker1.add(5);  // result1 is 15
result2 := worker2.add(5);  // result2 is 25
```

Ownership

- 2nd-class references:
  - read   
  - write
- owned reference:
  - own

```rust
x := 1;
y := 2;
swap :: (fn(x : write(i32), y : write(i32)) {
  temp := x;
  x := y;
  y := temp;
});
swap(x, y);
```

```rust
x := ^(box(1)); // x : own(Box(i32));
y := x; // x is moved to y, x is invalid now
```

- ^  : to_own     (convert T to own(T), and panic if fails)
- ^? : try_to_own (returns Option)
- !^ : not_to_own (convert own(T) to T)

Rules for Actor:

- Its methods can only value types, own/read/write references. Not `ref struct` or types containing `ref struct`.

QUESTION: How to handle types that is for dynamic dispatch, eg, Dyn, Closure which might capture read/write references? Do we need to design new syntax for them?

```rust
some_fn :: (fn(x : write(i32)) -> i32) {
  closure := (fn(y : i32) => i32) {
    result := (x + y);
    x = y; // update x to y
  };
  // In this case, closure captures x which is write(i32)
  // however, as write reference is considered as 2nd-class reference
  // then assigning it to the variable `closure` is not allowed.
  // How do we distinguish from the signature like 
  // (fn(y : i32) => i32) to know if the closure captures read/write references, or not?
};

// Examples of different closure types:
pure_closure := ((Fn(x : i32) => i32) { return x * 2; });           // No captures
read_closure := ((FnRead(x : i32) => i32) { return x + global; }); // Captures read refs  
write_closure := ((FnWrite(x : i32) => i32) { global = x; });     // Captures write refs

// Examples of different Dyn types:
Dyn(Speak);
DynRead(Speak);
DynWrite(Speak);

// Examples of different IO types:
IO(i32);
IORead(i32);
IOWrite(i32);
```

