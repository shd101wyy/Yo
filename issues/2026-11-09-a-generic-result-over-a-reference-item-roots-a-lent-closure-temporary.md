# Binding `find`'s result over a reference `Item` is E0911: the lent closure temporary is a root

**Severity:** S2. A valid program is rejected: `found := cursor.find(v => …)` over an iterator whose `Item` is a
reference is E0911 (R-TEMP). Matching the result in place is accepted.

Found 2026-11-09 with the fix for
`issues/fixed/2026-11-08-a-match-binding-of-a-reference-payload-carries-its-own-place-as-origin.md`, which made `find`
over a reference `Item` reachable. It only shows once that fix lands.

## Reproducer

`tests/ref_of_ref.test.yo`'s cursor (`Item : &(i32, p)`):

```yo ignore
found := rr_cursor(&xs).find(v => (v.*.* == i32(2)));
```

```
error[E0911]: Cannot bind `found` to `(rr_cursor(&(xs)).find)(v => …)`: its value holds a reference into
`v => …`, a temporary that ends with this statement, while `found` lives on (… §3 R-TEMP).
```

## Root cause

`Iterator.find` is `fn(generic(A, F), sink(self) : Self, pred : &mut F, …) -> Option(A)`.
`projection_call_root_args` reads the callee type that receiver dispatch recorded. That is the generic signature,
whose result `Option(A)` spells no origin, so it is treated as elided: every reference parameter, `pred` included, is
a root. O-5's R-TEMP then sees the closure literal, a temporary lent to `pred : &mut F`, as a root of the result.

After specialization the result is `Option(&(i32, p))`. It spells `p`, which `pred`'s slot does not carry, so `pred`
is no root. The root arguments should be read from the specialized result type, as P3's composite-origin rule does for
a spelled `-> Option(&(T, p))`. The receiver must stay a root: it is a by-value holder carrying `p`.
