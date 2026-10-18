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

**Status: FIXED 2026-10-17.** The derive's `where` does reach the generated impl. Two things combine to cause the failure:

- **The trial misses for every generic impl.** A generic impl's method body is trialled at definition time with its type variables abstract. `try_match_generic_impl` never matches an unbound type variable, so the trial cannot use a conditional impl on an abstract instantiation. `self._peeked.clone()` on `Option(A)` therefore misses even under `where(A <: Clone)`, while a method on the bare `A` resolves through the environment. `YO_DEBUG_CTFE=1` shows the same `[vcall-throw] callee=((self._peeked).clone)` for a hand-written impl. There the deferred trial swallows the miss, and the specialization evaluates the body again with concrete types, where `Option(i32).clone` resolves.
- **A derive's miss is not swallowed.** A derive's body is parsed by `generate_expr_from_code`, so its tokens carry `auto-generated://`. `hard_swallow_diagnostic`'s fourth class (`src/evaluator/context.yo`, from `issues/fixed/derive-clone-over-a-non-clone-field-is-swallowed-into-a-runtime-abort.md`) re-raises any failure at that location, including the miss above in a deferred generic trial. The derive reported it.

Two experiments separate this from the derive machinery. A user `derive_rule` whose body is a `quote(...)` written in the source compiles. The same body passed through `"...".to_expr()` fails with this error, and so does a body where only the `.clone()` call comes from `to_expr`.

## Fix

- **The deferred trials leave the fourth class out.** `hard_swallow_diagnostic_in_generic_trial` (`src/evaluator/context.yo`) keeps the forward-reference, arity and unbound-name classes. The deferred generic trials use it: the closure trial in `src/evaluator/values/anonymous_function.yo` and the named-fn trial in `src/evaluator/calls/function_type.yo`. A non-generic derive's body is evaluated by the concrete-parameter path, which keeps the full class, so the 2026-09-20 hole stays closed.
- **A concrete miss is still raised at the `derive`.** The no-method error raised inside auto-generated code, on a receiver whose type has no type variable, is marked generic-independent (`_generated_no_method_independence`, `src/evaluator/calls/function.yo`). The deferred trial's Phase 6 re-raise reports it at the `derive`. `derive(generic(A : Type), W(A), Clone)` over a field of a non-`Clone` struct still fails there, and hand-written bodies are unchanged.

**Tests:** `tests/derive.test.yo`, after `CloneBox`, covers two passing cases:

- `derive(Clone)` on a generic struct whose fields are `Option(A)`, `ArrayList(A)` and `Box(A)`.
- `derive(Clone, Eq(...))` on a generic enum over `Option(A)`.

It also adds two canaries that must keep failing: a generic derive over a concrete non-`Clone` field, which fails at the `derive`, and `Option(NC).clone()` reached through a generic derive with no `where`, which fails at the clone. The 2026-09-20 canaries in the same file still pass: a field whose `Clone` impl is registered below the derive, and `tests/cli-cases/check-derive-clone-non-clone-field`. Before the fix, the passing cases failed with the E0610 above.

**Limitation recorded here:** a deferred trial still cannot resolve a conditional impl on an abstract instantiation, so `check` judges such calls only at a specialization, as it already did for hand-written impls.

**`Copy` is a separate bug.** A generic `Copy` impl over the same shape is rejected by the impl's field check, hand-written or derived. That is `issues/fixed/2026-10-17-a-generic-copy-impl-rejects-a-field-that-is-a-conditional-copy-container-of-its-parameter.md`, which has the same abstract-instantiation limitation but a different site.

**Deferred to Generation B, DONE 2026-10-18:** `IterPeekable`'s conditional `Clone` derive is in `std/prelude.yo`, landed once the v0.2.65 seed carried the fix (gate verified: `yo build --std-path ./std --cc zig` with the actual seed bundle, rc=0, plus a compiled-and-run Clone-of-a-peekable probe; `plans/backlog/SEED_VERSION_AUTOMATION.md`, "a generic derive over a container of its parameter"). Its `Copy` still waits on the issue above.
