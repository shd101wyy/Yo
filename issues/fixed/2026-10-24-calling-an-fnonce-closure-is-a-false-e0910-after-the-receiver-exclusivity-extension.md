# Calling an `FnOnce` closure inside an operand is a false E0910 after the receiver-exclusivity extension

**Severity:** S2 — valid code rejected: a one-argument call of a closure local used as an operator operand or a borrowed receiver is E0910, so the whole `tests/fn_once.test.yo` batch fails to compile on every platform (develop red).

**Status:** FIXED 2026-10-24 (branch `fix/fixdev-fnonce-e0910`). Regression from #1573 (`27431e4be`, "a receiver or & argument reached through an Rc/Arc keeps the handle alive for its call; … E0910 checks deref and element receivers").

## Symptom

Develop battery run 40070135232 failed shard 1 on every platform, wasm and the hollow sweep:

```
tests/fn_once.test.yo — 0 of 23 tests in this batch ran
error[E0910]: This argument moves `f`, which an earlier argument of the same call lends to it (`f(true)`)
```

The failing tests are "FnOnce: an early return drops the captures the body did not move" and
"FnOnce: an early return that moves nothing drops every capture": both write
`assert(f(true) == i32(N), …)` on an `Impl(FnOnce(go : bool) -> i32)` local.

## Reproducer

```yo
{ assert } :: import("std/assert");
Tok :: struct(n : i32);
take :: (fn(sink(t) : Tok) -> i32)(t.n);
main :: (fn() -> unit)({
  t := Tok(n : i32(5));
  (f : Impl(FnOnce(go : bool) -> i32)) = ({ t }(go : bool) => take(t));
  assert(f(true) == i32(5), "impl fnonce");
  ()
});
export(main);
```

A develop binary (containing #1573) reports the E0910 above at the `f(true)` operand; seed v0.2.68
compiles and runs it clean under ASan. The same false positive hits:

- `Dyn(FnOnce(go : bool) -> i32)` called as either operand: `i32(6) == d(true)`;
- an `Fn` closure's result as an operand followed by an argument that moves the closure:
  `g(i32(1)) == eat(g)` reports "moves `g`, which an earlier argument … lends (`g(i32(1))`)",
  although `g(x)` returns a fresh temporary that lends nothing of `g`.

A zero-argument call (`d() == i32(5)`) escapes only because the predicate requires exactly one argument.

## Root cause

#1573 added `_is_unmarked_lent_place` (`src/evaluator/calls/function.yo`), which decides whether an
unmarked lend (an operator operand or a borrowed receiver) names a place. It treats any one-argument,
non-infix call whose callee's type is not a function type as an element read `xs(i)`:

```yo ignore
(!ul_infix && (ul_args.len() == usize(1)) && match(expr_info_table_get(&ctx.expr_info_table, ast_expr_id(&ul_callee)), .Some(ci) => !is_function_type(&ci.ty), .None => false)) => ul_callee,
```

A closure local is typed `Impl(Fn*/FnOnce)` (a SomeT) or `Dyn(Fn*/FnOnce)` (a DynT), never `.Func`, so
`is_function_type` is false and `f(true)` is read as an element read rooted at `f`. `_check_call_lent_place`
then asks `_lent_root_moved_at`, which finds `f.consumed_at_token` set by the FnOnce call itself
(`consume_called_fnonce_closure`), and `_check_lent_place_not_moved` reports the operand as both
lending and moving `f`. For an `Fn` closure, a later argument that legitimately moves the closure is
flagged instead.

The sibling walker `_global_lend_root` in the same file already uses the exact positive test: the call's
own ExprInfo carries `expr_info_index_method_type` (set by Index-trait dispatch, which also covers
`Array`), or the callee is array-typed. Codegen is not involved; the predicate gates only a diagnostic.

## Fix

`_is_unmarked_lent_place` now recognises an element read the way `_global_lend_root` does: the call's
own ExprInfo carries the Index dispatch marker (`expr_info_index_method_type`), or the callee is
array-typed. The one-argument / not-a-function-type heuristic is gone. Every other call (a closure,
`Dyn(Fn*)` or `Dyn(FnOnce)` call, a closure-typed field `h.cb(x)`, a constructor) yields a temporary that
no later argument can reach, so it lends nothing. The #1573 protections are unchanged: their receivers
(`hs(usize(0)).peek`, `fs(usize(0)).r.peek`, `ts(usize(0)).peek_len`) are Index-dispatched, so they keep
the marker, and the `r.peek` case is a plain name. The predicate gates only a diagnostic, so no emitted C
changes.

Regression tests, in `tests/fn_once.test.yo`:

- "FnOnce: a one-argument call of an FnOnce local is either operand of ==": `Impl(FnOnce)` on the right,
  `Dyn(FnOnce)` on both sides.
- "FnOnce: an Fn closure's call result is a temporary a later argument may move the closure past":
  `g(i32(1)) == _once_eat_fn(g)`, and the same through `Dyn(Fn)`.
- "FnOnce: a closure call's result as a borrowed receiver lends nothing of the closure":
  `mk(i32(1)).plus(_once_eat_mk(mk))`.
- "FnOnce: an element read as an operand still lends its container", a negative control that stays
  E0910: `xs(usize(0)) == _once_first(xs)`.

The develop binary fails the first three with the E0910 above and passes the control. All four pass
after the fix, and each checks dispose counts. The two existing tests that turned develop red pass as well.

Two more shapes that the fix accepts were dropped from the tests. They fail at run time, under seed
v0.2.69 as well, so these are pre-existing bugs that the false E0910 had been hiding. Each is filed
with a repro:

- `cb(i32(1)).len()`, where `cb`'s `FnOnce` body is the bare capture `s`, leaks the environment:
  `issues/2026-10-24-an-fnonce-closure-whose-body-is-a-bare-capture-leaks-its-environment.md`.
- `h.cb(i32(1)) == (i32(1) + eat(h))` on a `Dyn(Fn)` field is a use after free, because the later
  argument's call is hoisted above the inline field call:
  `issues/2026-10-24-a-dyn-closure-field-call-operand-runs-after-a-later-hoisted-argument.md`.
