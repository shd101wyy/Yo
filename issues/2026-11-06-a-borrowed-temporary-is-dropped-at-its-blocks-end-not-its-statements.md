# A borrowed temporary is dropped at its block's end, not its statement's

**Severity:** S2: a temporary's `Drop` runs later than documented. `show(&make())`
keeps `make()`'s value alive, with its resources and its `Drop` side effects,
until the enclosing block ends. The values-by-default plan gives it Rust's
temporary lifetime: to the end of the enclosing statement.

> Found 2026-11-06 while writing VERDICTS-25's `Drop` holder test for N1e-2b
> PR 2b. Reproduced on develop `935c6ee69` with a plain struct, so the
> behavior is not specific to references or origins.

## Reproducer

```yo
{ assert } :: import("std/assert");
(mut(g_n) : i32) = i32(0);
Plain :: struct(n : i32);
impl(
  Plain,
  Drop(
    drop : (fn(self : &mut Self) -> unit)({
      g_n = (g_n + i32(1));
    })
  )
);
rd :: (fn(p : &Plain) -> i32)(p.n);
main :: (fn() -> unit)({
  assert(rd(&Plain(n : i32(3))) == i32(3), "read");
  assert(g_n == i32(1), "the temporary is dropped at the statement's end");
  ()
});
export(main);
```

The second assert fails. Wrapping the first statement in its own block
(`{ _a := rd(&Plain(n : i32(3))); };`) makes it pass: the temporary is
dropped at the block's end.

## Expected

`plans/VALUES_BY_DEFAULT.md` ("`&temp` is allowed"): "it borrows the
temporary, which lives to the end of the enclosing statement or `match`
(Rust's temporary lifetime)".

## Root cause

Not yet investigated. A call argument's temporary is registered with the
enclosing block's scope-end drops, not with the statement's.

## Fix

Drop a borrowed temporary after the statement that created it, unless a
binding's lifetime extension applies. The temporary-holder test in
`tests/origins/reference_read_rule.test.yo` then asserts the drop at the
statement's end, as VERDICTS-25 asks.
