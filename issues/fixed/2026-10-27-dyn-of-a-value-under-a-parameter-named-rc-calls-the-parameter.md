# `dyn(v)` of a value under a parameter named `rc` calls the parameter

**Severity:** S2 — a valid program is rejected: boxing a value with `dyn(...)` inside a function whose parameter (or match-pattern binding) is named `rc` fails with "rc is not callable", pointing at line 1 column 1.

**Status:** FIXED 2026-10-27 (`feat/sai-a2a3-handle-ctors`, plans/backlog/STATIC_ARGUMENT_INFERENCE.md §5 A3). **Found:** 2026-10-27, while making `dyn(...)` synthesize `Rc(T).new` instead of `rc`.

## Reproducer

```yo
{ assert } :: import("std/assert");
{ ToString } :: import("std/fmt");
{ String } :: import("std/string");
_boxed_under_rc_param :: (fn(rc : i32) -> Dyn(ToString))(dyn(rc));
main :: (fn() -> unit)({
  d := _boxed_under_rc_param(i32(5));
  assert(d.to_string() == `5`, "boxed");
});
export(main);
```

`yo check` with v0.2.70 (and develop `476cfb700`):

```text
error[E0606]: rc is not callable: it has type i32.
  --> tmp/rcparam.yo:1:1
```

## Root cause

`evaluate_dyn_value` (`src/evaluator/values/dyn.yo`) boxes a payload that is not an object by synthesizing the call `rc(v)` (`arc(v)` for a `Send` target) and evaluating it in the `dyn(...)`'s environment. The callee is an atom named `rc`, so it resolves like any written `rc`: a parameter or a pattern binding of that name, which `tests/rc_binding_gives_way.test.yo` allows to shadow the prelude's `rc`, wins. The synthetic token has no source position, hence `1:1`.

## Fix

The synthesized call is `Rc(T).new(v)` (`Arc(T).new(v)`), whose receiver is a fresh node with its ExprInfo already `.TypeVal(Rc(T))`, the cell type `_create_box_type_via` computes; the node is marked pre-evaluated around the call (`_synthesized_cell_new_call`). No name is looked up, so no binding can capture it.

Test: `tests/rc_binding_gives_way.test.yo` "a parameter named rc does not capture the cell dyn(...) builds" fails on develop `476cfb700` with the error above and passes with the fix.
