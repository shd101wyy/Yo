# A `match` over a reference-returning call is rejected as a copy of a move-only value

**Severity:** S2. `match(id(&k), r => r.len())`, where `id :: (fn(a : &String) -> &String)(a)`, is rejected with
E0901 "cannot copy `id(&(k))`, whose type `String` is move-only, and it cannot be moved either": the scrutinee is a
`&String`, nothing is copied or moved, and binding the result first (`r2 := id(&k); match(r2, …)`) is accepted.
A valid program is refused with a message about a copy that does not exist; no unsoundness. Not comparable on
v0.2.76, which rejects the definition of `id` itself (E0901 "cannot copy `a` … it is a `&mut` borrow").

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 C3). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-match-over-a-reference-returning-call-is-rejected-as-a-copy-of-a-move-only-value.yo`
(positive, expects accept):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
id :: (fn(a : &String) -> &String)(a);
main :: (fn() -> unit)({
  k := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
  n := match(id(&k), r => r.len());
  println(`OUT: ${n.to_string()}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710
error[E0901]: use of moved value: cannot copy `id(&(k))`, whose type `String` is move-only, and it cannot be
moved either: it is borrowed from the value that holds it (an element, or a binding into another value).
```

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `match(id(&k), r => r.len())` | E0901 | accept |
| `match(id(&longs()), r => …)` inside a template, beside `id(&longs()).len()` operands | E0901 (ledger) | accept |
| `match(c.borrow_mut().get(), r => r.len())` (a user guard's `&self` projection) | E0901 (ledger) | accept |
| `(r : &String) = match(id(&longs()), q => q)`, `r` read after the statement | E0901 (ledger) | E0911 (R-TEMP: `longs()` dies with the statement) |
| `match(&id(&k), r => r.len())` (an explicit `&` marker) | E0901, same text | accept |
| `r2 := id(&k); match(r2, q => q.len())` | accepted, `OUT: 72` | — |

The `(r : &String) = …` row is the one where a rejection is due, but for the temporary, not for a copy.

## Root cause

The message is `transfer_explicit_copy_value`'s (`src/evaluator/utils.yo`, reached from
`set_expr_as_needs_to_call_dup`), the copy-or-move transfer of a value that is not implicitly copyable: the
projection call's result sits in a compiler temporary that does not own its value (`is_owning_the_rc_value()` is
false), so the transfer is judged a copy out of borrowed storage, "it is borrowed from the value that holds it". The
type it reads is the payload's (`String`): the reference is judged as if it were the value.

Which caller in the `match` evaluation transfers the scrutinee is not established. It is not the mode decision:
`_decide_match_mode` (`src/evaluator/exprs/match.yo`) has its own message ("Cannot match `…` by value"), returns
`MATCH_MODE_BORROW` for an explicit `&` marker, and yet `match(&id(&k), …)` fails with the same text. Its temporary
branch has the same gap (a non-owning temporary is `_throw_unmovable_scrutinee`, with no case for a scrutinee that
IS a reference), so a fix needs both.

## Expected

Accepted, `r` a `&String` borrow of `k` for the arm. `plans/VALUES_BY_DEFAULT.md` decision 26: a `&` scrutinee's
bindings "`&` borrow", because "Nothing can be moved out of a borrow, so the match follows the scrutinee's mode."
A reference VALUE a call returns is such a scrutinee, the same as `r2 := id(&k); match(r2, …)`; its origin (R-CALL:
`k`, plus the R-TEMP entry when an argument is a temporary) is what the arm bindings carry (BCC: "arm bindings of a
borrowed scrutinee `bind` with the scrutinee's entries"), which also gives the `(r : &String) = …` row its E0911.

## Test

With the fix: the repro moves to `tests/origins/unsound/` as a positive program (with a negative beside it: the
`(r : &String) = match(id(&longs()), q => q)` row, expecting E0911); rows in `tests/match_binding_lend.test.yo`, and a corpus row next to
`match-arm-binding-origin` in `tests/origins/corpus.tsv`.
