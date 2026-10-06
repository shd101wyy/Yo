# A closure value with an `Impl(Fn)` parameter emits invalid C

**Severity:** S2 — a valid program fails at the C compile: a closure bound to a local whose own parameter is `Impl(Fn(...))` lowers that parameter to `void*` and the call site passes the capture struct.

Status: FIXED 2026-10-06 — a function literal now REJECTS an unresolved
`Impl(Fn(...))` parameter at definition (`_is_unresolved_impl_fn_type` +
the check after the annotation-driven substitution in
`src/evaluator/values/anonymous_function.yo`): the message names
`Dyn(Fn(...))` and the named-`fn` alternative. Per-call specialization of a
literal's body remains future work; the rejection is the honest bound of
what one lowered body can do. Tests: tests/closure_capture_list.test.yo
("a function literal rejects an Impl(Fn(...)) parameter"); the exclusivity
re-entry test was rewritten onto a named callee, which is the shape the
rule was about anyway.

Found 2026-10-06 while writing the capture-list re-entry test
(`plans/VALUES_BY_DEFAULT.md` decision 38 B). Pre-existing: the v0.2.52 seed
fails the same way, with no capture list involved.

## Reproducer

`issues/repros/a-closure-value-with-an-impl-fn-parameter-emits-invalid-c.yo`:

```rust
main :: (fn() -> unit)({
  n := i32(1);
  (f : Impl(Fn(k : Impl(Fn() -> i32)) -> i32)) = ((k : Impl(Fn() -> i32)) => (k() + n));
  println(f(() => i32(2)));
});
```

```
error: passing '__yo_t_…' (aka 'struct __yo_t_…_struct') to parameter of incompatible type 'void *'
yo: error: compile: C compiler failed (exit 1) on tmp/hof.c
```

## Analysis

The closure's own function is emitted once, with the `k` parameter still the
unresolved `Impl(Fn() -> i32)` type variable, which lowers to `void*`. A named
function with the same parameter is specialized per call (its `Impl` parameter
is a generic), but a closure value bound to a local has one emitted body, so
its `Impl(Fn)` parameter has no concrete capture struct to lower to. Either
the closure needs per-call specialization like a generic function, or such a
parameter must be rejected with a diagnostic naming `Dyn(Fn(...))`.

The same defect breaks every value shape of the literal: a `->` literal bound
to an `Impl(Fn(k : Impl(Fn(...)))` slot (`use of undeclared identifier` in the
emitted C), and a closure inside a generic named function whose `Impl(Fn)`
parameter mentions the generic (the same `void*` mismatch). `Dyn(Fn(...))`
parameters (one boxed calling convention) and named functions (per-call
rtparam specialization) both work.
