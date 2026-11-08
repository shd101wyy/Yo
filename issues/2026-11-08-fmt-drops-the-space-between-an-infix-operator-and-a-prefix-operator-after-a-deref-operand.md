# `yo fmt` drops the space between an infix operator and a prefix operator after a `.*` operand

**Severity:** S3 — cosmetic. The formatted text parses back to the same
expression and the program is unchanged, but the layout is wrong and reads
like a different operator.

Found 2026-11-08 while writing `tests/box_layout.test.yo` (decision 49, `Box`
layout L1).

## Repro (v0.2.76)

```yo
pragma(Pragma.AllowUnsafe);
f :: (fn(h : *usize) -> usize)(unsafe((h.* & ~(usize(1)))));
```

`yo fmt` rewrites the body to:

```yo ignore
f :: (fn(h : *usize) -> usize)(unsafe(h.* &~usize(1)));
```

The space between the infix `&` and the prefix `~` is gone. Over a plain
operand the same expression keeps it: `(a & ~(usize(1)))` formats as
`(a & ~usize(1))`. The binary built from either spelling prints `4` for
`h.* = 5`, so only the layout is affected.

## Expected

`h.* & ~usize(1)`: a space on both sides of an infix operator, whatever the
left operand's last token is.

## Root cause (suspected)

The formatter's spacing rule for an infix operator looks at the token before
it. After the postfix `.*` the operator is laid out as if it continued a
postfix chain, and the prefix operator that follows is glued on.
