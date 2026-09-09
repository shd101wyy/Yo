# An enum field named after a builtin type breaks `derive(Error)` / `derive(ToString)`

**Status:** open (found 2026-09-09 while adding `EncodingError.UnpairedSurrogate`).

## Symptom

```
error[E0603]: derive on "Bad" failed: error[E0603]: error[E0603]: Argument count mismatch: expected 1, got 0
```

with the generated body printed underneath (that print is the #518 fix doing
its job — before it, this failure was swallowed and surfaced as a
green-`check`-then-`abort()` stub).

## Reproducer

`issues/repros/derive-field-named-after-a-builtin-type.yo`:

```rust
Bad :: enum(Surrogate(unit : u16));
derive(Bad, Error(.Surrogate => `unit ${unit}`));
```

Renaming the field to anything that is not a type name (`cu`, `code_unit`)
makes it compile. The field TYPE is irrelevant; the field NAME is the trigger.

## Root cause

`derive(Error)` (and the structural `derive(ToString)`/`derive(Debug)`) splice
their body into the CALL SITE's scope, and that body is **unhygienic** — the
same property already documented for the `ToString`-in-scope requirement
(`std/error.yo`) and in
`issues/fixed/derive-tostring-debug-body-is-unhygienic-and-aborts.md`.

The generated arm is

```
.Surrogate(unit) => ("unit ".to_string)().(+)((unit.to_string)())
```

`unit` binds the field in the match pattern, but the name resolution for
`unit.to_string` reaches the BUILTIN `unit` type first, so `to_string` is the
type's associated function and wants its receiver as an argument — hence
"expected 1, got 0". Any builtin type name is a candidate: `unit`, and by the
same route `str`, `bool`, `usize`, `i32`, … used as a field name.

## Why it matters beyond the field name

The diagnostic points at nothing the author wrote. It names an arity, not a
name collision, and the offending token appears only inside the
`auto-generated://` block. A reader has no way to get from the message to
"rename your field".

## Suggested fixes, in order of preference

1. **Make the derived body hygienic**: bind each payload field to a generated
   name (`__yo_derive_f0`) and rewrite the user's `${field}` references to it
   during splicing. This is the real fix and also closes the
   `ToString`-must-be-imported requirement.
2. **Reject the collision at derive time** with a message that says so:
   `derive(Error) on Bad: field "unit" shadows the builtin type "unit" — rename
   it`. Cheap, and strictly better than the arity error.
3. At minimum, document the restriction where `derive_rule(Error)` is defined.

## Workaround in std today

`EncodingError.UnpairedSurrogate` spells the field `code_unit`, not `unit`.
