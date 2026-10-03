# A nested generic enum instance reads as comptime-only, so `a := wrap(wrap(n))` demands `::`

**Severity:** S2. A valid program is rejected: a runtime value of type `Option(Option(i32))`
cannot be bound with `:=` when a generic fn built both levels.

**Status:** FIXED 2026-10-02 (`tss/option-of-generic-option-identity`). Regression:
`tests/generic_instantiation_compat.test.yo`, "a nested generic enum instance is a runtime
type".

**Found:** 2026-10-02, while extending the reproducer of
`issues/fixed/a-generic-fns-option-result-at-a-specialized-option-is-a-second-c-type.md`.
It reproduces on v0.2.48 and on `tss/phantom-enum-type-args` (a compiler built from the tree).

## Reproducer

```rust
{ println } :: import("std/fmt");
wrap :: (fn(generic(U : Type), x : U) -> Option(U))(.Some(x));
both :: (fn(n : i32) -> unit)({
  a := wrap(wrap(n));
  println(match(a, .Some(.Some(v)) => v, _ => i32(-1)));
});
main :: (fn() -> unit)({ both(i32(5)); });
export(main);
```

```
error: Expected "::" instead of ":=" for compile-time known value assignment:
a := wrap(wrap(n))

Type:
Option(U)
```

`y := wrap(n); a := wrap(y)` fails the same way. `(a : Option(Option(i32))) = wrap(wrap(n))`
and `y := wrap(n); a := y` are accepted.

## Cause (measured with a probe on the `:=` check)

The bound type is concrete. A structural dump at the check (id, type arguments,
payloads) printed `#…_n194[#…_n194[i32,](|i32;|),](|#…_n194[i32,](|i32;|);|)`. Both levels carry the
prelude `Option`'s id, because substitution keeps an instance's definition-era id, and
`type_to_string` names that id's declaration, `Option(U)`. The check asks whether the type
implements `Runtime`. That is the step-4b on-demand marker re-derivation in
`evaluator/trait_checking.yo`, guarded against cycles by `g_ondemand_marker_guard`, keyed
`<type id>:<trait id>`. Deriving the outer instance pushed `<Option id>:Runtime`, so the
inner `Option(i32) <: Runtime` found its own key already held and fell through to `false`.
The outer type then implemented `Comptime` but not `Runtime`, which reads as comptime-only.

## Fix

A generic enum instance keys the guard by its id plus its type arguments' identities
(`enum_instance_node_id`, `types/type_key.yo`), the rule `type_key`, `stable_type_identity`
and the intern key now share for enum instances. A true self-reference repeats the same
arguments, so it is still cut.
