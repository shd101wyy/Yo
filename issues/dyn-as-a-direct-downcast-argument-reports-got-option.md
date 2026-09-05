# `downcast(dyn(x), T)` is rejected with "got Option" — a diagnostic that names the wrong type

**Status:** OPEN
**Found:** 2026-09-05, writing the regression test for
`issues/fixed/downcast-to-a-never-dyned-value-type-emits-invalid-c.md` (the test
wanted a downcast whose operand is not a plain local).
**Severity:** bad diagnostic. The rejection itself is defensible — a bare
`dyn(x)` in that position has nothing to say WHICH `Dyn` to build — but the
message names `Option`, which appears nowhere in the operand, so it sends the
reader looking at the wrong expression.

## Symptom

```rust
{ assert } :: import("std/assert");
open(import("std/string"));
open(import("std/fmt"));

Cat :: ref(struct(name : String));
impl(Cat, ToString(to_string : (self -> self.name)));
Animal :: Dyn(ToString);

main :: (fn(io : Io) -> unit)({
  assert(downcast(dyn(Cat(`shadow`)), String).is_none(), "expected None");
});
export(main);
```

```
error: downcast expects a Dyn type as first argument, got Option.
```

with the caret under `dyn`. Nothing in the operand is an `Option` — the only
`Option` in sight is `downcast`'s own RESULT type, which is what appears to have
been handed back to `dyn()` as its expected type.

The same expression written through a binding or a call is accepted:

```rust
(animal : Animal) = dyn(Cat(`shadow`));
assert(downcast(animal, String).is_none(), "expected None");     // OK

make_animal :: (fn() -> Animal)(dyn(Cat(`shadow`)));
assert(downcast(make_animal(), String).is_none(), "expected None"); // OK
```

Both give `dyn()` an expected type (the annotation, the declared return type),
which is the information a bare argument position lacks.

## Expected

Either

- infer the `Dyn` from `downcast`'s first-parameter type, if that is a concrete
  `Dyn(...)` at the call — it is not, `downcast` accepts any `Dyn`, so probably
  not; or
- reject with a message that names the real problem, e.g. *"cannot infer the Dyn
  type of `dyn(...)` here — annotate the value or bind it first"*, pointing at
  the `dyn` token.

The current text asserts a fact about the operand's type that is not true.

## Where to look

The expected type flowing into the argument. `downcast`'s builtin evaluation is
`src/evaluator/builtins/downcast.yo`; the "expects a Dyn type as first argument"
text is the check it makes after evaluating that argument, and the `Option` it
reports is the type the argument came back as — i.e. the expected type pushed
into the argument was the CALL's result type, not the parameter's.

## Not blocking

The two accepted spellings above are unambiguous and are what the regression
tests use.
