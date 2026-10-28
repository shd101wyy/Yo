# A `.clone()` whose receiver holds an `Rc` over a user-`Clone` payload is E0916 on a `mut` global

**Severity:** S2 — a legal read of a `mut` global (`v := G.clone()`, the spelling E0916's own help prescribes) is rejected when the global's type holds an `Rc(V)` whose payload `V` reaches a hand-written `Clone` anywhere inside, although the `Rc`'s clone is a count bump that never touches `V`. The V2c rc-clone sweep hits this shape in `src/env.yo` (`g_synthetic_token_last.clone()`), so the swept compiler tree cannot type-check.

**Status:** FIXED 2026-10-25 (V2c, decision 17). The test is `tests/global_lend.test.yo` ("a structural clone() of a mut global is exempt from E0916", the `Option(Rc(_GlWrap))` line): it fails before the fix and passes after.

## Verbatim error

```text
error[E0916]: Cannot lend `g_synthetic_token_last` to `g_synthetic_token_last.clone` (the receiver of a `self : &Self` method): `g_synthetic_token_last` is declared `mut(g_synthetic_token_last)`, a mutable module-level binding, which has no run-time borrow flag. Any function can write it by name, and so can another task while the callee awaits, so the callee could read a value that was already released while it still holds the borrow (plans/VALUES_BY_DEFAULT.md decision 18 rule 3, decision 47).
    --> src/env.yo:521:11
    |
521 |   last := g_synthetic_token_last.clone();
    |           ^^^^^^^^^^^^^^^^^^^^^^
```

## Reproducer (before the fix)

```yo ignore
{ String } :: import("std/string");
Loud :: struct(n : i64);
(mut(count) : i64) = i64(0);
impl(
  Loud,
  Clone(
    clone : (fn(self : &Self) -> Self)({
      count = (count + i64(1));
      Loud(n : self.n)
    })
  )
);
Holder :: struct(inner : Loud, label : String);
(mut(g_h) : Option(Rc(Holder))) = Option(Rc(Holder)).None;
f :: (fn() -> i32)({
  v := g_h.clone();
  i32(0)
});
main :: (fn() -> unit)({ f(); })
```

Measured with the yo-r5 build (branch `vbd/v2c-rc-clone`, tree `5a793dce9`): `check` fails with the E0916 above at `v := g_h.clone();`. A `mut` global of `Option(Rc(Loud))` (the user-`Clone` type as the payload itself) passes only because of evaluation order; the walk judges the payload either way.

## Root cause

`_clone_runs_no_user_code_inner` (`src/evaluator/trait_checking.yo`) decides whether a `.clone()` runs user code by walking the type: a hand-written `Clone` anywhere inside returns false. `Rc(V)` is spelled `ref(struct((*) : V))` in the prelude, so the walk descended into the storage field `V` and judged `V`'s impls — but the `Rc` handle's `Clone` (the prelude's, decision 17: a handle copy with no `where` clause) is a `ref_count` bump that never constructs, reads or clones the payload. The exemption therefore failed for `Option(Rc(_SyntheticTokenModule))`, whose payload reaches `Token`'s hand-written `Clone` (`src/token.yo`), even though cloning the `Option` runs only std code: the `Option`'s clone and the handle's count bump.

## Fix

The walk stops at the prelude's counted handle: after `type_has_user_clone_impl` (a user-written `Clone` on the handle type itself still loses the exemption), `is_counted_handle_value_type` (`Rc(V)`, `Arc(V)`) returns true — the handle's `Clone` cannot run payload code. This is the same reasoning the prelude's `Rc`/`Arc` `Clone` (V2c) already embodies for decision 17. A first version stopped at every `ref` object (`is_counted_handle_type`), which exempted a collection whose `Clone` clones user-`Clone` elements; `tests/global_lend.test.yo`'s `mut(_gl_mlouds)` (an `ArrayList(_GlLoud)`) expectation caught it.
