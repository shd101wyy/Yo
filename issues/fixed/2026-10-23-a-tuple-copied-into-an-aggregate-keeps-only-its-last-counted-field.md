# A tuple copied into an aggregate keeps only its last counted field

**Severity:** S1 — a named tuple (or array) holding refcounted fields, copied into a tuple or array literal, into a closure, as a `recur` argument or out of a `cond` arm block, is stored or passed as its LAST counted field alone: the other fields read as zero (a segfault), the copy leaks or is released early (heap-use-after-free), or the C compiler rejects the program

**Status:** fixed (2026-10-23, `fix/s1-rc-depth-cap`). Pre-existing: the
v0.2.68 seed and develop `ef153b749` behave the same. Found by the review of
`issues/fixed/yo-self-rc-depth-cap-skips-deep-teardown.md` while probing
nested tuples. The same mechanism as
`issues/fixed/2026-10-20-ptr-write-of-an-rc-element-array-emits-invalid-c.md`
and `issues/fixed/2026-10-21-return-of-an-rc-element-array-emits-invalid-c.md`,
at the adoption sites those two fixes did not reach.

## Reproducer

```yo
{ println } :: import("std/fmt");
(mut(g_drops) : i32) = i32(0);
Tracked :: ref(struct(v : i32));
impl(
  Tracked,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_drops = (g_drops + i32(1));
    })
  )
);
main :: (fn() -> unit)({
  {
    x1 := (Tracked(v : i32(1)), Tracked(v : i32(2)));
    x2 := (x1, i32(0));
    println(`${x2.0.0.v.to_string()} ${x2.0.1.v.to_string()}`);
  };
  d := g_drops;
  println(`drops=${d.to_string()}`);
});
export(main);
```

Before the fix: exit 139 (`x2.0.1` is NULL). Without the `println` inside the
block, `drops=1` instead of 2, and with `x1 := (x0, x0)` over one named cell,
`drops=0` and LSan reports the cell leaked.

| site                                  | before the fix                                   |
| ------------------------------------- | ------------------------------------------------ |
| tuple literal element `(x1, 0)`       | wrong value (other fields zero), leak            |
| array literal element `[x1, x1]`      | wrong value, ASan SEGV                           |
| implicit closure capture `() => x1.0` | the capture is never retained: heap-use-after-free |
| `recur(x1, …)`                        | C compile error (pointer passed for the tuple)   |
| `cond(c => { …; x1 }, …)`             | C compile error (pointer assigned to the tuple)  |

## Root cause

`evaluate_dup` (`src/evaluator/builtins/dup.yo`) lowers the copy of a tuple or
an `Array(T, N)` with counted fields ELEMENT-WISE:
`___dup(x1)` becomes `begin(__yo_dup_tuple_element(x1, 0), __yo_dup_tuple_element(x1, 1))`.
That retains the fields of `x1` in place, and the begin's result temp is the
LAST field's. Several codegen sites that store or pass a copy took the dup's
result temp as the copy:

- the tuple literal (`src/codegen/exprs/tuple_fn.yo`) and the array literal
  (`src/codegen/exprs/array_fns.yo`) put that temp where the whole tuple
  belongs. C's brace elision accepts `{ ._0 = <ptr>, ._1 = 0 }` for a nested
  tuple member, so the tuple-literal case compiled silently, with the first
  field holding the last field's pointer and the rest zero;
- `recur` (`src/codegen/exprs/recur.yo`), the `cond` final-expression path
  (`src/codegen/exprs/cond.yo`), `dyn(...)` (`src/codegen/exprs/dyn.yo`) and
  the Index-trait argument path (`generate_arg_code_with_deferred_dups`,
  `src/codegen/exprs/drop_dup.yo`) did the same;
- the closure constructor (`src/codegen/exprs/closures.yo`) matched an
  implicit capture's dup only in its `___dup(name)` form, so the element-wise
  form was never emitted and the capture took no reference.

`emit_deferred_dup_or_code`, the inline-call argument path and both `return`
paths already refused a result temp whose type differs from the value's.

## Fix

`element_wise_dup_target` (`src/codegen/utils/index.yo`) recognizes the
element-wise form and names the variable it retains. Each site above emits
the dup and then reads that variable itself, which the dup has already
retained; the closure constructor emits the element-wise dup as a statement
and reads the captured variable. An `io.async` capture never adopted the
temp: its retain lines cover an unmatched capture.

## Tests

`tests/rc.test.yo`, the seven tuple-copy cases after the depth-cap block:
tuple literal, one cell twice, array literal, `recur`, closure capture, a
closure capturing a nested tuple and an array, and a `cond` arm block. Each
fails before the fix (two batches fail to compile; the others crash or count
the wrong drops) and passes with it. An `io.async` body capturing a tuple was
probed too: it passed before and after.
