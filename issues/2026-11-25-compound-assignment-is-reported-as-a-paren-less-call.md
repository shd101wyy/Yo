# Every compound assignment (`x += 1`, `x |= 1`, `x <<= 1`) is E0008 "paren-less function and operator calls are not supported"

**Severity:** S3 — a misleading diagnostic: the error is anchored at the right operand and names paren-less calls; nothing, including `yo explain E0008`, says Yo has no compound assignment.

**Found:** 2026-11-25, VERDICTS-86 §5 item 4, probes `l1a`–`l1f`.
**Measured:** `yo 0.2.79` built from develop, `--std-path` of develop `fc89e3195`.

## Symptom

```yo ignore
{ println } :: import("std/fmt");

main :: (fn() -> unit)({
  (mut(x) : i32) = i32(4);
  x += i32(1);
  println(`${x}`);
});
export(main);
```

```text
error[E0008]: paren-less function and operator calls are not supported; use parentheses
  --> m4.yo:5:8
  |
5 |   x += i32(1);
  |        ^^^
help: run `yo explain E0008` for more information
```

The same code, anchored at the right operand, for `x |= i32(1)` (`l1a`, at `i32`), `x |= 1` without spaces (`l1b`, at `1`), `x <<= i32(1)` (`l1e`), and `x -= 1` (`l1f`, at `1`). With a grouped operand, `flags |= (u32(1) << u32(3))` (`l1d`) reads "whitespace before '(' is not allowed in function calls". `yo explain E0008` ("call syntax") describes `f (a)` and paren-less calls only. The only statement of the rule in the tree is `docs/en-US/TRAITS.md:318` ("Yo has no compound assignment operator"); `pack/context.md`, `.github/instructions/yo-syntax.instructions.md` and `GRAMMAR.md` have no `+=` line. A grep of `issues/` for "compound assign" and `+=` found no earlier report.

## Root cause

The lexer has no `+=`, `|=` and similar tokens, so `x += 1` lexes as `x`, `+`, `=`, `1`. The parser reads `x + ...` as a binary operator whose right operand starts at `=`, which no expression can start with; the fallthrough arm of the call/operator loop in `src/parser.yo` (the `true =>` arm after the `LParen` arms, "paren-less function and operator calls are not supported") fires on the next token. `src/error.yo` maps that message text to `E_CALL_SYNTAX` (E0008).

## Proposed fix (VERDICTS-86 §5.4; recorded, not implemented here)

A dedicated parser diagnostic. When an assignment target is followed by one of `+ - * / % & | ^ << >>` and then `=`, report "Yo has no compound assignment. Write `x = (x | 1)`." with a `yo fix` rewrite to the parenthesized form, anchored at the operator. Add the same sentence to `pack/context.md`, `.github/instructions/yo-syntax.instructions.md` and the `yo explain` entry (both languages). `a |- 1` (a `|` and a unary minus) is valid Yo today, so the check must key on the `=` that follows the operator, not on the operator alone.

## Test to add with the fix

A parser test in `tests/internal/parser.test.yo` (one file, run singly) asserting the new text and code for `x += 1`, `x |= i32(1)`, `x <<= i32(1)`, `x -= 1`, and that `c := (a |- b)` still parses; plus a `tests/cli-cases/` golden for the `yo fix` rewrite.
