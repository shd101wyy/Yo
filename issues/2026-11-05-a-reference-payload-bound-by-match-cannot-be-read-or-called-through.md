# A reference payload bound by `match` cannot be read, called or lent through

**Severity:** S2: an `Option(&T)` (or `Option(&Dyn(Trait))`) value, which
decision 43 step 3's N2b made legal, cannot be used once a `match` binds its
payload. `r.f`, `r.m()` and `r.*` fail to evaluate and a lend of `r` is
E0914. So a borrowing `Error.source` walk cannot be written, which blocks
the `AnyError` end state (`plans/handover/D43_STEP3_N2_DESIGN.md` §3.2).

> Found 2026-11-05 while probing the `AnyError` follow-up on the N1e-2a tree
> (develop 95209c9b5) and on the v0.2.74 seed. Both reject the same programs.

## Reproducer

```yo
Sq :: struct(s : i32);
pick :: (fn(r : &Sq) -> Option(&Sq))(.Some(r));
main :: (fn() -> unit)({
  q := Sq(s : i32(4));
  a := match(pick(&q), .Some(r) => r.s, .None => i32(0));
  _ := a;
  ()
});
export(main);
```

The checker gives these results:

- `r.s` fails with `Last expression in "begin" is not evaluated correctly: (r.s)`.
- `r.*.s` fails the same way.
- `r.m()` is E0610 `No method "m" on &Sq`. Over `&Dyn(Shape)` it is `No method "area" on &dyn(Shape)`.
- `f(r)` for `f : fn(x : &Sq)` is E0914, and asks for `&r`.
- `f(&r.*)` fails with `evaluate_function_call: arg not evaluated`.

## Root cause

The `match` arm bound every pattern name with the payload's type. For a
reference payload that type is `Reference(T, m, o)`. No reader handles a
local of that type: `y := &x` and a `-> &T` projection's result bind with the
pointee's type and `is_ref` set (the C slot holds the pointer and reads emit
`(*y)`). A `&T` parameter does the same, with `is_imm_borrow` added.

## Fix

`src/evaluator/exprs/match.yo` binds a runtime pattern name whose payload
type is a reference as a reference binding:

- the name gets the pointee's type;
- `is_ref` is set;
- a `&` payload also gets `is_imm_borrow`, so it is read-only and lends bare,
  as a `&T` parameter does.

The variant field's own type still gives the C declaration (`const T*`), so
the emitted C of every program without reference payloads is unchanged.
Test: `tests/ref_payload_binding.test.yo`.
