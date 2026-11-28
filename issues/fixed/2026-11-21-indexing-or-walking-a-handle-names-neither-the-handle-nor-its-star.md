# Indexing or walking a handle names neither the handle nor its `.*`

**Severity:** S3 — `r(i)` on an `Rc(ArrayList(T))` and `for(&r, …)` over one are rejected with messages that do not say `r` is a handle or that `r.*` is the spelling

**Status:** FIXED (found 2026-11-21 by VERDICTS-73's probes d4 and d4b, on the v0.2.79 seed and develop `bb237b871`; fixed by the VERDICTS-73 deletion PR)

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array-list");
main :: (fn() -> unit)({
  mut(xs) := ArrayList(i32).new();
  xs.push(i32(9));
  r := Rc.new(xs);
  _a := r(usize(0));
  (mut(t) : i32) = i32(0);
  for(&r, x => {
    t = (t + x.*);
  });
});
export(main);
```

Before the fix, `r(usize(0))` is `E0606 r is not callable: it has type Rc(ArrayList(i32)).` with no help, and the
`for` head is `E0901 use of moved value: cannot copy r.*, whose type ArrayList(i32) is move-only`: the loop's
`(&r).into_iter()` reached the payload's by-value `into_iter` through the method forwarding, and the error is about
the copy that forwarding made, not about the handle. Neither names `r.*(i)` or `for(&r.*, …)`.

## Cause

Indexing (`r(i)`) never looked through a handle, so the call fell to the generic "not callable" text. The `for`
desugar's `into_iter` call did look through it, by the member forwarding VERDICTS-73 deletes, and so reported a
consequence of the forwarding.

## Fix

E0606 on a callee whose type is a `Deref` type adds a help line naming the handle and `r.*(...)`, with a `yo fix`
repair for a plain name. With the forwarding deleted, the `for` head's `into_iter` is a member of the place `r.*`
names, so it is E0623, worded for the loop: ``write `for(&r.*, …)`: `r.*` names the payload``.

## Test

`tests/deref-explicit.test.yo`, "E0606 and a for head over a handle name its .*".
