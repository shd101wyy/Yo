# `Dyn(SelfTrait)` does not unify with `Dyn(ThatTrait)`, so `Error.source`'s result cannot be held

**Status:** OPEN — blocks `ErrorChain` / `root_cause`
**Found:** 2026-09-08, building §4 Core's error ergonomics.
**Reproducer:** `issues/repros/error-source-selftrait-dyn.yo`

## The trait

`std/error.yo` declares, as it must:

```rust
Error :: trait(
  (source : (fn(inout(self) : Self) -> Option(Dyn(SelfTrait)))) ?= (self -> .None),
  where(Self <: ToString)
);
AnyError :: Dyn(Error);
```

`Dyn(SelfTrait)` is the only spelling available: `Dyn(Error)` inside `Error`'s
own declaration is a definition cycle, and so is naming `AnyError`, which is
`Dyn(Error)`.

## Symptom — providing is fine, CONSUMING is not

Overriding `source` with the more convenient `Option(AnyError)` is accepted:

```rust
impl(E2, Error(source : (fn(inout(self) : Self) -> Option(AnyError))(
  Option(AnyError).Some(self.inner)
)));
```

Calling it and holding the result at that same type is rejected:

```rust
(held : Option(AnyError)) = b.source();
```
```
error[E0601]: Incompatible types:
- Expected: <enum:enum_yo_id_7241>
- Given   : <enum:enum_yo_id_7224>
```

and through an intermediate re-wrap the payloads are shown not to unify either:

```
Expected: dyn(Error + ToString)
Got:      dyn((source : fn(self : Self : (ToString)) -> <enum:...>) + ToString)
```

So the trait's own `Dyn(SelfTrait)` is a STRUCTURAL dyn — whose `source` member
is typed by the recursive `Option(Dyn(SelfTrait))` — and it never unifies with
the NAMED `Dyn(Error)`, even though they denote the same thing. The asymmetry
(an impl may declare `Option(AnyError)`, a caller may not receive it) suggests
the impl-conformance check is laxer than assignment's.

## What it costs

`err.source()` is only usable INLINE — you can `match` on it and call
`to_string()` on the payload. You cannot:

- store it in a field or local typed `Option(AnyError)`;
- call `.source()` on the payload, so you cannot walk more than one link;
- therefore write `ErrorChain` (an iterator over the chain) or `root_cause`
  at all.

This is the real reason "nothing in the tree overrides `source`", which
`plans/STD_API_STABILIZATION.md` §4 records as an observation: the feature is
not merely unused, it is barely usable. `std/error.yo` ships `error_is` and
`Context` (which DOES override `source`, and whose `to_string` renders the
cause, so the message chain works even though the typed chain does not);
`ErrorChain` and `root_cause` wait on this.

## Candidate fixes

1. **Canonicalise `Dyn(SelfTrait)` to `Dyn(<the enclosing trait>)`** when the
   trait's own type value becomes available — i.e. resolve the self-reference
   after the trait is registered, rather than leaving a structural stand-in.
   This is the fix that makes the two spellings one type.
2. Allow `Dyn(Error)` / a forward `AnyError` inside the declaration by
   deferring the dyn's construction, which the lazy-bindings machinery may
   already make possible.

(1) looks right: the structural form carries no information the named one
lacks, and every other self-reference in the language resolves to the named
entity.
