# A generic bound ONLY by an explicit `comptime(C) : Type` argument leaves the call result under-resolved

**Status:** OPEN
**Found:** 2026-08-24, prototyping `collect` for STD_API_AUDIT D3.4.
**Severity:** high for std design — this is the "trait-generic-method
prototyping" gap the audit named as the reason `collect`/`FromIterator` was
deferred. It blocks every "pass the target type, get a value of it back" API:
`collect(C)`, a `parse(T)`, a `zeroed(T)`.

## Symptom

When a function's type parameter is pinned **only** by the explicit comptime
type argument — no value argument has that type — the call's *result* is
under-resolved. Method calls on the result then fail to resolve, and if the
result is discarded the evaluator accepts the call but codegen emits
"Failed to transpile part of main's body".

An explicit type annotation on the binding does **not** repair it.

## Measured matrix

All four compiled with the same binary, 2026-08-24
(`yo compile <f> --release`; reproducer: `issues/repros/comptime-type-arg-binding.yo`):

| shape | result |
| --- | --- |
| `pick :: (fn(comptime(C) : Type, v : C) -> C)(v)` | ✅ works — C is also pinned by a value argument |
| `a := (i32 <: Default).default()` (concrete type) | ✅ works — explicit trait dispatch is fine |
| `dflt2 :: (fn(comptime(C) : Type, hint : C, where(C <: Default)) -> C)((C <: Default).default())` | ✅ works — adding *any* value parameter of type C fixes it |
| `dflt :: (fn(comptime(C) : Type, where(C <: Default)) -> C)((C <: Default).default())` | ❌ **fails** |

The failing call:

```rust
dflt :: (fn(comptime(C) : Type, where(C <: Default)) -> C)((C <: Default).default());
main :: (fn() -> unit)({
  (a : i32) = dflt(i32);
  println(a.to_string());     // Error: No matching call found with arguments: (a.to_string)()
});
```

and with the result discarded:

```rust
main :: (fn() -> unit)({
  dflt(i32);                  // evaluator accepts …
  println(`ok`);              // … but codegen: "Failed to transpile part of main's body"
});
```

## Reading

The working/failing contrast says the type binding for `C` is populated by
**unifying value arguments against parameter types**, and not by the explicit
comptime `Type` argument itself — even though the caller wrote `i32` in the call.
The body can use `C` (the call is accepted), so `C` reaches the callee's
environment as a *value* binding; what is missing is the *type* binding that the
declared return type `-> C` and the call-site result stamp consult.

Two consequences worth noting for whoever fixes it:

- the binding annotation `(a : i32) = dflt(i32);` does not stamp `a` as `i32` —
  the annotated binding adopts the RHS's (unresolved) type, which is itself
  worth checking.
- the failure is silent-ish at eval time and only becomes loud in codegen when
  the value is used, which is the same late-failure signature as the
  under-resolution family (`issues/varbound-combinator-receiver-impl-match.md`,
  `issues/iterator-chain-shared-stamp-cross-item-pollution.md`) — but the
  trigger here is much simpler and reproduces in three lines, so it may be a
  distinct, more tractable bug.

## Why it matters for std

`collect` cannot be expressed without it. The natural shape is

```rust
collect : (
  fn(
    generic(A : Type),
    self : Self,
    comptime(C) : Type,
    where(Self <: Iterator(Item := A), C <: Default, C <: Extend(A := A))
  ) -> C
)( … )
```

which is exactly the failing shape: `C` is pinned only by the type argument.
Two shapes were ruled out on the way:

- `FromIterator(A)` with a *generic trait method*
  (`from_iter : (fn(generic(I : Type), it : I, where(I <: Iterator(Item := Self.A))) -> Self)`)
  fails earlier, at the bound check itself.
- The same `collect` written as a free function fails the `I <: Iterator(Item := A)`
  bound; as a blanket method on `I <: Iterator` the receiver bound resolves fine,
  which is the shape to keep once this bug is fixed.

Until then, `collect` would have to be a family of concrete methods
(`collect_list`, `collect_set`, …), which the audit's §1 stability contract makes
an expensive thing to ship and later replace.
