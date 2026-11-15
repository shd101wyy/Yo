# `yo fix --migrate unsized` suggestions print desugared text, and it lists the prelude's `Dyn` record itself

**Severity:** S3 (listing text only; nothing is rewritten wrongly)

**Status:** OPEN. Found 2026-11-15 by the S2 sweep rehearsal (`vbd/d49-flip-swept`).

## What happens

A `dyn(...)` or `Dyn(...)` written over several lines is listed for a hand rewrite ("does not print
back on one line"). The suggested replacement is `ast_expr_to_string` of the evaluated tree, so it
prints the desugarings, not what the user wrote:

- a template string prints as `begin(__yo_tpl_687030 := ("".to_string)(), (__yo_tpl_687030.push_str)(...), ...)`;
- a method call prints as `(x.f)(...)`;
- a `&T` parameter in a `Fn(...)` trait prints as `__yo_imm(expr) : AstExpr`.

That last one is `src/evaluator/shared/suspension_analysis.yo`'s
`detect : Dyn(Fn(...))` field, which the rehearsal had to rewrite by hand. It is also a MISS: a
by-value `Dyn(...)` field type over several lines stays as written, and it is E0619 under the flip.

The prelude's own `Dyn :: (fn(...) -> ...)` constructor record at `std/prelude.yo:8109`
(`Dyn(required_traits : ..., negative_traits : ...)`) is listed too. It is the definition of `Dyn`,
not a use of the type.

Counts in the rehearsal: 203 multi-line `dyn(...)` sites listed (legal in v0.2.78 through the alias,
so S3b must handle them), 1 multi-line `Dyn(...)` field, and the prelude record.

## Direction

- Print the suggestion from the source span: splice `Box(`…`)` or `Box.new(`…`)` around the written
  text instead of re-printing the tree. That would also let the multi-line sites be rewritten
  rather than listed.
- Skip the `Dyn` record's own definition.

No test yet: there is no fix to pin.
