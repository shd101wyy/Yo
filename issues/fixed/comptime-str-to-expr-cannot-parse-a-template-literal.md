# `comptime_str.to_expr()` cannot parse a backtick template literal

**Status:** FIXED 2026-09-08
**Found:** 2026-09-07, while fixing `issues/fixed/derive-tostring-debug-body-is-unhygienic-and-aborts.md`

Already known as authoring guidance — `.github/skills/yo-syntax/syntax-cheatsheet.md`
carried "a raw backtick inside a `"..."` code string splits the parse" — but never
filed, so the reproducer, the misleading error message and the `comptime_eval`
asymmetry below were not recorded anywhere.

## Symptom

`to_expr()` on a source string holding a backtick literal makes the surrounding
derive rule fail with a type error, not a parse error:

```
error: derive: derive rule must return(comptime(Expr)); got Comptime
```

## Reproducer

A user-defined derive rule, with the spliced source varied and nothing else changed:

```rust
{ println } :: import("std/fmt");
{ String } :: import("std/string");
Lbl :: trait(lbl : (fn(inout(self) : Self) -> String));
__r :: (fn(comptime(T) : Type, comptime(ctx) : DeriveContext, comptime(tp) : ComptimeList(Expr)) -> comptime(Expr))({
  src :: "`BQ_OK`";                       // ← vary this
  ctx.make_impl(quote(Lbl(lbl : ((self) -> #(src.to_expr())))))
});
derive_rule(Lbl, __r);
P :: struct(x : i32);
derive(P, Lbl);
main :: (fn() -> unit)(println(P(x : i32(1)).lbl()));
export(main);
```

| `src` | result |
| --- | --- |
| `"String.from(\"CTRL_OK\")"` | prints `CTRL_OK` |
| `"i32(7).to_string()"` | prints `7` |
| ``"`BQ_OK`"`` | **`derive rule must return(comptime(Expr)); got Comptime`** |

So it is specific to the template literal, not to `to_expr` or to the splice.

## Notes

- `comptime_eval("`hello`")` **does** accept a backtick literal, so the parser itself
  handles them — the gap is in the `to_expr` path
  (`__yo_comptime_string_to_expr`, `src/evaluator/builtins/type_fns.yo:1478`).
- That builtin strips a leading/trailing `"` from `StrLit.raw` before calling
  `generate_expr_from_code`:
  ```
  code_str := if(raw.starts_with(String.from("\"")), raw.substring(usize(1), n_raw - usize(1)), raw)
  ```
  A backtick-quoted raw is a plausible suspect for that logic, but this has not
  been confirmed — the failure surfaces as a *type* mismatch (`got Comptime`),
  which suggests the throw is swallowed and an unknown value is returned rather
  than the parse error being reported.
- The misleading error message is itself worth fixing: a parse failure inside
  `to_expr` should say so, at the offending source, instead of surfacing as
  "derive rule must return(comptime(Expr))".

## Why it mattered

The natural fix for the derive hygiene bug was to emit template-literal bodies
(`` `P(${self.x.debug_string()})` ``), which reference no module-scope name. That
route is blocked by this bug, so the hygiene fix instead emits
`"P(".to_string()` — a `str` literal plus a type-resolved method call, which also
carries no free names.

## Root cause (measured)

`generate_expr_from_code` (`src/parser.yo`) throws unless the parse yields
EXACTLY one expression. Dumping the parse of `` `FIXED` `` shows it yields **two**:

```
[gefc] expr[0] = import("std/fmt/to_string")     ← injected by the parser
[gefc] expr[1] = ("FIXED".to_string)()           ← the value
```

A template literal desugars to `"...".to_string()` **plus a prepended import** so
that a whole FILE containing one is self-sufficient. Every template literal is
therefore two expressions and was rejected — which is why `.to_expr()` could not
build one, and why `derive` reported the unrelated-looking "derive rule must
return(comptime(Expr)); got Comptime": the parse error was swallowed and the
half-built value reported its own type.

This is the same injected import behind
`issues/nested-backtick-template-interpolates-the-injected-import.md`.

## Fix

`generate_expr_from_code` drops LEADING `import(...)` nodes and returns the tail.
The injected import exists to make a whole file self-sufficient; a spliced
fragment is evaluated in the splice site's scope instead, and the `.to_string()`
the desugaring emits is a METHOD call resolved through the receiver's type —
`impl(str, ToString(...))`, registered once by whichever module loaded
`std/fmt/to_string`, which is necessarily loaded wherever a template literal is
being built.

**Folding them into a `begin` instead was tried and reverted.** The import is
then a runtime statement and codegen tries to materialise the MODULE as a C
value: `use of undeclared identifier '__yo_t9'` from
`(__yo_t9){ .ToString = /* Error: no C type name for ToString */, ... }`.

Only leading imports are dropped. A genuinely multi-statement string still
errors — verified: `"i32(1); i32(2)"` still reports "expected exactly 1
expression from parsed code, got: 2", so the documented "wrap statement blocks
in parens" rule is unchanged.

## Regression tests

`tests/derive.test.yo` — two custom derive rules splicing a template literal
through `.to_expr()`: a plain one (`` `TE_PLAIN` ``) and an interpolating one
(`` `P(${self.x.to_string()})` `` → `P(7)`). Both failed before the fix.

## Follow-up now unblocked

`__derive_structural_body` could go back to emitting template literals instead of
the `"…".to_string()` chain it uses today
(`issues/fixed/derive-tostring-debug-body-is-unhygienic-and-aborts.md`). Both are
identifier-free, so this is a simplification, not a correctness fix — worth doing
only alongside a re-record of the derive goldens.
