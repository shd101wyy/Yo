# The explicit-copy return split calls an index of a temporary "a borrowed binding"

**Severity:** S3. A listing gives misleading advice: `yo fix --migrate explicit-copy` says a returned element of a temporary is "returned from a borrowed binding" and suggests a projection (`-> &T`), but a projection there would borrow a temporary that dies when the function returns.

**Status:** FIXED 2026-10-22 on `fix/explicit-copy-migration-defects`. Filed 2026-10-20 while landing the dying-temporary guard
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

## Fix

Both walkers now classify a step by its ExprInfo (`src/evaluator/utils.yo`):

- `_ic_owning_temp` reads whether an expression's ExprInfo names a temporary,
  and whether that temporary owns its value (a call's owned result) or not
  (a projection).
- `_ic_place_root_borrow` walks with `_ic_place_root_var(..., stop_ctx)`,
  which stops with no root at a call whose ExprInfo names an owning
  temporary. `make()` and `grab(&s)` are rooted in no variable, so neither
  is "a borrowed binding". A borrow a method returns (`p.get()`, a
  non-owning temporary) still walks on to its receiver. The write recorder
  keeps the old walk: a write rooted at a call's callee names no copy site's
  variable.
- `_ic_dying_temp_source` follows an index step as well as a `.` step. An
  index is a non-infix call whose ExprInfo carries `index_trait_ptr_type`,
  and its callee is the container. A method call is not followed: a method
  returning `&T` may point into storage the temporary does not own. A
  container that is an owning temporary makes the copy "an element of a
  temporary" (or "a field of a temporary") that dies after the copy.

The first reproducer is now listed as an element of a dying temporary. The
second, the scrutinee `grab(&s).*.maybe`, is a genuine copy of an owned
place and gets `.clone()`; the binding `z` over the cloned scrutinee is a
single-use move, judged at its arm's end.

## Test

`tests/cli-cases/fix-migrate-explicit-copy-temp-root`, with both
reproducers. Its goldens expect `first_tag`'s `make().tags(usize(0))` listed
as an element of a temporary that dies after the copy, and the scrutinee
rewritten to `grab(&s).*.maybe.clone()`. The trailing `check` proves the
result evaluates. The rewritten program prints `t y m` under
`--sanitize address`.
