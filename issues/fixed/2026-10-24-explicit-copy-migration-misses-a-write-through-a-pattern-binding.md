# `yo fix --migrate explicit-copy` misses a write through a pattern binding

**Severity:** S1. The rewrite changes what the program computes: a value copied out of a variable and then pushed to through a `match` or destructuring binding of the same variable stops sharing the push, so a later read of the copy sees a different length.

> Found 2026-10-24 by the review of B4-0a
> (`plans/handover/VBD_LOOKAHEAD_2026-10-23.md` §4.1). It is the same class
> as
> `issues/fixed/2026-10-24-explicit-copy-migration-misses-a-write-through-a-mut-capture-list-borrow.md`:
> a second name for the variable's buffer that the guard did not connect to
> the variable.

## Symptom

```yo
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
VEntry :: struct(yes : ArrayList(i32), opt : Option(ArrayList(i32)));
opt_arm :: (fn(entry : &VEntry) -> usize)({
  x := entry.opt;
  match(entry.opt, .Some(v) => v.push(i32(1)), .None => ());
  match(x, .Some(v) => v.len(), .None => usize(99))
});
main :: (fn() -> unit)({
  a := VEntry(yes : ArrayList(i32).new(), opt : .Some(ArrayList(i32).new()));
  println(opt_arm(&a));
});
export(main);
```

The program prints `1`. On the B4-0a branch (`f03b1b80a`)
`yo fix main.yo --migrate explicit-copy` wrote `x := entry.opt.clone();`,
after which it prints `0`. A `&mut` scrutinee (`match(&mut entry.opt, …)`),
a record pattern (`match(&mut entry, { yes } => yes.push(…))`) and a `:=`
destructuring (`{ yes } := entry; yes.push(…)`) behave the same. Develop
listed the parameter cases only because every parameter shared one key; a
local was cloned there too.

## Root cause

A pattern binding is a new variable, declared at its pattern
(`evaluate_match`, `handle_member_destructuring`). A write through it is
keyed at that declaration, and nothing connected the binding to the
scrutinee's variable, so the written-after guard (`src/main.yo`) did not
count the push as a write of `entry`.

## Fix

While the migration runs, a binding records a flow from the variable its
scrutinee or right-hand side is a place of (`_ic_binding_source_decl`) into
the binding (`record_copy_flow_decl`): in `evaluate_match`
(`src/evaluator/exprs/match.yo`) for each arm's bindings, and in
`handle_member_destructuring` (`src/evaluator/exprs/destructuring_assignment.yo`)
for each bound name. A `&mut` match's binding is the scrutinee's place, so
its flow is recorded both ways. The guard already follows flows after the
copy, so the push through the binding is a write of `entry`. A call's own
result is a place of no variable, and neither is a variable of another
module: a `for` expansion binds the user's element from the template's
iterator, whose `next()` writes advance it and touch no element.

Test: `tests/cli-cases/fix-migrate-explicit-copy-pattern-binding`. A by-value match, a `&mut`
match, a record pattern and a `:=` destructuring are listed. A binding that
is only read leaves its copy cloned.
