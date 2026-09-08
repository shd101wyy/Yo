# Hover and go-to-definition on `p.x` resolve the member `x` to a same-named LOCAL `x`

**Status:** FIXED 2026-09-08. Found 2026-09-08 during the LSP audit against
`origin/develop` (44f1370c4), reproduced at runtime. **Severity: wrong-value**
— hover shows the wrong type, definition navigates to the wrong declaration.

## Reproducer

```rust
Point :: struct(x : bool, y : i32);
main :: (fn() -> unit)({
  x := i32(5);
  p := Point(x : (x > i32(0)), y : x);
  q := p.x;
  ()
});
```

- `textDocument/hover` on the `x` of `p.x` (line 4, col 9) answered
  `x : i32` — the local's type; the field is `bool`.
- `textDocument/definition` there answered the local's declaration
  (line 2, col 2) instead of nothing / the field.

## Root cause

`handle_hover` and `handle_definition` (`src/lsp/hover.yo`,
`src/lsp/definition.yo`) find the Atom under the cursor, read its ExprInfo, and
then "refine through the env": `get_variables_from_env(info.env, "x")` →
`_select_best_variable` — which for a MEMBER atom finds the local `x` in scope
and reports it. Nothing distinguished the `x` after a `.` from a variable
reference. The same blindness let a label `x :` in `Point(x : …)` be treated
as a reference (issues/fixed/lsp-references-and-rename-match-by-spelling.md).

## Fix

`hover.yo` gains `classify_atom_roles`: one walk of the program marks MEMBER
atoms (the arguments after the receiver of an infix `.` call, every argument
of a prefix `.Variant` call, and the callee of a member CALL `p.dist()`) and
LABEL atoms (the left side of a `:` pair in any call that does not introduce
bindings — `fn`, `unsafe_fn`, `ctl`, `Fn`, `generic`, `given`, `=`, `:=`, `?=`
do; struct literals, labelled calls, `impl`, `struct`/`enum` field
declarations do not). Hover on a member reads the type of the enclosing `.`
call (the access result) and skips the env refinement; hover on a label
answers nothing; definition answers nothing for either; references/rename skip
both.

## Verification

`tests/cli-cases/lsp-rename-identity`: hover on `p.x` is `x : bool`,
definition there is `null`, hover on the label is `null`.

## Left open (resolved 2026-09-08)

- Member DEFINITION targets: fixed by
  issues/fixed/lsp-member-definition-targets.md (the declaring module's AST is
  re-read; no declaration tokens were added to the types).
- Hover on a field DECLARATION (`x` in `struct(x : i32)`) is classified as a
  label and answers nothing; before, it answered `x : i32` by the same
  accident that made `p.x` wrong. Showing the declared field type there needs
  the label's `:` pair, not the atom, to be the hover subject.
