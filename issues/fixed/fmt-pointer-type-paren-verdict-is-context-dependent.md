# `yo fmt` gives two different verdicts for the SAME pointer-type spelling

**Severity:** S3 — the identical pointer spelling gets opposite `fmt --check` verdicts per file — the CI gate fails copied code

**Status: FIXED** (2026-10-05, branch `s3/batch-2-fixes`). Observed 2026-09-07
while integrating the D-batch PRs
(`plans/archive/STD_API_STABILIZATION.md`). Not a blocker — the fix is to run `yo fmt`
and take whatever it produces — but it makes `fmt --check` unpredictable when
writing new code, and it cost a CI-visible failure on PR #461.

## The observation

Two files in `std/collections/` contain the **byte-identical** text
`Item : *(MapEntry(K, V)),` inside a structurally identical `impl` block:

| file:line | text | `fmt --check` |
| --- | --- | --- |
| `std/collections/hash_map.yo:694` | `    Item : *(MapEntry(K, V)),` | **rc=0 (clean)** |
| `std/collections/ordered_map.yo:280` (as written by D14, PR #461) | `    Item : *(MapEntry(K, V)),` | **rc=1**, rewritten to `*MapEntry(K, V)` |

Both sit in:

```rust
impl(
  generic(K : Type, V : Type),
  where(K <: (Eq(K), Hash)),
  <Iter>(K, V),
  Iterator(
    Item : *(MapEntry(K, V)),
    next : (fn(inout(self) : Self) -> Option(*(MapEntry(K, V))))(...)
  )
);
```

and both import `MapEntry` from `./entry.yo`.

So the formatter accepts the parenthesized form in one place and canonicalizes
it away in another. Whatever selects between them is NOT the pointer type, the
enclosing `Iterator(...)`, the `where` clause, or where `MapEntry` comes from —
those are the same on both sides.

Three experiments narrow it to a **file-scope** trigger, not a construct-scope
one:

1. **A reduced probe fails.** A fresh file containing the same `impl` shape
   (same `where`, same `Iterator(...)`, `MapEntry` imported from
   `std/collections/entry.yo`) reports rc=1 — it behaves like
   `ordered_map.yo`, so `hash_map.yo` is the outlier.
2. **`hash_map.yo`'s rc=0 is NOT vacuous** — fmt really does process it.
   Damaging an unrelated line (`contains_key`'s indent, ~250 lines away)
   makes `fmt --check` report rc=1, and `fmt` then repairs that indent — while
   leaving `Item : *(MapEntry(K, V))` on line 690 untouched in the same run.
   So this is not fmt bailing out on the file.
3. **The SAME block is preserved when pasted INTO `hash_map.yo`.** Appending
   the reduced probe's `impl` verbatim to the end of `hash_map.yo` and running
   `fmt` leaves BOTH `Item : *(MapEntry(K, V))` lines (690 and 998) intact —
   the identical text that gets rewritten in a standalone file.

So something at FILE scope in `hash_map.yo` makes the formatter keep the
parentheses, and it is not the pointer type, the enclosing `Iterator(...)`,
the `where` clause, where `MapEntry` comes from, or the surrounding `impl`.
The mechanism is NOT yet isolated — that needs reading `src/formatter.yo`,
which is why this is filed rather than fixed.

## Why it matters

`fmt --check ./std ./tests ./src` is a required CI step
(`.github/workflows/test.yml`), so writing the "wrong" one of two spellings that
both appear in the tree fails the build. A contributor copying the shape from
`hash_map.yo` — the natural thing to do, since it is the sibling
implementation — produces a file CI rejects.

Related, already recorded as working knowledge: `yo fmt` is non-idempotent and
is not a syntax gate.

## Reproducing

No new fixture needed — both witnesses are checked in:

```bash
yo fmt --check std/collections/hash_map.yo    # rc=0
# then write `Item : *(MapEntry(K, V))` into ordered_map.yo's OrderedMapIterPtr
yo fmt --check std/collections/ordered_map.yo # rc=1
```

## Next step

Find the branch in `src/formatter.yo` that decides whether to keep the
parentheses around a parameterized pointee, and make it a single rule. Then
pick ONE canonical spelling and sweep the tree, the way #459 did for the
callee-position prefix cast `(*T)(x)`.

## Fixed

The pointer type was never the decider — the `(...)`-around-the-pointee
elision (`*(MapEntry(K, V))` → `*MapEntry(K, V)`) was being silently
disabled FILE-WIDE in any file that also carries a NON-prefix-capable
operator's operand call. `is_redundant_grouping_paren`'s D1 rule ("an
atom-like operand needs no parens after ANY operator") elided the CALL paren
of `...` in hash_map.yo's trailing spread-rest macro
(`fn(...(quote(entries)))` → `fn(...quote(entries))`, a parse error — E0008,
`paren-less function and operator calls are not supported`), so the
re-parse verify gate in `format_yo_source` failed and reformatted the whole
file with `elide_parens=false`; ordered_map.yo, with no such macro, kept
elision on. The same class covered `#(x)` unquotes and `...#(x)` splices.
The fix adds `is_non_prefix_operator_call_paren` (src/formatter.yo): a `(`
whose previous meaningful token is a non-prefix-capable operator in prefix
position is that operator's call delimiter (`...`/`#`/`...#` have no bare
prefix form, so the tight call is their only operand grammar) and is never
elided; infix position is unaffected (`a + (y)` still flattens), judged via
the same rvalue-end-before-the-operator test `prefix_call_paren_shape`
uses. Five regression cases in tests/internal/formatter.test.yo (verified
red first), including the two-file verdict-consistency case; the fixture
`33_keeps_macro_splice_calls_tight.expected` and the gate-conservative
splice-group test moved to the now-canonical output (their old expectations
pinned the file-wide fallback, and the splice call parens themselves stay
tight — the fixture's actual concern). `yo fmt` then swept the ten files
the fix re-enabled elision in (std/collections/{hash_map,array_list,
hash_set}.yo, std/encoding/json.yo, std/error.yo, std/fmt/to_string.yo,
std/prelude.yo, tests/derive.test.yo, tests/variadic_comptime.test.yo, and
the ftt-stub cli-case fixture, re-recorded); every hunk is a documented
elision class. `yo fmt --check ./src ./std ./tests` green;
`yo check ./std` 178/178; `yo check ./src` 278/278;
tests/internal/formatter.test.yo 51/51. Fixed 2026-10-05 on branch
`s3/batch-2-fixes`.
