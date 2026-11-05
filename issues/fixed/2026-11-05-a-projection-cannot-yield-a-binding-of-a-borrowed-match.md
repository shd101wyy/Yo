# A projection cannot yield a binding of a borrowed `match`

**Severity:** S2 — a valid program is rejected: `match(&self.v, .Some(x) => &x, …)` in a `-> &T` method, Rust's `Option::as_ref` read, is E0912.

Found while giving `OnceCell(T).get_or_init` Rust's `-> &T` result (the `OnceCell` move-only
read S2 filed on `vbd/v5-part-b-tests`), on develop 68b45b81d.

## Symptom

```yo ignore
_Slot :: struct(v : Option(String));
impl(_Slot, value : (fn(self : &Self) -> &String)(match(&self.v, .Some(s) => &s, .None => __yo_panic("empty"))));
```

```
error[E0912]: A projection yields a place reached from one of its `&`/`&mut` parameters, and `s` is a local: its storage ends with the call (decision 24, the single-root rule).
```

## Root cause

Decision 24's root rule (`_projection_root_error`, `src/evaluator/builtins/ptr_fns.yo`)
follows a yielded name only when it is a borrow parameter or a reference payload binding
(`ref_payload_source`, decision 43 step 3). A binding of a borrowed `match` (`match(&x, …)`,
or a reference binding matched bare) is a place inside the scrutinee's place
(VERDICTS-13 §14: Rust's default binding modes), but the rule read it as a local whose
storage ends with the call.

## Fix

This needs the binding to BE a place inside the scrutinee, which it is since
`issues/fixed/2026-11-05-a-borrowed-match-binding-returned-in-an-option-of-a-reference-dangles.md`:
the binding is a C pointer into the scrutinee's place. Before that fix it was a copy, and
following the root rule would have returned the address of a dying local.

The `match` evaluator records each borrowed-match binding's scrutinee place
(`note_borrow_match_source`, `src/evaluator/utils.yo`), and the root rule follows a yielded
binding to that place's own root (`_borrow_match_root_error`). The binding is a shared
borrow, so a `&mut` result cannot yield it ("is a shared borrow"). The root rule recurses
into the scrutinee place, so a binding of a temporary scrutinee (`match(&f(), …)`) is still
E0912.

## Test

`tests/ref_payload_binding.test.yo`, "a borrowed match binding is yielded as a place of
`self`" (`_Slot.value_or_fallback -> &String`, `_Slot.peek -> Option(&String)`). It reads the
yielded reference after the call, and it has `comptime_expect_error`s for a `&mut` result and
for a temporary scrutinee.
