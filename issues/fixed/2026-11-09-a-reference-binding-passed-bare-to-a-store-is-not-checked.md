# A reference binding passed bare to a `&mut` holder's store is not compared with the holder's fixed origin

**Severity:** S1: `yo check` accepts a program whose `&mut` holder keeps a reference to a block local past the block's end; safe code, no `unsafe`, on develop and the v0.2.76 seed. (The block local is a stack `i32`, so ASan at `-O1` did not trap; the dangling read printed the dead slot.)

Found while checking that O-6's call-result elision leaves what #1846 binds from a method receiver intact
(`tests/origins/impl_origin_result.test.yo`): the probe's free-function twin was accepted too.

## Reproducer

`tests/origins/corpus/bare-reference-store-widen.yo`:

```yo
_store :: (fn(generic(q : Origin), dst : &mut Option(&(i32, q)), v : &(i32, q)) -> unit)({
  dst.* = .Some(v);
});
main :: (fn() -> unit)({
  x := i32(1);
  (mut(slot) : Option(&(i32, x))) = .Some(&x);
  {
    yb := i32(2);
    r := &yb;
    _store(&mut slot, r);
  };
  ()
});
```

`_store(&mut slot, &yb)` is E0923 (`&yb` carries `yb`, outside `x`); the same call with the reference first bound to
`r` is accepted. `yo check` prints no diagnostic and `YO_AUDIT_ORIGIN_TOTALITY` reports nothing, so `origin_of` of `r`
is computed; `lend_through` step 2 does not use it for this position.

## Root cause

Not yet isolated. `_argument_origin_pairs` documents it: "A reference binding passed bare is not a lend of its own
place: its origin is its declaration's, which this walk does not read", and the pair it builds for a reference-typed
argument reads the argument's TYPE. The binding's type origin is not what the binding holds (`r`'s type is
elided or flow-adopted), so step 2 either finds no pair or compares a name the slot's own origin already contains.
The fix belongs where O-6 put the `origin_of` fallback for an elided position, extended to a bare reference binding.

## Status

**FIXED** on `v0280/clusters` (2026-11-20). The O-6 PRs did not fix it. The cluster lane's A56 change (`b4df91033`, "a
closure call's reference result freezes its reference arguments") did: `_origin_of_into`'s R-NONE gate
(`src/evaluator/utils.yo`) now continues for an atom that is a reference binding instead of returning ∅ at its
pointee-typed node. So `origin_of(r)` is `{(yb, &)}` at the store, and `_store(&mut slot, r)` is E0923 (`r` carries
origin `yb`, outside `x`), like the `&yb` form. The doc lists no other variant. The corpus row
`bare-reference-store-widen` pins the fix: its `today` column is re-recorded from `accept` to
`E0923|carries origin \`yb\`, outside \`x\``, which matches its `expect` (ORIGIN_MISMATCH).
