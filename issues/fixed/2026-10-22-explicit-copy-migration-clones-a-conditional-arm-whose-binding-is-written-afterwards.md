# `yo fix --migrate explicit-copy` clones a conditional arm whose binding is written afterwards

**Severity:** S1 — the rewrite changes what the program computes: a push through a binding chosen by `if(c, entry.no, entry.yes)` stops reaching the entry, so the regenerated compiler drops every where-clause trait constraint it records (`src/env.yo:3359`, `:3578`).

> Found 2026-10-22 by the B1 regeneration (`feat/v2b-b1-regeneration`,
> plans/VALUES_BY_DEFAULT.md B1, "As-built 2026-10-22").

## Symptom

The migration's written-after guard lists a copy whose destination is
written later: `r := s; r.push_str(...)` is left as written ("the copy is
written afterwards, so the two may share a buffer on purpose"). The same copy
spelled through a conditional is cloned:

```yo ignore
-      target_list := if(is_negated, entry.negative_traits, entry.required_traits);
+      target_list := if(is_negated, entry.negative_traits.clone(), entry.required_traits.clone());
       ...
       if(!already, {
         target_list.push(trait_type);
       });
```

`entry` is a `ref` `WhereClauseConstraints` stored in the frame's table, and
`target_list` aliases one of its lists ON PURPOSE: the push is how
`add_where_clause_constraint_to_env` (`src/env.yo:3359`) and
`add_where_clause_constraint_for_type_application` (`src/env.yo:3578`) record a
constraint. After the rewrite the push lands in a copy that dies at the end
of the function.

## Reproducer

```yo
//! A copy chosen by `if` and written afterwards: `target` aliases one of the
//! entry's lists on purpose, so the push lands in the entry.
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Entry :: ref(
  struct(
    yes : ArrayList(i32),
    no : ArrayList(i32)
  )
);
add :: (fn(entries : &ArrayList(Entry), negated : bool, v : i32) -> unit)({
  entry := match(
    entries.get(usize(0)),
    .Some(existing) => existing,
    .None => Entry(yes : ArrayList(i32).new(), no : ArrayList(i32).new())
  );
  mut(target) := if(negated, entry.no, entry.yes);
  target.push(v);
});
main :: (fn() -> unit)({
  mut(entries) := ArrayList(Entry).new();
  entries.push(Entry(yes : ArrayList(i32).new(), no : ArrayList(i32).new()));
  add(&entries, false, i32(1));
  add(&entries, true, i32(2));
  e := match(entries.get(usize(0)), .Some(x) => x, .None => Entry(yes : ArrayList(i32).new(), no : ArrayList(i32).new()));
  println(`${e.yes.len().to_string()} ${e.no.len().to_string()}`);
});
export(main);
```

As written it prints `1 1`. `yo fix main.yo --migrate explicit-copy` (the
`fix/explicit-copy-migration-defects` tree binary, 3cb59050d) reports
`inserted 2 \`.clone()\` call(s); 0 site(s) left as written` and rewrites the
`if` to `if(negated, entry.no.clone(), entry.yes.clone())`; the rewritten
program prints `0 0`. With `entry` a `&Entry` PARAMETER instead of a local,
the two sites are listed (as "returned from a `&` parameter"), so only the
local-rooted shape is lost.

## Root cause

A binding's destination declaration reaches the copy only when the copied
place IS the right-hand side: `evaluate_initialization_assignment`
(`src/evaluator/exprs/initialization_assignment.yo:1298`) passes
`copy_dest_decl` to the dup it marks on the RHS. When the RHS is an `if`,
`cond` or `match`, the dup is marked on each arm's tail (the `return`
copy path), which carries no destination, so `_copy_written_after`
(`src/main.yo:2828`) checks only the source's writes and never sees
`target.push`.

## Fix

Fixed 2026-10-22 on `fix/explicit-copy-s1-tool-defects`, as the doc
proposed. A binding's or an assignment's destination now reaches the copies
made at the result positions of its right-hand side.

- `set_expr_as_needs_to_call_dup` (`src/evaluator/utils.yo`) is where every
  store that carries a `copy_dest_decl` arrives: a binding, an assignment, a
  capture-list entry. When the migration runs, it calls
  `record_copy_tail_dests` first, before any early return. A temporary
  holding a conditional's result is an owning temp and returns early, which
  is why the destination never reached the arms before.
- `record_copy_tail_dests` walks the right-hand side's result positions: a
  block's tail and each `cond`/`match` arm's body, nested. An `if` is a
  `cond` after the parser's desugaring. For each leaf it records
  (destination key, leaf's leftmost token position).
- `_run_migrate_explicit_copy` (`src/main.yo`) indexes those records by
  position. `_tail_dest_written_after` judges a site at such a position
  against each of its destinations exactly as `_copy_written_after` judges
  `dst_decl`. A written destination lists the site as "the copy is written
  afterwards".

A `return(...)` inside an arm leaves the function and is not a result
position of the right-hand side, so it is not walked. A conditional whose
binding is never written keeps its arm copies cloned.

Repro (`issues/repros/2026-10-22-explicit-copy-migration-clones-a-conditional-arm-whose-binding-is-written-afterwards.yo`):

| | output of `yo fix main.yo --migrate explicit-copy` | migrated program prints |
| --- | --- | --- |
| before (3cb59050d) | `inserted 2`, `if(negated, entry.no.clone(), entry.yes.clone())` | `0 0` |
| after | `inserted 0`, 2 sites listed as written afterwards, file unchanged | `1 1` |

## Test

`tests/cli-cases/fix-migrate-explicit-copy-conditional-arm` runs the
reproducer's `if` shape, a `match` whose arm is a block ending in a nested
`if`, and a conditional binding that is never written. A trailing
`build run` runs the migrated program. Its goldens expect the five `target`
arm copies listed, the two `seen` copies cloned (`inserted 2`), and `2 2 2`.
With the pre-fix binary the case is GOLDEN-DIFF: it inserts 7 and prints
`0 0 0`.

The 89 `return:` insertions of the 2026-10-22 regeneration
(`plans/handover/VBD_B1_EXPLICIT_COPY_LISTING_2026-10-22.md` lists only the
left-as-written sites; the insertions are the branch's diff) are arm or
function tails, and each is suspect until the guard covers them.
