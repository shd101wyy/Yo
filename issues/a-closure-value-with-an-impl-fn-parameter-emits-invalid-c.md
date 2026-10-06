# A closure value with an `Impl(Fn)` parameter emits invalid C

**Severity:** S2 — a valid program fails at the C compile: a closure bound to a local whose own parameter is `Impl(Fn(...))` lowers that parameter to `void*` and the call site passes the capture struct.

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

The capture-list test checks the re-entry rule with `check`-time
(`comptime_expect_error`) only, and calls `f` with no closure argument at run
time.
