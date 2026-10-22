# The explicit-copy migration rewrites a capture-list shorthand `{ x }` into `{ x.clone() }`, which does not parse, and clones a capture the closure writes

**Severity:** S2: `yo fix --migrate explicit-copy` turns a valid program into one that fails to parse (E0007). For a capture the closure body writes, even the correct spelling (`{ x : x.clone() }`) would silently change behaviour, because the caller observes the write. The workaround is to review every capture-list site by hand.

**Status:** FIXED 2026-10-22 on `fix/explicit-copy-migration-defects`.
**Found:** 2026-10-21, during VALUES_BY_DEFAULT V2b B2's sweep of `tests/`.
The binary was the explicit-copy guards build (`feat/explicit-copy-guards`
at 8954cb9b6). It rewrote five sites:
`tests/async/combinators.test.yo` (3, all `{ c, seen }` for a spawned
task), and `tests/fn_once.test.yo` (2). B2 reverted all five by hand.

## Reproducer

`issues/repros/2026-10-21-explicit-copy-rewrites-a-capture-list-shorthand-into-an-unparseable-clone.yo`:

```yo
{ String } :: import("std/string");
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  s := String.from("four");
  (f : Impl(Fn() -> usize)) = ({ s }() => s.len());
  seen := ArrayList(i32).new();
  (g : Impl(Fn() -> unit)) = ({ seen }() => seen.push(i32(1)));
  g();
  println(`${f()} ${s.len()} ${seen.len()}`);
});
export(main);
```

The original program prints `4 4 1`. Running
`yo fix repro.yo --migrate explicit-copy` reports `inserted 2 .clone()
call(s); 0 site(s) left as written` and writes:

```yo ignore
  (f : Impl(Fn() -> usize)) = ({ s.clone() }() => s.len());
  (g : Impl(Fn() -> unit)) = ({ seen.clone() }() => seen.push(i32(1)));
```

`yo check` then fails at the first one:
`error[E0007]: { ... } without semicolons is parsed as a struct literal,
not a block`.

## Two defects

1. **Spelling.** A capture-list shorthand entry `x` names the capture and
   its source together. The `.clone()` belongs on the source, so the
   rewrite must expand the entry to `x : x.clone()`, not append to the
   name.
2. **Classification.** The `seen` capture is written in the closure body
   (`seen.push(...)`), and the caller reads that write (`seen.len()` is
   1). This is the "the copy is written afterwards, so the two may share a
   buffer on purpose" case the migration lists for a local binding. A
   write through a by-value capture inside the closure body is not
   counted, so the site is cloned. Even with defect 1 fixed, that clone
   changes the output to `4 4 0` without a diagnostic.
   `tests/async/combinators.test.yo` ("the body's effect is visible
   outside") depends on exactly this.

## Fix direction

Rewrite a shorthand capture entry to `name : name.clone()`. Treat a write
to a by-value capture inside the closure body as a write to the copy: list
the site instead of rewriting it.

The regression test is a cli-case beside
`tests/cli-cases/fix-migrate-explicit-copy-*` whose fixture is the
reproducer. Its golden expects `s` rewritten to `{ s : s.clone() }` and
`seen` listed as written afterwards. It lands with the fix: until then the
golden would record the wrong rewrite.

## Fix

Both defects, in `_evaluate_capture_list`
(`src/evaluator/values/anonymous_function.yo`), which stores a by-value
entry with `set_expr_as_needs_to_call_dup(..., "field-store")`:

1. **Spelling.** The parser reads the shorthand `x` as `x : x` with one
   token on both sides (`_cap_entry_is_shorthand`). That entry now passes its
   label as `copy_capture_label`, carried to `ExplicitCopySite.capture_label`,
   and the rewrite in `_run_migrate_explicit_copy` (`src/main.yo`) inserts
   `x : ` before the source along with the `.clone()` after it. The opener is
   one insertion (`x : (` when the source needs parentheses), so the sort
   cannot separate the label from its parenthesis.
2. **Classification.** The entry also passes `copy_dest_decl`: the
   `_ic_decl_key` of its label token, which is the declaration of the
   capture the body sees (`add_variable_to_env(..., ce.label_tok)`). A write
   to the capture in the body (`seen.push(...)`, recorded by the `&mut`
   receiver's `d3_record_inout_place` entry) is then a write of the copy
   after the site, and the written-after guard lists the site.

## Test

`tests/cli-cases/fix-migrate-explicit-copy-capture-list`, whose fixture is the
reproducer. Its goldens expect `s` rewritten to `{ s : s.clone() }` and
`seen` listed as "the copy is written afterwards"; the trailing `check`
proves the rewritten file evaluates. The rewritten program prints `4 4 1`,
as the original does.
