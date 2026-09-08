# `textDocument/rename` rewrites every identifier with the same spelling — struct fields, labels and member accesses included

**Status:** FIXED 2026-09-08. Found 2026-09-08 during the LSP audit against
`origin/develop` (44f1370c4), reproduced at runtime. **Severity: destructive** —
the client applies the WorkspaceEdit and the program no longer compiles.

## Reproducer

```rust
Point :: struct(x : i32, y : i32);
main :: (fn() -> unit)({
  x := i32(5);
  p := Point(x : x, y : i32(2));
  q := p.x;
  _z := (q + x);
  ()
});
export(main);
```

`textDocument/rename` at the local `x` (line 2, col 2) with `newName: "xx"`
returned six edits: the local's declaration and its two uses (correct), plus
the struct FIELD declaration `x` on line 0, the LABEL `x :` in `Point(x : x)`
and the MEMBER `x` in `p.x`. Applying them yields `struct(xx : i32, …)`,
`Point(xx : xx, …)`, `p.xx` — the field was renamed by accident, and any other
file using `Point.x` is now broken. `textDocument/references` listed the same
six.

## Root cause

`src/lsp/rename.yo` and `src/lsp/references.yo` walked the AST for Atom tokens
whose `value` equals the target's spelling — a port of the attic's
by-name matching — with no notion of which binding an atom refers to and no
notion of atoms that are not variable references at all.

## Fix

`references.yo`'s `collect_symbol_occurrences` (shared by rename) resolves the
target atom through its ExprInfo env to a variable and uses that variable's
declaration token as the identity; every same-named atom is resolved the same
way and kept only when it names the same declaration. Kept BY NAME: atoms the
evaluator never reached (a `generic(...)` body is deferred until a call
specializes it) and every atom when the target itself cannot be resolved.
Member names and labels (hover.yo `classify_atom_roles`: the name after a `.`,
the name before a `:` in any call that is not `fn`/`unsafe_fn`/`ctl`/`Fn`/
`generic`/`given`/`=`/`:=`/`?=`) are never occurrences; a cursor ON one
answers no rename at all.

## Verification

`tests/cli-cases/lsp-rename-identity`: renaming the local `x` yields exactly
its declaration and three uses; the field declaration, the label and `p.x` are
untouched; rename at the label and at the member answer `null`. The
`lsp-handshake` and `lsp-position-encoding-*` goldens pin the same for
`add_one`.
