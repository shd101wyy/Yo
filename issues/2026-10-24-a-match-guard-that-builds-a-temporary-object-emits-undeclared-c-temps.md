# A `match` guard that builds a temporary object emits undeclared C temps

**Severity:** S2 — a valid program fails at the C compiler: a guard such as
`(n && (rc(n).* > i32(1)))` refers to C temporaries that are never declared.
Binding the object before the `match` avoids it.

**Status:** OPEN — found 2026-10-24 by the adversarial review of
`feat/yo-cell-primitive-gen-a` (the `__yo_cell` primitive). It predates that
branch: the develop binary (v0.2.68 tree, 54e94f11e) reproduces it with `rc`
and with a `ref` object constructor, and the new cell type fails the same way.
Not fixed.

## Reproducer

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  k := i32(3);
  r := match(
    k,
    (n && (rc(n).* > i32(1))) => i32(2),
    _ => i32(3)
  );
  println(`r=${r}`);
});
export(main);
```

`yo compile p.yo -o p`:

```
p.c:2293:24: error: use of undeclared identifier '_file____tmp__temp_112134577611135368880'
```

## Where to look

The guard's object constructor is hoisted into a temp (the payload temp and
the deferred drop of the cell), but the guard is emitted inside the arm test,
where the hoisted declaration is not in scope or was never emitted. Compare
the guard emission in the pattern compiler
(`src/evaluator/exprs/pattern_compile.yo`, `src/codegen/exprs/match*.yo`) with
how an `if` condition declares the temps its expression hoists.
