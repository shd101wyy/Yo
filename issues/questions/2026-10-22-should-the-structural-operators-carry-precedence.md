# Should the structural operators (= := :: : => ->) carry precedence? (DECIDED)

**Kind:** design question: an open decision, not a defect. Filed 2026-10-22,
raised mid-VALUES_BY_DEFAULT by the maintainer: with macros being deleted
(`plans/backlog/MACRO_AND_ISO_REMOVAL.md`), should the non-arithmetic
operators get precedence levels while the arithmetic/comparison/logic/bitwise
set stays precedence-free — so `(x : i32) = ((a + b) - c);` could be written
`x : i32 = (a + b) - c;`?

## Verdict (maintainer, 2026-10-22)

**Keep no precedence, for any operator.** The current rule is the most
explicit form possible — grouping is verifiable by local inspection with no
prior knowledge — and the single sentence ("same-operator chains
left-associate; adjacent different operators need parentheses") is an asset an
LLM carries whole, unlike any table. The friction it costs is one compile
roundtrip with an obvious fix, and the 2026-09-19 authoring audit's own data
says syntax is not where models fail in Yo (parser: 7 of 218 open issues).
Mitigation shipped instead: E0003 now names the canonical grouping where the
mix has exactly one mainstream reading (the change that files this doc), so
the roundtrip is a copy-paste rather than a decision.

## What the audit found (2026-10-22)

- The grammar has **one enforcement point**: `parse_primary_end`'s infix
  branch (`src/parser.yo`). Files are expression lists; `::`, `:=`, `=`, `:`,
  `?=` and the arrows `->`, `=>`, `=>>` are ordinary infix `FnCall` nodes —
  there is no separate statement/arm/lambda grammar to hook a "declaration
  precedence" into. Any tier system is a change at that one branch (plus a
  rotation case: greedy full-expression RHS parsing means `a <= b => v`
  arrives with the arrow inside the comparison's right operand and must be
  regrouped).
- The forced-paren population is real and large: ~13.8k `name : (fn(...)->...)`
  annotation groups, ~5.3k `Name :: (fn...)` aliases, ~2.1k parenthesized
  annotated lambda params across `src/`, `std/`, `tests/` — but these count
  CONFORMANCE, not pain: the corpus is stable, and fmt canonicalizes the
  groups.
- The maintainer's sketch (`.` > `=> ->` > `= := :: :`) does not parse its own
  example: `x : i32 = e` needs `:` to close before `=`, so `:` cannot share
  the binding tier; and the two biggest populations force `->` ABOVE `:`
  (fn-type annotations) while `:` sits ABOVE `=>` (annotated lambda params) —
  the arrows land in different tiers. The corrected lattice, worked out in
  full, is: computational (no internal precedence) > `->` > `:` > `=>`/`=>>` >
  `= := :: ?=`, with same-tier different-token mixes staying errors.

## Recommendation

Adopted position: **no change to the grammar.** The corrected lattice above is
recorded so a future revisit does not re-derive it; if measured agentic
roundtrip data ever shows precedence-paren errors are a meaningful fraction of
compile roundtrips (the revisit trigger
`plans/reference/OPERATOR_SET_AND_PRECEDENCE.md` Part 2 pre-registered), that
lattice — never a full C-style table — is the shape to adopt, landed outside
an active migration campaign (it re-canonicalizes every file, like the
decision-42 spelling flip).

What DID land (this PR): the E0003 diagnostic names the canonical grouping
for the unambiguous classes —

```yo ignore
x := 1 + 2;
// Adjacent different operators need parentheses to clarify grouping (near :=).
// Wrap the right-hand side in parentheses: name := (1 + 2).
```

— for a binding operator, arm/lambda arrow, or `:` annotation next to a
fn-type arrow (wrap the RHS); for `x : i32 = v` (wrap the annotated binding on
the left); and for `n <= i32(1) => v` (wrap the left side). A computational
mix (`1 + 2 * 3`) stays hint-free: both groupings are real programs, which is
why the E0003 repair was declined as non-unique
(`plans/backlog/LLM_AUTHORING_AUDIT_2026-09-19.md` §3.1). The hint is
diagnostic text only — the grammar, and the explicitness it buys, are
untouched.
