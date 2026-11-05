# `yo fix --migrate rc-clone` rejects a `Dyn` moved through a capture list that `yo check` accepts

**Severity:** S2. `yo fix <path> --migrate rc-clone` reports E0901 "use of moved value" for a `Dyn` (`AnyError`)
that moves into a closure's capture list and is then moved in the closure body. `yo check` accepts the same file.
Because the file "does not evaluate" under the migration, none of its copies, or the copies of any module that
imports it, are migrated.

> Found 2026-11-05 while running the rc-clone migration over `src/` for V5 part B. Three `src/` sites have the
> shape: `src/evaluator/exprs/expr.yo` (`g_guarded_eval_err`), `src/evaluator/exprs/match.yo`
> (`g_guard_block_err`) and `src/evaluator/builtins/derive.yo` (`g_derive_eval_err`). Seed v0.2.74 and a tree
> build of 208f93fb3 both show it.

## Reproducer

```yo
{ AnyError } :: import("std/error");
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ RefCell } :: import("std/sync/refcell");
{ println } :: import("std/fmt");
(g_errs : RefCell(ArrayList(AnyError))) = RefCell(ArrayList(AnyError)).new(ArrayList(AnyError).new());
record :: (fn(sink(err) : AnyError) -> unit)(
  g_errs.with_mut({ err }(xs) => xs.push(err))
);
main :: (fn() -> unit)({
  record(dyn(String.from("boom")));
  println(g_errs.with(xs => xs.len()));
});
export(main);
```

`yo check h.yo` passes. `YO_DEBUG_FIX=1 yo fix h.yo --migrate rc-clone` prints:

```text
[fix] h.yo: error[E0901]: use of moved value: `err`
  --> h.yo:8:34
help: `err` holds a `Dyn`, which owns its payload alone (plans/VALUES_BY_DEFAULT.md decision 7): ...
note: value moved here
  --> h.yo:8:20
```

With `String` in place of `AnyError` (and no `dyn(...)`), the migration evaluates the file and inserts nothing.

## Root cause (suspected)

The migration switches on `migrate_rc_clone_on()`, which suspends decision 17's copy rule and records a copy into
a closure where a counted handle would be copied (`src/evaluator/utils/closure.yo`, `_runtime_capture_names` and
the `type_holds_counted_handle_ignoring_migration` arm). A `Dyn` falls under the unique-`Dyn` rule
(`dyn_copy_rule_applies`), and on that path the capture-list move is counted as a move *and* the body's use is
checked against it as a second use. `check` treats the capture list as the closure's ownership of `err` and the
body's move as moving out of the closure's own slot.

## Fix direction

Make the migration's capture path treat a capture-list entry the same way `check` does: the body moves out of the
closure's slot, not out of the outer binding. A test lands with the fix: the reproducer above as a `yo fix`
cli-case (`tests/cli-cases/`) that fails before the fix (the file does not evaluate) and reports `inserted 0
clone(s)` with rc 0 after it.
