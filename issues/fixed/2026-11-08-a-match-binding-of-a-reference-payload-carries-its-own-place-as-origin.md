# A match binding of a reference payload carries its own place as origin

**Severity:** S2 — valid programs are rejected: storing a by-value `match`'s reference payload into a holder declared
over its origin is E0923. This makes std's `filter` (`IterFilter.next`) and `find` unusable over an iterator whose
`Item` is a reference, which G2's borrowing cursors need.

Found 2026-11-08 while landing P3 (`&&T`, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7) with its `&&T`
adapter-closure test. Present on develop a25a71ee1 and ce90d42f0, and in the v0.2.76 seed. P3's adapter test covers
`map`, `filter` over a by-value `Item`, `fold` and `count`; the `filter`/`find` arms over a reference `Item` wait for
this fix.

## Reproducer

```yo
pick :: (fn(generic(p : Origin), o : Option(&(i32, p))) -> Option(&(i32, p)))({
  (mut(res) : Option(&(i32, p))) = .None;
  candidate := o;
  match(
    candidate,
    .None => (),
    .Some(item) => {
      res = .Some(item);
    }
  );
  res
});
main :: (fn() -> unit)({
  x := i32(3);
  _a := pick(.Some(&x));
  ()
});
export(main);
```

```
error[E0923]: Cannot assign a value holding origin `item` to `res`: its type is declared over `Option(&i32)`, whose
origin does not name `item`, and a holder points only into the places its origin lists
 --> tmp/fixme.yo:7:11
  |
7 |       res = .Some(item);
  |             ^
```

Through std, a reference `Item` (`Item : &(i32, p)`) gives the same error inside `IterFilter.next` (origin `candidate`)
and inside `Iterator.find` (origin `item`):

```yo ignore
n := cursor.filter(v => (v.*.* > i32(1))).count();   // E0923 at `loop_result = .Some(item)`
f := cursor.find(v => (v.*.* == i32(2)));             // E0923 at `found = .Some(item)`
```

## Root cause

The payload binding `item` of a by-value `match` over an `Option(&(i32, p))` is a reference binding: the payload IS its
reference. `.Some(item)` reads it as a reference value (the read rule, R1), whose recorded type's elided origin names the
binding itself (`reference_binding_read_type`). `origin_of`'s R-LEND recorded-form branch then pushes the binding's
own place (`_origin_push_place`), so the value holds `item`. When the scrutinee is a local, the binding's registered
local-borrow entry names the scrutinee's PLACE (`candidate`), never what the payload reference points to. Neither is in
the holder's declared origin `p`.

The value read out is a copy of the reference stored in the scrutinee. By R-DEREF, its origin is the scrutinee's roots
(`o`, here an origin parameter's, so the caller's storage).

## Fix

Two rules, both in `src/evaluator/utils.yo`:

- **A reference payload binding's read holds what the scrutinee held.** At the `match`, `note_ref_payload_held`
  records, for each reference payload binding, the roots `origin_held_by(scrutinee)` returns. That is the same list
  that freezes those places while the binding is live (`src/evaluator/exprs/match.yo`). An R1 read of the binding
  pushes that list in both of `origin_of`'s walks: the recursion (`_origin_of_into`, ahead of the R-LEND
  recorded-form branch, which pushed the binding's own place) and the shallow walk (`_origin_carrying_roots_shallow`).
  The list is recorded when the match runs, so a later write to the scrutinee does not change what the binding holds.
- **`origin_held_by` never returns a by-value holder's own place.** Before the fix, only a parameter scrutinee
  contributed just its registered entries. A by-value holder local now does too. `candidate := self._inner.next()`
  holds references into the caller's storage, so it registers no entries, and its payload holds nothing. Before
  the fix, the payload held `candidate`'s place.

A reference binding scrutinee keeps `origin_of`, and a `&` match still freezes its scrutinee through `imm_place`.

## Tests that pin it

- `tests/ref_payload_binding.test.yo`:
  - the reproducer above, in two forms: a parameter scrutinee and a local holder;
  - `IterFilter.next`'s shape, a holder bound from `next_ref()`;
  - a negative, where a local's lend read out of a payload into a holder declared over `p` is still E0923
    ("holding origin `x`").
- `tests/ref_of_ref.test.yo`: `filter` and `find` over a reference `Item`, with `v.*.*` closures.
- G-B: `tests/origins/unsound/mbo-payload-read-inner.yo` must be E0911: a payload stored into an outer holder,
  then read after its referent's block ends. Its positive twin, `mbo-payload-read-inner-pos.yo`, must be accepted.
