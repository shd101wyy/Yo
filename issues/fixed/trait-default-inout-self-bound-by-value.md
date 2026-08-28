# A trait `?=` default method binds its `inout(self)` BY VALUE in the per-impl materialized body

**Status: FIXED 2026-08-28** (the D3.9 Hasher PR, `src/evaluator/values/impl.yo`).
**Found:** 2026-08-28, writing `Hasher`'s default `write_u8`..`write_isize`
methods — every one of them is this shape.
**Severity: HIGH.** One manifestation is a clang error, the other a SILENT
wrong value (the emitted C is a pointer-type mismatch, which `yo compile`'s
`-w` suppresses).

## Trigger

A trait method with a `?=` default whose receiver is `inout(self)`, not
overridden by the impl:

```rust
Hr :: trait(
  bump : (fn(inout(self) : Self, v : u64) -> unit),
  (twice : (fn(inout(self) : Self, v : u64) -> unit)) ?= ((self, v) -> { self.bump(v); self.bump(v); }),
  (direct : (fn(inout(self) : Self, v : u64) -> unit)) ?= ((self, v) -> { self.state = (self.state + v); })
);
Fnv :: struct(state : u64);
impl(Fnv, Hr(bump : (fn(inout(self) : Self, v : u64) -> unit)({ self.state = (self.state + v); })));
h := Fnv(state : u64(0));
h.twice(u64(1));   // state stays 0 — `bump` was handed &(self), a Fnv**
h.direct(u64(10)); // clang: member reference type 'Fnv *' is a pointer
```

Writing the default as an explicit `(fn(inout(self) : Self, ...) -> ...)({...})`
instead of the arrow lambda changes nothing — the defect is in how the default
body is bound, not in how it is spelled.

## Root cause

Pointer-ness travels through two independent channels
(issues/fixed/specialized-inout-param-loses-ref-with-comptime-arg.md, #258): the
C signature from `FuncMeta.param_is_ref`, and the body's `p` vs `(*p)` from
`Variable.is_ref` on the binding the body's atoms record in their `ExprInfo.env`.

The impl evaluator fills un-overridden `?=` defaults by MATERIALIZING a
fresh-id clone of the default body per impl (`impl.yo`, the "PER-IMPL
MATERIALIZATION" block) and evaluating it with the params bound into a pushed
frame via `add_variable_to_env(...)`, whose flags were all hardcoded `false` —
so `self` was a by-value binding of the receiver type. The registered
specialization kept `param_is_ref`, so the signature stayed `Fnv* self` while
the body read `self.state` (clang error) or, calling a sibling `inout` method,
let `_apply_ref_amp` take the address again (`&(self)`, a `Fnv**`, silently
wrong). Third site in the `Variable.is_ref` family after `function.yo` and
`helper.yo`.

## Fix

The default-fill binder reads `param_is_ref` off the same Self-substituted
method type (`d_sub_ty`) it registers the specialization from, and on each bound
`Variable` restores `is_ref`/`is_reassignable` when set and marks it
`is_parameter` — the idiom `check_param` and the #258 repair use.

## Regression tests

- `tests/trait_default_inout_self.test.yo` — the reproducer above, both faces
  (sibling call and direct field write), plus a by-value `self` default as
  control.
- `tests/hash.test.yo` "a user Hasher gets the default write_* methods through
  write" — the production shape.
