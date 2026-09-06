# `yo fmt` callee prefix-call canonicalization — `op(x)(y)` renders as `(op x)(y)`

**Status:** LANDED 2026-09-06 (rule "D4", extending the
[`FMT_PAREN_ELISION.md`](../archive/FMT_PAREN_ELISION.md) family). Implemented in
`src/formatter.yo`: `prefix_call_paren_shape` (the D3 shape, extracted and shared),
`is_callee_prefix_call_paren`, and `canonicalize_callee_prefix_calls` — a token
surgery pass that runs before the elision/layout machinery, under the same
`elide_parens` flag, counted by `g_fmt_canonicalized_callee_parens` so
`format_yo_source`'s re-parse AST-equality gate also covers surgery-only files.
Decision-table tests in `tests/internal/formatter.test.yo` ("fmt D4:" family);
fixtures 41/42 refreshed (they contained `*(?*(u8))(…)` spellings).

## The trap this closes

A bare prefix operator binds ONE postfix expression
([`PREFIX_OPERATOR_OPERAND_RULE.md`](PREFIX_OPERATOR_OPERAND_RULE.md) Rule 1), and a
call is one postfix expression — `-f(x)` is `-(f(x))`. So `*void(p)` parses as
`*(void(p))`: prefix `*` (the pointer-TYPE constructor,
`src/evaluator/calls/pointer.yo`) applied to the VALUE `void(p)` — the evaluator
rejects it ("Cannot create a pointer to a value"). The pointer cast must name the
type and then call the resulting type value. Two spellings do that, and they parse
to the SAME AST (`FnCall(func : FnCall(*, [void]), args : [p])`):

```rust
*(void)(p)   // operator-call form: `*`'s call paren, then the cast's args paren
(*void)(p)   // grouped form: the tight type expression, wrapped once, called
```

The tree had both (~4:1 toward `*(void)(p)` in std/), and the grouped form reads
better: the cast's callee is visibly a TYPE, and the tight inner form is the same
`**u8` / `?*u8` shape the D3 elision already canonicalizes for type expressions.
DECIDED: the grouped spelling is canonical, `yo fmt` rewrites the other one, and
the corpus was swept.

## The rule (operator-generic)

When a prefix operator call's result is immediately CALLED — the func's call paren
is followed byte-adjacent by the args paren — render the func grouped:

| input | canonical output | note |
| --- | --- | --- |
| `*(void)(x)` | `(*void)(x)` | the common cast |
| `*(*(u8))(x)` | `(**u8)(x)` | inner `*(u8)` tightens via D3 |
| `*(?*(u8))(x)` | `(*?*u8)(x)` | whole prefix chain inside the group |
| `-(x)(y)`, `~(x)(y)` | `(-x)(y)`, `(~x)(y)` | every prefix-capable op, not just `*` |

`-(x)(y)` → `(-x)(y)` looks odd at first (the code itself is degenerate — a
negated number is not callable), but the grouped form is the unambiguous one: in
C, postfix calls bind tighter than unary operators, so C-trained eyes read
`op(x)(y)` as `op(x(y))` — in Yo it is `(op(x))(y)`. The same reader trap as
`*void(x)`, pointing the other way; the grouped callee spelling kills it for
every operator at once, which is also why the rule is operator-generic rather
than a `*` special case.

NOT rewritten (the re-parse gate would reject them anyway, but the predicate
never fires):

| input | why it stays |
| --- | --- |
| `-x(y)` | bare prefix binds the CALL — it is `-(x(y))`, a different AST from `(-x)(y)`; matches C, no trap |
| `*void(x)` | no call paren on the operator — it IS the `*(void(x))` AST; fmt never invents a cast |
| `* (void)(x)` | the spaced spelling parses as `*((void)(x))` — adjacency is structural |
| `-(1, 2)(y)` | multi-arg call (D3 shape requires no top-level comma) |
| `*((a + b))(y)` | non-atom operand (D3 shape requires atom-like) — pre-existing elision gives `*(a + b)(y)`, D4 leaves it alone |
| `(!)(x)` | operator ATOM as callee — parens are load-bearing |

## Mechanism

The output paren sits OUTSIDE the operator token, so this cannot be a paren
elision — it is a paren MOVE. `canonicalize_callee_prefix_calls` rewrites the
token list before every layout/elision pass: drop the func's call parens, insert
a synthetic grouping pair around the operator (anchored on the tokens it
prepends, so rows/columns/offsets stay sane), and let the existing machinery run
on the rewritten list — D3 then tightens inner prefix calls (`(**u8)`), multiline
and spacing decisions treat the synthetic parens as ordinary tokens, and
`format_yo_source`'s verify gate re-parses the output against the input AST. The
gate's early-return condition is `elided + moved == 0` so a file whose only
rewrite is the surgery still gets verified.

Files where `exprs_are_equal` cannot prove output ≡ input (the `quote(...)` /
`#(...)` splice class) keep their original spelling — the gate falls back to
no-elision/no-surgery for the whole file. The 2026-09-06 sweep hand-edited those
few files.
