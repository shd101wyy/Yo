# E0920 calls a `&` projection binding a `&mut` borrow

**Severity:** S3: the `.*` rejection (E0920) on a binding of a projection that returns `&T` says the binding "is a `&mut` borrow", while it is a `&` borrow (an assignment through it is rejected as read-only, E0908); the error itself is right, only the mode it names is wrong.

**Status:** open. Found 2026-10-29 by decision 43 step 2 N1c's origins-corpus re-record (`dyn-call-spelled-result` moved from E0911 to E0920). The develop-built binary at `086b01a7e` prints the same message.

## Reproducer

```yo
_first :: (fn(x : &i32) -> &i32)(&x);
main :: (fn() -> unit)({
  x := i32(1);
  r := _first(&x);
  _ := r.*;
  ()
});
export(main);
```

```text
error[E0920]: `r` is a `&mut` borrow: a borrow reads as its value, and `.*` does not apply to a borrow until decision 43 (references become types).
```

## Root cause

`src/evaluator/exprs/property_access.yo` (the E0920 site) picks the mode with `cond(deref_b_v.is_ref => "&mut", true => "&")`. A projection's result binding is held by pointer, so `is_ref` is set for a `&` result too; `is_imm_borrow` is what tells the two apart.

Also seen 2026-11-14 (VERDICTS-62 §3, probe `d1`): an operator operand `rhs.*.len()` with `rhs : & &str` — a shared reference-to-reference *parameter* this time, not a projection result — prints the same wrong mode ("`rhs` is a `&mut` borrow") on the seed v0.2.77 and on develop `57fb978f9`. The neighbouring shapes of that one site are collected in `issues/2026-11-14-a-deref-of-a-reference-to-a-reference-operator-operand-is-an-internal-error.md` (a struct pointee in the same position is an internal error; a double `.*` is accepted).

## Plan

E0920 is retired by decision 43 step 2 N1e, which makes references binding types and gives `.*` its meaning (DESIGN.md §8, Q7). The fix lands there, or earlier as a one-line change that tests `is_imm_borrow` first, with a `comptime_expect_error` case in `tests/local_borrows.test.yo` naming the `&` mode.
