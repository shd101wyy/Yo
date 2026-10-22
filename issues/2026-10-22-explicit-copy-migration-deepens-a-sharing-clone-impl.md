# `yo fix --migrate explicit-copy` deepens a `Clone` impl that shares its children on purpose

**Severity:** S1 — the rewrite changes what the program computes: the migrated compiler rejects valid std (`std/rand.yo:242`, `thread_local(mut(_tl_state))`), and a minimal program prints `0` instead of `1` after the migration.

> Found 2026-10-22 by the B1 regeneration (`feat/v2b-b1-regeneration`,
> plans/VALUES_BY_DEFAULT.md B1, "As-built 2026-10-22").

## Symptom

`AstExpr`'s hand-written `Clone` (`src/expr.yo:433`) is documented as
SHARE-on-recursion: a copy of a `FnCall` node bumps its `args` handle, so the
copy and the original are one tree. Evaluator code relies on that: an AST
rewrite through a clone lands in the original (`strip_mut_marker`,
`src/evaluator/utils.yo:2360`, "rewriting the tree in place (the argument list
is shared with it)", reached from `src/evaluator/exprs/assignment.yo:1326`
through `mut_name_pos.clone()`).

The migration rewrote the impl's own body:

```yo ignore
-        .FnCall(fid, ffunc, fargs, finfix, ftok) => AstExpr.FnCall(fid, ffunc, fargs, finfix, ftok.clone())
+        .FnCall(fid, ffunc, fargs, finfix, ftok) => AstExpr.FnCall(fid, ffunc, fargs.clone(), finfix, ftok.clone())
```

listed as `fix: src/expr.yo:440:80: field-store: \`fargs\` would become \`fargs.clone()\``.
`ArrayList(AstExpr).clone` clones each element through this same impl, so
every `AstExpr.clone` became a deep copy of the whole subtree, and the marker
strip ran on a copy. The stage-1 compiler built from the regenerated tree then
fails `check src/main.yo` of develop with

```text
error: "thread_local" takes the variable NAME: write "(thread_local(name) : T) = init;" or "thread_local(name) := init;".
    --> std/rand.yo:242:2
242 | (thread_local(mut(_tl_state)) : _RngState) = _RngState(state : u64(0), inc : u64(0));
```

## Reproducer

```yo
//! A `Clone` impl that shares its children on purpose: `Tree.clone` bumps
//! the `kids` handle, so a push through the copy is seen by the original.
{ ArrayList } :: import("std/collections/array_list");
{ println } :: import("std/fmt");
Tree :: ref(
  enum(
    Leaf(n : i32),
    Node(kids : ArrayList(Self))
  )
);
impl(
  Tree,
  Clone(
    clone : (fn(self : &Self) -> Self)(
      match(
        self,
        .Leaf(n) => Tree.Leaf(n),
        .Node(kids) => Tree.Node(kids)
      )
    )
  )
);
main :: (fn() -> unit)({
  t := Tree.Node(ArrayList(Tree).new());
  u := t.clone();
  match(
    u,
    .Node(ks) => {
      mut(list) := ks;
      list.push(Tree.Leaf(i32(1)));
    },
    .Leaf(_) => ()
  );
  n := match(t, .Node(ks) => ks.len(), .Leaf(_) => usize(0));
  println(`${n.to_string()}`);
});
export(main);
```

Compiled as written it prints `1`. `yo fix main.yo --migrate explicit-copy`
(the `fix/explicit-copy-migration-defects` tree binary, 3cb59050d) reports
`inserted 1 \`.clone()\` call(s); 0 site(s) left as written` and rewrites
`Tree.Node(kids)` to `Tree.Node(kids.clone())`; the rewritten program prints
`0`.

## Root cause

The migration's semantic guard is the written-after check
(`_copy_written_after`): a copy is left as written when its source or its
destination binding is written later in the same function. A `Clone` impl's
body is where a type DEFINES what a copy is; the write that makes the shared
buffer observable happens in a caller of `clone` (here `strip_mut_marker`,
two calls away), which no local check can see. Inside that body a field copy
of `self` is not an implicit copy the program happens to make. It is the
impl's chosen depth: `Pattern`'s impl (`src/pattern.yo:89`, "A deep copy")
wants the clone, `AstExpr`'s wants the share.

## Fix (proposed, not on this branch)

List, never rewrite, a copy inside the body of a `Clone` impl's `clone`
method: the hand edit picks the depth (an explicit `.clone()` for a deep
impl, an `Rc` share for a sharing one once the collections are values). The
test is the reproducer above as a
`tests/cli-cases/fix-migrate-explicit-copy-clone-impl` case: today it inserts
`kids.clone()`; fixed, it lists the site and the trailing run prints `1`.

## Measured effect on B1

Reverting only this insertion does not make the regeneration landable: the
diagnostic stage 1 without it still reaches the 12 GB cap on
`check src/main.yo` (plans/VALUES_BY_DEFAULT.md B1, "As-built 2026-10-22").
