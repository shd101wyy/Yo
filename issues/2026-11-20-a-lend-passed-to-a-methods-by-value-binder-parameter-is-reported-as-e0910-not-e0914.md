# A lend passed to a method's by-value binder parameter is reported as E0910, not E0914

**Severity:** S3 — misleading diagnostic: `slot.replace(&x2)` (`Option(&X).replace(self : &mut Self, value : T)`) is rejected with E0910 "This argument moves `x2`, which an earlier argument of the same call lends", although nothing moves `x2` and no earlier argument lends it; the rule that applies is E0914.

- Filed: 2026-11-20 by the v0.2.80 s1-origins lane, while writing the positive twins for `issues/fixed/2026-11-19-an-fnmut-closure-stores-its-per-call-reference-parameter-through-a-method-of-a-mut-capture.md`.
- Reproduces on the rename tree `df9927b92` and on `v0280/clusters` `33c855dfa`.

## Reproducer

```yo
X :: struct(n : i32);
main :: (fn() -> unit)({
  x := X(n : i32(1));
  x2 := X(n : i32(2));
  mut(slot) := Option(&X).Some(&x);
  _o := slot.replace(&x2);
  ()
});
export(main);
```

```text
error[E0910]: This argument moves `x2`, which an earlier argument of the same call lends to it (`&(x2)`): the arguments are evaluated in order, so the callee would read and write a place whose value was already moved out and dropped (decision 28's argument exclusivity, plans/VALUES_BY_DEFAULT.md).
```

## What happens

A lend `&x2` passed to a by-value parameter whose type is a binder (`value : T` at `T := &X`) is E0914 for a free function: `keep(&mut slot, &x2)` with `keep(generic(T : Type), dst : &mut Option(T), v : T)` reports "`&x2` lends a borrow, but parameter "v" takes its argument by value". The method form `slot.replace(&x2)` reaches decision 28's argument-exclusivity check first, which reads the by-value slot as a move of `x2` and pairs it with the same argument's own lend. The program is rejected either way; only the code and the text are wrong. Binding the reference first (`r := &x2; slot.replace(r)`) is accepted, as E0914's help says for the free function.

## Expected

E0914, with the free function's text and help, at `&x2`.
