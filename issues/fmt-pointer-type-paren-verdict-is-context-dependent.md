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
