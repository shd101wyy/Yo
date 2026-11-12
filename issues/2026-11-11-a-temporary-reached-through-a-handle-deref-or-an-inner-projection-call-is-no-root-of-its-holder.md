# A temporary reached through a handle's `.*` or an inner projection call is no root of the holder it feeds

**Severity:** S1. In `{ v = mkv(&long().*.s); }` (`long() -> Rc(X)`, `mkv :: (fn(r : &String) -> V(r))`) and
`{ v = mkv(mkx().get()); }` (`get(self : &Self) -> &String`), the holder `v` outlives the statement while the `Rc`
or the struct its reference points into is a temporary of that statement; both pass `yo check` and `v.r` is read
after the temporary is gone (ASan: heap-use-after-free; stack-use-after-scope). The plain field form
`v = mkv(&mkx().s)` is rejected. Pre-existing: v0.2.76 accepts both reproducers.

Found 2026-11-11 by the ownership / borrowing / origin audit
(`plans/backlog/OWNERSHIP_BORROWING_ORIGINS_AUDIT.md` §3 A23). Confirmed on develop `64f33c710`. The `.*` half
shares its cause with
`issues/fixed/2026-11-11-a-projection-may-return-a-reference-into-a-local-or-by-value-box-rc-or-arc-handle.md` (A30).

## Status

The `.*` half is fixed with A30
(`issues/fixed/2026-11-11-a-projection-may-return-a-reference-into-a-local-or-by-value-box-rc-or-arc-handle.md`):
`is_temporary_operand` reads a `.*` on an owning handle as a field step (`deref_is_owning_handle_step`), so
`long().*.s` and `Box.new(…).*` are temporaries. G-B rows `holder-from-temporary-rc-deref`,
`holder-from-temporary-box-deref` and `holder-from-temporary-rc-deref-pos` in `tests/origins/unsound/`. This doc
stays open for the inner-projection-call half (`…-projection-call.yo`, `mkv2(long().as_ref())`), which the fix does
not touch.

## Reproducers

`tests/origins/unsound/holder-from-temporary-rc-deref.yo` (filed under `issues/repros/` with this doc's name; it
moved with the `.*` half's fix, see Status)
(negative, expects E0911):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
X :: struct(s : String);
V :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(String, p)));
mkv :: (fn(r : &String) -> V(r))(V(r)(r : r));
long :: (fn() -> Rc(X))(Rc.new(X(s : String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz"))));
main :: (fn() -> unit)({
  k := String.from("k");
  mut(v) := mkv(&k);
  {
    v = mkv(&long().*.s);
  };
  println(`OUT: ${v.r.*}`);
});
export(main);
```

```text
$ yo check repro.yo        # develop 64f33c710: accepted.  v0.2.76: accepted
$ yo compile repro.yo --optimize 1 --sanitize address --allocator system -o t && ./t
==…==ERROR: AddressSanitizer: heap-use-after-free
```

- `…-projection-call.yo` (negative, E0911): `v = mkv(mkx().get())` in an inner block, `mkx() -> X` by value;
  stack-use-after-scope. v0.2.76: accepted. (A variant that builds `X` from an inline literal instead of
  `longs()` reads a stale `0` with no ASan report.)
- `…-pos.yo` (positive control): the `Rc` and the struct are bound to locals that outlive the holders
  (`v := mkv(&h.*.s)`, `w := mkv(x.get())`). Accepted, runs clean.

## The family (develop `64f33c710`)

| Shape | Verdict | Correct |
| --- | --- | --- |
| `v = mkv(&long().*.s)` in an inner block (also in a `while` body) | accepted, UAF; E0911 since the A30 fix | E0911 |
| `v = mkv(&Box.new(longs()).*)` in an inner block | accepted, UAF (ledger); E0911 since the A30 fix | E0911 |
| `v = mkv2(long().as_ref())` (the `Rc`'s projection `as_ref`) | accepted, UAF (ledger) | E0911 |
| `v = mkv(mkx().get())`, `v = mkv(id(&longs()))` in an inner block | accepted, stack-use-after-scope | E0911 |
| `v := mkv(&long().*.s)` / `v := mkv(mkx().get())`, read later in the same block | accepted; runs print `72 72` / a stale `0` (ledger); the `.*` form E0911 since the A30 fix | E0911 |
| `v = mkv(&mkx().s)` (a field of the temporary, no `.*`, no inner call) | E0911 "Cannot store a reference into `(mkx().s)` in `v` here: it is a temporary" | — |
| `r := c.borrow_mut().get()` (projection result bound directly) | E0911 (R-TEMP) | — |

## Root cause

`is_temporary_operand` (`src/evaluator/utils.yo`), R-TEMP's test for "this lent operand is a temporary", is
structural, and it returns `false` in exactly the two shapes above:

- at a `.` whose member is `*` it stops ("not a deref (`p.*` is a place behind a reference)") without asking what
  is dereferenced, so `long().*.s` is not a temporary although `long()` is an owned `Rc` the statement made;
- for a projection call it returns `false` ("not a projection's or a subscript's place (those lie in their own
  roots)"), so `mkx().get()` and `long().as_ref()` are not temporaries.

The second exit relies on the caller to recurse: `origin_of`'s R-CALL loop tests each root argument with
`is_temporary_operand` and then recurses into it (`_origin_of_into`), where the inner call's own root (`mkx()`) is a
temporary. That recursion does not produce the entry. Measured with `YO_DEBUG_N2B=1`: for the plain field form
`bind_join` (`src/evaluator/utils.yo`) prints `join v: roots=[#temporary(imm)]` and rejects; for
`v = mkv(mkx().get())` it prints nothing, i.e. `origin_of(mkv(mkx().get()))` is EMPTY — `v` keeps no loan at all
after the assignment, not even the temporary. Which branch of `_origin_of_into` drops the inner call's roots is not
identified (hypothesis: a reference-typed call result is read as a recorded lend and handed to the place walk,
which finds no named root).

## Expected

E0911 at both `=` (and at the `:=` forms), naming the temporary, as for the plain field form. BCC's R-LEND row: "a
temporary operand is a hidden statement local (R-TEMP)"; O3's return rule (made precise 2026-11-11, A30): a `.*` on
an owning handle is a field step, and "the same reading applies wherever a place's root is computed: a lend
(`mkv(&long().*.s)` borrows the temporary `long()` returns) and a temporary's extent." An inner projection call's
result is rooted at its own arguments (R-CALL), so a temporary among them is a root of the outer holder too.

## Test

With the fix: the two negative programs and the positive control move to `tests/origins/unsound/`; corpus rows next
to `holder-from-temporary` and `lend-of-temporary-in-call-result` in `tests/origins/corpus.tsv` for the deref and
the inner-projection forms.
