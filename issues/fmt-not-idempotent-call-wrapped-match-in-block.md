# `yo fmt` is not idempotent: one pass leaves a file `yo fmt --check` rejects

**Status: OPEN.** Found 2026-08-25 while formatting a codegen edit for
issues/fixed/inline-builtin-alias-drops-body-arguments.md. Reproducer:
`issues/repros/fmt-not-idempotent-call-wrapped-match-in-block.yo`.

## Symptom

A `match` wrapped in a call, inside a **brace block body**, needs TWO `yo fmt`
passes to reach a fixed point. The first pass breaks the `match` across lines
but indents the continuation to the *enclosing block's* level instead of
nesting it; the second pass fully expands it and is then stable.

```rust
pick :: (fn(xs : ArrayList(i32)) -> i32)({
  i32(match(xs.get(usize(0)), .Some(a) => a, .None => i32(0)))
});
```

after `yo fmt` (pass 1):

```rust
  i32(match(xs.get(usize(0)),
  .Some(a) => a,
  .None => i32(0)))
```

after `yo fmt` again (pass 2, and stable from here):

```rust
  i32(
    match(
      xs.get(usize(0)),
      .Some(a) => a,
      .None => i32(0)
    )
  )
```

## Why it matters

`AGENTS.md` prescribes "run `yo fmt <file>` on every `.yo` file you create or
modify … use `yo fmt --check` to verify". For this shape that sequence FAILS:

```
$ yo fmt f.yo          # rc=0, "Formatted 1 Yo file(s)."
$ yo fmt --check f.yo  # rc=1, "The following Yo files need formatting: f.yo"
```

A contributor who follows the documented workflow gets a check failure on a
file they just formatted, and the natural reaction — run `yo fmt` again — is
also the fix, which makes this look flaky rather than deterministic. It is
deterministic.

Pass-1 output is also not merely differently-indented: the continuation lines
sit at the same indentation as the statement that opened them, which is the one
thing a formatter exists to prevent.

## Scope

Measured with the released `yo` 0.2.16 and reproduced on `develop`.

The brace block is load-bearing. The same expression as a paren body is
idempotent in one pass:

```rust
// idempotent — no block
pick :: (fn(xs : ArrayList(i32)) -> i32)(
  i32(match(xs.get(usize(0)), .Some(a) => a, .None => i32(0)))
);
```

UNMEASURED: whether other call-wrapped block-scoped constructs (`cond`, `if`,
nested closures) share the defect, and whether any file currently in the tree is
sitting in the pass-1 state — `yo fmt --check` over `std/` and `src/` is green,
so no committed file is, but that is a weaker statement than "the formatter is
idempotent".

## Where to look

`src/formatter.yo` — the line-budget decision that chooses between the inline
and the exploded rendering of a call's arguments appears to be made against the
wrong indentation base when the call sits directly inside a block body, so the
first pass under-indents and the second pass, seeing the new line structure,
re-decides correctly.

The acceptance test for a fix is idempotency itself, not a golden: for every
`.yo` in the tree, `fmt(fmt(x)) == fmt(x)` — worth adding as a gate, since it
is checkable without agreeing on what the output should be.
