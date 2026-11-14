# A `Dyn` listing `Clone` shadows its handle's own `clone` (E0616), and offers an unsized value

**Severity:** S2 (found by the d49 flip's own probes on `vbd/d49-flip`; every `Box(Dyn(..., Clone))` program hit it)

**Date:** 2026-11-14

## Verbatim error

```text
error[E0616]: "clone" is a method of Box(dyn(Speak + Clone)) and of its payload dyn(Speak + Clone), so c.clone(...) could mean either (plans/VALUES_BY_DEFAULT.md decision 32).
Write Box.clone(c) for the Box's own clone, or c.*.clone(...) for the payload's.
```

and, taking the message's second suggestion:

```text
error[E0619]: `dyn(Speak + Clone)` is not `Sized`: the local `e` needs a size, and an unsized type lives only behind a pointer
```

## Reproducer (`tmp/fixme.yo`)

```yo
Speak :: trait(speak : (fn(self : &Self) -> i32));
Cat :: struct(n : i32);
impl(Cat, Speak(speak : ((self : &Self) -> self.n)));
derive(Cat, Clone);
main :: (fn() -> unit)({
  (c : Box(Dyn(Speak, Clone))) = dyn(Box.new(Cat(n : i32(4))));
  d := c.clone(); // E0616 before the fix; the box's clone after
});
export(main);
```

## Root cause

`get_receiver_methods_by_name_from_env`'s `DynT` walk (`src/env.yo`) pushed
every function-typed field of every required trait as a callable receiver
method — including the prelude `Clone`'s `clone`. Under decision 49's flip the
erased `Self` a `Dyn`'s `clone` would return is unsized, so `Clone` contributes
the vtable's `clone_into` slot and no method of its own
(`docs/en-US/DYN_DESIGN.md`, "Ownership"). With the method present:

- `b.clone()` over the owning handle read as an ambiguity with the handle's own
  `clone` (E0616), and
- `b.*.clone()` resolved to a method returning the unsized `Dyn` (E0619 at the
  binding).

## Fix

`src/env.yo`: the `DynT` receiver-method walk skips a required trait for which
`is_clone_trait_type` holds (the same recognizer `dyn_impl_clone_fid` uses).

## Test

`tests/dyn.test.yo`: "Box(Dyn(T, Clone)).clone() is the box's clone" (a
counting-`Clone` payload cloned exactly once through `clone_into`, the source
unchanged) and "a Dyn's Clone is not a method of the erased value"
(`b.*.clone()` is an error). Fails before the fix, passes after.
