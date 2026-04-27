# `break`/`continue` skipped loop-body deferred drops, leaking RC values

## Summary

When `break` or `continue` was used inside a loop body — particularly inside a
nested begin block such as a `match` arm — the C codegen jumped to the loop
exit label without first emitting the deferred drop expressions for variables
declared earlier in the loop body's begin block. RC-typed values (Strings,
Boxes, Options carrying RC payloads, ArrayLists, etc.) bound in the loop body
were therefore leaked on every iteration that exited via `break`/`continue`.

This was discovered while bootstrapping the parser to Yo (`yo-self/parser/`):
ASan reported indirect leaks of `next_tok` payload data on a `Pratt`-style
loop that used `break` inside `match(...)` arms.

## Reproducer

Minimal Pattern 2 (`break` inside a `match` arm in `while runtime(true)`,
with an RC-typed binding declared after the break) — see
`tests/escape_cleanup_uninit_vars.test.yo`:

```rust
open import "std/string";
open import "std/error";
open import "std/fmt";

ParseError :: object(message : String);
impl(ParseError, ToString(to_string : ((self) -> `parse error`)));
impl(ParseError, Error());

Token :: object(name : String);
ParseResult :: object(label : String, index : usize);

get_opt_token :: (fn(present : bool) -> Option(Token))(
  cond(present => .Some(Token(name: `tok`)), true => .None)
);

collect_one :: (fn(present : bool, using(exn : Exception)) -> ParseResult)({
  (final_label : String) = `default`;
  while runtime(true), {
    match(get_opt_token(present),
      .None    => { break; },
      .Some(next_tok) => {
        if((next_tok.name == `stop`), { break; });
        chain_pr := ParseResult(label: next_tok.name, index: usize(1));
        final_label = chain_pr.label;
        break;
      }
    );
  };
  ParseResult(label: final_label, index: usize(0))
});
```

Compiled with `--sanitize address`, ASan reported leaks for the `Option(Token)`
discriminant temp and for the `chain_pr` / inner temps every time `break`
fired before the natural end-of-iteration drop block.

## Root cause

The codegen for loop bodies (`generateLoopBody` in
`src/codegen/exprs/while.ts`) used to populate `pendingDeferredDrops`
**incrementally**, scanning the env after each statement and `unshift`ing
drops only for variables that had become live. This left two windows where a
break/continue inside a still-running statement could see only the outer-scope
drops:

1. The body's per-iteration `Option(...)` discriminant temp had not yet been
   activated when a nested `if(..., break)` fired inside the match arm.
2. Drops for variables declared earlier in the same begin block (e.g.
   `chain_pr`) were not always emitted because the `consumedAtToken` check in
   `emitLoopBodyDropsBeforeExit` triggered false-positive skips — the deferred
   drop synthesis itself marks variables as consumed via a sentinel token.

## Fix

Two-part change:

1. **`src/codegen/exprs/while.ts` — populate body drops up front.**
   Match the strategy already used by `generateBegin`: prepend ALL body drops
   to `pendingDeferredDrops` before processing statements. Liveness is then
   handled by the position-based filter in
   `emitLoopBodyDropsBeforeExit`.
2. **`src/codegen/exprs/atom.ts` — env-aware filter for break/continue.**
   In `emitLoopBodyDropsBeforeExit`, look up each drop's target variable in
   its captured env and compare `initializedAtToken.position.character` to
   the exit token's position. Drops for variables declared **after** the exit
   point are skipped (avoids "use of undeclared identifier" C errors and
   double-drops). Do **not** consult `consumedAtToken` here — drop synthesis
   marks targets consumed with sentinel tokens, so it is unreliable for
   liveness.

## Verification

- `tests/escape_cleanup_uninit_vars.test.yo` covers the Pattern 2 reproducer
  (`break` inside `Some` arm before later RC binding).
- `tests/algebraic_effects.test.yo` (57 tests) — passes, including the
  `break/continue in Option match arm` cases.
- `tests/iter_filter_closure.test.yo`, `tests/iterator_combinators.test.yo`,
  `tests/basic.test.yo` — all pass under ASan.
- The original `/tmp/drop_debug.yo` reproducer reports 0 leaked bytes.
