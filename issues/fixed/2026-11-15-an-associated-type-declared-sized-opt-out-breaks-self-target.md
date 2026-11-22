# An associated type declared `: ?Sized` makes `Self.Target` not a type

**Severity:** S3. A trait whose associated type opts out of the implicit `Sized` bound cannot name that type in a
method signature; the error is the internal "Expected a type" form and the spelling has no workaround except
`: Type` (which admits an unsized type today).

**Status:** FIXED by `v0279/sized-assoc` (v0.2.79), so v0.2.80's std can declare `Deref`/`DerefMut` with
`Target : ?Sized` (VERDICTS-66 Q2).

Found 2026-11-15 by the VERDICTS-63 probes (p4, first run). Seed `yo` 0.2.77 and develop (`yo-dt6`) both fail.

## Reproducer

`issues/repros/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.yo`:

```yo
Peek :: trait(
  Target : ?Sized,
  peek : (fn(self : &Self) -> &Self.Target)
);
export(Peek);

main :: (fn() -> unit)({});
export(main);
```

```text
error: Expected a type for function return type, got:
(Self.Target)
  --> issues/repros/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.yo:5:36
  |
5 |   peek : (fn(self : &Self) -> &Self.Target)
  |                                    ^
```

(The probe's first run hit the same text on the prelude's `Deref`: `derive on "AllocatorVTable": the derive rule
failed: Expected a type for function return type, got: (Self.Target)`.)

## Expected

`Self.Target` is a type in a signature whether the associated type is declared `Type` or `?Sized`. VERDICTS-63 keeps
`Deref.Target : Type` for Generation A; decision 49's "`Deref.Target : ?Sized`" waits on this fix.

## Root cause

A trait field's kind slot evaluated `?Sized` as an expression, where the prefix `?` is `Option`: the field's type
was `Option(Sized)`, not a kind. The associated-type detection (`_evaluate_trait_field`,
`src/evaluator/types/trait.yo`) recognized only the `Type` universe (`TypeUni(0)`), so `Target` was registered as a
plain member with no type variable, and `Self.Target` (`src/evaluator/exprs/property_access.yo`, again gated on
`is_type_0`) yielded an unknown VALUE of type `Option(Sized)`, which a signature rejects.

## Fix

- `src/evaluator/types/trait.yo`: `?Sized` in a trait field's kind slot is the `?Sized` kind (as in a binder's,
  `generic(T : ?Sized)`); a field of either type kind (`is_type_kind`) with no value is an associated type, and its
  variable is minted with that kind (`t_some_t_of_kind`), so `Self.Target` is known to be possibly unsized: a by-value
  `Self.Target` in a signature is E0619, as for a `?Sized` binder.
- `src/evaluator/exprs/property_access.yo`: `Self.X` resolves an associated type of either kind.
- `src/evaluator/values/impl.yo`: an impl that omits a `?Sized` associated type is E0602 ("is not provided"), as for
  a `Type` one.

An impl binding `Target : str` keeps the unsized `str`: the legacy value-`str` alias of an associated type
(`ls_aliased`, `impl.yo`) and of a type binder (`legacy_str_type_arg`, `src/evaluator/utils.yo`; the comptime-fn
argument arm in `src/evaluator/calls/comptime_fn.yo`) each fire only at a `Type` (`is_type_0`) slot, and a `?Sized`
slot is not one. Probed, not only read: `Type.impls(N, Peek(Target := str))` holds and the member's
`-> &Self.Target` is `-> &str`, where the same impl against `Target : Type` is rejected as a reference to a
reference (`&&str`).

## Verification

`tests/sized.test.yo` gains two tests (a `?Sized` associated type bound to `[i32]`, `str` and `i32`, read through
the impls, a where-bound naming it and a generic `-> &T.Target`; and E0602 for an omitted one, E0619 for a by-value
`Self.Target`). They fail to compile on develop `d8f0d89fa` and pass with the fix. The reproducer checks clean.
