# A call missing its closing `)` before `;`, `}`, `]` or the end of the file parses as if it were closed

**Severity:** S2 — invalid source is accepted: a missing `)` goes unreported by `check`, `compile`, `test` and `yo fmt --check` (the formatter writes the unbalanced text back unchanged), so it survives in a repository until the parser is fixed and then breaks it.

Found by the README example-project rehearsal for v0.2.75: raylib_yo's and tetris_yo's `tests/main.test.yo` end in `};` instead of `});`, and both pass `yo test` and `yo fmt --check` on the v0.2.74 seed and on develop d76eac577.

## Reproducer

```yo ignore
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  println("a");
};
export(main);
```

`yo compile` builds it and the program prints `a`. The same happens for `x :: f(1;` and for `x :: f(1` at the end of the file (both reach the evaluator; only a later, unrelated error is reported). By contrast `(f(1;` is rejected with E0002 `expected ) for tuple`.

## Root cause

`parse_fn_args` (src/parser.yo, the argument loop after `parse_expression`) serves both call shapes, and returns successfully, without consuming a `)`, when the token after an argument is `;`, `]` or `}`, or when the tokens run out:

```yo ignore
((curr.kind == TokenKind.Semicolon) || (curr.kind == TokenKind.RBracket) || (curr.kind == TokenKind.RCurlyBracket)) => {
  return(FnArgsResult(args : args, index : idx));
},
```

That exit is right only for the whitespace-separated shape (`has_whitespace`), whose arguments end at the statement's end. A parenthesized call (`has_whitespace == false`) has to end at its `)`.

## Recommendation

In `parse_fn_args`, when `has_whitespace` is false, treat `;`, `]`, `}` and end-of-input like any other unexpected token: raise `expected , or ) in function call` at that token. The change alters what parses, so it is a Generation A step: sweep `tests/`, `std/`, `src/` and the embedded programs (`scripts/check-embedded-yo.sh`) for unbalanced calls before landing it, and add a parser test with the reproducer above expecting the error.

## Fix

`parse_fn_args` (`src/parser.yo`): `;`, `]` and `}` end the arguments of a
whitespace-separated call only. In a parenthesized call they are E0002
`expected , or ) in function call: the call's ( is not closed before this ;`
(or `]`, `}`) at that token. Running out of tokens is the same error,
`… is not closed before the end of the file`, reported at the call's `(`.
`( a; b )` block arguments and multi-line argument lists parse as before.

The tree sweep used the tree binary. `yo fmt --check` parses a file only when
formatting would change it, so the sweep ran over a copy of `src/`, `std/`,
`tests/`, `docs/`, `plans/`, `issues/`, `.github/` and `scripts/` in which
every `.yo` file and every Markdown ```` ```yo ```` block was perturbed
(trailing blank lines). It compared the first diagnostic per file against the
v0.2.74 seed. It found five unclosed calls, and the lenient parse had read each
of them as the author intended:

- the `src/main.yo` subcommand dispatch tail, five `)` short;
- a debug `if(…, {…};` in `src/evaluator/values/impl.yo`;
- the T9 lend `Option(TypeValue).Some(t_reference_with_origin(…));` in
  `src/evaluator/calls/helper.yo`;
- the RAII example in `docs/en-US/DESIGN.md` and `docs/zh-CN/DESIGN.md`.

Twenty-three files already failed to parse in that copy (historical `plans/`
fragments and cli-case fixtures that are invalid by design). Their first error
is unchanged, so a later unclosed call in them would stay hidden; CI never
parses them either.

Tests: `tests/internal/parser.test.yo` ("a call missing its `)` is E0002 …":
the four shapes plus three canaries); cli-cases
`a-call-missing-its-closing-paren-is-e0002` (this doc's reproducer) and
`a-call-missing-its-closing-paren-at-eof-is-e0002`; the registry's E0002
example (exemption removed from `diagnostics_registry_examples`).
