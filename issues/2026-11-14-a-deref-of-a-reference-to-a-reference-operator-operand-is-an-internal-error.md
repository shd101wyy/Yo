# A deref of a reference-to-a-reference operator operand is an internal error

**Severity:** S2. `rhs.*.n` with `rhs : & &Bar` in an operator impl body stops the evaluator with the internal invariant message `check_if_function_parameter_matches_argument: arg has no ExprInfo` — no error code, no help — instead of a diagnostic; the same `.*` on a `& &str` slot is accepted as a function body and rejected as an operator operand, so nothing about the shape is consistent. Nothing is miscompiled (the file fails, rc=1), but this exact operand shape is on the road to valid code (`impl(Foo, Eq(&Bar))`'s `rhs : & &Bar` slot, VERDICTS-62 decision 6), where it would reject a valid program.

Filed 2026-11-14 by the d49-str lane (VERDICTS-62 §3, Fable's probe `b2-ice`). Reproduces on the installed seed v0.2.77 (bundled std) and on a develop-tip binary at `57fb978f9` alike.

## Reproducer

`issues/repros/2026-11-14-a-deref-of-a-reference-to-a-reference-operator-operand-is-an-internal-error.yo`:

```yo
Bar :: struct(n : i32);
Foo :: struct(n : i32);
impl(
  Foo,
  Eq(&Bar)(
    (==) : (fn(lhs : &Self, rhs : & &Bar) -> bool)(lhs.n == rhs.*.n),
    (!=) : (fn(lhs : &Self, rhs : & &Bar) -> bool)(lhs.n != rhs.*.n)
  )
);
main :: (fn() -> unit)({
  f := Foo(n : i32(1));
  b := Bar(n : i32(1));
  rb := &b;
  _a := Foo.(==)(&f, &rb);
  ()
});
export(main);
```

```text
error: check_if_function_parameter_matches_argument: arg has no ExprInfo
   --> b2-ice.yo:14:64
   |
14 |     (==) : (fn(lhs : &Self, rhs : & &Bar) -> bool)(lhs.n == rhs.*.n),
   |                                                                ^
```

The `main` is not needed: the impl alone (six lines, no `main`, no second impl) fails the same way — the trial evaluation of the fn-literal body at definition time triggers it. The twin `impl(Foo, Eq(Bar))` beside it changes nothing.

## The neighbouring shapes (same site, measured on the seed and on g3)

| Shape | Result |
| --- | --- |
| `rhs.*.n`, `rhs : & &Bar`, operator operand (this doc) | internal error, `arg has no ExprInfo` |
| `rhs.*.n`, `rhs : & &Bar`, plain fn body | `error: Last expression in "begin" is not evaluated correctly` |
| `rhs.*.len()`, `rhs : & &str`, operator operand | E0920, and it calls the shared `rhs` "a `&mut` borrow" (`issues/2026-10-29-e0920-calls-a-shared-projection-binding-a-mut-borrow.md`) |
| `rhs.*.*.len()`, same slot | accepted, compiles and runs |
| `v.*.len()`, `v : & &str`, plain fn body (`_g :: (fn(v : & &str) -> usize)(v.*.len())`) | accepted |

One spelling of "`.*` applied to a reference-to-reference binding" is thus accepted, wrongly rejected, and internally errored depending only on where it sits.

## Root cause

Not traced past the surface. The E0920 borrow-deref guard in `src/evaluator/exprs/property_access.yo` (the block that throws "…is a borrow: a borrow reads as its value…", added with `issues/fixed/2026-10-17-a-dereference-of-a-borrow-parameter-in-a-closure-reports-an-internal-error.md`) fires for the `& &str` operand but not for `& &Bar`; the unguarded struct-pointee deref then leaves the `.*` (or its property read) without an `ExprInfo`, which surfaces far away in `check_if_function_parameter_matches_argument` — the same "no ExprInfo" family that fixed issue documents.

## Plan

Diagnose when the mixed-shape/reference-temporary operand work (the S3 issue `2026-11-13-an-operator-operand-that-is-a-reference-field-or-a-reference-temporary-does-not-select-an-impl-over-the-reference.md`, a prerequisite of S3b-`str` per VERDICTS-62 decision 7) touches the operator-operand path; the guard must either fire uniformly (one diagnostic for every context) or the deref must evaluate uniformly. A regression test belongs in `tests/impl_ref.test.yo` next to the gap-1 rows.
