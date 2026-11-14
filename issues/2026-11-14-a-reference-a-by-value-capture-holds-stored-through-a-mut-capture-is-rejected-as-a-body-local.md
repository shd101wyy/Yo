# A reference a by-value capture holds, stored through a `&mut` capture, is rejected as a body local

**Severity:** S2 — a valid program is rejected (E0912): a closure that stores, through its `&mut` capture, a reference it captured by value is told the referent is "a local of this literal's body" when the referent lives outside the literal and outlives the slot.

Found 2026-11-14 while fixing audit A50 (`fix/c7-captures`, audit §9 cluster 7). Pre-existing: develop `a76974e41` and
v0.2.77 reject it the same way.

## Reproducer

`issues/repros/2026-11-14-a-reference-a-by-value-capture-holds-stored-through-a-mut-capture-is-rejected-as-a-body-local.yo`:

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  owned := String.from("abc");
  mut(slot) := Option(&String).None;
  r := &owned;
  {
    (mut(c) : Impl(FnMut() -> unit)) = ({ s : &mut slot, r }() => {
      s.* = .Some(r);
    });
    c();
  };
  match(slot, .Some(x) => println(x), .None => ());
});
export(main);
```

```text
error[E0912]: Cannot store a reference to `owned` into `slot` through the capture `s : &mut slot`: the origin names
a local of this literal's body, whose storage ends with it, while `slot` outlives it
```

`slot` is declared after `owned`, so `owned` outlives it; the program is sound.

## Root cause

`_capture_store` (`src/evaluator/utils.yo`) judges each ground root of the stored value. `r`'s ground root is `owned`,
reached through the by-value capture's holder roots. `owned` is not a parameter of the literal, not module-level and
has no `borrow_capture_outer` record, so it falls into the last branch, "a local of this literal's body" (E0912).
That branch does not ask where the binding was declared: a binding outside the literal reaches the body only through
a capture, and its storage is not the literal's.

## Expected

`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` O-3: a store through a `&mut` capture is E0923 when rooted at a
per-call parameter, E0912 at a body local, and otherwise joins the outer holder's flow set at the literal. A ground
root declared outside the literal joins `slot`'s flow set, like a borrow capture's outer place. The roots that are
the literal's own storage stay E0912: a body local, and a by-value capture itself (audit A50,
`issues/fixed/2026-11-11-a-body-may-store-a-reference-to-its-own-by-value-capture-through-a-mut-capture.md`).

## Test

With the fix: the reproducer moves to `tests/origins/unsound/` as a positive control (`// expect: accept`).
