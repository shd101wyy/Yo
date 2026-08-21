# `yo fmt` paren canonicalization — flatten what the grammar already flattens

**Status:** REJECTED by the maintainer, 2026-08-21, the same day it was
drafted — CLOSED, nothing implemented. Decision: `yo fmt` stays
paren-preserving (the gofmt position: formatters normalize layout, not
expression spelling; deliberate parens are the author's). The "don't
WRITE unnecessary parens" half of the problem moved to authoring guidance
in `.github/instructions/yo-syntax.instructions.md` and the syntax
cheatsheet instead. Kept for the analysis — especially Rule 3's
counterexamples, which remain true statements about the grammar.

Originally a companion to
[`OPERATOR_SET_AND_PRECEDENCE.md`](OPERATOR_SET_AND_PRECEDENCE.md) (the
no-precedence stance and closed operator set this design leans on) and
[`OPERATOR_ASSOCIATIVITY.md`](OPERATOR_ASSOCIATIVITY.md) (same-op chains
are left-associative — the rule that makes Rule 2 below meaning-preserving).

## Problem

LLMs (Yo's primary authors) overproduce parentheses as a safety default,
and hand-written code accumulates redundant groups too. Redundant parens
cost diff stability and one-canonical-form-ness. But in a **no-precedence**
language, most parentheses are load-bearing grammar — so a paren-removal
feature must be split into what is *provably* redundant and what is not,
and the formatter must be structurally incapable of changing meaning
(this project already removed newline-associativity from the language
because "`yo fmt` is dangerous" when formatting can shift semantics —
see OPERATOR_ASSOCIATIVITY.md's motivation).

## The two rules (DO)

**Rule 1 — collapse duplicate parens.** `((e))` → `(e)`, recursively.
Always meaning-preserving; parens do not create AST nodes.

**Rule 2 — flatten a LEFT-nested same-operator group.**
`(a ⊕ b) ⊕ c` → `a ⊕ b ⊕ c`, only when ALL of:

- the group is the **left** operand of the outer infix operator;
- the group's top-level operator is **identical** to the outer operator;
- the group's contents are themselves a plain chain of that operator
  (no mixed operators inside).

This is re-parse-identical **by the language's own associativity rule**
(same-op chains are left-associative), so the flattened spelling is the
canonical one. The **right** operand's parens always stay:
`1 + 2 + (3 + 4)` ≠ `1 + 2 + 3 + 4` (`(1+2)+(3+4)` vs `((1+2)+3)+4`).

### Worked examples (from the 2026-08-21 discussion)

| Input | Output | Why |
| --- | --- | --- |
| `((1 + 2))` | `(1 + 2)` | Rule 1 |
| `(1 + 2) + 3` | `1 + 2 + 3` | Rule 2 (left, same op) |
| `(1 + 2) + (3 + 4)` | `1 + 2 + (3 + 4)` | Rule 2 on the left only; right parens are load-bearing |
| `(1 + 2) - 3` | unchanged | mixed operators — parens required by grammar |
| `(1 + 2) - (3 + 4)` | unchanged | mixed operators |
| `-(1 + 2)` | unchanged | prefix operand is an infix chain — parens required |
| `-(1) + 2` | unchanged | Rule 3 (below): prefix-call parens are never removed |
| `*(i32)` | unchanged | Rule 3 |

## Rule 3 — prefix-call parens are NEVER removed (DON'T)

`*(i32)` → `*i32` and `-(1) + 2` → `-1 + 2` were considered and
**rejected**:

1. **Context-dependent breakage.** `x - *(i32)` reformatted to `x - *i32`
   yields the token stream `x`,`-`,`*`,`i32` — adjacent DIFFERENT
   operators, a grouping error under OPERATOR_ASSOCIATIVITY.md. A rewrite
   that is only sometimes valid has no place in a formatter.
2. **Paren-less prefix calls are banned wholesale today.** Verified
   2026-08-21 three ways: `*i32` (type position), `x : *i32` (param), and
   `x :: -1` all reject with "paren-less function and operator calls are
   not supported"; `3 - -3` rejects identically (write `3 - -(3)`), and
   `**i32` parses the leading `*` as an operator ATOM, giving the infix
   `(*) * i32`. The one-postfix-operand rule is still the unimplemented
   `PREFIX_OPERATOR_OPERAND_RULE.md` — until it lands, every target of
   this rewrite is illegal syntax.
3. **Readability inverts.** Nested prefix chains without parens are
   strictly harder to read — the maintainer's own counterexample:
   `?(*(?(*(i32))))` "flattened" toward `??**i32`-style spellings. The
   parens in prefix calls do real work for the eye; in a language whose
   stated reading model is "locally verifiable without a table," they
   stay.

Revisit only after PREFIX_OPERATOR_OPERAND_RULE.md lands — and the
presumption even then is to keep Rule 3.

## Deliberate parentheses

Rules 1–2 are **canonicalization**, not suggestions: they always apply.
A "keep my redundant parens" mode would break idempotence (the
`FMT_IDEMPOTENT` tier-1 gate) and one-canonical-form-ness. Deliberate
grouping lives everywhere OUTSIDE Rules 1–2 — mixed-operator groups,
right operands, prefix operands — where fmt never touches parens at all.

## Implementation sketch

The formatter is **token-based by design** (comment/trivia preservation;
it never builds the AST — which is also why the `if`→`cond` desugar is
invisible to it). Rules 1–2 are its first structure-aware rewrites, so
they come with a hard safety net:

1. **Token-level rewrite**: match `(`…`)` groups via `find_matching_bracket`
   (`src/token.yo`); for Rule 2, require the group's top-level operator
   tokens (depth-0 within the group) to all equal the single operator
   token immediately following the group's `)`, and require the group to
   sit in left-operand position (start of expression or after `(`/`,`/`;`
   — NOT after another operator or identifier).
2. **Re-parse verify gate (mandatory)**: after formatting a file with any
   paren elision applied, parse BOTH the original and the formatted text
   and assert the ASTs are identical (ignoring ExprIds/positions —
   `exprs_are_equal` in `src/expr.yo` is the comparator). On ANY mismatch:
   discard the elisions for that file, emit the conservative format, and
   log a warning. This makes a meaning-changing format structurally
   impossible rather than merely untested.
3. **Idempotence**: the elided output must be a fixed point (gates already
   check FMT_IDEMPOTENT); Rule 2's output contains no left-nested same-op
   groups by construction.
4. **Corpus dry run before landing**: run the new fmt over the whole repo;
   the diff is the set of canonicalizations — review it, commit it in the
   same PR (the fmt gate requires the tree to be fmt-clean).

## Non-goals

- No prefix-call paren removal (Rule 3).
- No paren INSERTION changes — the existing formatter behavior for
  required grouping stays as-is.
- No configuration flags; canonical means canonical.
