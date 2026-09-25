# An atomic field exempts an `Iso` graph from rules D2 and D9

**Found:** 2026-09-25, while tracing why `^` over a list of closures skipped rule D9 on
`ps/closure-container`.
**Status:** FIXED 2026-09-25. **Class:** soundness hole (a function value that reaches a
thread-affine global crosses threads through `^`).

## Repro

```rust
g := ArrayList(i32).new();
_touch :: (fn() -> unit)({
  g.push(i32(1));
});
_Wrap :: ref(struct(counter : AtomicI32, f : (fn() -> unit)));
main :: (fn() -> unit)({
  w := _Wrap(counter : AtomicI32.new(i32(0)), f : _touch);
  match(^w, .Some(iso) => {
    t := Thread(unit).spawn((io : Io) => {
      v := iso.extract();
      (v.f)();   // runs _touch, which mutates `g`, on the new thread
      ();
    });
    t.join();
  }, .None => ());
});
```

`yo check` passed. Without the `counter` field, the same program is rejected:
`Iso(_Wrap) is not allowed: it holds a fn() -> unit, a function type whose value is unknown
here ...`.

## Cause

`evaluate_iso_type_call` (`src/evaluator/calls/iso.yo`) applied the D2 checks (`T` is a
non-atomic reference object, no `Iso(Iso(T))`) and the D9 walk (every function value in the graph
is `Send`) only when `get_all_some_types(child_type)` was empty. The test is meant to skip the
prelude's own `impl(generic(T), Iso(T), ...)`, which builds `Iso(T)` over a type variable.

`AtomicI32`'s storage field is the extern opaque type `atomic_int`, which the evaluator
represents as a SomeT. So any graph holding an atomic mentioned a SomeT, counted as generic, and
skipped every Iso rule. A closure capturing an atomic has the same shape: its capture struct holds
the atomic.

## Fix

The gate is `type_has_no_open_some` (`src/types/utils.yo`): no SomeT in the type is an open type
variable. An extern opaque type is a concrete C type, and a SomeT whose resolution chain ends at a
non-SomeT type stands for that type. So neither is open.

## Regression test

`tests/parallelism_soundness.test.yo`: `_d9_iso_of_fn_field_beside_an_atomic` must fail to
compile. It compiled before the fix.
