# exprToString dot-access with function call RHS causes reparse ambiguity

## Problem

`exprToString` serialized `self.(#(x))` as `(self.#(x))`, which when reparsed becomes
`(self.#)(x)` — a dot access of `self.#` followed by a call with `(x)`. This broke the
test runner because it serializes test code with `exprToString` and then reparses it.

## Root cause

In `exprToString` (both compact and pretty versions), the infix dot case at line 1358
produced `(${lhs}.${rhs})` without wrapping the RHS in parentheses when it's a function
call. For most dot accesses this is fine (e.g., `obj.field` where `field` is an atom),
but when the RHS is a function call like `#(x)`, the result `self.#(x)` is ambiguous.

## Fix

Added a check in both `exprToCompactString` and `exprToPrettyString`: when the dot
expression's RHS (`expr.args[1]`) is a function call (`exprIsFunctionCall`), wrap it in
parentheses before concatenation. This produces `(self.(#(x)))` which reparses correctly.

This only affects the case where the RHS of a dot is itself a function call expression,
which primarily occurs with `.(unquote(...))` syntax. Normal method calls like `obj.method()`
are parsed as `call(.(obj, method))`, so the dot's RHS is `method` (an atom), unaffected.

## Files changed

- `src/expr.ts` (exprToCompactString and exprToPrettyString)
