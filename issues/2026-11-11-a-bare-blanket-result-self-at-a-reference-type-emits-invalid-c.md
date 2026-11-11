# A bare-variable blanket's `-> Self` at `T := &Bag` emits invalid C

**Severity:** S2: a program the evaluator accepts fails in the C compiler.

Found 2026-11-11 by the VERDICTS-54 probes (`fable/probe-54/q4.yo`). Present on develop `13aa6abe0`, so it is not R3's regression; R3's narrowing (a slot whose declared type is `Self` is never a by-value reference slot) leaves it as it is.

## Reproducer

Program: `issues/repros/2026-11-11-a-bare-blanket-result-self-at-a-reference-type-emits-invalid-c.yo`.

```yo ignore
Dup :: trait(dup : (fn(self : Self) -> Self));
impl(generic(T), where(T <: Named), T, Dup(dup : (fn(self : Self) -> Self)(self)));
// r : &Bag;  r.dup()  with T := &Bag
```

`yo check` passes; the C compiler rejects the instance: the result `Self` is lowered as a projection of the by-value parameter instead of the pointer value it returns.

## Root cause (not yet traced)

The by-value parameter and the result are both `Self`, which at `T := &Bag` is a reference type, and the declaration names no type binder (`T` is the impl's, `Self` the written type), so neither slot is a by-value reference slot (VERDICTS-54 Q1 keys R3's `ValueSlot` on a binder written as itself). The result is therefore the bare `Reference` slot, which codegen reads as a borrowed projection.

## Fix

Decide with the `Self` rule of VERDICTS-54: either the result of a bare-variable blanket's `-> Self` reads as the value `Self` names (the pointer), or the instance is rejected in the evaluator with a diagnostic. Test: the reproducer runs, or `comptime_expect_error` names the rule.
