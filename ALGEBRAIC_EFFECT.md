I am thinking about bringing the algebraic effects back to the Yo language.

First of all, I would like to reintroduce the `using` keyword used in function signature for contextual parameters, aka implicit parameters.

So we have something like:

```
add_numbers :: (fn(
  x : i3,
  y : i32,
  using(add_fn : (fn(a : i32, b : i32) -> i32))
  ) -> i32)(
  add_fn(x, y)
);
```

then we simply define the variable with the required signature in the context, so the evaluator can pick it:

```
add : (fn(x : i32, y : i32) -> i32)(
  x + y
);
add_numbers(3, 4); // It should be the `add` above.
```

The first question is should we put the `given` keyword back to use for defining the implicit variable, or we just pick the latest variable in the env frames?

With `given` we have code like:

```
given(add) : (fn(x : i32, y : i32) -> i32)(
  x + y
);
add_numbers(3, 4); // It should be the `add` above.
```

so we know `add` is the implicit variable. But I wonder if that could introduce complexity.

---

After that, I would like to introduce the `ctl` keyword for effectful function that could `resume`, like the one in `koka`.

For example, below is a code example of using the `Raise` effect.

```
Raise :: (ctl(forall(T : Type), msg : String) -> T)

safe_divide :: (fn(x : i32, y : i32, using(raise: Raise)) -> i32)
  cond
    (y == 0) => raise(`div-by-zero`),
    true => (x / y)
;
```

then we defining the handler:

```
raise_const :: (fn() -> i32) {
  (comptime(raise) : Raise) =
    (msg) -> 42
  ;
  8 + safe_divide(1, 0) + 10
};
raise_const(); // Should return 42, (not 60)
```

another example with `resume`:

```
raise_const :: (fn() -> i32) {
  (comptime(raise) : Raise) =
    (msg) -> resume(42)
  ;
  8 + safe_divide(1, 0) + 10
};
raise_const(); // Should return 60
```

---

Below are my questions:

I am thinking about converting the `ctl` function, and the functions that uses `ctl` functions (like in `using`) to state machine, like we did for async/await state machine generation. Will that work? Is that the correct approach?

Also, for our example above, in this case, should we also convert `raise_const`, which is a `fn` but not `ctl` and not use `ctl` in its function signature, to state machine?

Given we are using reference counting in Yo, should we support one-shot delimited contiuation, or multi-shot delimited continuation?

Should the `resume` variable be a closure in our implementation? If so then should it be using static (Impl) or dynamic (Dyn) dispatch?  
Or should we just take it as a regular function?

Will having algebraic effects in Yo make Yo stand out from other programming languages?
