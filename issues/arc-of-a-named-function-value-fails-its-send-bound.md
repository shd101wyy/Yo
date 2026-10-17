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

**Re-measured 2026-10-17 (develop 5425cd7bf).** The first analysis below
blamed `arc`'s own `where` clause. That clause is not where the rejection
happens.

- **`arc`'s where clause passes.** It judges the function by its value: the
  callee env binds `value` to the `FuncVal`, and `function_value_marker`'s
  frame scan finds it. A copy of `arc`'s signature whose body never builds
  an `Arc`, such as
  `myarc :: (fn(generic(V : Type), sink(value) : V, where(V <: (Send, Sync, Acyclic))) -> V)(value)`,
  accepts `myarc(nine)`.
- **The rejection is at `std/prelude.yo`'s `arc` line, column 94.** That
  column is the `Arc` of `Arc(V)(value)`, the type constructor's own
  `where(V <: (Send, Sync, Acyclic))`. It is re-checked when the specialized
  body is evaluated, with `V` bound to the bare type `fn() -> i32`.
  - That check runs in `Arc`'s callee env, which holds no value of that type.
  - So the type-level rule decides: a bare `fn(...)` type is not `Send`
    (PARALLELISM_RULES D9).
  - A closure gets through because its type is an identity: an `Impl(Fn...)`
    SomeT that resolves to its capture struct. The `g_closure_fids_by_some`
    and `g_closure_fids_by_capture` registries map that identity back to the
    closure, which is then judged by value. A named function's type
    `fn() -> i32` carries no identity at all.

**Passing argument values into the where-clause validation (the first
direction) would change nothing.** The clause that fails has no argument
values to receive.

**Admitting `Arc(fn() -> T)` for a binder that was proved by value is unsound.**
Function types are structural, so admitting it by provenance, by scanning the
caller's frames, or by a "specializing" scope all fail open.

```yo
_wrap :: (fn(generic(F : Type), f : F, where(F <: (Send, Sync, Acyclic))) -> Arc(F))(
  Arc(F)(_d9_fill)      // F was proved by `f`'s value; `_d9_fill` has the same type
);
```

Any rule that accepts `Arc(F)` here because `f` was clean also accepts
`_d9_fill`, a function that pushes to a non-`Send` global. A later
`make_mut()` write into an `Arc(fn() -> T)` is the same hole. A type that
holds a bare function value is `Send` only if every write into it is judged
by value, and nothing enforces that today. D9 made the bare type non-`Send`
for exactly this reason (the struct route).

**The declared-binding route fails too.** D9's documented workaround for a
named function is `(f : Impl(Fn(...), Send)) = count`. It is E0601 today
(`issues/2026-10-17-a-declared-send-binding-of-a-named-function-is-rejected.md`).
Even accepted, the binding would keep only the right-hand side's type, so the
promise would be lost again.

## Direction

The fix needs a design decision first:
`issues/questions/2026-10-17-how-a-named-function-value-carries-send.md`.
That doc weighs two options:
- function-item identity types, which is Rust's design;
- rebinding a binder to a marker-declaring `Impl(Fn(...), Send, ...)` SomeT
  once the binder has been proved by value.

Until the decision lands, `dyn(() => nine())` and `arc` of a capture-free
closure work. They take the closure's identity route, and the value is
judged in the same way.

The fix's tests must pin both halves on every route: `arc(f)`, `dyn(f)` into
`Dyn(Fn, Send)`, the declared binding, `where(T <: Send)` and an
`Impl(Fn, Send)` argument.
- A clean named function (`_d9_count` in `tests/parallelism_soundness.test.yo`)
  is accepted.
- A dirty one (`_d9_fill`) is refused with its reach reason.
- `Arc(F)(_d9_fill)` inside a generic body whose `F` was proved by a clean
  argument stays refused.
