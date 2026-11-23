# A generic body at `T := &mut U` cannot move a `T` payload out of an owned enum (`Option(&mut U).unwrap()` is E0901)

**Severity:** S2: a valid program is rejected. `Option(&mut U).unwrap()` and every other `Option(T)` / `Result(T, E)` method that moves its payload out cannot be called at a `&mut` payload. The error points into std (`auto-generated://value-mut-read`), not at the user's call.

Found 2026-11-22 while extending the VERDICTS-75 rider r1 tests to a `&mut` call result (`pick_mut(&mut y).unwrap().push_str(…)`). Reproduces identically on the v0.2.79 seed and on develop `f06ff5889`.

## Reproducer

```yo
pragma(Pragma.AllowUnsafe);
{ String } :: import("std/string");
my_unwrap :: (fn(generic(T : Type), o : Option(T)) -> T)(
  match(
    o,
    .Some(v) => v,
    .None => __yo_panic("none")
  )
);
main :: (fn() -> unit)({
  mut(y) := String.from("hello");
  r := my_unwrap(Option(&mut String).Some(&mut y)); // E0901 (std's `unwrap` too)
  r.push_str("!");
  ()
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `addr_of((v.(*)))`, whose type `&mut String` is move-only, and it cannot be moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
   --> auto-generated://value-mut-read:6:17
   |
 6 |     .Some(v) => v,
```

The concrete forms pass: a non-generic `match(o, .Some(v) => { v.push_str("!"); v.len() }, …)` over `o : Option(&mut String)`, and rebuilding `.Some(v)` from the arm. The failure needs the generic body instantiated at `T := &mut U`.

## Root cause (to confirm)

The arm's payload binding `v : T` is evaluated at `T := &mut String` through the reference read rule. The `value-mut-read` rewrite reads it as `addr_of(v.*)`, a reborrow of the place `*v` inside the scrutinee, rather than as the `T` value the arm moves out of the owned `o`. The reborrow of a move-only `&mut` cannot be copied, and since it is "borrowed from the value that holds it" it cannot be moved either. A by-value `T` binder whose `T` is a reference is a value (VERDICTS-23 R3), so the rewrite should not apply to it. This is the same family as `issues/2026-11-11-a-bound-method-on-a-by-value-reference-parameter-is-rejected.md`: a by-value `T` binder at `T := &U` read as a place.
