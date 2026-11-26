# A rest pattern `..` in a curly field list is reported as the block error E0007

**Severity:** S3 — `.V({ w, .. })` and `{ x : 0, .. }` in a pattern fail with E0007 "`{ ... }` is a block, and a block separates statements with `;`", which says nothing about patterns; the fix (delete the `..`, a field list already names only the fields it needs) is not suggested.

- Filed: 2026-11-26 (lane `v81-bare-variant`). That lane made `..` in a variant, tuple or named struct pattern a coded E0609 with a repair (`.V(..)` is the bare `.V`); the curly form never reaches the pattern compiler, so it keeps the parser's message.

## Reproducer

`tmp/fixme.yo`:

```yo ignore
Shape :: enum(Circle(r : i32), Rect(w : i32, h : i32));
width :: (fn(s : &Shape) -> i32)(match(s, .Rect({ w, .. }) => w.*, _ => i32(0)));
export(width);
```

```text
error[E0007]: `{ ... }` is a block, and a block separates statements with `;`. A record literal is written `.{ a, b }` and names its fields
  --> tmp/fixme.yo:2:52
```

The anonymous struct pattern `match(p, { x : 0, .. } => …)` reports the same.

## Root cause

`parse_curly_bracket_expr` (`src/parser.yo`, the comma-group branch) treats a comma-separated `{ … }` as a field list only when every item passes `is_valid_struct_field_arg`. The operator atom `..` is not a field, so the group falls to the block reading and throws E0007 before any pattern context is known.

## Fix direction

In that branch, when an item is the atom `..`, throw E0609 ("`..` is not a pattern: Yo has no rest pattern") with the help "delete the `..`: a field list names only the fields it needs" and the repair deleting `, ..`, as `src/evaluator/exprs/pattern-compile.yo` does for the named struct pattern. A test in `tests/match-bind-nothing.test.yo` (beside the `..` cases) cannot hold a parse error; add a cli-case under `tests/cli-cases/`.
