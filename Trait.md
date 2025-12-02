# Rust like trait system

Our current Yo language design embraces incoherence and give programmers a way to manually choose an implementation when there's a conflict. 
However, I feel this approach introduces unnecessary complexity and cognitive load for programmers.  
Therefore, I would like to migrate to Rust style coherence by simply refusing to compile programs that contain conflicting implementations:

QUESTION: How about:
`impl` will attach the module value to the type.
It will not check the conflict with other `impl`s.
The conflict only happens when we try to use the trait method.

```rust
id :: module(
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


~~Separate `trait` and `module` concepts. In this design, `module` is no longer used as `trait`:~~

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

---

`where` keyword for `trait` bounds:

```rust
// function declaration
process :: (fn(forall(T : Type, U : Type),
  item : T,
  extra : U,
  where(  T <: (Display, Clone),
          U <: (Debug, Into(String)))
  ) -> String) {
    return format("{} and {:?}", item.clone(), extra);
  };

// struct declaration
Container :: (fn(compt(T) : Type, 
  where(
    T <: (Display, PartialOrd)
  )) -> compt(Type)) {
    return struct(
      value : T,

      show :: ((fn(self : Self)-> unit) {
        println("{}", self.value);
      }),

      compare :: ((fn(self : *(Self), other: *(T)) -> boolean) {
        return self.value < other.*;
      })
    );
  };

// module implementation for type
Processor :: module(
  process : (fn(self : *(Self)) -> unit)
);

impl(forall(T : Type), where(T <: (Debug, Serialize)),
   for: Container(T),
   Processor(
      process : ((self) -> {
        println("Processing: {:?}", self.value);
      })
   )
);

// module declaration
AdvancedDisplay :: (fn(compt(T) : Type,
  where(
    T <: Clone
  )) -> compt(Module)) {
  return module(
    display_with_clone : (fn(self : *(Self)) -> T)
  );
};
```

We can remove the use of `using` once we support `where` clauses.  