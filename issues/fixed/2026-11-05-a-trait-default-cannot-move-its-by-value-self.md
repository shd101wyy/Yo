# A trait default cannot move its by-value `self`

**Severity:** S2. A trait `?=` default method whose receiver is by value (`self : Self`) cannot move that receiver when the implementing type is move-only. The impl that relies on the default fails with E0901 "it is borrowed (a `&T` parameter or a `match`/`for` binding)", anchored at the impl and noted at the default's body. Overriding the default in every impl is the only workaround. A default that only READ its by-value receiver checked, but the receiver was bound as a borrow, so the body never dropped it. It surfaced in V5 part B (VERDICTS-20 §1): `Digest.finish_hex ?= (self -> hex.encode(Self.finish_bytes(self)))` once the hashers became move-only values whose `finish_bytes` consumes them.

**Status:** FIXED 2026-11-05 (`fix/trait-default-by-value-self`). **Found:** 2026-11-05, migrating `std/crypto` off `ref` (`vbd/v5-part-b-std`). The v0.2.74 seed and develop `ac14b5d50` reject the reproducer.

## Reproducer

```yo
{ String } :: import("std/string");
D :: trait(
  fin : (fn(self : Self) -> i32),
  (fin2 : (fn(self : Self) -> i32)) ?= (self -> (Self.fin(self) + i32(1)))
);
H :: struct(_x : i32, _s : String);
impl(H, D(fin : (fn(self : Self) -> i32)(self._x)));
```

```text
error[E0901]: use of moved value: cannot copy `self`, whose type `H` is move-only, and it cannot be moved either: it is borrowed (a `&T` parameter or a `match`/`for` binding), and a borrow cannot give the value away.
note: raised in the default body of "fin2", which trait D gives H because this impl does not provide it
```

The same impl checks when it provides `fin2` itself.

## Root cause

A parameter is bound in more than one place (AGENTS.md "A parameter is bound in three places"). The def-time binder (`bind_parameter`, `src/env.yo`) makes a by-value parameter OWNING when its type is not bitwise `Copy`. The two binders that materialize a trait default for a concrete receiver build the parameters by hand with `add_variable_to_env`: the per-impl materialization in `src/evaluator/values/impl.yo` and `_monomorphize_default_fv` in `src/evaluator/values/dyn.yo`. Both set `is_ref` for `&mut` and `is_imm_borrow` for `&`, but never set `is_owning_the_rc_value` for a by-value parameter. `transfer_explicit_copy_value` (`src/evaluator/utils.yo`) then finds a non-owning, non-borrow parameter and falls through to its "it is borrowed" arm.

## Fix

`bind_parameter`'s owning predicate is now the exported `by_value_param_owns` (`src/env.yo`). Both default binders set `is_owning_the_rc_value = by_value_param_owns(ty)` for a by-value parameter, as `bind_parameter` does.

## Test

`tests/trait_default_inout_self.test.yo`, "by-value self default moves a move-only receiver": the `Finish` trait's `finish_twice` and `label_len` defaults move a `String`-holding receiver into the consuming `finish`. Before the fix the batch fails to compile with the E0901 above.
