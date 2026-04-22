# Forward-ref impl shell leaves an orphan FunctionValue that codegen emits as a duplicate

## Status

**FIXED** in `src/evaluator/values/impl.ts` `evaluateImplFieldList`.

## Symptom

Running `tests/rc.test.yo` in batched mode (all tests compiled into a single
binary) failed with C compiler errors of the form:

```
error: use of undeclared identifier '_yo209f7c18_temp_42033'
error: use of undeclared identifier '_yo209f7c18_temp_42039'
```

Running each test in the file individually (e.g.
`--test-name-pattern "Test 'rc' function"`) succeeded. The failure only
showed up when multiple tests in the same file shared one compile unit.

## Root cause

The forward-references-in-impl-blocks change (commit `4aea1a8f`) introduced
a two-pass evaluation in `evaluateImplFieldList`:

1. **Pre-pass** — `tryCreateForwardShell` allocates a real `FunctionValue`
   "shell" with a fresh `funcId`, evaluates the function-type head, and
   pushes the shell into `receiverType.trait.fields` so sibling fields can
   resolve mutual references via `self.method`.
2. **Main pass** — calls `evaluateExpression(valueExpr)` on
   `(fn(...) -> R)(body)`. This produces a **second** `FunctionValue`
   (different `funcId`), with its own body evaluation. The shell is then
   mutated in place with the analyzed metadata.

After the merge, the local variable `fieldValue` is reassigned to point at
the shell, and the trait field's `assignedValue` references the shell. But
the AST nodes inside `valueExpr` retain `expr.$.value = orphan` from the
main-pass evaluation. In particular `valueExpr.$.value` (the result of
calling `(fn(...) -> R)(body)`) and any `recur` nodes still point at the
orphan FunctionValue.

When codegen walks the test main body, `findFunctionCallsInExpr` traverses
the impl call expression and discovers these orphan references, registering
the orphan in `context.functions` under its own `funcId` (e.g. `id_85`).
The shell is also registered (under e.g. `id_76`). Both share the same body
AST.

Codegen then emits **both** functions. The shell's emission walks the body
first and tags each generated temp variable as "already added to begin
block". The orphan's emission walks the _same_ AST nodes, sees the temp
names already attached, re-uses them in expressions, but skips the
declaration emission — producing a function body that references undeclared
local identifiers.

## Reproducer

`tests/forward_ref_impl_block.test.yo` ("no duplicate function emission for
shell + orphan"):

```rust
QQ :: object(data : Box(i32));
impl(QQ,
  new : (fn(val : i32) -> Self)(
    Self(data : box(val))
  ),
  get_implicit : (fn(self : Self) -> Box(i32))(
    self.data
  ),
  get_explicit : (fn(self : Self) -> Box(i32))({
    return self.data;
  })
);

test "no duplicate function emission for shell + orphan", {
  q := QQ.new(i32(42));
  d1 := q.get_implicit();
  assert((d1.* == i32(42)), "d1 == 42");
  d2 := q.get_explicit();
  assert((d2.* == i32(42)), "d2 == 42");
};
```

The exact `tests/rc.test.yo` test that originally surfaced the bug is
"Test explicit return and implicit return" (essentially the same shape).

## Fix

In the shell-merge branch of `evaluateImplFieldList`, after copying analyzed
metadata onto the shell, also redirect the orphan FunctionValue's `funcId`
and `funcName` to the shell's. Codegen's `context.functions` map keys on
`funcId`, so collapsing both `FunctionValue` objects onto the same `funcId`
turns the orphan into a benign alias — only one C function is emitted, and
both AST references resolve to it.

```ts
// In src/evaluator/values/impl.ts evaluateImplFieldList, shell merge:
fieldValue.funcId = stableFuncId;
fieldValue.funcName = stableFuncName ?? label;
fieldValue = shell;
```

## Why isolated tests passed

When a test file contains a single test, the test main body is small and
straight-line. The orphan's reachability through `findFunctionCallsInExpr`
depends on which AST nodes the codegen walk visits; small main bodies plus
single trait-method receivers happen not to exercise the path that pulls
the orphan into `context.functions`. The batched binary inlines all 13
test bodies into one main, dramatically increasing the chance that
`findFunctionCallsInExpr` discovers the orphan via the impl AST.
