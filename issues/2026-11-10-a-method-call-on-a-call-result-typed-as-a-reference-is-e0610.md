# A method call on a call result typed `&U` (`o.unwrap().len()` over `Option(&String)`) is rejected with E0610

**Severity:** S2: a valid program is rejected; the reference has to be read through `.*` first (`o.unwrap().*.len()`).

Found 2026-11-10 while closing R3 (`Option(&T).unwrap` now returns the reference). The same call result bound with `:=` takes `k.*.len()`.

## Reproducer

Program: `issues/repros/2026-11-10-a-method-call-on-a-call-result-typed-as-a-reference-is-e0610.yo`.

```text
error[E0610]: No method "len" on &String: the type has no field or method with that name.
  --> m.yo:7:25
  |
7 |   n := pick(&y).unwrap().len();
  |                         ^
```

The message names no "Receiver slot types probed" note, so the R-PROBE (VERDICTS-25 Q2: a `&U` receiver auto-derefs to `U`'s method) did not run for a receiver that is a call.

## Root cause (not yet traced)

The receiver-method probe keys its reference mode on the receiver's binding flags or its explicit `&`, `_receiver_reference_mode` (`src/evaluator/calls/function.yo`), and a by-value reference VALUE (a call's result) reaches the exact-type lookup only.

## Fix

Probe a receiver whose evaluated type is `&U` / `&mut U` whatever its expression. Test: the reproducer prints `5` three times.
