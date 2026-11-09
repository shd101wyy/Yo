# `Option(&T).unwrap()` is E0601 inside std

**Severity:** S2. A valid program is rejected: `unwrap()` on any `Option(&T)` fails to type-check, so a by-value
`Option` of a reference can be read only with `match`.

Found 2026-11-09 while writing the tests for
`issues/fixed/2026-11-08-a-match-binding-of-a-reference-payload-carries-its-own-place-as-origin.md`. Present in the
v0.2.76 seed and on develop e769f6b0d.

## Reproducer

```yo
{ assert } :: import("std/assert");
_p :: (fn(r : &i32) -> Option(&i32))(.Some(r));
test("unwrap of a reference payload", {
  x := i32(4);
  o := _p(&x);
  v := o.unwrap();
  assert(v.* == i32(4), "u");
});
```

```
error[E0601]: Incompatible type with expected type:
- Expected: *(i32)
- Actual  : i32
note: raised here, inside the standard library
     --> std/prelude.yo:8214:23
8214 |       .Some(value) => value,
```

The `match` spelling, `match(_p(&x), .Some(v) => (v.* == i32(4)), .None => false)`, is accepted and runs.

## Root cause

It shares the root cause of `issues/2026-11-06-a-generic-result-at-t-reference-is-lowered-as-a-projection.md` (VERDICTS-23 R3) and is fixed with it.


`unwrap : (fn(self : Self) -> T)(match(self, .Some(value) => value, …))` specialized at `T := &i32`. The arm binds
`value` as a reference payload binding (decision 43 step 3), whose name has the pointee's type. The arm's value is
then checked against the result `T`, the reference, and is read as the pointee instead of the reference value. The
expected type prints as `*(i32)`, so the specialization's result is lowered to a pointer before the check. That
suggests the read rule (R1, N1e-2b) does not see a generic result slot bound to a reference as a position that
expects one.
