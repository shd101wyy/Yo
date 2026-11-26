# A rest pattern `..` outside a match arm's variant, tuple or struct pattern is a binding or the block error

**Severity:** S3 — `(x, ..) := t` compiles and binds a variable named `..` (only an "unused variable `..`" warning says so), and `.V({ w, .. })`, `{ x : 0, .. }` (a curly pattern) and `{ a, .. } := s` fail with E0007 "`{ ... }` is a block, and a block separates statements with `;`", which says nothing about patterns; neither suggests the fix.

- Filed: 2026-11-26 (lane `v81-bare-variant`). Under VERDICTS-88 `..` stands for a variant's whole payload and is written alone (`.V(..)`); the lane made every other `..` in a match arm's variant, tuple and named struct pattern a coded E0609 with a repair. These two sites never reach the pattern compiler (`src/evaluator/exprs/pattern-compile.yo`), so they keep their old behavior.

## Reproducer

`tmp/fixme.yo`, a tuple destructuring binding:

```yo
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  t := (i32(1), i32(2), i32(3));
  (x, ..) := t;
  println(`${x}`);
});
export(main);
```

```text
warning: unused variable `..`
  --> tmp/fixme.yo:4:7
  |
4 |   (x, ..) := t;
  |       ^^
help: prefix the name with `_` to silence this warning
```

It compiles and prints `1`: `..` binds the second element.

A curly field list, in a pattern or on a binding's left side:

```yo ignore
Shape :: enum(Circle(r : i32), Rect(w : i32, h : i32));
width :: (fn(s : &Shape) -> i32)(match(s, .Rect({ w, .. }) => w.*, _ => i32(0)));
export(width);
```

```text
error[E0007]: `{ ... }` is a block, and a block separates statements with `;`. A record literal is written `.{ a, b }` and names its fields
  --> tmp/fixme.yo:2:52
```

`match(p, { x : 0, .. } => …)` and `{ a, .. } := s` report the same.

## Root cause

- Destructuring binding: the tuple branch of `src/evaluator/exprs/destructuring-assignment.yo` takes every atom of `(a, b, …)` as a name, and `..` lexes as an operator atom, so it is bound like an identifier.
- Curly group: `parse_curly_bracket_expr` (`src/parser.yo`, the comma-group branch) reads a comma-separated `{ … }` as a field list only when every item passes `is_valid_struct_field_arg`. The atom `..` is not a field, so the group falls to the block reading and throws E0007 before any pattern or binder context is known.

## Fix direction

Reject `..` at both sites with E0609 ("`..` stands for a variant's whole payload and is written alone, as `.V(..)`"), as the match-pattern compiler does (VERDICTS-88 §8.2 keeps them rejected; accepting them later would be additive): in a tuple binder the help writes `_` for each element it stands for; in a curly field list the help and the repair delete `, ..`, since a field list names only the fields it needs. Tests: a `comptime_expect_error` case for the binder beside the `..` cases in `tests/match-bind-nothing.test.yo`, and a cli-case for the parse error.
