# `typeid`'s diagnostic suggests an `is()` builtin that does not exist

**Status:** FIXED 2026-09-09 (found while documenting `downcast`).

## The message

`src/evaluator/builtins/typeid.yo:84` — when `typeid`'s argument is a VALUE
rather than a type:

```
typeid expects a type argument. Use is() or downcast() for runtime type checks on Dyn values.
```

## The problem

**There is no `is()` in the language.** The builtin-name table in
`src/expr.yo:24-77` has no `BF_IS`, and nothing in `src/` or `std/` defines,
exports, or dispatches an `is` function. Grepping the tree for it finds only
this diagnostic.

So a user who hits this error and follows the advice gets a second, unrelated
error (`Variable "is" not found`), and has to discover the real answer —
`downcast(v, T)` — from the second half of the same sentence.

The message is otherwise correct: `downcast(dyn_value, T) -> Option(T)` IS the
runtime type check for a `Dyn`, and `std/error.yo`'s `error_is(err, T)` is the
`AnyError`-shaped wrapper over it.

## Reproducer

`issues/repros/typeid-on-a-value-suggests-is.yo`:

```rust
main :: (fn() -> unit)({
  x := i32(1);
  y := typeid(x);
  ()
});
export(main);
```

`yo check` on it reports the message above. The binding has to be plain —
wrapping it in `comptime_print(...)` replaces the diagnostic with
`Failed to evaluate argument for "comptime_print": typeid(x)`, which is a
second, separate reporting gap (the inner throw is swallowed and only the
wrapper's own failure is shown).

## The fix

`src/evaluator/builtins/typeid.yo` now names only things that exist:

```
typeid expects a type argument. For a runtime type check on a Dyn value use
downcast(value, T), which returns Option(T) — or error_is(err, T) for an
AnyError.
```

Guidance: user-facing error messages must never cite an API that does not
exist — see `.github/instructions/documentation.instructions.md` and the
`yo-docs-and-errors` rule (errors never cite `plans/*.md` either).

## Coverage

`tests/cli-cases/check-typeid-on-a-value` — a `yo check` over the reproducer
with `stdout_keep_match=downcast(value, T), which returns Option(T)`.
A `comptime_expect_error` cannot cover this: it asserts only THAT an expression
fails, never with which message, and the whole defect here is the message.
