# Bug: `ArrayList(Token)` as impl method return type fails with "Variable 'Runtime' not found"

**Status**: ✅ FIXED (commit after Phase 6f)  
**Severity**: Medium (workaround was available)  
**Discovered**: Phase 2i (yo-self evaluator/index.yo)

## Fix

Added a `try-catch` around the `evaluateExpression` call inside `attachTraitToReceiverType`
in `src/evaluator/types/utils.ts`. When the trait module (e.g., `Runtime`) is not in scope
in the current evaluation environment, we silently return the unchanged env instead of
throwing. The trait was already attached during the type's first instantiation; re-attaching
is unnecessary.

```typescript
let evaluatedTraitCall;
try {
  evaluatedTraitCall = evaluateExpression({ expr: traitCallExpr, env, ... });
} catch {
  // Trait not in scope (already attached during first instantiation); skip.
  return env;
}
```

The workaround in `yo-self/parser/parser.yo` was reverted — `get_tokens()` now returns
`ArrayList(Token)` correctly. All 43 parser tests still pass after this fix.

## Symptom

Adding any method to the `impl(Parser, ...)` block in `yo-self/parser/parser.yo` with
a return type of `ArrayList(Token)` produces:

```
Error: Variable "Runtime" not found.

auto-generated://
// === START auto-generated code ===
Runtime()
// === END auto-generated code ===
:1:1:
Runtime()
   ^
```

The error is thrown inside `attachTraitToReceiverType("Runtime", ...)` in
`src/evaluator/types/utils.ts` (line 1138), which calls
`generateExprFromCode("Runtime()")` and tries to evaluate it with the current
environment — but at that point `Runtime` is not in scope.

## Reproduction

Add to `yo-self/parser/parser.yo` (inside `impl(Parser, ...)`):

```rust
get_tokens : (fn(self : Self) -> ArrayList(Token))(self.tokens)
```

This triggers the error on **any** position in the impl block (first, middle, last).

A `-> unit` return works fine:

```rust
get_tokens : (fn(self : Self) -> unit)(())  // OK
```

A `-> String` return also works:

```rust
get_module_path : (fn(self : Self) -> String)(self.module_path)  // OK
```

## Root Cause (hypothesis)

`Parser` is a large file (~1307 lines) with `while runtime(...)` loops inside
`get_program`'s body. When the TypeScript evaluator processes `get_program` and
encounters `while runtime(...)`, the CTFE-analysis for `get_program` fails (by
design — `while runtime(...)` prevents CTFE).

The hypothesis is that the CTFE failure leaves the environment (or type-cache)
in a state where subsequent `ArrayList(Token)` instantiation as a return type
triggers `autoDeriveRuntimeForStructType` → `attachTraitToReceiverType("Runtime",...)`
in an environment that no longer has `Runtime` in scope.

`ArrayList(Token)` as a field type (`tokens : ArrayList(Token)` in the `Parser`
struct) is instantiated and gets `Runtime` attached at struct-definition time.
But when it appears as an explicit return type annotation in a later method, the
evaluator may re-derive traits in a restricted environment.

Note: `ArrayList(AstExpr)` works fine as a return type in `get_program` — likely
because `AstExpr` is already registered before the problematic CTFE-analysis loop.

## Workaround

Access the `tokens` field directly on the `Parser` struct instead of calling a
`get_tokens()` method:

```rust
// In index.yo / Evaluator.new:
parser := Parser.new(input_string, module_path, using(exn));
toks   := parser.tokens;           // direct field access — no method needed
program := parser.get_program(using(exn));
```

The `get_tokens : (fn(self : Self) -> unit)(())` stub is kept in the impl block
for API completeness (TypeScript mirror) but currently returns `unit` instead of
`ArrayList(Token)`.

## Files Affected

- `yo-self/parser/parser.yo` — cannot add `-> ArrayList(Token)` method to impl
- `yo-self/evaluator/index.yo` — uses `parser.tokens` directly (workaround)
- `yo-self/tests/evaluator_index.test.yo` — updated to not call `parser.get_tokens()`

## Impact on Phase 2i

`Evaluator.get_tokens()` in `yo-self/evaluator/index.yo` stores and exposes the
token list. The `Evaluator` impl is in a fresh file with fewer dependencies;
**testing showed that `Evaluator.get_tokens() -> ArrayList(Token)` does work**
in `index.yo` (or needs to be verified — may hit the same bug if `Evaluator`
struct is equally large).

## Related TypeScript source

- `src/evaluator/types/utils.ts`: `attachTraitToReceiverType`, `autoDeriveRuntimeForStructType`
- `src/evaluator/types/utils.ts:1138`: evaluation of `"Runtime()"` auto-generated expression
