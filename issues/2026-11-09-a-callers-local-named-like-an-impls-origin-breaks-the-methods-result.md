# A caller's local named like the impl's origin parameter makes a method's result "borrow no argument"

**Severity:** S2: a valid program is rejected (a false positive), on develop and the v0.2.76 seed.

Found while checking that O-6's call-result elision leaves what #1846 binds from a method receiver intact.

## Reproducer

`tests/origins/corpus/impl-origin-name-collides-with-local.yo`:

```yo
_H :: (fn(comptime(p) : Origin) -> comptime(Type))(struct(r : &(i32, p)));
impl(generic(p : Origin), _H(p), get : (fn(self : &Self) -> &(i32, p))(&self.r.*));
main :: (fn() -> unit)({
  p := i32(1);
  h := _H(p)(r : &p);
  r := h.get();
  ()
});
```

```
error: Cannot bind `r` to `(h.get)()`: the projection borrows no argument, so its place has no storage to borrow.
```

Renaming the local `p` to `x` makes it check. The impl's origin parameter `p` and the caller's local `p` are one
name in the result type's origin set, and the root rule reads it in the caller's scope: the same capture as
`issues/fixed/2026-11-09-a-call-results-type-keeps-its-callees-origin-names.md`, here for an IMPL origin parameter,
which `elide_callee_origin_names` does not elide (its scope is the callee's parameters and origin binders; the impl's
`p` is bound from the receiver by `projection_call_root_args`).

## Status

Open. The corpus row `impl-origin-name-collides-with-local` records `today = -|the projection borrows no argument`.
