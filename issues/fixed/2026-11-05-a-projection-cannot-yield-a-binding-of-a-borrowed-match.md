# A projection cannot yield a binding of a borrowed `match`

**Severity:** S2 — a valid program is rejected: `match(&self.v, .Some(x) => &x, …)` in a `-> &T` method, Rust's `Option::as_ref` read, is E0912.

Found while giving `OnceCell(T).get_or_init` Rust's `-> &T` result
(`issues/2026-11-05-oncecell-get-or-init-copies-its-element-so-a-move-only-value-cannot-be-read.md`),
on develop 68b45b81d.

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

The `match` evaluator records each borrowed-match binding's scrutinee place
(`note_borrow_match_source`, `src/evaluator/utils.yo`), and the root rule follows a yielded
binding to that place's own root (`_borrow_match_root_error`). The binding is a shared
borrow, so a `&mut` result cannot yield it ("is a shared borrow").

## Test

`tests/ref_payload_binding.test.yo`: "a borrowed match binding is yielded as a place of
`self`" (`_Slot.value -> &String`, `_Slot.peek -> Option(&String)`), and a
`comptime_expect_error` for a `&mut` result.
