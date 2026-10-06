# `yo fmt` is not idempotent: one pass leaves a file `yo fmt --check` rejects

**Severity:** S3 — one `yo fmt` pass produces output `fmt --check` rejects — the format-then-check workflow breaks

**Status: FIXED** (2026-10-05, branch `s3/batch-2-fixes`). Found 2026-08-25
while formatting a codegen edit for
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

## Fixed

**Root cause.** The main-loop comma handler
(`_format_yo_source_impl` in `src/formatter.yo`) decided the break after
every comma from the innermost open bracket/curly frame with NO depth
guard: its `(cur_curly_inline && cur_curly_ml) => break` arm (and
symmetrically `cur_bracket_ml => break`) fired for ANY comma lexically
inside a multiline inline curly / multiline bracket — including commas
nested inside a call paren (`match(...)`, `cond(...)`) below the frame.
The break was emitted at `indent_level` before the paren's own multiline
machinery had bumped the indent, so pass 1 under-indented the
continuation to the enclosing block's level and only pass 2 — now seeing
the paren span rows, taking the multiline-paren path — reached the fixed
point. The frame-depth comparison was the discipline
`find_inline_curly_indices` already applied to semicolons; the comma
handler was missing it. (Probing the pre-fix binary further showed the
broader class: a bare `match`/`cond` statement in a block, single-row
calls inside a multiline array, and four long-stable-but-inconsistent
`if(x,\n{` splits in `src/evaluator/values/impl.yo` — a call's
block-argument curly whose only content is a single nested call
statement is inline-eligible because that statement's `;` sits inside
the call's parens, so the spurious arm fired on the inner call's
argument comma too.)

**Fix.** The comma handler now records, per open bracket/curly frame,
the paren/bracket/curly depth at which the frame opened (parallel
stacks `bracket_stack_paren_depths`/`bracket_stack_curly_depths`,
`curly_stack_paren_depths`/`curly_stack_bracket_depths`) and breaks at
the frame only when the comma sits DIRECTLY at that frame's own level
(`comma_in_bracket_frame` / `comma_in_curly_frame`). A comma nested
below a multiline frame defers to the delimiter that owns it: break iff
its own enclosing paren is multiline (same newline the old code
emitted, now via the paren arm), else stay on the row. Commas directly
at a multiline frame's own level (bracket elements, struct-literal
fields) still break exactly as before.

**Test.** Seven cases in `tests/internal/formatter.test.yo` under
"fmt comma frames": the issue's reproducer, the bare-`match` and
`cond` block variants, single-row calls in a multiline array (all
one-pass fixed points now), plus the preserved break cases (multiline
call in a multiline array, struct-literal field commas) and the joined
call-block-arg comma. Verified with the rebuilt tree compiler:
`suite 46/46 passed`; `fmt --check ./std ./tests ./src` green;
`fmt f.yo && fmt --check f.yo` rc=0 on the reproducer in one pass.
The fix also joins the four stale `if(x,\n{` spots in
`src/evaluator/values/impl.yo` to the dominant `if(x, {` spelling.

Fixed 2026-10-05 on branch `s3/batch-2-fixes`.
