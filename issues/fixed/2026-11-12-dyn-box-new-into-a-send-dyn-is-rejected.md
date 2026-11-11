# `dyn(Box.new(v))` into a `Dyn(..., Send)` is rejected

**Severity:** S2 — the documented owning spelling `dyn(Box.new(v))` is rejected at every `Dyn(T, Send)` slot, while the legacy `dyn(v)` it replaces is accepted, so `yo fix --migrate unsized` turns valid programs into rejected ones.

Found 2026-11-12 by the decision 49 S1g sweep with #1901's recorder (`yo fix ./tests --migrate unsized`): after the rewrite, `tests/send_sync.test.yo` and `tests/arc.test.yo` no longer evaluate.

## Reproducer

```yo
{ println } :: import("std/fmt");
Speak :: trait(speak : (fn(self : &Self) -> i32));
Dog :: struct(n : i32);
impl(Dog, Speak(speak : ((self : &Self) -> self.n)));
main :: (fn() -> unit)({
  (d : Box(Dyn(Speak, Send))) = dyn(Box.new(Dog(n : i32(4))));
  n := d.speak();
  println(&n);
});
export(main);
```

```
error: A dyn(Send + Speak) is shared between threads, so its payload must be atomically reference counted, and Rc(Dog) is not: pass the value itself (`dyn(...)` boxes it with `Arc.new`) or `Arc.new(v)`.
```

## Cause

While `unsized_legacy_spellings` holds, `dyn(Box.new(v))` is read as `dyn(Rc.new(v))` (`_box_new_as_cell_new`, `src/evaluator/values/dyn.yo`). The legacy auto-box of `dyn(v)` picks `Arc` for a `Send` target (`_dyn_target_requires_send`), but the `Box.new` reading always wrote `Rc`.

## Fix

`_box_new_as_cell_new` takes the same `Send` verdict and writes `Arc.new(v)` against a `Dyn(..., Send)`.

Test: `tests/send_sync.test.yo`, "dyn(Box.new(v)) into a Dyn(Trait, Send) crosses Thread.spawn".
