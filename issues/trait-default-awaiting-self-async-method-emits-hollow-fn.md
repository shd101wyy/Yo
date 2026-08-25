# A trait `?=` default that awaits `Self.<async method>` is never monomorphized — the emitted C function is hollow

**Status: OPEN.** Found 2026-08-25 by the STD_API_AUDIT D5 survey, with three
probes compiled through `yo compile --emit-c --skip-c-compiler --release`.
Blocks D5 ("async `Reader`/`Writer` traits with default methods
`read_to_end`, `read_to_string`, `write_all`, `lines()`") — the default methods
are the whole point of that section, and this is exactly their shape.

## Symptom

A trait with a required async method and a `?=` default whose body awaits it:

```rust
AsyncReader :: trait(
  read : (fn(self : Self, n : usize, io : Io) -> Impl(Future(usize, IoExn))),
  read_twice ?= (fn(self : Self, n : usize, io : Io) -> Impl(Future(usize, IoExn)))(
    io.async((e) => {
      a := e.io.await(Self.read(self, n, io), e);
      b := e.io.await(Self.read(self, n, io), e);
      (a + b)
    })
  )
);
```

`yo check` is green and `yo compile` exits 0. The emitted C:

```c
static inline void* closure_yo_id_5110(void* closure_context, void* e) {
  // Failed to transpile a := ((e.io).await)((Self.read)(self, n, io), e);
  // Failed to transpile b := ((e.io).await)((Self.read)(self, n, io), e);
  // Failed to transpile a + b
}
```

and the state machine calls it: `sm->result = closure_yo_id_5110(...)`.

Note the parameter types: `void*`, not the concrete implementor. The default was
emitted from the **generic, `Self`-unbound** FuncVal — it was never
monomorphized per implementor. The two impl bodies transpiled fine
(`return 11ULL;` / `return 13ULL;`).

## Isolation (what is NOT broken)

- A **sync** default calling `Self.base(self)` works — emits `return 3ULL;`.
- An **async** default that never mentions `Self` works.
- Inside an async default, a **sync** `Self` call works:
  `io.async((e) => Self.base(self))` emits a real `size_t`-returning body.

So neither `?=` defaults nor async trait methods are broken alone. The failure
needs all three: a default, `io.async`, and an `await` of a `Self` method.

## Relationship to the FTT work

Same class as `issues/ftt-stub-in-live-closure-falls-off-non-void-function.md`.
Since PR #275 that hollow body is rewritten to `abort()`, so the symptom is now a
loud runtime abort rather than a value-returning function falling off its end —
but the *cause* is untouched: the default is not monomorphized, so codegen has no
concrete `Self.read` to call. #275 is a backstop; this is one of the roots.

## Where to look

- `src/evaluator/values/impl.yo` (default-fill)
- `src/evaluator/values/dyn.yo` `_monomorphize_default_fv`
