# Rust like trait system

Our current Yo language design embraces incoherence and give programmers a way to manually choose an implementation when there's a conflict. 
However, I feel this approach introduces unnecessary complexity and cognitive load for programmers.  
Therefore, I would like to migrate to Rust style coherence by simply refusing to compile programs that contain conflicting implementations:


```rust
id :: trait(
  id : (fn(self : Self) -> Self)
);

impl(i32, Id(
  id : ((self)-> {
    return self;
  })
));

impl(forall(T : Type), ArrayList(T), Id(
  id : ((self) -> {
    return self;
  })
));

(i32 <: Id).id(12);
(ArrayList(i32) <: Id).id(ArrayList(i32).new());
```

Use Rust like orphan rule:
- A type can implement a trait if either the type or the trait is defined in the current package.


Separate `trait` and `module` concepts. In this design, `module` is no longer used as `trait`:

```rust
SomeModule :: module { // Use the module keyword to define modules
  x :: 1;
  add :: (fn(x : i32, y : i32) -> i32) {
    return (x + y);
  };
  export x, y;
};
```

QUESTION: Should we keep `trait` as structural type or nominal type?