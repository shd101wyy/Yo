# Generic inference ignores the phantom type arguments of structs

**Severity:** S2 — a phantom struct index stops separating instantiations when it reaches a `generic(T)` function: `_PS(i32)` flows into `_PS(bool)` through an identity function, and a `T` known only from a struct's phantom argument is never checked against another argument's.

**Found:** 2026-10-01 (with its enum twin); split off 2026-10-03 when the enum
half was fixed (`issues/fixed/generic-inference-ignores-phantom-type-arguments-of-enums.md`).
**Measured on:** develop `22ae8e452`, Mac mini M4.

## Reproducers

```rust
_PS :: (fn(comptime(T) : Type) -> comptime(Type))(struct(x : i32));
_ps_id :: (fn(generic(T : Type), p : _PS(T)) -> _PS(T))(p);
main :: (fn() -> unit)({
  x := _ps_id(_PS(i32)(x : i32(1)));
  (_y : _PS(bool)) = x;
});
export(main);
```

`check` rc 0. A direct `(_y : _PS(bool)) = _PS(i32)(x : i32(1))` is rejected
(E0601), so struct identity does carry the type argument; only inference
through a `generic` parameter misses it. `_ps_pick :: (fn(generic(T : Type),
y : T, _p : _PS(T)) -> T)(y)` called as `_ps_pick(true, _PS(i32)(x : i32(1)))`
is accepted too.

## Cause (measured)

- `_record_ctor_phantom_positions` (`src/evaluator/calls/function_type.yo`)
  records phantom positions for an ENUM constructor body only, so a struct
  constructor has none, and call-site inference has nothing to bind through.
- Recording them (the struct arm) and unifying them in the synthesizer's
  Struct+Struct case fixed both reproducers, and broke
  `tests/type_soundness.test.yo`'s canary "two .map chains at different Item
  types keep their own Item": std's `IterMap(I, A, B, F)` mentions `A`/`B` in
  no field, two `.map` chains at different `Item` types share one substituted
  instance id, and the second chain's instance carried the first chain's
  `type_arguments`. The unification bound `A := i32` for the `i64` chain:
  `Type <struct:capture_…> does not implement required trait Fn(i64) -> i64`.

## Recommendation

Make a struct instance's `type_arguments` per-instantiation the way #1112 made
an enum's (keyed in `type_key`, substituted per instance), so a shared
substituted id cannot carry another chain's arguments; then add the struct arm
to `_record_ctor_phantom_positions`, unify struct phantom positions in the
synthesizer, and extend `_phantom_binder_args` (`src/evaluator/calls/function.yo`)
to structs. Gate: the canary above plus the reproducers.
