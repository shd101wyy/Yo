# A capture-list entry named with a leading underscore is emitted bare when the body moves it

**Severity:** S2 — a valid program fails to compile: the C compiler rejects the
closure. The workaround is to name the variable without a leading underscore.

**Found:** 2026-10-29, in B13-b (errors by value, `vbd/b13b-errors-by-value`).
Three `src/` handlers kept their error with
`g_errs.with_mut({ _g_err }(xs) => xs.push(_g_err))`, and the v0.2.72 seed's
build of the compiler failed in C. A tree binary has the same bug. The
handlers were renamed (`guard_err`, `derive_err`) to work around it.

## Reproducer

`issues/repros/2026-10-29-a-capture-list-entry-named-with-a-leading-underscore-is-emitted-bare-when-moved.yo`,
built with `yo compile <file> --std-path ./std`:

```yo
{ AnyError } :: import("std/error");
{ RefCell } :: import("std/sync/refcell");
{ ArrayList } :: import("std/collections/array_list");
{ String } :: import("std/string");
{ println } :: import("std/fmt");
(g_errs : RefCell(ArrayList(AnyError))) = RefCell(ArrayList(AnyError)).new(ArrayList(AnyError).new());
keep :: (fn(_g_err : AnyError) -> unit)({
  g_errs.with_mut({ _g_err }(xs) => xs.push(_g_err));
});
main :: (fn() -> unit)({
  keep(dyn(String.from("boom")));
  println(g_errs.with(xs => xs.len()));
});
export(main);
```

```text
error: use of undeclared identifier '_g_err'; did you mean '__erf'?
```

Renaming `_g_err` to `gerr` compiles and prints `1` (ASan-clean).

## The emitted closure

With `gerr`, the `FnOnce` body takes the capture into a local first:

```c
__yo_t_… __yo_v_gerr = ((__yo_t_…*)closure_context)->__yo_v_gerr;
…
__yo_fs_…(__yo_v_xs, __yo_v_gerr);
```

With `_g_err`, that local is never declared, and the move reads the bare name:

```c
__yo_fs_…(__yo_v_xs, _g_err);
```

## Root cause

The C spelling rule is consistent: `sanitize_for_c_identifier`
(`src/codegen/utils/index.yo`) leaves a compiler-shaped name as it is, so
`_g_err` is `_g_err` at every site, and `gerr` is `__yo_v_gerr`. The fault was
in what the FnOnce body's prologue claimed about those names.

`generate_function` (`src/codegen/functions/generation.yo`) seeded each
capture LABEL of an FnOnce closure into the function's declared C names and
its block-scope stack, so that the capture drops would pass the declared-name
gates. Those sets hold C names, and an owned capture is no C local: it lives in
`closure_context`. Seeding the sanitized C names had already been tried and
backed out in #1266, because it defeated the `closure_context` rewrite; the
raw labels were seeded instead. A raw label matches a C name only when the
label is its own C spelling, which is exactly a name with a leading `_` or
the `var_` prefix.

The moving read is the argument materialization in `_materialize_arg`
(`src/codegen/exprs/other_fn_call.yo`). It emits `T <name> = <read>;` unless
the name is "already in an open scope". For `gerr`, `__yo_v_gerr` is not in
scope, so it declares the local from `closure_context` and passes it. For
`_g_err`, the seeded label is `_g_err`, the check answers "in scope", nothing
is declared, and the call passes the bare `_g_err`. The `var_` prefix fails
the same way (`{ var_moved }(xs) => xs.push(var_moved)`:
`use of undeclared identifier 'var_moved'`).

## Fix

The seeding is removed. The gates it was meant to satisfy exempt a tagged
FnOnce capture drop (`is_fnonce_capture_drop`) on every path:
`_keep_pending_drop` and the consumed-variable escape drops in
`exprs/return.yo`, and the scope-end flush in `exprs/drop_dup.yo`. So the
seeding had no effect left except this one. The spelling rule stays as it
was.

Test: `tests/closure_capture_list.test.yo`, "an FnOnce body moves a
capture-list entry named `_x` or `var_x`". It fails in C on develop
`b7e873958` (both names undeclared) and passes with the fix.

The three `src/` handlers that B13-b renamed (`guard_err` in
`evaluator/exprs/expr.yo` and `evaluator/exprs/match.yo`, `derive_err` in
`evaluator/builtins/derive.yo`) keep their names until `SEED_VERSION` carries
this fix. Stage 1 is built by the v0.2.72 seed, which still has the bug.
