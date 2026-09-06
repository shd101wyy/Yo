# `glob`: `[a-z]` ranges were not implemented and `*` backtracked exponentially

**Status: FIXED** (2026-09-06, `std/glob.yo`). Found by the std API audit —
`plans/STD_API_STABILIZATION.md` §3 item 10.

## Symptoms

1. **Ranges.** The character-class scanner compared every byte between `[`
   and `]` to the text byte, so `[a-z]` was the three-member set `{a, -, z}`:
   `glob_match("[a-z].txt", "b.txt")` was `false`.
2. **Exponential `*`.** `_glob_match_impl` recursed on every `*` — try
   "matches nothing", else consume one byte and recurse — so a pattern with
   k stars against a text of n bytes explored O(n^k) paths on a miss.
   `*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*c` against sixty `a`s and a `b` did not
   return.

## Fix

The matcher is rewritten as one iterative run per `**`:

- a single `*` is resolved by the classic wildcard algorithm — on a mismatch,
  back up to the most recent `*` and let it absorb one more byte — O(|p|·|t|)
  per run. The `/` barrier keeps it exact: every literal `/` in the pattern
  must match a `/` in the text and no `*` may eat one, so the text a later
  `*` is asked to absorb on backtrack never contains a `/` an earlier `*`
  "should have" taken (the slash counts on both sides of any prefix agree);
- only `**` recurses, once per candidate resume position, so cost is
  polynomial in the text and exponential only in the number of `**`s;
- classes support `lo-hi` ranges, `-` first/last as a literal, `]` first as a
  literal member (POSIX), and `!`/`^` negation. `?` and `[…]` — negated or not
  — never match `/`; an unterminated `[` matches nothing (as before).

## Regression tests

`tests/glob/glob.test.yo` — "glob character ranges" (12 assertions) and "glob
star is polynomial" (the 17-star pattern above, `**`/`*` interleaving, literal
`/` after a star). The nine existing tests are unchanged and still pass.
