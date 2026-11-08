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

## Proposed fix

In `_origin_of_into`, an R1 read of a pattern binding over a by-value scrutinee should take the scrutinee's origin
(R-DEREF), not the binding's place. The match evaluator would record the scrutinee per binding, just as a local borrow
records its places. The spelled-type shortcut (`origin_param_names_of` of the binding's type) is not enough on its own:
a specialization's types carry elided origins.
