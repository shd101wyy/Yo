# `.{ x : 1 }.x` is not parsed as a dot record followed by a field access

**Severity:** S3 — a spelling the new `.{ … }` record form (brace groups, Generation A) does not accept; a one-token workaround (parentheses) exists, and the bare `{ x : 1 }.x` keeps working.

## Reproducer

```yo ignore
main :: (fn() -> unit)({
  a := (.{ x : i32(5) }.x);
  ()
});
export(main);
```

`yo check` on it prints, verbatim:

```text
error: (1) Evaluating the expression (token: {) is not implemented:
{
  --> /tmp/brace_t.yo:2:10
  |
2 |   a := (.{ x : i32(5) }.x);
  |          ^
yo: error: check: 1 file(s) failed evaluator coverage
```

`yo fmt` also lays the same text out as a prefix-dot application, which confirms it parses as `.( {…}.x )`. The parenthesized `(.{ x : i32(5) }).x` parses, evaluates and runs (`tests/brace_record_dot.test.yo`, "a parenthesized dot record takes a trailing field access").

## Root cause

In `src/parser.yo` the prefix-dot branch parses its right-hand side with the ordinary postfix handling, so the field-value rhs `{ x : i32(5) }.x` is already a dot-access call node when control returns. The Generation A rule `is_dot_record` requires the rhs to BE the anonymous-struct call (`ast_expr_is_fn_call_of(&rhs_expr, BK_ANON_STRUCT, …)`), so it does not fire and the old prefix-dot path wraps the whole `{…}.x`, leaving an unevaluable brace atom.

## Workaround

Parenthesize the record: `(.{ x : i32(5) }).x`.

## Fix sketch

Detect the adjacent-brace case before the rhs absorbs its postfix chain (parse the record group alone, then continue the postfix chain on the resulting record node), and add the unparenthesized form to `tests/brace_record_dot.test.yo`; that test fails before the fix and passes after.
