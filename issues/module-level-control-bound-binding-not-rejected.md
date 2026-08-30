# Module-level binding of a control-bound STRUCT value is not rejected

**Status: OPEN.** Split from
issues/fixed/ctl-handler-escaping-its-defining-fn-is-untypeable.md
(2026-08-30) while implementing the result-type escape rule.

## What

Escape boundary 2 (`src/evaluator/exprs/initialization_assignment.yo` ~line
268) rejects a module-level binding whose RHS type is control-bound, because
module bindings outlive every call frame. It works for a DIRECT ctl-typed
binding **in `comptime_expect_error` propagate mode** (the rule-8
boundary-2 test), but a plain `yo check` accepts BOTH of these:

```rust
open(import("std/string"));
{ Exception } :: import("std/error");
(g_exn : Exception) = Exception(throw : ((err) -> { unwind(()); }));
```

```rust
open(import("std/string"));
(g_raise : (ctl(msg : String) -> i32)) = ((msg) -> { unwind(i32(0)); });
```

`type_is_control_bound(Exception)` is demonstrably TRUE (the pointer rule
fires: `*(Exception)` errors with "Pointee type: Exception"), so the leak is
in the module-level rule's inputs or reach, not the predicate. Suspects, in
order: the RHS `->` literal / struct-construction is def-time trial-evaluated
and its `rhs_info` never reaches the check; the swallow eats the throw;
`ctx.is_evaluating_function_body_or_async_block` is unexpectedly `.Some`
during module eval of these shapes.

A stored module-level handler that a later call invokes would `unwind` to a
dead frame — same class as the fixed result-type escape, one door over.

## Fix sketch

Trace where `rhs_info_opt` comes from for an annotated module binding whose
RHS is (a) a bare handler literal and (b) a struct construction carrying one;
make the boundary-2 check see the resolved type in both, and add both shapes
to the rule-8 family in `tests/algebraic_effects.test.yo` as
`comptime_expect_error` pins PLUS a `yo check`-visible repro (the propagate-
mode-only enforcement is what hid this).
