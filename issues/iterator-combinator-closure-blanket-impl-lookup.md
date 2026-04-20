# Iterator combinator + inline closure: blanket impl lookup fails

## Summary

When chaining iterator combinators with inline closures, the next call in
the chain fails to find a matching `Iterator` impl, even though all
where-clause constraints are individually satisfiable.

## Repro

```rust
open import "std/collections/array_list";

CountIter :: struct(_count : i32, _max : i32);

impl(CountIter, Iterator(
  Item : i32,
  next : (fn(self : *(Self)) -> Option(i32))(
    cond(
      (self._count >= self._max) => .None,
      true => {
        val := self._count;
        self._count = (self._count + i32(1));
        .Some(val)
      }
    )
  )
));

main :: (fn() -> unit)({
  iter := CountIter(i32(0), i32(5));
  filtered := iter.filter((x : *(i32)) => (x.* > i32(2)));
  result := (&filtered).next();   // ← fails here
});

export main;
```

Error:

```
No matching call found with arguments:
(&(filtered).next)()
```

## Why it's not a where-clause check failure

Earlier, the same code failed in `validateConcreteTypeConstraints` with
"Type struct() does not implement required trait Fn(item:\*(i32))->bool".
That symptom was fixed by making `extractFnTraitFromType` consult the
env's `whereClauseConstraints` map (in addition to `requiredTraits`) when
deciding whether a forall SomeType `F` satisfies `Fn(...)`.

After that fix, the lambda-call where-clause check passes — but the
subsequent generic impl lookup for `IterFilter(I, F)` returns no
candidates, with `Available functions:` empty.

## Suspected root cause

`iter.filter(λ)` returns a value typed as `IterFilter(CountIter, F)`
where `F` is the forall SomeType from `filter`'s signature, with
`F.resolvedConcreteType` set to the closure's capture struct (an empty
struct in this case).

When `(&filtered).next()` triggers Iterator-impl lookup for
`IterFilter(CountIter, F)`, the synthesizer must match the blanket impl

```rust
impl(forall(I : Type, A : Type, F : Type),
  where(I <: Iterator(Item := A), F <: (Fn(item : *(A)) -> bool)),
  IterFilter(I, F),
  Iterator(...));
```

The match should bind I=CountIter, F=(forall SomeType from filter), and
A=i32. The where-clause check `F <: Fn(...)` should then succeed via
`extractFnTraitFromType`'s env-aware lookup.

The actual failure is empty `functionsToCall.length` — meaning even the
candidate enumeration step found nothing. This points to either:

1. The blanket impl's IterFilter type isn't being matched against the
   value's IterFilter (struct identity mismatch through the resolved-F
   path).
2. The candidate filter (perhaps in `findMethodsFromGenericImpls`) skips
   this impl due to some pre-check.

## Workaround

Use top-level `fn(...)` callbacks instead of inline lambdas:

```rust
my_pred :: (fn(x : *(i32)) -> bool)(x.* > i32(2));
filtered := iter.filter(my_pred);  // works
```

Top-level fn types are FunctionType (not SomeType wrapper), so no
where-clause Fn extraction is involved.

## Status

Deferred. Blocks one path of iterator combinator usage but does not block
the broader trait-checking env refactor (other tests pass). Bootstrapping
the compiler in Yo can use the workaround pattern until this is resolved.

## Related

- `plans/TRAIT_CHECKING_ENV_REFACTOR.md`
- `tests/where_clause_fn_inference.test.yo` (the regression test for the
  underlying inference fix that does pass)
