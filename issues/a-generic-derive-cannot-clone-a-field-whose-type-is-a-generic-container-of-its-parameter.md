# A generic `derive(Clone)` cannot clone a field whose type is a generic container of its parameter

**Severity:** S2: a valid conditional derive is rejected, so the type cannot be `Clone` (or `Copy`) through `derive` at all.

> Found 2026-10-09 while giving std's iterator adapters their conditional
> `Copy`/`Clone` pairs for decision 36's flip (`plans/VALUES_BY_DEFAULT.md`):
> `IterPeekable(I, A)`, whose `_peeked` field is an `Option(A)`, is the one
> adapter left without them.

## Reproducer

```rust
_Peek :: (fn(comptime(A) : Type) -> comptime(Type))(struct(_n : i32, _peeked : Option(A)));
derive(generic(A : Type), where(A <: Clone), _Peek(A), Clone);
main :: (fn() -> unit)({
  p := _Peek(i32)(_n : i32(1), _peeked : .Some(i32(2)));
  q := p.clone();
  _x := q._n;
});
export(main);
```

```
error[E0610]: derive on "_Peek(A)" failed: No method "clone" on Option(A): the type has no field or method with that name.
```

A field typed by the parameter itself works (`IterPair(A, B)`'s fields are
`A` and `B`), so the gap is the conditional impl of a container of it:
`Option`'s `Clone` impl is `where(T <: Clone)`, and the derived body
`Self(self._n.clone(), self._peeked.clone())` is evaluated against
`Option(A)` without the derive's `where(A <: Clone)` reaching the lookup of
`Option(A)`'s impl.

Reproduces with the pre-flip compiler (the FnOnce Generation B branch), so it
is not caused by the flip.

## Fix direction

Evaluate a generic derive's generated impl body with the derive's `where`
constraints active (as a hand-written `impl(generic(A : Type), where(A <:
Clone), ...)` body is), so `Option(A)`'s conditional `Clone` impl resolves.
Then give `IterPeekable` its pair.
