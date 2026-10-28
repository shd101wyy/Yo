# `yo fix --migrate rc-clone` misses a nested closure's capture of an enclosing closure's capture

**Severity:** S3: the migration leaves a copy that decision 17 rejects, so the
migrated file needs a hand edit before it type-checks. The rule itself is
right; only the repair tool misses the site.

> Found 2026-10-28 by the V2c sweep of `tests/` (`tests/async_await.test.yo`,
> "Test awaited condition really suspends (spawned task interleaves)": an
> `io.async` body that spawns a second `io.async` reading the same `Rc`).

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
{ RefCell } :: import("std/sync/refcell");
main :: (fn() -> unit)({
  order := rc(RefCell(i32).new(0));
  (outer : Impl(Fn() -> i32)) = (() => {
    (inner : Impl(Fn() -> i32)) = (() => {
      order.with_mut(cur => {
        cur = (cur + i32(1));
      });
      i32(0)
    });
    _x := inner();
    order.with(cur => cur) // error[E0901]: use of moved value: `order`
  });
  println(`${outer()}`);
});
export(main);
```

`yo fix main.yo --migrate rc-clone` inserts nothing, and
`YO_AUDIT_IMPLICIT_COPY=1` prints no copy for `inner`'s capture. With one
level of closure (`noise := io.async(...)` directly in `main`) the tool spells
`{ order : Rc.clone(order) }` as it should.

## Repair by hand

Give the inner closure the capture list the rule asks for:
`(inner : Impl(Fn() -> i32)) = ({ order : Rc.clone(order) }() => { … })`.

## Where to look

`generate_captured_variable_dup_expressions` (`src/evaluator/utils/closure.yo`)
records a capture's copy through `audit_record_implicit_copy`; for a closure
inside another closure's body the record is never made, so the capture of the
enclosing closure's own capture is not seen as a copy.
