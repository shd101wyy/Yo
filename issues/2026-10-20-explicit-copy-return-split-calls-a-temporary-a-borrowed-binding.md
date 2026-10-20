# The explicit-copy return split calls an index of a temporary "a borrowed binding"

**Severity:** S3. A listing gives misleading advice: `yo fix --migrate explicit-copy` says a returned element of a temporary is "returned from a borrowed binding" and suggests a projection (`-> &T`), but a projection there would borrow a temporary that dies when the function returns.

**Status:** OPEN. Filed 2026-10-20 while landing the dying-temporary guard
(`issues/fixed/2026-10-20-explicit-copy-migration-clones-a-copy-out-of-a-dying-temporary.md`),
which covers the `.` field form (`make().name`) but not an index.

## Reproducer

```yo ignore
Holder :: struct(name : String, tags : ArrayList(String));
make :: (fn() -> Holder)(Holder(name : String.from("m"), tags : ArrayList(String).new()));
first_tag :: (fn() -> String)(make().tags(usize(0)));
```

`yo fix main.yo --migrate explicit-copy --dry-run` with the v0.2.66 tree prints:

```text
fix: main.yo:7:31: `(make().tags)(usize(0))` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
```

## Root cause

`_ic_place_root_var` (`src/evaluator/utils.yo`) walks a non-infix call to its
callee, which is right for an index on a named place (`xs(i)` roots at `xs`)
and wrong for a call: `make()` walks to the function binding `make`, which is
not owned, so `_ic_place_root_borrow` reports "a borrowed binding". The
dying-temporary guard (`_ic_dying_temp_source`) follows only `.` receivers,
because an index and a method call share one AST shape (a non-infix call
whose callee may be a `.` node), and a method that returns `&T` into a dying
temporary is a genuine copy, not a move.

## Recommendation

Classify each step of the walk by its ExprInfo instead of its AST shape: an
index result is a non-owning temporary whose callee is a value, a method
call's callee is a function value. Then stop at an owning temporary (dying)
in both walkers. Add the reproducer as a line of
`tests/cli-cases/fix-migrate-explicit-copy-dying-temp` with the fix.
