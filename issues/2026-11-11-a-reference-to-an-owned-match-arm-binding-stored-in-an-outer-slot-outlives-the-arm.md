# A reference to an owned match arm binding stored in an outer slot outlives the arm

**Severity:** S1. In `match(o, .Some(bx) => { slot = match(&bx, Box(s) => Option(&String).Some(s)); }, …)` the slot
declared before the `match` keeps a reference into `bx`, an OWNED binding of the by-value `match` that is dropped at
the arm's end; `yo check` accepts it and the read of `slot` after the `match` is a heap-use-after-free. The same store
through a `:=` copy of the binding (`w := v; slot = .Some(&w)`) is E0911. Pre-existing: v0.2.76 accepts it too.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A21). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-reference-to-an-owned-match-arm-binding-stored-in-an-outer-slot-outlives-the-arm.yo`
(negative, expects E0911):

```yo
L :: (fn() -> String)(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
main :: (fn() -> unit)({
  mut(slot) := Option(&String).None;
  o := Option(Box(String)).Some(Box.new(L()));
  match(
    o,
    .Some(bx) => {
      slot = match(&bx, Box(s) => Option(&String).Some(s));
    },
    .None => ()
  );
  match(slot, .Some(r) => println(`OUT: ${r.*}`), .None => ());
  ()
});
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-direct.yo` (negative, E0911): `slot = .Some(&v)` with `v` the owned `String` arm binding. It runs without an
  ASan report but prints `OUT:` with an empty string: the read sees the dropped `String`.
- `…-pos.yo` (positive control): the slot is read inside the arm while `v` is alive and never after it.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| a reference into the owned arm binding's Box stored in an outer slot, read after the `match` | accepted, heap-use-after-free | E0911 |
| the scrutinee a call result, `match(mko(), .Some(x) => { slot = match(&x, …); })` (ledger sh01) | accepted, heap-use-after-free | E0911 |
| `slot = .Some(&v)` directly (`…-direct.yo`, ledger sh21) | accepted; prints the dropped `String` as empty | E0911 |
| `w := v; slot = .Some(&w)` (ledger sh22) | E0911 "Cannot store a reference to `w` in `slot` here: `w`'s scope ends with its block" | E0911 |

## Root cause

The store reaches the §7 scope check in `bind_join_roots_for` (`src/evaluator/utils.yo`) with the right ground root:
`YO_DEBUG_N2B=1` prints `join slot: roots=[bx(imm)]` for the main repro and `roots=[v(imm)]` for `…-direct.yo`. The
check compares the holder's live range with the root's scope end, which it takes from `_lb_binding_site_of(&root_v)`.
That function finds a binding only as a `:=` statement or a typed declaration in an armed look-ahead frame; a
pattern binding of a `match` arm is neither, so it returns `.None` and the check is skipped (`.None => ()`). The
loan is registered (the join entry exists), but the arm-end drop of an owned binding
(`drop_owned_match_binding_at_arm_end`) is not an access the entry is checked against, so nothing else fires.
`w := v` has a binding site, which is why sh22 is caught.

## Expected

E0911 at the store: an owned arm binding's scope is its arm, and its drop at the arm's end is the scope end the §7
check compares against ("`v`'s scope ends with its arm, while `slot` is live to its last use"). `REFERENCES_AND_ORIGINS.md`
O3 step 2: a loan conflicts with a "read, write, move, drop" of a place in its origin; `BORROW_CHECKER_COMPLETENESS.md`
§3 (`bind`): "a root's scope-end drop before that drop is an `access(root, drop)` conflict". The same applies to any
other binder that owns its value and has no `:=` statement (a by-value `for` element is the next shape to probe).

## Test

With the fix: both negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`store-owned-arm-binding-past-arm` (neg, E0911) and `store-owned-arm-binding-in-arm` (pos) in
`tests/origins/corpus.tsv`.
