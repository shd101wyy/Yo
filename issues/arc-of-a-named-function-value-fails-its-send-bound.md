# `arc(f)` of a named function fails its `Send` bound, so a `Send` `Dyn` cannot hold one

**Severity:** S2 — a valid program is rejected at `check`: a named function cannot be boxed with `arc`, so `dyn(f)` into a `Dyn(Fn(...), Send)` is E0602; a capture-less closure (`dyn(() => f())`) works.

**Status:** OPEN. **Found:** 2026-10-13, probing the shapes of
`issues/fixed/dyn-of-a-named-function-value-emits-invalid-c.md` (independent of
that fix: the same error before and after it).

## Repro

```yo
nine :: (fn() -> i32)(i32(9));
take :: (fn(f : Impl(Fn() -> i32, Send)) -> i32)(f());
main :: (fn() -> unit)({
  _r := take(nine); // accepted
  _a := arc(nine); // E0602
  (d : Dyn(Fn() -> i32, Send)) = dyn(nine); // E0602, raised in `arc`
});
export(main);
```

```
error[E0602]: Type fn() -> i32 does not implement required trait Send.
note: raised here, inside the standard library  (std/prelude.yo, `arc`'s where clause)
```

## Analysis

Rules D4 + D1 judge `Send` on a function type by its VALUES
(`call_function_value_marker`): what a closure captures, what the code reaches.
The `Impl(Fn() -> i32, Send)` parameter route passes the argument as the
witness (`judge_function_argument_markers`) and accepts `nine`. `arc`'s
`where(V <: (Send, Sync, Acyclic))` goes through
`validate_concrete_type_constraints`, which calls the judgement with no
witness; `function_value_marker` then looks for values of `fn() -> i32` in the
environment, skips `::` definitions by design (a definition only shares the
signature), finds none, and the type-level rule rejects the function type.
`dyn(...)` into a `Send` `Dyn` boxes with `arc`, so it inherits the rejection
even though `_require_dyn_traits_implemented` already judged the payload's
markers by value.

## Direction

Hand the where-clause validation the argument values the call binds to each
generic (as the `Impl` parameter route does), so a named function is judged by
what its code reaches.
