# The static E0923 message prints the holder's type without its `static` origin

**Severity:** S3 (a diagnostic contradicts itself: it says the type is declared over `static`, then prints a type with no
`static` in it).

**Status:** OPEN. Found 2026-11-25 by the p12-t6 lane while it checked the generic-container fix. Every E0923 that
`_static_origin_reject` raises (VERDICTS-74 rule 2, `src/evaluator/utils.yo`) shows it: typed locals, fields, arguments,
results and the generic-container store.

## The repro

```yo
X :: struct(n : i32);
Box1 :: (fn(comptime(T) : Type) -> comptime(Type))(
  struct(v : Option(T))
);
impl(
  generic(T : Type),
  Box1(T),
  put : (fn(self : &mut Self, v : T) -> unit)({
    self.v = .Some(v);
  })
);
main :: (fn() -> unit)({
  mut(b) := Box1(&(X, static))(v : .None);
  {
    x := X(n : i32(1));
    b.put(&x);
  };
  _ := b;
});
export(main);
```

```text
error[E0923]: Cannot keep this value in `b`: its type is declared over the empty origin `static` (`Box1(&X)`), which holds only values that borrow no place, and the value holds `x` (decision 49; plans/backlog/REFERENCES_AND_ORIGINS.md O3).
```

The type the user wrote is `Box1(&(X, static))`. The P12 lane's G-B logs show the same at the other sites: `(&X)` for a
`&(X, static)` local, `(Option(&X))` for an `Option(&(X, static))` field.

## Root cause

`_static_origin_reject` renders the holder with `type_to_string`, whose `Reference` arm prints no origin on purpose:
`type_key` falls back to that rendering, and origins stay out of every key (decision 43 step 1;
`src/types/string.yo`, the comment above the `ValueSlot` arm). Since P12 the static bit is the one part of an origin
in type identity, but it is not in the rendering either.

## Where the fix belongs

The diagnostic needs a rendering that spells a reference's origin (at least `static`), used by the E0923 messages and
not by `type_key`. Whether `type_to_string` itself should print the static bit (it is part of identity now) is the
question to settle first: changing it moves every key and C name that falls back to it.
