# A temporary object built in a `while` condition leaks once per evaluation

**Severity:** S1 — an unbounded leak in generated code: a `ref` object or an
`Rc` cell built and read inside a `while` condition is never released, one
allocation per evaluation of the condition, so a long loop leaks without bound.

**Status:** OPEN — found 2026-10-24 by the adversarial review of
`feat/yo-cell-primitive-gen-a` (the `__yo_cell` primitive). It predates that
branch: the develop binary (v0.2.68 tree, 54e94f11e) reproduces it, and the new
cell type leaks the same way because it shares the `ref` object lowering. Not
fixed.

## Reproducer

```yo
{ println } :: import("std/fmt");
RI :: ref(struct(v : i32));
main :: (fn() -> unit)({
  mut(j) := i32(0);
  while(RI(v : j).v < i32(3), {
    j = (j + i32(1));
  });
  println(`${j}`);
});
export(main);
```

`yo compile p.yo --sanitize address --allocator system -o p && ./p`:

```
SUMMARY: AddressSanitizer: 48 byte(s) leaked in 4 allocation(s).
```

Four allocations: the condition runs four times (`j` = 0, 1, 2, 3). The same
loop over `rc(k).* < i32(3)` leaks the same 48 bytes in 4 allocations. The
same temporary in an `if` condition or a `let` initializer is released.

## Where to look

The condition's temporaries are dropped by the scope that encloses the
`while`, not after each evaluation of the condition. A condition is
re-evaluated per iteration, so its deferred drops must run after each
evaluation (on both the continue and the exit edge), the way a loop body's
temporaries are dropped per iteration. Start at the `while` lowering in
`src/codegen/exprs/` and the deferred-drop bookkeeping of the condition
expression.
