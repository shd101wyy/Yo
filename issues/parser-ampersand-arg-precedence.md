# Parser: `&x` as a call argument is parsed greedily

## Severity

Medium — silent surprising failure with confusing error message.

## Symptom

A function call where the **first** (or any) argument is `&ident` without
parentheses produces:

```
Error: Too few arguments for function call:
Expected: N arguments
Got:   1 arguments
```

even though syntactically the user wrote N arguments.

## Minimal repro

```rust
foo :: (fn(p : *(i32), a : i32) -> i32)( i32(0) );
main :: (fn() -> unit)({
  (x : i32) = i32(0);
  r := foo(&x, i32(1));   // ERROR: Got: 1 arguments
  ()
});
export main;
```

Wrapping `&x` in parens fixes it:

```rust
  r := foo((&x), i32(1));   // OK
```

## Cause hypothesis

The `&` (address-of) unary operator is being parsed with a precedence that
swallows the trailing comma-separated argument list as a single tuple
operand. So `foo(&x, y, z)` ends up parsed roughly as `foo(&(x, y, z))`,
giving the call exactly one argument (the `&(...)` expression).

This is consistent with the existing rule documented in the syntax skill:

> Unary operators need parenthesized operands: `!(ready)`.

## Workaround

Always parenthesize `&` operands in call arguments:

```rust
foo((&x), arg1, arg2)
(&x).method(arg1, arg2)   // already required for method calls
```

This matches the existing convention in `yo-self/evaluator/eval.yo` and
`yo-self/evaluator/async/await_analysis.yo`, which always write
`(&fresh_fn_env).define_val(...)`, `(&ty).clone()`, etc.

## Suggested real fix

Tighten the parser so the `&` unary operator binds only the immediate
following primary expression (an identifier, member access, or
parenthesized expression), not a comma-separated argument list. Or, more
permissively, emit a clearer error that `&x` requires parens in this
context.

## Related

- `.github/skills/yo-syntax/syntax-cheatsheet.md` already notes
  unary operators need parenthesized operands.
- Issue arose while porting yo-self `add_variable_to_env`.
