# A call whose by-value result spells its origin freezes the receiver's place

**Severity:** S2 — valid programs are rejected: every std adapter over an iterator whose `Item` is a reference reports E0911 inside the prelude

Found 2026-11-08 while landing P3 (`&&T`, `plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7) with its required
`&&T` adapter-closure test, which is G2's borrowing-cursor shape.

## Reproducer

```yo ignore
RrCursor :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(xs : &(ArrayList(i32), p), i : usize));
impl(generic(p : Origin), RrCursor(p), Iterator(Item : &(i32, p), next : (fn(self : &mut Self) -> Option(&(i32, p)))(…)));
main :: (fn() -> unit)({
  xs := …;
  n := RrCursor(xs)(xs : &xs, i : usize(0)).map(v => (v.*.* * i32(10))).count();
});
```

`yo check` (develop a25a71ee1 plus P3's `&&T`) reports, inside `std/prelude.yo`'s `IterMap.next`:

```
error[E0911]: Cannot write `self._f` here: `item` borrows `self` with `&` and is still live
note: raised here, inside the standard library: .Some(item) => .Some((self._f)(&item))
```

## Root cause

`origin_of`'s R-CALL rule takes the call's roots from `projection_call_root_args`, which named only a REFERENCE result's
spelled origin (`fn_result_origin_names`). A by-value result that spells its origin (`-> Option(&(i32, p))`, where `p`
is the cursor type's origin argument) read as elided, so O2's default made every reference parameter a root, the receiver
`self._inner` included. The result points where the cursor's references point (`p`, a place of the caller of `map`), never
into the receiver's place, so `item` froze `self` and the call of `self._f` that follows it was E0911. The shallow walk
(`_origin_carrying_roots_shallow`) already read such results with `fn_result_composite_origin_names` and
`fn_param_pointee_in_result_origin`; the recursive root walk did not.

## Fix

`projection_call_root_args` falls back to `fn_result_composite_origin_names` when the result is not a reference, so a
by-value result's spelled origins select the roots exactly as a reference result's do (O3's substitution at the call); a
receiver whose pointee carries the origin contributes its holder's roots through the shallow walk, never its own place.

## Test that pins it

`tests/ref_of_ref.test.yo`, "an adapter closure over a reference Item takes a &&T" (`map`, `filter`, `fold`, `find` over
a cursor whose `Item` is `&(i32, p)`).
