# Self-hosted parser crashes on `=>` lambda expressions (WASM error handling)

## Description

The self-hosted parser (`yo-self/parser/parser.yo`) crashes with an out-of-bounds
memory access when parsing lambda expressions like `f := (x) => x;` on a single line.

## Root cause

This is **NOT a parsing logic bug**. The parser correctly detects an **operator
precedence ambiguity**: both `:=` and `=>` are infix operators, and Yo requires
explicit parentheses to disambiguate chained infix operators on the same line.

The correct Yo syntax is:

```rust
f := ((x) => x);     // parenthesized lambda
// OR
f :=
  (x) => x;          // newline after := implies right-associativity
```

The **crash** occurs because the parser's error message uses a template string:

```rust
exn.throw(dyn make_parse_error(tok, `ambiguous operator precedence near ${tok.value} — use parentheses`))
```

The template string formatting or `dyn` allocation corrupts memory under WASM,
turning a graceful parse error into a memory fault.

## The real bugs

1. **Error handling crash in WASM**: The `dyn make_parse_error(tok, template_string)`
   path crashes instead of cleanly reporting the error. This needs investigation
   in the `dyn` allocation or template string codegen for WASM targets.

2. **Not a syntax limitation**: The TypeScript host parser has the same ambiguity
   rule — `f := (x) => x` on one line fails there too (but with a clean error).

## Workaround

For tests, build `=>` AST nodes directly:

```rust
lambda := make_infix("=>", make_ident("x"), make_ident("x"));
```

For source code, always parenthesize:

```rust
f := ((x) => x);
```

## Priority

Low — the parser is correct; only the error reporting crashes. Parenthesized
lambda syntax works fine.

## Discovered

Phase 5t bootstrapping (closure evaluation feature addition)
