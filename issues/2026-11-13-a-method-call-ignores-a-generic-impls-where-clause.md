# A method call ignores a generic impl's `where` clause

**Severity:** S2 — a method of `impl(generic(T : Type), where(T <: Copy), N(T), …)` (or the matching `derive`) is
callable on `N(String)`, an instance the bound excludes, while every trait query (`where(T <: Clone)`, `Impl(Clone)`)
correctly says `N(String)` does not implement the trait.

Found 2026-11-13 by the `sig` lane while closing audit A43
(`issues/fixed/2026-11-11-safe-code-reads-maybeuninits-public-value-field-before-anything-was-written.md`): the fix
first bounded `MaybeUninit`'s derived `Clone` by `where(T <: Copy)`, as Rust does, and the bound did not stop
`MaybeUninit(Box(i64)).new().clone()`. The fix removes the derive instead, so A43 does not depend on this issue.

## Reproducer

`issues/repros/2026-11-13-a-method-call-ignores-a-generic-impls-where-clause.yo`:

```yo
{ String } :: import("std/string");
N :: (fn(comptime(T) : Type) -> comptime(Type))(newtype(_v : T));
derive(generic(T : Type), where(T <: Copy), N(T), Clone);
main :: (fn() -> unit)({
  m := N(String)(_v : String.from("a"));
  c := m.clone();
});
export(main);
```

```text
$ yo check repro.yo        # develop 6c90536aa: accepted
```

## The family (develop `6c90536aa`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `m.clone()` on `N(String)`, the derive bounded `where(T <: Copy)` | accepted | E0610 |
| `m.show()` on `N(String)`, a hand-written `impl(generic(T : Type), where(T <: Copy), N(T), Show(…))` | accepted | E0610 |
| `g(&m)` with `g(generic(T : Type), x : &T, where(T <: Clone))` | E0602 | E0602 |
| no impl at all | E0610 | E0610 |

No memory error was found: a specialized member body is re-evaluated at the instance, so a body that relies on the
bound (`Self(v : self.v)` under `T <: Copy`) is rejected there (E0901) instead of copying a `String`. A derived
member that clones field by field runs fine, which is how `MaybeUninit`'s payload was reached.

## Root cause

Not established. The trait query honours the impl's `where_constraint_traits` (`GenericImplEntry`,
`src/evaluator/values/impl.yo`); the method-call lookup that finds a generic impl's member by receiver pattern does
not appear to consult them.

## Test

With the fix: the reproducer as an `E0610` case beside the generic-impl tests, and the hand-written impl form.
