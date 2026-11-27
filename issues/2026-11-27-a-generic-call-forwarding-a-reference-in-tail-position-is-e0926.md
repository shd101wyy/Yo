# A generic call forwarding a reference in tail position is E0926

**Severity:** S2 — a valid program is rejected. `pass :: (fn(a : &X) -> &X)(id(a))`, with
`id :: (fn(generic(T : Type), v : T) -> T)(v)`, is E0926 "`a` is a reference (`&X`): reading the value it refers
to is spelled `a.*`", while `{ q := id(a); q }` in the same body is accepted.

- Filed: 2026-11-27 by the `v81-infer-first` lane (VERDICTS-90 §9 item 3, probes `h2_tail`, `f2_tail_expected`,
  `e9_return`, `g5_param_ref`).
- Reproduces with the v0.2.80 seed and with a tree binary built from develop at `ba2959c00`.

## Reproducer

```yo
X :: struct(n : i32);
id :: (fn(generic(T : Type), v : T) -> T)(v);
pass :: (fn(a : &X) -> &X)(
  id(a)
);
pass2 :: (fn(a : &X) -> &X)({
  q := id(a);
  q
});
main :: (fn() -> unit)({
  y := X(n : i32(2));
  q := pass(&y);
  q2 := pass2(&y);
  ()
});
export(main);
```

```text
error[E0926]: `a` is a reference (`&X`): reading the value it refers to is spelled `a.*`
  --> h2_tail.yo:4:6
  |
4 |   id(a)
  |      ^
```

`pass2` alone checks. The same holds with a named origin (`-> &(X, p)` over `a : &(X, p)`). In `e9_return`, a
function returning `id(r)` for a LOCAL's `r := &x` reports this E0926 instead of the E0912 the escape deserves.

## Root cause (as far as traced)

In tail position the call is evaluated against the function's declared result `&X`. The early synthesis of a
`generic(...)` callee's binders from the expected type (VERDICTS-90 §2 step 3) solves `T` from the RESULT before
the argument is read: `-> T` against `&X` with the reference peeled gives `T := X`, so `v : T` is a by-value `X`
slot and the reference argument `a` is read through (kind 0 of the reference read rule, E0926). Bound to a local
first, the call has no expected type and `T := &X` comes from the argument.

## Expected

`id(a)` in tail position binds `T := &X` and is accepted; `id(r)` of a local's reference under a reference result
is E0912.
