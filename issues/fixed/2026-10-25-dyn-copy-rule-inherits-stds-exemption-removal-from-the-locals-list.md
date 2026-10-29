# `dyn_copy_rule_applies` inherited std's exemption removal from the shared list (E0901 fired inside std a generation early)

**Severity:** S1 (made `yo check ./std` fail on any tree carrying both #1603 and the decision 47 std half; blocks the v0.2.71 std cluster)

Filed 2026-10-25, found while re-gating `vbd/p5-std-mut-locals` after its rebase onto #1610.

## Verbatim error

```
error[E0901]: use of moved value: cannot copy `cause`, whose type `dyn(ToString + Error)` is move-only (a `Dyn` copies only when `Clone` is in its trait list), and it cannot be moved either: it is a `&T` parameter, and a borrow cannot give the value away. Take the parameter by value (`x : T`, without `&`) to own it.
    --> std/error.yo:223:45
    |
223 |     Self(message : message.clone(), cause : cause)
    |                                             ^^^^^
```

`yo check ./std --std-path ./std` then fails with 66 std files not evaluating (every importer of
`std/error.yo`), and `yo fix ./std --migrate mut-bindings` reports the same 66 files as not
evaluating. The v0.2.70 seed checks the same std clean (it predates #1603).

## Minimal reproducer

Any tree that (a) carries #1603's decision 7 Generation A rule and (b) removes `std/` from
`is_global_mut_rule_exempt` (the decision 47 locals std half):

```sh
yo check ./std --std-path ./std          # E0901 in std/error.yo:223, rc=1
yo test tests/error_source_chain.test.yo --std-path ./std --parallel 1   # same E0901, rc=1
```

`tests/error_source_chain.test.yo` calls `Context.new` directly (lines 28, 92, 112), so it is the
test that fails before the fix and passes after it.

## Root cause

`dyn_copy_rule_applies` (`src/evaluator/utils.yo`) scoped #1603's rule as "outside the trees the
seed builds" by negating the one shared exemption helper:

```yo
dyn_copy_rule_applies :: (fn(ty : &TypeValue, tok : &Token, ctx : &EvalContext) -> bool)(
  !is_global_mut_rule_exempt(&tok.module_path.*, &ctx.std_path) && type_holds_dyn_by_value(ty)
);
```

`is_global_mut_rule_exempt` (`src/evaluator/memory_safety.yo`) is decision 47's list, and the
locals Generation B std half removes `std/` from it. The Dyn rule's own Generation A scope was
always "std and src are exempt until B13 sweeps them" (#1603's plan text), so piggybacking on the
shared list coupled two unrelated sweeps: whoever removes a tree from the decision 47 list widens
the decision 7 rule into that tree a generation early. The four other consumers of the list
(`global_mut_rule_applies`, `binding_require_mut` twice, `place_require_mut`) are the locals rule
itself and were meant to widen.

## Fix

`dyn_copy_rule_applies` names std's continued exemption explicitly, so the decision 47 list is
again about only decision 47:

```yo
dyn_copy_rule_applies :: (fn(ty : &TypeValue, tok : &Token, ctx : &EvalContext) -> bool)(
  !is_global_mut_rule_exempt(&tok.module_path.*, &ctx.std_path)
  && !is_std_module_path(&tok.module_path.*, &ctx.std_path)
  && type_holds_dyn_by_value(ty)
);
```

(`is_std_module_path` from the same module, memoized per std root.) B13 removes that conjunct when
it sweeps std's Dyn copies. Fixed on `vbd/p5-std-mut-locals` with the regression test named above;
move this doc to `issues/fixed/` with the merge.

## Resolution (B13, 2026-10-28)

The explicit std conjunct shipped with p5 (#1612). B13 (decision 7 Generation B,
branch `vbd/b13-dyn-gen-b`) then swept std's and src's `Dyn` copies and deleted
both conjuncts: `dyn_copy_rule_applies` is now `type_holds_dyn_by_value(ty)` alone
and consults no exemption list, so no later change to decision 47's list can
widen or narrow it. `yo check ./std` and `yo check ./src` pass with the rule
applied to every tree; `tests/error_source_chain.test.yo` (the regression test
named above) passes, as does
`tests/cli-cases/a-dyn-copy-in-a-fetched-dependency-is-e0901` (a store path, which
the shared list exempts, gets the rule).
