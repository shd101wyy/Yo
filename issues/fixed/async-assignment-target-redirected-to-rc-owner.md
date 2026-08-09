# An assignment inside an async state machine wrote to the WRONG variable

**Status: FIXED** 2026-08-09 (`src/codegen/exprs/assignment.ts`). **Silent** — the
arm ran, the await returned the right value, and the target kept its old one.

Reproducer:
[`repros/async-match-binding-passed-to-capturing-future.yo`](repros/async-match-binding-passed-to-capturing-future.yo)

```rust
out := String.from("none");
match(
  lookup(want),
  .None => (),
  .Some(item) => {
    d := io.await(describe(item, io), io);
    out = d;                      // <- assigns to `d`, not `out`
  }
);
return(out)
```

```
$ ./yo-cli compile … && ./a.out      # BEFORE
none
none                                 # first line should be `thing:7`
```

Instrumenting the arm showed it running and the await returning `thing:7`
correctly — only the write to `out` went astray.

## Root cause

The emitted C assigns to `d`:

```c
sm->var_…_temp_40809 = sm->var_…_d;     // "Save old value for deferred drop"
__yo_struct_… d = sm->var_…_d;
__yo_struct_… _temp_40808 = ___dup(sm->var_…_d);
sm->var_…_d = _temp_40808;              // the target should be var_…_out
```

`generateAssignment` produces the target with `generateExpr(lhs)`, and
`generateAtom` resolves a variable through `isOwningTheSameRcValueAs`:

```ts
let varId = variable.isOwningTheSameRcValueAs
  ? variable.isOwningTheSameRcValueAs.id
  : variable.id;
```

That redirection is right for a READ — a variable borrowing another's Rc value
must read the owner's field — and wrong for a WRITE. `out = d` makes the
evaluator record that `out` now shares `d`'s Rc value, so by the time codegen
resolves the LHS, `out` points at `d`, and the assignment lands on `d`'s field.

Outside a state machine this is invisible: the C name is the variable's own
identifier either way. Inside one, the field is chosen by ID.

## Fix

Resolve an assignment target by its OWN id, honouring field aliases and outer
captures exactly as `generateAtom` does otherwise
(`resolveAssignmentTargetField`), and fall back to `generateExpr` for
non-atom targets (field/index assignments):

```ts
const lhsCode =
  resolveAssignmentTargetField(lhs, context as FunctionGenerationContext) ??
  generateExpr(lhs, indent, context);
```

## Worth remembering

`isOwningTheSameRcValueAs` is a READ-side redirection. Any codegen path that
needs the variable's own storage — assignment targets, drops, `memset` of a
field — must not go through `generateAtom` to get it.
