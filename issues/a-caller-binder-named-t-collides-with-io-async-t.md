# A generic fn whose binder is named `T` cannot return `io.async` of a composite over `T`

**Status:** OPEN. **Found:** 2026-09-26, reducing
`issues/a-generic-async-fn-whose-future-result-contains-t-emits-two-c-types.md` to a minimal
program (Phase 3.8 of `plans/TYPE_SYSTEM_SOUNDNESS.md`).
**Severity:** a false type error: a correct program is rejected at the call.
**Reproducer:** `issues/repros/a-caller-binder-named-t-collides-with-io-async-t.yo`

## Symptom

```rust
_wrap :: (fn(generic(T : Type), v : T, io : Io) -> Impl(Future(Option(T), Io)))(
  io.async((io : Io) => Option(T).Some(v))
);
main :: (fn(io : Io) -> unit)({
  r := io.await(_wrap(i32(5), io), io);
  ...
});
```

```
error[E0601]: Cannot unify incompatible types: "i32" and "Option(T)"
 --> 3 |   io.async((io : Io) => Option(T).Some(v))
```

`yo check` of the definition alone passes; the error comes from the call's specialization
(`T := i32`). Renaming the binder to `U` removes the error (and reaches the double-emission bug
instead). So `io.async`'s own `T` resolves, by name, to the caller's `T := i32`.

## Suspected cause (not yet measured)

`_freshen_io_builtin_callee` (`src/evaluator/calls/function.yo`) gives `io.async`'s binders fresh
ids per call but keeps their name and frame level, and the call's synthesis resolves a binder by
`(name, level)` in an environment that also holds the caller's `T`.
