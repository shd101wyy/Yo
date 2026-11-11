# A lend of a holder's own field stored into the holder is recorded as the holder's earlier loans

**Severity:** S1. `a = S(x : big(), y : .Some(&a.x))` stores a reference to `a`'s own field into `a`. The checker
records `a`'s flow set as the loans `a` held BEFORE the store (`{z}`), not `{a.x}`, so `a` is not frozen by its own
lend: `mut(b) := a; b.x = big();` is accepted and `b.y` reads the Box that write freed (ASan: heap-use-after-free).
The field-write form `a.y = .Some(&a.x)` behaves the same once `a` already holds another loan. Pre-existing:
v0.2.76 accepts both.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A27). Confirmed on develop `64f33c710`.

## Reproducers

`issues/repros/2026-11-11-a-lend-of-a-holders-own-field-stored-into-the-holder-is-recorded-as-the-holders-earlier-loans.yo`
(negative, expects E0911 at `mut(b) := a`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
big :: (fn() -> Box(X))(Box.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
S :: struct(x : Box(X), y : Option(&Box(X)));
main :: (fn() -> unit)({
  z := big();
  mut(a) := S(x : big(), y : Option(&Box(X)).Some(&z));
  a = S(x : big(), y : Option(&Box(X)).Some(&a.x));
  mut(b) := a;
  b.x = big();
  match(&b.y, .Some(r) => println(`OUT: ${r.*.*.s.len().to_string()}`), .None => ());
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
$ YO_DEBUG_N2B=1 yo check repro.yo
[n2b] join a: roots=[a(imm)] value=S(x : big(), y : (Option(&(Box(X))).Some)(&((a.x))))
[n2b] join-register a: site=yes end_char=717 ground=[z(imm)]
[n2b] bind b: roots=[z(imm)] rhs=a
```

- `…-field-write.yo` (negative, E0911): `a.y = .Some(&a.x)` on an `a` that already holds `&z`, then the same move
  and write.
- `…-pos.yo` (positive control): the stored lend points outward (`&w`, a local outliving `b`).

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `a = S(…, y : .Some(&a.x))` with `a` holding `&z`, then `mut(b) := a; b.x = big();` | accepted, heap-use-after-free | E0911 at the move |
| `a.y = .Some(&a.x)` with `a` holding `&z`, then the same move and write | accepted, heap-use-after-free | E0911 at the move |
| `a.y = .Some(&a.x)` with `a` holding nothing (`y : .None`), then `b := a` or `eat(a)` | E0911 "Cannot move `a` here: `a` borrows `a.x`" | E0911 |
| the tuple form `t.1 = .Some(&t.0); t.0 = big();` | E0911 | E0911 |
| `p := &mut a; p.y = .Some(&a.x)` | E0911 (the read of `a.x` under `p`) | E0911 |
| `a = S(…, y : .Some(&a.x))` and `a.y` read in place, no move (ledger) | accepted, runs | see Expected |

## Root cause

Verified in the source, with `YO_DEBUG_N2B`. `origin_of` gives the right root, the place `a.x`. The join
(`bind_join` → `bind_join_roots_for`, `src/evaluator/utils.yo`) first maps every root to its GROUND places with
`_origin_ground_roots` / `_origin_ground_root`: a root whose place's ROOT NAME has registered holder entries is
replaced by those entries, transitively. That step exists for a root at a borrow (the hidden `for` local, a
projection binding), whose places are what it borrows. It does not ask whether the root's path goes through a
reference. `a.x` is a field `a` OWNS by value, but `a` is itself a registered holder (`{z}`), so `a.x` is grounded
to `z`. The `=` then kills `a`'s old set and gens `{z}`: the lend of `a.x` is lost, and `b := a` inherits `{z}`.
With `a` holding nothing, `_origin_ground_root` finds no entries and keeps `a.x`, which is why the `.None`-initialized
program is rejected.

## Expected

E0911 at `mut(b) := a`, as the `.None`-initialized program gets: a move of `a` while a loan of `a.x` held by `a`
itself is live. A root is grounded through a holder's entries only when its path reaches the referent THROUGH a
reference (a reference binding, a `.*`, a reference field; `BORROW_CHECKER_COMPLETENESS.md` §3 R-DEREF / R-FIELD); a
place inside the holder's own storage (R-LEND, `{(a.x, &)}`) stays itself. O5 ("No self-reference",
`REFERENCES_AND_ORIGINS.md`) says a self-referential value "is not writable in safe Yo at all"; the checker today
admits the store and rejects only the move (liveness, decision 18). Whether the store itself should be E0911 is
O5's question and is not this defect; the move after it must be rejected under either reading.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows
`self-lend-reassigned-then-moved` (E0911) and `self-lend-field-write-over-held-loan` (E0911).
