# Two traits that share a method name in one `Dyn` emit a duplicate C wrapper

**Status:** OPEN
**Found:** 2026-09-27, Dyn upcast feasibility audit.
**Measured:** yo 0.2.44 seed. `yo check` rc=0; `yo compile` fails in clang.
**Repro:** `issues/repros/two-traits-sharing-a-method-name-in-one-dyn-emit-a-duplicate-c-wrapper.yo`

## Symptom

```rust
A :: trait(get : (fn(self : Self) -> i32));
B :: trait(get : (fn(self : Self) -> i32));
C :: ref(struct(n : i32));
impl(C, A(get : (self -> i32(1))));
impl(C, B(get : (self -> i32(2))));
main :: (fn() -> unit)({
  (d : Dyn(B, A)) = dyn(C(n : i32(0)));
  println(`${d.get()}`);
});
```

```
error: redefinition of '__yo_wrap___yo_t_…___yo_t_…_get'
```

## Mechanism (READ)

`generate_dyn_declaration` (`src/codegen/types/generation.yo`) names vtable slots by method
label and de-duplicates labels across traits with a `processed` set, so only one `get` slot
exists; `generate_dyn_wrapper_functions` (`src/codegen/functions/dyn.yo`) emits one wrapper per
(trait, method), both named `…_get`. The evaluator never checks the clash:
`src/evaluator/types/dyn.yo` carries `// Phase 2aq deferred: function-name conflict check across
required traits.` Even with the C fixed, `d.get()` would have to pick one trait silently; see
`issues/a-method-call-two-trait-impls-supply-silently-picks-one.md` for the concrete-type twin.

## Fix direction

Slots and wrappers are keyed by (trait, method), not by label. An unqualified `d.get()` that two
of the Dyn's traits supply is an ambiguity error naming both traits, and the qualified form picks
one.
