# Escape inside expression argument double-frees / leaks

## Summary

`escape value` inside an expression argument that constructs RC values would
double-free or leak temporaries. The escape codegen path generated drops for
ALL `pendingDeferredDrops` AND for `consumedVarPendingDrops`, but did not
exclude drops whose targets had already been emitted/consumed inline by the
`escape` argument expression itself. It also failed to truncate the snapshot
of the argument's intermediate temporaries, so the same temp was dropped
twice (once inline, once by the escape cleanup tail).

## Reproducer

Pattern 1 of `tests/escape_cleanup_uninit_vars.test.yo` — the escape arm of
a `match` whose result initializes a new variable:

```rust
open import "std/string";
open import "std/error";

ParseError :: object(message : String);
impl(ParseError, ToString(to_string : ((self) -> `parse error`)));
impl(ParseError, Error());

Token :: object(name : String);
ParseResult :: object(label : String, index : usize);

get_opt_token :: (fn(present : bool) -> Option(Token))(
  cond(present => .Some(Token(name: `tok`)), true => .None)
);

parse_one :: (fn(present : bool, using(exn : Exception)) -> ParseResult)({
  (tok : Token) = match(get_opt_token(present),
    .None    => exn.throw(dyn ParseError(message: `eof`)),
    .Some(t) => t
  );
  ParseResult(label: tok.name, index: usize(0))
});
```

When `present == false` the `.None` arm escapes via `exn.throw`. The escape
codegen path used to emit drops for ALL pending deferred drops, including
`tok` — which was _not yet initialized_ at that point — and to re-drop the
intermediate `Option(Token)` discriminant temp that the `match` had already
consumed.

## Root cause

`generateEscape` in `src/codegen/exprs/generation.ts` did not:

1. Snapshot the pending drop list before generating the argument expression,
   then truncate to that snapshot length so only drops for variables that
   existed BEFORE the escape arg are considered.
2. Filter out drop entries whose target variable name was consumed during
   the argument generation (those are already dropped inline by the
   ownership-transfer code path).

## Fix

`generateEscape` now:

- Captures `pendingDeferredDrops` and `consumedVarPendingDrops` lengths before
  generating the escape argument.
- After generation, only iterates over the entries that existed BEFORE the
  argument was generated.
- Skips any of those entries whose target var name matches a variable that
  the escape argument consumed (looked up via
  `getDeferredDropTargetAtomName`).

## Verification

- `tests/escape_cleanup_uninit_vars.test.yo` — Pattern 1 passes under ASan.
- `tests/algebraic_effects.test.yo` (57 tests) — passes.
