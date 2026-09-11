# A string literal that can contain a backtick without escaping it

**Status:** BACKLOG (written, not started) — 2026-09-11. Written after a
reviewer pushed back on documentation that said "never write a markdown
backtick inside a C comment in an emitted-C template". The documentation was
wrong twice over, and the second way is a real gap.

## What is and is not a problem

**An ordinary Yo comment can already contain backticks.** The lexer skips
comments, so this compiles and runs today, no escape needed:

```rust
// This is `valid` without escape
/// A doc comment with `markdown` backticks and a ```rust fence
```

That is the case a reader is most likely to have in mind, and it works.

**A backtick inside a template LITERAL is different**, because there it is
string content, and `` ` `` is the delimiter:

```rust
c := `// reads `state` first`;   // the second ` CLOSES the literal
```

`\`` is a supported escape and fixes it (`yo fmt` preserves it and is
idempotent over it), so nothing is impossible. The gap is ergonomic, and it has
a sharp edge.

## Why it is worth a feature rather than a doc line

`src/codegen/**` emits the entire C runtime from backtick templates — 65 files,
9774 backticks. C is prose-heavy: its comments are where the emitter explains
itself, and a comment explaining Yo semantics wants to name Yo identifiers the
way every other comment in the tree does, in backticks.

Today that costs an escape at 10 sites. The count is small; the FAILURE MODE is
not. An unescaped backtick closes the literal, the rest of the C is parsed as
Yo, and the error is:

```
error[E0008]: paren-less function and operator calls are not supported; use parentheses
   --> src/codegen/async/runtime_core.yo:412:17
    |
412 |   // reads ` state ` first, then registers
```

— anchored on a WORD INSIDE A C COMMENT, hundreds of lines from anything the
author changed, and `yo fmt` has helpfully padded the fragment to `` ` state ` ``
because it now parses as an operator call. It cost three separate diagnoses in
one session.

## Step 1 — the diagnostic, which is most of the value

E0008 cannot know it is looking at the inside of a template that closed early.
But the *lexer* knows how many template literals it opened and closed in the
file, and an ODD interaction is detectable: when E0008 (or any parse error)
fires on a token that the lexer emitted from INSIDE what it had been treating
as template text, say so:

```
help: this text is inside a backtick template that may have been closed early
      by an unescaped ` on line 409; write \` for a literal backtick
```

That is a hint on an existing error, it needs no language change, and it turns
a 20-minute diagnosis into a 20-second one. **Do this first and measure whether
the rest is still wanted.**

## Step 2 — a fenced template, if step 1 is not enough

The emitters need INTERPOLATION (`${thread_local}`, `${indent}`), so Rust's
`r#"…"#` — which is raw in the sense of "no escapes at all" — is the wrong
shape: it would break every existing emitter. What is wanted is the same
template with a delimiter that C text does not contain.

**Recommendation: a triple-backtick fence,** which reads the way a markdown
fence reads and which no emitted C contains:

````rust
c := ```
// reads `state` first, then registers
static int x = 1;
```;
````

- Single backticks inside need no escape; `` ``` `` closes it.
- `${…}` interpolation keeps working, unchanged, and `\$` still escapes it.
- `\`` stays legal and meaningful in both forms, so nothing existing breaks.
- The lexer change is contained: the template scanner already tracks a
  delimiter and a brace depth; it gains a fence LENGTH (1 or 3) and closes on
  a run of that length.

Alternatives considered and why they lose:

| form | why not |
| --- | --- |
| `r#"…"#` (Rust) | kills interpolation, which every emitter uses |
| a heredoc (`<<<EOF`) | a second, unrelated syntax for the same job, and the terminator is a new kind of identifier |
| doubling (` `` ` for a literal backtick) | invisible in review, and ambiguous against an empty template |
| leaving it at `\`` | works, and is what to do until this lands |

## Cost, honestly

Step 1 is a diagnostic and is worth doing on its own. Step 2 is a lexer change
plus `yo fmt` (which must print the fence back and choose the shorter form when
the content has no backtick), plus the syntax docs in both languages and the
`yo-syntax` skill. It is NOT urgent: ten escape sites is not a crisis, and the
escape is one character. It is on this list because "you cannot write a
backtick there" is not true and should not be documented as if it were, and
because the error you get when you forget is one of the worst in the tree.

## Related

- `.github/instructions/c-codegen.instructions.md` — the emitted-C literal
  rules, including the `\`` escape and its failure mode.
- `plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` — the closed operator token
  set; a fence is a lexer-level delimiter and does not touch it.
