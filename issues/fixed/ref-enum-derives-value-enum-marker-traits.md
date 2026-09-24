# `ref(enum)` derived the VALUE-enum marker traits: no `Rc` (so no `Dispose`), and `Send` without an atomic refcount

> Found 2026-09-24 while writing a leak reproducer for the evaluator memory
> campaign (`plans/EVALUATOR_MEMORY_REDUCTION.md`): a `Dispose` counter on a
> `ref(enum)` was rejected. **FIXED same day** on
> `fix/ref-enum-auto-derived-markers`.

## Symptom

```rust
T :: ref(enum(Leaf, Box1(inner : Self)));
impl(T, Dispose(dispose : (fn(self : Self) -> unit)({ ... })));
```

```
error: Type "T" does not implement required constraint "Rc" from trait "Dispose"'s where clause.
```

`Dispose` is declared `where(Self <: Rc)` (`std/prelude.yo`), and a
reference enum is exactly as refcounted as a `ref(struct)`, which does get
`Rc`.

## Root cause

The marker traits are auto-derived at type definition, and the enum
derivation (`auto_derive_traits_for_enum_type`,
`src/evaluator/types/utils.yo`) predates `ref(enum)`
(`plans/reference/REF_REFERENCE_SEMANTICS.md` Phase 3). Its doc said "Enums
are always value types", and it took no `is_reference_semantics` /
`is_atomic_rc`, so every reference enum got the value-type rules. The
on-demand re-derivation for instantiated types (step 4b of
`type_implements_trait`, `src/evaluator/trait_checking.yo`) had the same
"enums are value types" arm. Consequences, per marker:

| marker   | value-enum rule (applied to ref enums)  | correct rule for a reference type             |
| -------- | --------------------------------------- | --------------------------------------------- |
| `Rc`     | never                                   | always (this was the reported symptom)        |
| `Send`   | iff every field is `Send`               | only when `atomic(ref(...))`, then field-wise |
| `Runtime`| iff every field is `Runtime`            | always                                        |
| `Comptime`| iff every field is `Comptime`          | never                                         |
| `Acyclic`| iff every field is `Acyclic`            | no RC cycle (`can_type_form_rc_cycle`)        |

The `Send` row is a thread-safety hole, not just a missing feature: a
NON-atomic `ref(enum(A(x : i32)))` was `Send`, so safe code could hand a
handle with a non-atomic refcount to another thread. The struct path has
refused exactly that since `atomic` objects landed (`Type.impls(RegularPoint,
Send) == false` in `tests/atomic_object.test.yo`).

## Fix

- `auto_derive_traits_for_enum_type` now takes the enum's
  `is_reference_semantics`, `is_atomic_rc` and final type, and delegates to
  `auto_derive_traits_for_struct_type` over the flattened variant fields. The
  struct function's value-type branch is the old enum rule verbatim, so value
  enums derive exactly what they did; reference enums get the object rules.
  One rule set instead of two copies that drifted.
- The call in `evaluate_enum_type` (`src/evaluator/types/enum.yo`) moved after
  the final `EnumT` is built (the Acyclic rule's cycle walk needs it). It
  still passes the unpatched variant fields, as before.
- The step-4b EnumT arm follows the same split: value enums field-wise; a
  reference enum answers `Runtime` directly, re-derives `Send` field-wise
  only when atomic, and leaves `Comptime`/`Acyclic` to the definition-time
  registry, mirroring the `ref(struct)` arm next to it.

## Tests

`tests/ref_enum.test.yo`: "ref(enum) derives the reference-type marker
traits" (plain, atomic, Self-recursive and type-constructor-instantiated ref
enums, plus a value-enum control) and "ref(enum) can implement Dispose; it
runs once at the last release" (a Dispose counter, payload and payload-free
variants). Both fail on the v0.2.41 seed: the first aborts on its `Rc`
assertion, the second does not compile.
