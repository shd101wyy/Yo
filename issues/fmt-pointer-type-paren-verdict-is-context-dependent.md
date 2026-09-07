# `yo fmt` gives two different verdicts for the SAME pointer-type spelling

**Status:** OPEN. Observed 2026-09-07 while integrating the D-batch PRs
(`plans/STD_API_STABILIZATION.md`). Not a blocker — the fix is to run `yo fmt`
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

A reduced probe (a fresh file with the same `impl` shape and a one-line `.None`
body) reports rc=1, i.e. it behaves like `ordered_map.yo`, NOT like
`hash_map.yo` — so `hash_map.yo` is the outlier and something in its context is
suppressing the rewrite. The remaining difference between the two real files is
the shape of the `next` BODY: `hash_map.yo` opens `(` + newline + `cond(`,
while `ordered_map.yo` opens `({`.

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
