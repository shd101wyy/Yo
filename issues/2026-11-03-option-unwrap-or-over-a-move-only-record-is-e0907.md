# `Option(P).unwrap_or(v)` over a move-only record is E0907 inside the prelude

**Severity:** S2. `opt.unwrap_or(default)` fails to compile when the element is a record that is move-only only through its fields: a struct holding a `String`, an `ArrayList` or a `Drop` type, with no `Drop` of its own. The user gets E0907 at their call, pointing into the prelude's `unwrap_or`, and the only way out is to write the `match` by hand. Since B8 every struct holding a `String` or an `ArrayList` is such a record, so a very common pattern stops compiling.

Found 2026-11-03 by B8 while writing a reproducer for another bug.

## Reproducer

```yo
{ println } :: import("std/fmt");
M :: struct(x : i32);
impl(M, Drop(drop : (fn(self : &mut Self) -> unit)(())));
P :: struct(m : M);
main :: (fn() -> unit)({
  o := Option(P).None;
  q := o.unwrap_or(P(m : M(x : i32(1))));
  println(&q.m.x);
});
export(main);
```

```
error[E0907]: Variable "or_value" is moved in some arms but not in others, so where they meet it would be dropped on some paths only:
     --> uo.yo:7:9
```

The develop compiler (`ce827ae52`) gives the same error, so this is older than B8. On the B8 tree the same happens for `P :: struct(name : String, xs : ArrayList(String))` with `derive(P, Clone)`.

`Option(String).unwrap_or(String.from(…))` compiles, and it runs ASan-clean, leak checking included, when the option is `.Some`. So a nominal `Drop` element is dropped correctly in the arm that keeps it. Only the field-wise move-only record is refused.

## Where

`unwrap_or` is `match(self, .Some(value) => value, .None => or_value)` (`std/prelude.yo`). The `.Some` arm keeps `or_value`, so the join must drop it there.

That is case 3 of the arm-join analysis in `src/evaluator/utils.yo`, around line 6240: `_drop_in_arms_that_keep` decides whether the elaboration can append the drop. It returns `false` for this record, so E0907 stands.

Candidates for the refusal:
- the generic `SomeT` early-out, which refuses a `T` with no resolution and no required bounds;
- a drop the elaborator cannot spell for a record whose drop is field-wise rather than its own `Drop`.

The fix is to make the elaboration append the field-wise drop, as it does for a nominal `Drop` type.

## Test

When fixed, add the reproducer above as a test in `tests/move_only.test.yo`, together with the B8 `String`-record variant. The test checks that it compiles, prints `1`, and is leak-clean when the option is `.Some`.
