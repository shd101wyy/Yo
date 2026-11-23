# A method call on a call result typed `&U` (`o.unwrap().len()` over `Option(&String)`) is rejected with E0610

**Severity:** S2: a valid program is rejected; the reference has to be bound first (`k := o.unwrap(); k.*.len()`). The written read-through `o.unwrap().*.len()` is no workaround: a `.*` on a call result does not evaluate at all (`issues/2026-11-22-a-deref-of-a-call-result-typed-as-a-reference-does-not-evaluate.md`, still open). Fixed 2026-11-22 (VERDICTS-75 §3 row (b) rider r1).

Found 2026-11-10 while closing R3 (`Option(&T).unwrap` now returns the reference). The same call result bound with `:=` takes `k.*.len()`.

## Reproducer

Program: `issues/repros/2026-11-10-a-method-call-on-a-call-result-typed-as-a-reference-is-e0610.yo`.

```text
error[E0610]: No method "len" on &String: the type has no field or method with that name.
Receiver slot types probed: &String, &&String, &mut &String, String, &mut String.
  --> m.yo:7:25
  |
7 |   n := pick(&y).unwrap().len();
  |                         ^
```

## Root cause

R-PROBE ranked the candidates correctly (the seed's message shows the `&String`-first order; `_receiver_reference_mode` reads the mode from the receiver's TYPE, so a call result probes like a binding), but the `value_receiver` filter in `_try_find_receiver_method` (`src/evaluator/calls/function.yo`) then dropped EVERY candidate registered on the base `String` — including the one at probe step 0, whose slot `&String` is exactly the reference the call result IS. The filter's rule ("a reference VALUE is not a place of `C`: a method registered on `C` reaches it only through the deref step") conflated the slots that need a lend from a place with the exact-type slot the reference fills as a value; the deref retry that was then left to answer `o.unwrap().len()` builds the node `o.unwrap().*`, which does not evaluate (the open issue above), so the method was lost and E0610 surfaced. The same erasure rejected the bound form `m.len()` with E0601 "Cannot unify String and &String" at the call's argument check, which judged the reference VALUE against the slot's POINTEE.

## Fix

The `value_receiver` filter keeps a base-registered candidate at probe step 0 (its slot is the receiver's own reference type): "a receiver that is itself a reference value needs no borrow — the reference is the slot's value" (VERDICTS-75 row (b)). The conservative argument check in `_evaluate_funcval_runtime_call` accepts an argument whose type IS the slot (not its pointee) the same way, and `try_to_call_function_with_arguments` (`src/evaluator/calls/helper.yo`) judges an already-evaluated receiver whose type is the borrow slot against the slot itself. In C the reference value is the pointer, so `_apply_ref_amp` (`src/codegen/exprs/other-fn-call.yo`, `_reference_value_at_own_slot`) passes the place it refers to, `(*p)`, through the slot's usual lowering: a pointer-ABI slot folds `&(*p)` to `p`, a by-value-ABI `&T` slot reads the referent (the first evaluator-only fix emitted the pointer bare at `len`'s by-value `self : &String`, an incompatible-argument C error). Test: `tests/impl-ref.test.yo` "(r1)": the reproducer's spellings (the call result, the result bound with `:=` read bare and through `.*`, a field's `Option(&String)`) all take `len`, compile and return `5`.
