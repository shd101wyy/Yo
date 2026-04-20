# Blanket impl method with inner forall leaks SomeType into return type

**Status:** Fixed.
**Regression test:** `tests/blanket_impl_inner_forall.test.yo`

## Symptom

Given a blanket impl whose method has its own inner forall parameters:

```rust
IterMap :: (fn(comptime(I) : Type, comptime(A) : Type, comptime(B) : Type) -> comptime(Type))(
  struct(_inner : I, _f : Impl(Fn(a : A) -> B))
);

impl(forall(I : Type), where(I <: Iterator), I,
  map : (fn(forall(A : Type, B : Type),
            self : Self,
            f : Impl(Fn(a : A) -> B),
            where(Self <: Iterator(Item := A))) -> IterMap(Self, A, B))(
    IterMap(Self, A, B)(_inner: self, _f: f)
  )
);
```

Calling `iter.map(closure)` produced an `IterMap` whose type contained
`SomeType(A)` and `SomeType(B)` rather than the concrete element types
inferred from the closure. Subsequent `.next()` calls returned
`Option(SomeType(B))` instead of `Option(i32)`, breaking pattern matching
and arithmetic.

## Root cause

In `src/evaluator/values/impl.ts` `findMethodsFromGenericImpls()`, when the
outer impl's `forall(I)` is bound to a concrete receiver (e.g.,
`I → ArrayListIter(i32)`), the function entered the
`shouldCreateSpecializedValue` branch and **pre-evaluated the method
body**. At that point the method's own inner forall (`A`, `B`) were still
SomeTypes, so the body expression `IterMap(Self, A, B)(...)` produced a
struct type literally containing `SomeType(A)`, `SomeType(B)`. Those
SomeTypes were baked into the returned `FunctionValue.specializedType`
and propagated to every call site.

## Fix

Detect when the method itself has unresolved inner forall parameters
that are not in the impl's substitution map, and route those methods
through the type-only specialization branch instead of pre-evaluating
the body. The body remains the original (unevaluated) expression and
the call site's `createSpecializedFunctionInline` finishes
specialization once `A`, `B` are bound from argument types.

```ts
const methodHasUnresolvedInnerForall =
  isFunctionType(method.type) &&
  method.type.forallParameters.some(
    (fp) => !match.substitutions.has(fp.label)
  );

const shouldCreateSpecializedValue =
  ...
  && !methodHasUnresolvedInnerForall;
```

The type-only branch was also taught to attach the original
`FunctionValue` (with `specializedType` updated) to the returned
method, so that the call site has a body to evaluate.

## Related issue

`Impl(Fn(a : A) -> B)` stored in a struct field (e.g., `IterMap._f`)
still hits a separate codegen issue: the closure's concrete type is
erased once the struct is constructed, so `(self->_f).call(...)` is
emitted against a `void*` field. That issue is tracked separately
(`impl-fn-in-struct-field`).
