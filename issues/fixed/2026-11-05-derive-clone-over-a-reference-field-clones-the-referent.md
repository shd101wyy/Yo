# `derive(Clone)` over a reference field clones the referent

**Severity:** S2: an origin-parameterized holder with a `&T` field cannot derive
`Clone`, and therefore cannot derive `Copy`, which needs it. `derive(..., Clone)`
fails with E0601 (`Cannot unify incompatible types: "i32" and "&i32"`), so the
corpus row `copy-shared-holder` (VERDICTS-12 Q4: an all-`&` holder may be
`Copy` by declaration) could not pass.

> Found 2026-11-05 while gating the N2b residue rows on develop 1df834f26
> (decision 43 step 3).

## Reproducer

```yo
_View :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p), n : i32));
derive(generic(p : Origin), _View(p), Copy, Clone);
main :: (fn() -> unit)({
  x := i32(1);
  v := _View(x)(r : &x, n : i32(0));
  w := v;
  _ := w.r.*;
  ()
});
export(main);
```

```text
error[E0601]: derive on "_View(origin(p))" failed: Cannot unify incompatible types: "i32" and "&i32"
Self(self.r.clone(), self.n.clone())
```

## Root cause

The prelude's `__derive_clone` writes `self.f.clone()` for every field, and
`__v_f.clone()` for every variant payload. On a reference field the method
call reads through the reference (decision 43: `.method()` auto-derefs), so
`.clone()` clones the `i32` the field points at, not the reference.

## Fix

`__derive_clone` (`std/prelude.yo`) passes a reference field bare
(`Self(self.r, …)`, `.V(__v_r)`). It lends the same referent to the
constructor's `&` slot, which is Rust's `Clone` for `&T`. A `&mut` field makes
the holder move-only, so its lend is rejected there.

The new helper `__derive_field_is_reference` reads the field type's display.
It does not use `Type.get_info`, which cannot decide a type-variable field: a
`cond` over it broke `Range(T)`'s generic derive.

Test: `tests/origin_holder_derive.test.yo`. The corpus row `copy-shared-holder`
now passes (ACCEPT).
