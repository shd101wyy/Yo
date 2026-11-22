# A re-point through a `match` binding keeps the binding and the cursor exclusive longer than needed

**Severity:** S3: a family of sound programs that Rust accepts is rejected with E0911. All of them sit around decision 25's cursor re-point under VERDICTS-71 rule (c). Each has a workaround that keeps the same program shape.

Filed 2026-11-21 by the cluster lane, on VERDICTS-71 addendum 2's ruling (`v0280/clusters`, rule (c) with B).

## The family

Rule (c) makes each place binding `n` of a `&mut` match over a local borrow `cur` an exclusive borrow of `cur`'s place.
A re-point `cur = &mut n.next` freezes `n` whole for `cur`'s live range. Yo keeps one registry record for `cur`
across the re-point, and `n`'s registration extends that record's range to `n`'s last mention. Every member below is
sound to reject, but stricter than needed:

| Row | Program (inside `match(cur, .Some(n) => { … })`) | Verdict | Rust |
| --- | --- | --- | --- |
| a2 | `cur = &mut n.next; n.value = i32(7);`, `cur` never read again | E0911 "Cannot read `n.*.value` here: `cur` borrows `n`" | accepts |
| a7 | `cur = &mut n.next; cur.* = .None; n.value = i32(7);` | E0911 at `cur.*` ("`n` borrows `cur`") | accepts |
| c2 | `cond((n.value > i32(0)) => { cur = &mut n.next; }, true => { n.value = i32(7); })`, `cur` used after the match | E0911 ("`cur` borrows `n`"): the freeze is positional, not per path | accepts |
| sib1 | `.Two(l, tag) => match(l, .Some(b) => { cur = &mut b.kids; tag.* = i32(1); })` | E0911 "Cannot re-point `cur` here: `tag` borrows from `cur`'s current target" | accepts |

In b3, a later mention of the direct binding `m` in a nested walk (`cur = &mut m.next; seen = m.value;`) extends its
ancestor `n`. The re-point is then rejected naming `n` ("Cannot re-point `cur` here: `n` borrows from `cur`'s current
target"), not as "Cannot read `m`". The program is rejected soundly, but the message blames the wrong binding.

a2's message has a wart. It says `cur` "is still live" although `cur` has no later mention, so its help ("make the
access after `cur`'s last use") cannot be followed. The help that works is "use `n` before the re-point".

G-B rows that pin today's verdicts, so they flip together when this is fixed:

- `tests/origins/unsound/a3-repoint-then-binding-write.yo` (a2)
- `a3-repoint-write-through-cur-then-binding.yo` (a7)
- `a3-repoint-on-one-branch-binding-write-on-another.yo` (c2)
- `a3-repoint-live-sibling-binding.yo` (sib1)

## Workarounds (measured, accepted)

- Use `n` before the step: `n.value = i32(7); cur = &mut n.next;` (c4,
  `tests/origins/unsound/a3-repoint-then-binding-write-pos.yo`).
- Put the branch that writes `n` before the branch that re-points (c2b,
  `tests/origins/unsound/a3-repoint-on-one-branch-binding-write-on-another-pos.yo`).
- For sib1, end the sibling's use before the re-point (sib2, `a3-repoint-live-sibling-binding-pos.yo`).

## Fix direction

Rust accepts the whole family for one reason: a re-point starts a new loan, and `n` borrows the old one. The exact fix
is a loan per definition of `cur`, the place model's deref step, which belongs to the `modes` and `flow` place-model
work.

It is explicitly not a separate freeze range on the shared record. VERDICTS-71 addendum 2 measured that a second range
on the shared record would only accept a2, a program whose re-point is a dead store. It leaves a7 and c2 rejected, and
splitting the one `last_use`/`end` pair risks reopening b2 (`cur = &mut n.next; l1.head = .None; n.value = i32(7);`),
which is a memory error.
