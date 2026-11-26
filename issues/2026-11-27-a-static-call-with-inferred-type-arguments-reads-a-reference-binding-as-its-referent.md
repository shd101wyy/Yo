# A static call with inferred type arguments reads a reference binding as its referent

**Severity:** S2 — a valid program is rejected, and the message is wrong about the reference's mode.
`W.make(r)` with `r := &x` (`make : fn(v : T) -> Self` in `impl(generic(T : Type), W(T), …)`) and `Box.new(r)` are
E0901 "cannot copy `r`, whose type `X` is move-only … it is a `&mut` borrow". `W(&X).make(r)` is accepted, and a
free generic `id(r)` binds `T := &X`.

- Filed: 2026-11-27 by the `v81-infer-first` lane (VERDICTS-90 §9 item 2, probes `d4_box_new_r`, `b8_box_new_ref`).
- Reproduces with the v0.2.80 seed and with a tree binary built from develop at `ba2959c00`.

## Reproducer

```yo
X :: struct(n : i32);
W :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), W(T), make : (fn(v : T) -> Self)(Self(v : v)));
main :: (fn() -> unit)({
  x := X(n : i32(1));
  r := &x;
  w := W.make(r);
  _n := w.v.*.n;
  b := Box.new(r);
  ()
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `r`, whose type `X` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is a `&mut` borrow, which names storage the caller owns. Lend it on with `&mut`, or move the caller's value.
  --> d4_box_new_r.yo:7:15
  |
7 |   w := W.make(r);
  |               ^
```

`Box.new(r)` alone gives the same error at `r`.

## Root cause (as far as traced)

Static-argument inference (`plans/archive/STATIC_ARGUMENT_INFERENCE.md` §2) binds `W`'s `T` from the argument's
type. A reference binding's VALUE type is its pointee (`X`), and the inference reads that instead of the binding's
slot type `&X`, so `T := X` and `r` meets a by-value `X` parameter: E0901. The text calls `r` a `&mut` borrow
because the move check's reference-binding arm does not distinguish the two modes. The explicit `W(&X).make(r)`
and the free-function path (`id(r)`) read the slot type and bind `T := &X`.

## Expected

Accepted, `T := &X`, `x` lent while `w` (and `b`) live, as for `W(&X).make(r)`. The E0901 text, where it does
fire for a reference binding, names the binding's real mode.
