# `recur(...)` result not hoisted into a temp when used as an argument → RC leak

## Symptom

When a recursive function returns an RC-typed value (`String`, `ArrayList`,
etc.) and the recursive `recur(...)` call appears as an **argument to another
function** (e.g. `String.concat(prefix, recur(x))`), the result of the recur
call is inlined at the call site without a hoisting temp and **without a
drop**. This leaks one RC allocation per recursive call.

The `yo-self` parser (`yo-self/parser/parser.yo`) hits this on every
recursive method, causing 16 of 36 tests in `yo-self/tests/parser.test.yo`
to fail under AddressSanitizer leak detection.

## Reproducer

```rust
{ ArrayList } :: import "std/collections/array_list";

Token :: object(name : String);

to_str :: (fn(toks : ArrayList(Token), i : usize) -> String) {
  cond(
    (i >= toks.len()) => `done`,
    true => match(toks(i),
      .Some(p) => String.concat(p.*.name, recur(toks, (i + usize(1)))),
      .None    => `none`,
    ),
  )
};

main :: (fn() -> i32) {
  toks := ArrayList(Token).new();
  toks.push(Token(name: `a`));
  toks.push(Token(name: `b`));
  s := to_str(toks, usize(0));
  i32(0)
};

export main;
```

Built with `--sanitize address --allocator libc`, this leaks one `String`
per recursive `to_str` call.

## Root cause

`evaluateRecur` in `src/evaluator/exprs/recur.ts` has two paths:

1. A **CTFE shortcut** for when `isAnalyzingCtfeCapability` or
   `isValidatingFunctionDefinition` is set. This is the path actually taken
   in normal compilation for recursive functions.
2. A fallback `evaluateFunctionCall` path used in some macro-expansion
   contexts.

The CTFE shortcut was setting `variableName` on the _value_ metadata
(`createUnknownValue({ variableName: ... })`) but **not** on
`expr.$.variableName`, and was not extracting `deferredDropExpressions` from
`tryToCallFunctionWithArguments`.

The argument-hoisting code in `src/codegen/exprs/other-fn-call.ts` checks
`arg.$?.variableName && arg.$?.type` to decide whether to hoist the
argument into a `_temp_xxxx` (with a deferred drop). Because
`expr.$.variableName` was undefined, the recur result string was inlined
verbatim and nothing dropped it.

## Fix

In the CTFE shortcut path of `evaluateRecur`:

1. Destructure `deferredDropExpressions` from `tryToCallFunctionWithArguments`.
2. Set `deferredDropExpressions` on `expr.$`.
3. Call `attachTempVariableToExpr(expr, true)` after writing `expr.$`.
   This is the same helper regular function calls use to allocate a temp
   variable name and register the drop with the env.

The non-CTFE fallback path is unchanged — it already routes through
`evaluateFunctionCall`, which calls `attachTempVariableToExpr` itself.

## Verification

- `tmp/named_recursion.yo` reports 0 user-allocated leaks under ASAN
  (only the macOS dyld/libobjc init noise of 120 bytes / 3 allocs remains).
- `yo-self/tests/parser.test.yo` — all 36 tests pass.
- Regression suites pass: `escape_cleanup_uninit_vars`, `algebraic_effects`,
  `iterator_combinators`, `basic`, `forward_ref_impl_block`.
- New regression test `tests/recur_inline_arg.test.yo` covers RC-returning
  recur as an argument.
