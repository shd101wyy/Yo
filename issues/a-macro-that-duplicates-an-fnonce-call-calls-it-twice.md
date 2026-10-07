# A macro that duplicates an `FnOnce(...)` call calls the closure twice

**Severity:** S2 — memory unsafety behind the macro gate: a macro whose expansion repeats its argument (`twice(f())` → `(f() + f())`) calls a call-once closure twice, and the second call runs a body that already gave its captures away (a double dispose, or a read of freed memory).

> Found 2026-10-07 by the adversarial review of PR #1266 (decision 37's `FnOnce`, Generation A). Open: macros need `Pragma.AllowMacroDef`.

## Reproducer

`tmp/review/p30.yo` (Dispose counter) and `p31.yo` (String capture) in the
`feat/vbd-fnonce` worktree: a macro `twice(x)` that expands to `(x + x)`,
applied to `f()` where `f : Impl(FnOnce() -> i32)`. The output is `10`,
`disposed=2`; the expected result is an E0901 at the second call.

## Root cause

An `FnOnce` call consumes its callee (`consume_called_fnonce_closure`,
`src/evaluator/utils.yo`). A re-evaluation of the same call site must not count
as a second call, because the evaluator re-walks call nodes as an enclosing
call's argument and in trial passes. So the consumption is exempt when the
variable's `consumed_at_token` is this call's token: the same position as the
identifier-read exemption in `evaluate_identifier_and_operator`. A macro
expansion that copies its argument produces two call nodes with ONE source
token, and the second is exempted.

## Fix direction

Key the exemption on the call NODE rather than its token: record the
consuming node id per variable, and exempt only that node. Trial passes that
clone a body with fresh ids (`clone_expr_fresh_ids`) evaluate against fresh
bindings, which must be confirmed before switching. The identifier-read
exemption has the same shape and should be audited with it.
