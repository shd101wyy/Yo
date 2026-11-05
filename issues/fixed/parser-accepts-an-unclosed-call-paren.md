# The parser accepts an unclosed call paren — at EOF, and across a `;` and the enclosing `}`

**Severity:** S2 — a missing `)` is silently accepted and the program restructured — the promised E0002 never fires

**Status: FIXED 2026-11-05** (found 2026-09-20 while probing the diagnostics
registry's E0002 example for the toolchain series; fixed with
`issues/fixed/2026-11-05-a-call-missing-its-closing-paren-before-a-semicolon-parses.md`). Repros:
`issues/repros/unclosed-call-paren-eof.yo`,
`issues/repros/unclosed-call-paren-in-body.yo`.

## Symptom

All three pass `yo check` (rc=0, "evaluator OK"):

```yo ignore
f :: (fn(a : i32) -> i32)(a);
_r := f(i32(1)
```

```yo ignore
f :: (fn(a : i32) -> i32)(a);
_r := f(i32(1);
_s := f(i32(2));
```

```yo ignore
f :: (fn(a : i32) -> i32)(a);
main :: (fn() -> unit)({
  _r := f(i32(1);
  _s := f(i32(2));
});
export(main);
```

The same leniency accepts an unclosed `struct(` at end of input:

```yo ignore
P :: struct(x : i32;
```

`yo fmt` on the third shows what the parser built:

```yo ignore
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

## Fix (2026-11-05)

Fixed together with its README-rehearsal duplicate,
`issues/fixed/2026-11-05-a-call-missing-its-closing-paren-before-a-semicolon-parses.md`,
which records the change. The registry's E0002 example now reproduces, and its
exemption in `tests/internal/diagnostics_registry_examples.test.yo` is removed.
A fix for the same shape had been written on 2026-09-20
(`fix/parser-unclosed-call-paren`) and was never merged.
