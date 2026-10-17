# A generic `derive(Clone)` cannot clone a field whose type is a generic container of its parameter

**Severity:** S2: a valid conditional derive is rejected, so the type cannot be `Clone` (or `Copy`) through `derive` at all.

> Found 2026-10-09 while giving std's iterator adapters their conditional
> `Copy`/`Clone` pairs for decision 36's flip (`plans/VALUES_BY_DEFAULT.md`):
> `IterPeekable(I, A)`, whose `_peeked` field is an `Option(A)`, is the one
> adapter left without them.

## Reproducer

```yo
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

## Root cause

**Status: FIXED 2026-10-17.** The `where` clause was not the cause. A hand-written `impl(generic(A : Type), where(A <: Clone), _Peek(A), Clone(...))` with the same body compiles with the `where` at either position. The cause is the generated impl's receiver node.

- `evaluate_derive` evaluates the user's target node `_Peek(A)` itself, to learn the target type. At that point each `generic(...)` name is bound to an unconstrained placeholder type variable.
- The rule's `DeriveContext.target` was that same `AstExpr`, and the derived `AstExpr` clone keeps node ids. So `ctx.make_impl` spliced the already-evaluated node into the generated `impl(generic(A : Type), _Peek(A), where(A <: Clone), Clone(...))`.
- Evaluating the impl re-evaluated the node under the original ids. `Self` came out as the derive-time `_Peek(A)`, whose `_peeked : Option(A)` holds the unconstrained placeholder, not the impl's `A`.
- `Option`'s `Clone` impl is `where(T <: Clone)`, so it did not match. A field typed by the bare parameter worked because a method on a bare type variable resolves through the environment.

The discriminator was a user `derive_rule` for a marker trait run on `_Peek(A)` before the working hand-written impl. That impl still compiled, so the derive-time evaluation leaves nothing global behind. Only the shared node carries it.

## Fix

`call_registered_derive_rule` (`src/evaluator/builtins/derive.yo`) binds `clone_expr_fresh_ids(target_type_expr)` as the rule's target. `expr.yo` prescribes exactly that for quoted-argument binding. Each trait in a `derive` gets its own fresh copy, so a later trait's impl never sees an earlier impl's evaluation either.

**Test:** `tests/derive.test.yo`, after `CloneBox`, covers three cases:

- `derive(Clone)` on a generic struct whose fields are `Option(A)`, `ArrayList(A)` and `Box(A)`.
- The conditional `Clone`/`Copy` pair on a generic struct with an `Option(A)` field. The test checks that `CopyPeek(i32)` is `Copy` and `CopyPeek(String)` is not.
- `derive(Clone, Eq(...))` on a generic enum over `Option(A)`.

Before the fix, the file failed with the E0610 above.

**Deferred to Generation B:** `IterPeekable`'s conditional `Copy`/`Clone` pair in `std/prelude.yo`. A seed without this fix fails to evaluate the prelude with that derive, and the compiler builds with `--std-path ./std`. It waits until `SEED_VERSION` carries the fix: `plans/backlog/SEED_VERSION_AUTOMATION.md`, "a generic derive over a container of its parameter".
