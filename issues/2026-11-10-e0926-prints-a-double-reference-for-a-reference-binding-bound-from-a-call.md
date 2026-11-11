# E0926 prints `&&i32` for a `&i32` binding bound from a call result

**Severity:** S3 — the E0926 message names the binding's type as `&&i32` when `q := id(y)` with `y : &i32` (the binding is a `&i32`), which sends the reader looking for a second reference level.

- Filed: 2026-11-10 (capture lane; `VERDICTS-44` probe `c5`).

```yo ignore
id :: (fn(generic(T : Type), v : T) -> T)(v);
mk :: (fn() -> Impl(Fn() -> i32))({
  x := i32(1);
  y := &x;
  q := id(y);
  ({ q }() => q.*)
});
```

Measured: ``error[E0926]: `q` is a reference (`&&i32`)``. Expected `&i32`. The generic `T` is instantiated at `&i32`, and the message wraps the already-reference type once more.
