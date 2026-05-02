# Self-hosted parser crashes on `=>` lambda expressions

## Description

The self-hosted parser (`yo-self/parser/parser.yo`) crashes with an out-of-bounds
memory access when parsing lambda expressions using `=>`:

```rust
f := (x) => x;
```

## Reproduction

```rust
given(exn) := Exception(throw: ((err) -> { println(`ERROR: ${err}`); escape (); }));
exprs := generate_exprs_from_code("f := (x) => x;", using(exn));
```

This produces a memory fault (wasm address 0xffffff6c, out of bounds memory access).

## Expected behavior

The parser should produce:

```
FnCall(Atom(":="), [
  Atom("f"),
  FnCall(Atom("=>"), [Atom("x"), Atom("x")], is_infix=true)
], is_infix=true)
```

## Root cause

The `=>` operator is lexed as a `TokenKind.Operator` token by the self-hosted
lexer (confirmed: operator chars `=` and `>` are consumed together). However,
the parser's infix expression handler may not correctly handle `=>` as an infix
operator, or it may produce a recursion/memory issue when trying to re-associate
the expression.

## Workaround

Build lambda AST nodes directly using raw constructors:

```rust
lambda := make_infix("=>", make_ident("x"), make_ident("x"));
```

## Impact

- Lambda/closure creation via `generate_exprs_from_code` is broken
- Integration tests that parse lambda expressions must use raw AST construction
- Does NOT affect the TypeScript host compiler's parser (only self-hosted)

## Priority

Medium — closures are fundamental for real programs, but the self-hosted evaluator
can still be tested via raw AST construction.

## Discovered

Phase 5t bootstrapping (closure evaluation feature addition)
