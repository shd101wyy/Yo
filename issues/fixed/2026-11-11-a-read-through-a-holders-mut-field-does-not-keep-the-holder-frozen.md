# A `&` read through a holder's `&mut` field does not keep the holder frozen

**Severity:** S1. With `H(p) :: struct(m : &mut(ArrayList(String), p))` and
`first(self : &Self) -> &String = &self.m(0)`, `r := h.first()` takes only the field's origin (`xs`), not its union
with the holder `h`; `h.m.push(…)` then reallocates the list while `r` lives, and `r` is read (ASan:
heap-use-after-free). The same hole makes any user guard type (a `borrow_mut()` returning a holder of a `&mut`)
unsound. The plain-holder form is pre-existing (v0.2.76 accepts it); the guard form is a regression since v0.2.76,
which rejects it with E0911 "Cannot write `g.c.xs` here: `r` borrows `g` with `&`".

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A31). Confirmed on develop `64f33c710`. Consequence for
std: `RefCell.borrow()` / `borrow_mut()` guards must not ship before this is fixed (O9, corrected 2026-11-11: "guards
must not ship before that does"); std has none today (`with`, `with_mut`, `replace`, `replace_with`, `take`,
`into_inner`).

## Reproducers

`issues/repros/2026-11-11-a-read-through-a-holders-mut-field-does-not-keep-the-holder-frozen.yo` (negative, expects
E0911):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
{ ArrayList } :: import("std/collections/array_list");
H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(m : &mut(ArrayList(String), p)));
impl(generic(p : Origin), H(p), first : (fn(self : &Self) -> &String)(&self.m(usize(0))));
main :: (fn() -> unit)({
  mut(xs) := ArrayList(String).new();
  xs.push(String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"));
  h := H(xs)(m : &mut xs);
  r := h.first();
  mut(i) := i32(0);
  while(i < i32(100), i = (i + i32(1)), {
    h.m.push(String.from("grow"));
  });
  println(`OUT: ${r.*}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-guard.yo` (negative, E0911): a user guard `Guard(p) :: struct(c : &mut(Cell, p))` returned by
  `Cell.borrow_mut(&mut self)`; `r := g.get()` reads through `g.c`, then `g.c.xs.push(…)` ×100 while `r` lives:
  heap-use-after-free. v0.2.76 rejects it at the write (E0911, `r` borrows `g`): a regression.
- `…-pos.yo` (positive control): `r`'s last use is before the writes through `h.m`. Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `r := h.first()` (`&self` method reading through `self.m`), then `h.m.push` | accepted, UAF | E0911 |
| the same through a user guard, `g.c.xs.push` while `r := g.get()` lives | accepted, UAF | E0911 |
| a free generic fn `first2(h : &H(p)) -> &String`, then `grow(h.m)` | accepted, UAF (ledger) | E0911 |
| a guard with a `Drop` that replaces `self.c.xs`, `drop(g)` while `r := g.get()` lives | accepted, UAF (ledger) | E0911 |
| `id(c.borrow_mut().get())`, `c.borrow_mut().me().get()`, `mkv(c.borrow_mut().get())` (temporary guard) | accepted, UAF / stale value (ledger) | E0911 (R-TEMP) |
| `r := c.borrow_mut().get()` bound directly | E0911 (R-TEMP) | — |
| `drop(h)` then `grow(&mut xs)` while `r` lives (the root written by name) | E0911 | — |
| `g = c2.borrow_mut()` while `r := g.get()` lives | E0923 (ledger) | — |

Every accepted row writes `xs` through the holder's own `&mut` while the read is live; every rejected one names
`xs` itself, or makes a temporary of the guard.

## Root cause

`_bind_projection_result` (`src/evaluator/exprs/initialization_assignment.yo`) roots `r := h.first()` at the call's
root arguments. For a receiver whose type carries an origin (a holder) it takes `origin_of(h)` — the places the
holder's references point at, here `(xs, &mut)` — and records those, marked as held; the receiver's own place is
recorded only when the holder contributes nothing (`holder_roots.len() == 0`). The comment states the intent: "the
result takes the holder's loan over … so it is not borrowed a second time against the holder's own entry". That is
right for a `&` field and wrong for a `&mut` one: `h` itself is never frozen, so a write through `h.m`, which is the
holder's own `&mut` loan of `xs` and not an access of `xs` by name, conflicts with nothing. `origin_of`'s R-DEREF
step (`_lend_crossed_reference`, `src/evaluator/utils.yo`) has the same shape: a lend through a crossed reference
takes that reference's origin alone. Hypothesis for the free-function and `Drop` rows: the same two sites.
(The fix shows that the free-function and `Drop` rows are the first site. A composite built from the read, such as
`o := Option(&String).Some(g.get())`, was already rejected through `_origin_carrying_roots_shallow`, on the seed and
on the tip.)

v0.2.76's E0911 on the guard form names `g` ("`r` borrows `g`"), so the older rule froze the receiver.

**Bisected (2026-11-12, lane a31fix):** the guard form regressed with #1846 (`634f4806e`). The binary at
`aa44b7d69` (#1845) rejects it with E0911, and the one at `b5e6881c3` (after #1846 and #1847) accepts it. With
`YO_DEBUG_ORIGIN=1`, `c.borrow_mut()` evaluates to `[]` before and `[c(mut)]` after: #1846's hunk in
`_origin_carrying_roots_shallow` ("origin_of roots a method call's receiver") made the guard's origin correct.
`g` is then a holder whose `origin_of` is non-empty, so `r := g.get()` takes the holder-root branch of
`_bind_projection_result` and drops `g`. Before #1846, `g` had no origin, and that branch fell through to `g`'s
own place. The hole itself is in the branch and is older than v0.2.76, which is why the plain-holder form also
passes on the seed. #1846 only routed the guard form into it.

## Expected

E0911 at `h.m.push(…)` (and at `g.c.xs.push`, at `grow(h.m)`, at `drop(g)`): `r` borrows `h`. O3 "Reborrows"
(corrected 2026-10-21): "read through a `&` path a `&mut` component yields a `&` reborrow whose origin is the UNION
of the component's origin and the path's place — for `c : &Holder` over an element `&mut(T, xs)`, the reborrow is
`&(T, (xs, c))` … The union is what keeps the holder frozen while the reborrow lives." BCC's R-DEREF row says the
same: `origin_of(r) ∪ {(r, &)}` when `r` is reached through a `&` path and holds `&mut`.

## Fix

The fix landed on 2026-11-12 in `fix/a31-holder-freeze`. `_bind_projection_result` now also records the holder's own
place, as an unheld `&` place, whenever a root holder reaches the call through a `&` slot (`self : &Self`,
`h : &H(p)`), the result is `&`, and the holder's `origin_of` contributed places. This is O3's union:
`r := g.get()` borrows `(c, &mut)` through the holder and `(g, &)` itself. Any write through `g` (`g.c.xs.push`,
`grow(h.m)`), a move of `g`, or `drop(g)` is then E0911 while `r` lives, with the seed's message: "`r` borrows `g`".
The other two cases keep the old rule, because their result never points into the argument:

- A holder passed BY VALUE, or one that is a root only through an impl's origin parameter (`ProjectionRootArg.by_value`,
  `Entry::or_insert(self)`).
- A `&mut` result, which takes the holder's loan over.

The union is not limited to a `&mut` field. With an elided result, O2 says the result borrows `self`, and the body
may point into a by-value field of the holder (`&self.n(0)` beside a `&` field). Taking the union for every holder
also closes that form (`holder-own-field-read-then-write`). v0.2.76 accepted it.

The elided-origin note in the E0911 counts the parameters without these added places (`holder_self_roots`). A
one-parameter call therefore still prints no note, and a call that already printed one is unchanged.

**Coverage.** The fix covers both halves. The plain-holder form, which v0.2.76 already accepted, is fixed as well,
because it runs through the same branch. A composite of the read (`o := Option(&String).Some(g.get())`) was already
rejected before the fix (`_origin_carrying_roots_shallow`). The temporary-guard ledger rows (`id(c.borrow_mut().get())`
…) are R-TEMP's and were not re-probed here.

## Test

The rows are in `tests/origins/unsound/` (`scripts/origins-unsound.sh`). Each negative row is accepted by develop
`64f33c710` and rejected with E0911 after the fix.

- `holder-mut-field-read-then-write` (the method form), with a `-pos` twin.
- `guard-mut-field-read-then-write` (the guard form), with a `-pos` twin.
- `guard-mut-field-read-then-guard-dropped` (the `Drop` form).
- `holder-mut-field-read-free-fn` (the free-function form).
- `holder-own-field-read-then-write` (a by-value field beside a `&` field).

The `tests/origins/corpus.tsv` row for the 2026-10-21 corpus case (`REFERENCES_AND_ORIGINS.md` §7) is not added. It
also needs a model-checker encoding (`model_corpus.test.yo`), and the G-B rows above cover the same programs.
