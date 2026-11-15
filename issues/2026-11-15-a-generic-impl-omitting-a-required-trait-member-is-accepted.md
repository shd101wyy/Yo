# A generic impl that omits a required trait member is accepted and satisfies the bound

**Severity:** S2. An invalid program is accepted: a generic `impl` that leaves out a required trait member (a method
with no default) passes, and `where(S <: Trait)` then holds at the instance. The concrete impl is rejected, so the
check exists and only the generic arm skips it.

Found 2026-11-15 by the VERDICTS-63 probes (p8, p4b). Seed `yo` 0.2.77 and develop (`yo-dt6`) both accept.

## Reproducer

`issues/repros/2026-11-15-a-generic-impl-omitting-a-required-trait-member-is-accepted.yo`:

```yo
{ assert } :: import("std/assert");

Shape :: trait(Kind : Type, area : (fn(self : &Self) -> i32));
G :: (fn(comptime(T) : Type) -> comptime(Type))(struct(v : T));
impl(generic(T : Type), G(T), Shape(Kind : T));
use_it :: (fn(generic(S : Type), s : &S, where(S <: Shape)) -> i32)(i32(1));

main :: (fn() -> unit)({
  g := G(i32)(v : i32(1));
  assert(use_it(&g) == i32(1), "the generic impl has no `area` and still satisfies `Shape`");
});
export(main);
```

Both binaries: rc 0. With a concrete type (`Sq :: struct(s : i32); impl(Sq, Shape(Kind : bool));`) both report
E0602 for the missing `area`.

## Why it matters

VERDICTS-63 decision 3 has the prelude's `Box`, `Rc` and `Arc` impls carry `deref` as a required `Deref` member. A
cell impl that forgot it would be accepted and fail only at the first call (`Rc.deref(&r)` is E0610 in a patched
prelude, probe p4b), so only a test would notice.

## Expected

E0602 at the generic impl, as for the concrete one.

Fix: not started (v0.2.79).
