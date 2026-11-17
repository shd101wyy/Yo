# A second rejected `Box.new` of one closure type inside `comptime_expect_error` reports "No method `new`"

**Severity:** S3: no program is accepted or rejected wrongly. A negative test row gets the wrong error text, so a
test of a real rule fails or has to be written around the defect. Outside `comptime_expect_error` the first rejection
stops compilation, so the second instantiation never runs.

**Status:** OPEN. Found 2026-11-16 by the S3b-`Dyn` lane (decision 49 S3b). The deletion of the `dyn(v)` alias moved
`tests/closure_capture_list.test.yo`'s rows "every route into a `Dyn` keeps the value second-class" to
`dyn(Box.new(f))`, and the second row then failed. Reproduces on develop `223b188f4`.

## Reproducer

```yo
_keep :: (fn(sink(d) : Box(Dyn(Fn() -> i32))) -> i32)(d());
test("t", {
  w := i32(1);
  (f : Impl(Fn() -> i32)) = ({ &w }() => w.*);
  comptime_expect_error(_keep(dyn(Box.new(f))), "second-class");
  comptime_expect_error(_keep(dyn(Box.new(f))), "second-class");
});
```

The first row passes (E0909: the closure borrows `w`, so it cannot be the payload of the heap-stored `_cell`). The
second fails:

```text
error: comptime_expect_error: the expression raised an error, but not the expected one.
- Expected text: second-class
- Raised: No method "new" on recur_yo_id_10098515952513380462000000: the type has no field or method with that name.
```

Either row alone passes, and so does the pair with two distinct closures.

## Where to look

The first `Box.new(f)` instantiates `Box(V)` at the closure's capture struct and is abandoned when E0909 is raised
inside `comptime_expect_error`. Something keyed by that instantiation survives the rollback
(`src/evaluator/builtins/comptime_expect_error.yo` restores the env, the forcing stack and module globals, but no
type-instantiation cache). The second `Box.new(f)` then finds the in-progress placeholder (`recur_yo_id_…`, the
recursive-type stand-in) instead of the `Box` instance, and the static method lookup fails.

## Test

`tests/closure_capture_list.test.yo` keeps a second closure (`f2`) for the second boxing row, with a comment naming
this doc. The fix makes the reproducer above pass; the row can then go back to one closure.
