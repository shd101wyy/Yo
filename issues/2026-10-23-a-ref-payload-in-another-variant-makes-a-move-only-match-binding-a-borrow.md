# A `ref` payload in another variant makes a move-only match binding a borrow

**Severity:** S2 — a valid program is rejected with E0901. Matching an owned
enum value whose type has a `ref` payload in ANY variant binds a move-only
struct payload of a different variant as a borrow. Moving that binding out
of the arm is then "cannot be moved either: it is borrowed (a `&T`
parameter or a `match`/`for` binding)". The same enum with a non-`ref`
payload in the other variant compiles.

**Status:** open. **Found:** 2026-10-23 by the V2b B8 flip probe
(`plans/handover/VBD_B8_PROBE_CENSUS_2026-10-22.md`), while it minimized the
`derive(FromJson)` leak
(`issues/fixed/2026-10-23-an-early-return-in-a-derive-generated-body-skips-the-drop-of-a-value-local.md`).
On develop, `derive(FromJson)` on a struct with a move-only struct field
fails to derive. `__derive_from_json` matches `Result(Field, JsonError)`, and
`JsonError.Other` carries a `String` (a `ref` type on develop), so
`.Ok(__djf_ok) => __djf_ok` is rejected. The v0.2.68 seed and develop
`e30c0d8ed` behave the same.

## Reproducer

`issues/repros/2026-10-23-a-ref-payload-in-another-variant-makes-a-move-only-match-binding-a-borrow.yo`:

```yo
{ println } :: import("std/fmt");
I :: struct(a : i32);
R :: ref(struct(b : i32));
E :: enum(A(i : I), B(r : R));
main :: (fn() -> unit)({
  e := E.A(I(a : i32(7)));
  x := match(e, .A(o) => o, .B(_) => I(a : i32(0)));
  println(&x.a);
});
export(main);
```

```text
error[E0901]: use of moved value: cannot copy `o`, whose type `I` is move-only (it is neither `Copy` nor `Clone`), and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away. Take the parameter by value (`x : T`, without `&`) to own it.
```

Expected: `7`.

What changes the outcome:

| The other variant's payload | Result |
| --- | --- |
| `R` (a `ref` struct), or `String` on develop | E0901 |
| `I2 :: struct(b : i32)` (a move-only value) | compiles |
| none (`Option(I)`), or `i32` (`Result(I, i32)`) | compiles |

Writing the scrutinee as a call, a parameter or a local makes no
difference. Neither does the arm order, or whether the other arm returns,
panics or yields.

## Root cause (hypothesis)

The match-binding mode is decided per scrutinee TYPE, not per arm. An enum
whose layout holds a `ref` handle is treated like a reference-semantics
container: its pattern bindings borrow from the scrutinee, so a by-value
payload cannot leave the arm. The decision should be made per variant: a
binding of a value payload in an owned scrutinee is owned.

## Fix direction

Bind each variant's payload by the scrutinee's ownership and the payload's
own type. The regression test is the repro, which should print `7`.

## Why it matters for the release plan

B8 makes `String` a value, which hides this case for `JsonError`. But any
enum that keeps an `Rc`, `Arc` or other `ref` payload next to a move-only
value payload (the `Dyn` and tree types of B12/B13) hits it. On develop
today it blocks `derive(FromJson)` for every struct that has a move-only
struct field.
