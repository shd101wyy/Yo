# A `&mut &(T, p)` lend does not write its solved origin back into the reference binding it lends, so a narrower-scoped reference outlives its storage

**Severity:** S1: `yo check` accepts a program that is a heap-use-after-free under ASan; safe code, no `unsafe`. New surface since P3 (#1841); the v0.2.76 seed cannot spell `&mut &T` and does not have it.

Found by the borrow audit (yo-6c, probe `r05_fn_mut_ref_ref_spelled`, and its re-borrow twin `p1b`); VERDICTS-58 (d) made it a cut gate for v0.2.77.

## Reproducer

`tests/origins/unsound/ref-mut-ref-store-narrower.yo` (expect E0911):

```yo
set :: (fn(generic(p : Origin), dst : &mut&(Rc(X), p), v : &(Rc(X), p)) -> unit)({
  dst.* = v;
});
main :: (fn() -> unit)({
  outer := mk();
  mut(r) := &outer;
  {
    inner := mk();
    set(&mut r, &inner);
  };
  println(`OUT: ${r.*.*.s.len().to_string()}`);
});
```

`r` is flow-inferred, `set` may store `&inner` into it, and `r` is read after `inner`'s block ends: a use-after-free of the `Rc`. The twin `rp := &mut r; set(&mut rp.*, &inner)` (`ref-mut-ref-store-reborrow.yo`) was accepted too.

## Root cause

`lend_through` step 3 (the flow write-back at a `&mut` lend, `src/evaluator/calls/function.yo`) writes the solved origin set into the lent holder only when `type_carries_origin(&variable_value_type(&hv))`. For a reference binding `variable_value_type` is the POINTEE (`Rc(X)`), which carries no origin, so `inner` was never joined into `r`. The `Option(&T)` holder (`flow-slot-lent-mut`) passes that guard; a bare reference binding did not. The corpus had only the positive row (`swap-inferred-locals`), which is why P3 landed green. For the re-borrow the lent place is `rp.*`, so even with the guard fixed the join landed on `rp`, not on `r`, whose set is the one that widens.

## Fix

The guard also accepts a reference binding whose slot type (`variable_slot_type`) carries the origin, and a `&mut` re-borrow of a reference holder (`rp`, whose slot's pointee is itself a reference) redirects the join to the local reference bindings that `origin_of(rp)` roots at. The scope end of `inner` with `r` live is then the existing E0911, as for `flow-slot-lent-mut`. Rows: `ref-mut-ref-store-narrower` (E0911), `-narrower-declared` (`r` declared over `outer` alone: E0923, already so by step 2), `-same-scope` (positive), `ref-mut-ref-store-reborrow` (E0911), each with its toy-model test, and G-B pairs for the first, second and fourth.

Not in this fix: the bare `set(rp, &inner)` is E0601
(`issues/2026-11-11-a-mut-binding-of-a-reference-cannot-be-passed-bare-to-a-mut-reference-to-a-reference-parameter.md`), a separate wrong rejection.
