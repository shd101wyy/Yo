# Calling an `FnOnce` closure inside an operand is a false E0910 after the receiver-exclusivity extension

**Severity:** S2 — valid code rejected: a one-argument call of a closure local used as an operator operand or a borrowed receiver is E0910, so the whole `tests/fn_once.test.yo` batch fails to compile on every platform (develop red).

**Status:** open. Regression from #1573 (`27431e4be`, "a receiver or & argument reached through an Rc/Arc keeps the handle alive for its call; … E0910 checks deref and element receivers").

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
