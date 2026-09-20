# The parser accepts an unclosed call paren — at EOF, and across a `;` and the enclosing `}`

**Status: FIXED 2026-09-20** (found the same day while probing the diagnostics
registry's E0002 example for the toolchain series). Repros:
`issues/repros/unclosed-call-paren-eof.yo`,
`issues/repros/unclosed-call-paren-in-body.yo`.

## Symptom

All three pass `yo check` (rc=0, "evaluator OK"):

```rust
f :: (fn(a : i32) -> i32)(a);
_r := f(i32(1)
```

```rust
f :: (fn(a : i32) -> i32)(a);
_r := f(i32(1);
_s := f(i32(2));
```

```rust
f :: (fn(a : i32) -> i32)(a);
main :: (fn() -> unit)({
  _r := f(i32(1);
  _s := f(i32(2));
});
export(main);
```

The same leniency accepts an unclosed `struct(` at end of input:

```rust
P :: struct(x : i32;
```

`yo fmt` on the third shows what the parser built:

```rust
main :: (fn() -> unit)({
  _r := f(
    i32(1);
    _s := f(i32(2));
  }
);
```

The `;` turned the argument list into a semicolon block that swallowed the
next statement, and the body's `}` was accepted INSIDE the still-open `(`.
The declared shape `f(i32(1)` with a missing `)` is the most common
agent-written typo after operator grouping, and the registry's E0002 entry
("expected a specific token … `expected )`") promises a diagnostic that is
never produced for it.

## Expected

E0002 `expected ) or , in function call` at the `;` (or at end of input for
the first form) — the message the parser already has at `parser.yo:687-688`.

## Notes for the fix

- `parse_paren`-family loops treat `;` as the separator of a `( … ; … )`
  block, which is a legitimate grouping form; the bug is that a `}` (or end
  of input) is accepted as the block's terminator instead of only `)`.
- Any tightening needs an over-rejection canary: `( a; b )` blocks and
  multi-line call argument lists must keep parsing, and `yo check ./src ./std`
  + the corpus must stay green (a rejection that fires anywhere in the tree
  means the tree relied on the leniency).

## Fix (2026-09-20)

`parse_fn_args` (`src/parser.yo`): `;`, `]`, `}` and end of input end the
PAREN-LESS call form only; inside `f(` they are E0002 `expected , or ) in
function call` at the offending token (end of input anchors on the last
argument). Goldens: `check-unclosed-call-paren`, `check-unclosed-call-paren-eof`;
the registry's E0002 example reproduces and its exemption in
`tests/internal/diagnostics_registry_examples.test.yo` is gone.

The stricter parser found four real unbalanced parens the lenient one had
hidden — `src/evaluator/values/impl.yo:890` and
`src/evaluator/types/synthesizer.yo:198` (a debug `if(…, {` … `};` whose inner
`if(` was never closed), the `src/main.yo` dispatch tail (one `)` short), and
`markdown_yo` v0.0.7's `_is_email_local_char` (one `)` short in a 20-term
`||` chain, fixed as v0.0.8). Every other file in `src/`, `std/`, `tests/`
parses unchanged (`fmt --check` over all three).
