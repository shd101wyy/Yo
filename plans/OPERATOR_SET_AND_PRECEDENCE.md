# Operator set & precedence — close the token set, stay precedence-free

**Status:** PROPOSED (drafted 2026-08-21). Two decisions are recorded here:
the **closed operator token set** is proposed for implementation; the
**no-precedence** stance was re-examined and **AFFIRMED by the maintainer
(2026-08-21)** — Yo keeps no operator precedence, and the considered
alternative is documented below as deferred.

Companion docs — both remain authoritative for what they cover:

- [`OPERATOR_ASSOCIATIVITY.md`](OPERATOR_ASSOCIATIVITY.md) (**implemented**):
  same operator → left-associative; different adjacent operators →
  parentheses required; newline-associativity removed. Untouched by this
  plan.
- [`PREFIX_OPERATOR_OPERAND_RULE.md`](PREFIX_OPERATOR_OPERAND_RULE.md)
  (proposed): a prefix operator binds exactly one postfix expression.
  Complementary — this plan's Part 1 makes that rule's chained-prefix case
  (`*(*(i32))`) actually reachable, so the two should land together or in
  sequence.

## Problem

Two related holes, both surfaced 2026-08-21:

1. **The operator token set is OPEN.** The lexer (`src/lexer.yo:119-133`)
   performs maximal munch over the operator *character class*: any
   uninterrupted run of operator characters becomes ONE `Operator` token.
   Combined with user-definable operators ("operators are just bindings" —
   e.g. `(^) ::` and `(?*) ::` in `std/prelude.yo`), this means `**i32`
   lexes as the single (nonexistent) operator `**` applied to `i32`, not as
   `*(*(i32))`. Since unary calls no longer require parentheses
   (`*i32` is now valid alongside `*(i32)`), users WILL write `**i32` and
   get "unknown operator `**`" at best — or, worse, silently pick up a
   user-defined `**` from scope. Every mainstream language avoids the whole
   class by lexing against a **closed table of known operators**: in Rust,
   `**x` is `*`,`*`,`x` because `**` is not a token.
2. **Nothing GUARANTEES the structural operators are unoverloadable.**
   `&&`/`||` (short-circuit), `=`, `:=`, `::`, `.`, `:`, `=>`, `->`, `<:`,
   `?=` are protected today mostly by dispatch order (builtins are matched
   before user bindings), not by rule. Rust reserves its equivalents
   explicitly (`&&`, `||`, `=`, `.`, `?:`) because an overload would
   silently change evaluation order or binding semantics.

Design constraint (from the maintainer): **Yo optimizes for LLM authorship.**
Backward compatibility is explicitly not a constraint.

## Part 1 — Close the operator token set (PROPOSED)

Replace the character-class maximal munch with **longest-match against a
fixed operator table**. Three layers, only the first of which changes:

| Layer | Today | Proposed |
| --- | --- | --- |
| Which char sequences are operator TOKENS | any run of operator chars | fixed table, longest match |
| Binding an operator name (`(^) :: ...`) | any operator token | any NON-RESERVED table member |
| Overloading via traits (`Add`, `BitXor`, …) | supported | unchanged |

New operator tokens become a **compiler change** — deliberate, reviewed,
like adding a keyword. Nobody outside `std/` has ever defined a novel
operator (audit 2026-08-21, `plans/MACRO_POLICY.md` Part 1), so the
expressiveness lost is theoretical; the predictability gained is not:

- `**i32` lexes as `*`,`*`,`i32` → with the prefix-operand rule,
  `*(*(i32))` — matching every reader's (and every LLM's) prior.
- An LLM's assumptions about what is one token become RIGHT by
  construction. An open set makes those priors silently wrong, and it
  cannot be fixed per-file: pragmas are recognized post-lexing, so the
  token set cannot be pragma-conditional. Closing it globally is the only
  clean shape.

### The table (draft — verify against the corpus before landing)

Grounded in a 2026-08-21 corpus scan of all `.yo` files (comment/string
stripped, counts in `plans/` history); the implementation step MUST
re-verify by lexing the whole corpus with the new table and diffing token
streams (zero diffs expected).

| Group | Tokens |
| --- | --- |
| Arithmetic | `+` `-` `*` `/` `%` |
| Comparison | `==` `!=` `<` `<=` `>` `>=` |
| Logic | `!` `&&` `\|\|` |
| Bitwise | `&` `\|` `^` `~` `<<` `>>` |
| Binding / assignment | `=` `:=` `::` `?=` |
| Arrows / structure | `->` `=>` `:` `<:` |
| Dot family (own token kinds) | `.` `..` `..=` `...` |
| Pointer / option types | `*` `?` `?*` |
| Splices (macro/derive layer) | `#` `...#` |
| Iso sugar | `^` (prefix use of the bitwise token) |
| Word alias | `not` (identifier-alias of `!`, `std/prelude.yo:569`) |

Notes:

- The dot family already has bespoke lexing (`src/lexer.yo:100-116`) and
  the operator munch deliberately EXCLUDES `.` — so deref `x.*` is three
  tokens (`x`, `.`, `*`), NOT an `.*` token; the table unifies the rest of
  the operator space with the dot family's closed-set discipline.
- The scan also shows artifacts the lexer never produces as single tokens
  (`.*`, `.*.` from deref chains; template-string `->$`, `/$`, `:$`;
  doc-comment `/*`, `--`, `##`, `&+`) — which is exactly why the
  verification step is a token-stream diff over the real corpus, not a
  grep.
- Table misses are LOUD under the new lexer ("unknown operator `xx`, did
  you mean `x` `x`?" — the error should suggest the two-token split), and
  the bootstrap is safe by construction: the seed binary keeps its old
  lexer, and the new table only needs to cover what the tree already
  writes, which the corpus diff proves.

### Reserved operators (no user binding, no overload)

`=` `:=` `::` `.` `:` `=>` `->` `<:` `?=` `&&` `\|\|` `#` `...#` `...`

- `&&`/`\|\|` stay lazy builtins — an overload would silently lose
  short-circuiting (Rust reserves them for the same reason).
- The rest are structural: binding forms, member access, arm/label/type
  syntax, and the splice markers owned by the quote layer
  (`plans/MACRO_POLICY.md`).
- Enforcement point: reject `(op) :: ...` bindings and trait-operator
  registrations for reserved tokens at definition evaluation, next to the
  existing operator-binding path (where `(^) ::` / `(!) ::` are handled) —
  turning today's dispatch-order accident into a guarantee.
- Everything else in the table stays bindable/overloadable exactly as
  today (`Add`…`BitXor` traits, `(^)`, `(?*)`, `(not)`).

## Part 2 — Precedence: NONE (AFFIRMED 2026-08-21)

Yo keeps **no operator precedence**. The `OPERATOR_ASSOCIATIVITY.md` rules
remain the complete story: same-operator chains are left-associative;
mixing different operators requires parentheses; anything else is a parse
error.

Why this was re-affirmed:

- **Mistakes are loud, not silent.** With no precedence, the failure mode
  of an unparenthesized mixed chain is a deterministic parse error with an
  obvious fix ("add parens"). With a precedence table, the failure mode is
  a silent misgrouping wherever the writer's prior and the table disagree.
  In agentic workflows — Yo's target — the compile loop is always present,
  so a loud error costs one cheap roundtrip; a silent misgrouping costs a
  debugging session.
- **Reading needs no table.** Parenthesized code is locally verifiable
  evidence — for reviewers and for LLMs consuming the code later.
- **Yo's operator surface is nonstandard anyway** (`<:`, `?=`, `=>` arms,
  `->` fn types, `.*`): a C-style table gives no guidance there, and a
  partial table creates two classes of operators.

### Considered and deferred: the "consensus core"

The examined alternative was a minimal table covering ONLY the five levels
where C, Rust, Python, Java, JS, and Go all agree —
`* / %` > `+ -` > comparisons > `&&` > `\|\|` — with everything else
(bitwise, shifts, ranges, `<:`, …) still parenthesis-required. Its case:
LLMs emit `a + b * c` and `i + 1 < n` constantly, each costing a compile
roundtrip today, and the consensus core is by construction the subset
where no mainstream prior can disagree (bitwise — the classic disagreement
zone, e.g. C's `&` below `==` — stays parens-required).

Deferred by maintainer preference for the loud-failure property. Revisit
trigger: if measured agentic-workflow friction from paren errors turns out
to be a real cost (e.g. a meaningful fraction of compile roundtrips in LLM
sessions are precedence-paren errors), the consensus core is the shape to
adopt — never a full C-style table, whose lower reaches are exactly where
priors conflict.

## Implementation sketch (Part 1 only)

1. **Lexer**: replace the operator-run munch (`src/lexer.yo:119-133`) with
   longest-match against the table. Keep the existing dot-family special
   cases. Unknown operator runs produce a compile error naming the run and
   the longest valid prefix split.
2. **Reserved-list enforcement**: at operator-binding definition
   (`(op) :: ...`) and operator-trait registration, reject reserved
   tokens with an error naming the reserved set.
3. **Corpus verification**: lex every `.yo` file in the repo with old and
   new lexers; diff the token streams (expect zero differences). Then
   `yo check ./src`, `yo check ./std`, the fast suite, bootstrap gates,
   and `fixpoint_only.sh`.
4. **Prefix chains**: land `PREFIX_OPERATOR_OPERAND_RULE.md` with or after
   this, so `**i32` actually parses as `*(*(i32))` instead of erroring on
   an unparenthesized prefix chain.
5. **Docs**: GRAMMAR.md gets the normative operator table; DESIGN.md
   (en+zh) documents the closed set and the reserved list;
   yo-syntax.instructions.md + cheatsheet updated.

## Non-goals

- **No operator sigil for `quote` — word-only, DECIDED 2026-08-21.**
  Considered and rejected: `:` (Julia's `:(expr)` precedent) collides with
  Yo's hottest structural token (annotations, labels, named fields — and
  macro templates are dense with real colons), and its priors are split
  (Ruby/Lisp read `:x` as a symbol literal); `'` is char literals;
  backtick is template strings. `quote` occurs once per template at the
  outermost position, where an explicit word is cheap and announces "AST
  territory" — sigils stay reserved for the frequent inner holes
  (`#`, `...#`). If a sigil is ever revisited, `@(...)` is the least-bad
  candidate (`@` is unused; Julia's `@macro` prior is at least
  metaprogramming-adjacent).
- No change to trait-based overloading of table operators.
- No change to `#`/`...#` (see the open question in
  `plans/MACRO_POLICY.md` — kept, with removal-if-ever as a separate
  mechanical PR).
- No precedence table of any size (Part 2).
