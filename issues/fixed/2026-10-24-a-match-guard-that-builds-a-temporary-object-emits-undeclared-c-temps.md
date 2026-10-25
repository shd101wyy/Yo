# A `match` guard that builds a temporary object emits undeclared C temps

**Severity:** S2 — a valid program fails at the C compiler: a guard such as
`(n && (rc(n).* > i32(1)))` refers to C temporaries that are never declared.
Binding the object before the `match` avoids it.

**Status:** FIXED 2026-10-25 (branch `fix/s1-closure-field-call-hoist`). Found 2026-10-24 by the adversarial review of
`feat/yo-cell-primitive-gen-a` (the `__yo_cell` primitive). It predates that
branch: the develop binary (v0.2.68 tree, 54e94f11e) reproduces it with `rc`
and with a `ref` object constructor, and the new cell type fails the same way.
A direct call's owned result used as a receiver in a guard fails the same way
(`(n && (mkt(n).peek() > i32(1)))`), and `fix/s1-closure-field-call-hoist`,
which gives a closure-field call's result a declared temp, extended it to
`(n && (h.mk(n).peek() > i32(1)))` and `(n && (h.ms(n).len() > usize(1)))`.

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

## Root cause

The evaluator gives a temporary the guard builds a name in the nearest
begin-block frame (`attach_temp_variable_to_expr` →
`add_variable_to_begin_block_frame`). The arm frame is no begin-block frame,
so the temp joined the enclosing block, and its release was that block's
scope-end drop. Codegen declares the temp where the guard is generated: inside
the arm's `{ … }` test block (`_gen_general_match`). The drop at the enclosing
block's end named a C identifier out of scope. A `cond` condition does not
have the problem: `evaluate_cond` evaluates a non-atom condition as a
one-expression block, so its temps get their own frame and their drops ride on
the condition node, which `_emit_cond_if_head` flushes right after the bool.

## Fix

`evaluate_match` (`src/evaluator/exprs/match.yo`) evaluates a non-atom guard
the same way (`_evaluate_guard_block`, `evaluate_begin_expression` with the
error returned as `evaluate_expression_guarded` returns it). The guard's temps
now live in the guard's own frame, and their drops ride on the guard node,
which `_gen_general_match` already flushes right after the guard's bool
("The guard's temps die here, on both paths"). The temp is released inside the
arm block, once per evaluation, whether the guard holds or fails.

## Test

`tests/match_guards.test.yo`: "a guard over an object it builds" (`rc(n).*`,
guard holds and fails) and "a guard's temporary receiver is released once on
either path" (a direct call, a `Dyn(Fn)` field call and a `String`-returning
field call as the receiver, four evaluations each, with a `Drop` counter).
Before the fix the file fails at the C compiler with the undeclared
identifiers on both the develop binary and the branch's previous head.
