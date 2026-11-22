# `Deref` on `ArrayList` / `String`: a trait `deref` method, or a compiler-known projection?

**Kind:** design question

**Status:** DECIDED 2026-11-15 (VERDICTS-63). Filed 2026-11-14 by the decision 49 S2 lane; the
mechanism was chosen by a Fable consult at the start of v0.2.79. Generation A (the compiler and the prelude) is one
PR in v0.2.79; Generation B (the `ArrayList` and `String` impls) is the first std PR of v0.2.80. The doc closes with
Generation B. **2026-11-21:** Generation B's `ArrayList` half (`Deref` and `DerefMut`, `Target : [T]`) lands on
`v0280/deref-std-impls`; the `String` half waits for S3b-`str`, because an associated type written `str` is still the
legacy alias `&(str, static)` (`impl.yo`'s `ls_aliased` arm), so `Deref(Target : str)` declares `deref -> &&str`.

## What

Decision 49 gives `ArrayList(T)` a `Deref(Target : [T])` impl and `String` a
`Deref(Target : str)` impl, so `list.*` is the `[T]` view and slice methods
reach a list through `.*`. Today `Deref` is a marker the compiler
understands only for the prelude's cells:

- `_throw_if_deref_impl_outside_prelude` (`src/evaluator/values/impl.yo`)
  rejects any impl outside the prelude ("only the prelude's Box, Rc and Arc
  implement it").
- `deref_target_type` and the `.*` lowering forward only through a cell's
  payload pointer.

A list's `[T]` view is not a payload pointer: it is the fat pointer
`(data, len)` built from two fields. The v0.2.77 seed also rejects the std
impls (finding F2, `plans/backlog/SEED_VERSION_AUTOMATION.md`), so whatever
mechanism is chosen lands as Generation A (compiler) and then Generation B
(the std impls).

## Options

1. **A trait method (chosen, with a `DerefMut` write half).** `Deref` gains
   `deref : fn(self : &Self) -> &Self.Target`; the write half is a second trait,
   `DerefMut` with `deref_mut : fn(self : &mut Self) -> &mut Self.Target`,
   selected as `IndexMut` is. `.*` on a non-cell type lowers
   to a call. This is general, so a user type could implement it too. It
   costs a call per `.*` (inlined in practice), and the origin of the result
   is the receiver's, which the reference rules already handle for a
   `&Self -> &T` method.
2. **A compiler-known projection (rejected).** The impl names the fields,
   `Deref(Target : [T], data : _ptr, len : _len)`, and the compiler builds the
   fat pointer in place. No call is made, and codegen sees the place. But it
   is a closed set of shapes: each new shape, such as a strided view, needs
   compiler work.

## Recommendation

Decided (VERDICTS-63, 2026-11-15): option 1, amended. Decisions 1-4, 7 and 10 of the verdict:

1. **`x.*` on a `Deref` type is the `Target` place its `deref` projection yields.** `Deref` carries
   `deref : fn(self : &Self) -> &Self.Target`; `Target : Type` stays (decision 49's `?Sized` waits on
   `issues/fixed/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.md`).
2. **The write half is `DerefMut`**, chosen as `IndexMut` is: a read calls `deref`; a write, a `&mut` lend, a
   `self : &mut Self` receiver and `addr_of` call `deref_mut`. A `DerefMut` impl needs a `Deref` impl with the same
   `Target`. `Box` implements both; `Rc` and `Arc` implement `Deref` only; `ArrayList` and `Array` implement both;
   `String` implements `Deref` only until a `&mut str` method exists.
3. **The cells implement the methods (`deref` is `&self.*.*`) and the compiler keeps reading a handle's `.*`
   natively.** A handle is a type for which `cell_handle_view(ty)` or `unique_box_payload_type(ty)` holds; every
   other `Deref` type is an owner.
4. **An owner's `.*`** lowers `&x.*` to `Deref.deref(&x)` and `&mut x.*` to `DerefMut.deref_mut(&mut x)`; elsewhere
   `x.*` is that call's place.
7. **An owner's own member wins.** The step from `ArrayList(T)` to `[T]` is R-PROBE's ordinary deref step, consulted
   only when no earlier step applies. Decision 32's clash error stays the rule for handles (`Box`, `Rc`, `Arc`, raw
   pointers).
10. **Outside the prelude, a `Deref` or `DerefMut` impl is accepted when its `Target` is an unsized type** (`[U]`,
    `str`, a `Dyn(...)`, a tail-unsized struct). A wrapper over a sized payload stays rejected, as #1191 decided.

`Array(T, N)` implements `Deref(Target : [T])` and `DerefMut` in the prelude in Generation A. Generation A is one
compiler PR in v0.2.79 (merging on day 2-3, wall Nov 28 12:00); Generation B (`impl(ArrayList(T), Deref(Target : [T]))`
and `DerefMut`, `impl(String, Deref(Target : str))`) is the first std PR of v0.2.80. Option 2 (named fields) is
rejected: neither std type has that shape.

## Implementation

Not started. Bugs found by the probes, filed 2026-11-15:

- `issues/fixed/2026-11-15-a-closure-capturing-a-fat-reference-by-value-emits-invalid-c.md` (S2, fixed on `vbd/d49-str`)
- `issues/2026-11-15-a-generic-impl-omitting-a-required-trait-member-is-accepted.md` (S2)
- `issues/fixed/2026-11-15-an-associated-type-declared-sized-opt-out-breaks-self-target.md` (S3)
- `issues/2026-11-15-returning-a-projection-call-of-a-local-reports-e0901-where-e0912-is-due.md` (S3)
- `issues/2026-11-15-a-unit-index-argument-emits-an-empty-c-argument.md` (S3)
