# A call missing its closing `)` before `;`, `}`, `]` or the end of the file parses as if it were closed

**Severity:** S3 — invalid source is accepted: a missing `)` goes unreported by `check`, `compile`, `test` and `yo fmt --check` (the formatter writes the unbalanced text back unchanged), so it survives in a repository until the parser is fixed and then breaks it.

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
