# A type-qualified call through a blanket bound at `T := &U` passes check and emits invalid C

**Severity:** S1 (raised from S2 on 2026-11-22): the reproducer is plain safe user code — a user trait, a user blanket, no `pragma(AllowUnsafe)`, no unsafe block — and `yo check` accepts it; the failure surfaces only as a C compiler error about pointer types, an unrelated-looking message, after a successful evaluation. `yo compile` rejects the program; no silently wrong binary was observed.

Found 2026-11-21 while gating the blanket `Hash(&T)` / `ToString(&T)` riders (branch `v0280/ref-blankets`). Pre-existing: the reproducer below uses only a user trait and a user blanket and fails identically on the v0.2.79 seed. The std riders make it easier to reach — once `&U <: ToString` / `&U <: Hash` hold through std, any generic body that spells the call the natural way walks into it.

## Reproducer

```yo ignore
{ String } :: import("std/string");
Show :: trait(show : (fn(self : &Self) -> String));
impl(String, Show(show : (fn(self : &Self) -> String)(self.*.clone())));
impl(
  generic(T : Type),
  where(T <: Show),
  &T,
  Show(show : (fn(self : &Self) -> String)(T.show(self.*)))
);
_use :: (fn(generic(T : Type), r : &T, where(T <: Show)) -> String)(T.show(r.*));
export(main);
main :: (fn() -> unit)({
  s := String.from("abc");
  rs := &s;
  u := _use(&rs);   // T := &String through the blanket
});
```

`yo check` passes ("evaluator OK", on the seed and on the blanket branch). `yo compile` emits C that the C compiler rejects:

```text
/tmp/….c:2988:103: error: passing argument 1 of ‘__yo_fs_…’ from incompatible pointer type
__yo_fs_…((&(__yo_v_r)));
             ~^~~~~~~~~~~
               const …_struct *** (expected …_struct **)
```

The emitted argument is `&r` — the address of the parameter — where the parameter wants the reference itself (`r`, i.e. `r.*`'s referent chain); exactly the lend the E0601 in
`issues/fixed/2026-11-21-a-reference-binder-whose-type-is-the-methods-own-slot-is-lent-once-too-often.md`
asks to undo, applied here as a silent rewrite of a written `r.*`.

## Root cause

The written `r.*` (N1e-1: a reference binding's whole-value read is rewritten to the binding `r`, `note_reference_deref_site`) models the place `*r` of type `&String`, but the call site's `_apply_ref_amp` then addressed the argument at the borrow slot `self : &&String` by wrapping the parameter's OWN storage: `&(__yo_v_r)` — a `String ***`, one indirection too many, where the lend of the place `*r` (`&(*r)`, which is `r` itself) was meant. `_var_read_code`'s `(*name)` wrap skipped the read: it fires for by-`ref` bindings and unsized places, not for a shared `&T` PARAMETER whose slot is a reference (`&&String`, pointer ABI) read at its pointee.

## Fix (2026-11-22, VERDICTS-75 §3 row (b) riders r3/r4)

`_var_read_code` (`src/codegen/exprs/atom.yo`) also wraps a read that models the REFERENCE at a thin-borrow slot's pointee (`r` at `&&String` read as the `&String` it refers to): the binding's C storage is the pointer one level up, so the read is `(*r)` and the slot's lend `&(*r)` is the reference itself. Test: `tests/impl-ref.test.yo` "(r4)": the reproducer compiles, links and returns the referent's rendering.
