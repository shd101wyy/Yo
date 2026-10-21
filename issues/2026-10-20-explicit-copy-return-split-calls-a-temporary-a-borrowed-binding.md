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

The same misreading hits a `match` scrutinee read through a dereference of
a call's result (found 2026-10-21 while re-verifying the guard's dereference
stop; the v0.2.67 seed prints the same line):

```yo ignore
Shelf :: struct(h : Rc(Holder));
grab :: (fn(s : &Shelf) -> Rc(Holder))(s.h);
b := match(grab(&s).*.maybe, .Some(z) => z, .None => String.new());
```

```text
fix: rm.yo:8:14: `((grab(&(s)).(*)).maybe)` is returned from a borrowed binding, so a caller may write through it; return a projection (`-> &T`) or spell the copy (`.clone()`) by hand
```

The scrutinee copy is real (the pointee lives on in `s.h`) and is listed,
so no wrong code results; only the reason is wrong. The binding `z` is a
move out of that copied temporary, which the dying-temporary guard lists
correctly.

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
