# An early return through a borrowed match binding over a local returns a dangling reference

**Severity:** S1. Inside `match(&o, .Some(h) => { return(Option(&i32).Some(&h.*.v)); }, …)` over a LOCAL `o`,
`yo check` accepts the `return`. The caller then reads a dead stack frame: AddressSanitizer reports
`stack-use-after-return`. The tail form of the same value (`.Some(h) => Option(&i32).Some(&h.*.v)` as the
function's result) is E0912. Found 2026-11-14 on develop 57fb978f9.

## Reproducer

`tests/origins/unsound/match-borrowed-binding-early-return-over-local.yo` (expects E0912). Its positive twin, over a
`&` parameter, is `match-borrowed-binding-early-return-over-param-pos.yo`.

```yo ignore
P :: struct(v : i32);
f :: (fn() -> Option(&i32))({
  o := Option(P).Some(P(v : i32(1)));
  match(&o, .Some(h) => { return(Option(&i32).Some(&h.*.v)); }, .None => ());
  Option(&i32).None
});
```

## Root cause

`return_check` maps a root that names a `&` match binding to the scrutinee's roots
(`_origin_through_match_bindings`, `src/evaluator/utils.yo`, added by
`issues/fixed/2026-11-08-an-early-return-does-not-follow-a-match-binding-to-its-scrutinee.md`). It computed those roots
as `origin_of` of the place UNDER the scrutinee's borrow marker: `o` rather than `&o`. An owned local's own origin is
empty, so `[h]` became `[]` and the `return` held nothing. Over a reference scrutinee (`match(a, …)`, `a : &T`) the
two readings agree, which is why the 2026-11-08 tests passed.

## Fix (2026-11-14, branch `fix/c3-value-origins`)

The binding is a place inside the scrutinee's place, so its roots are those of a LEND of that place. That is
`origin_of` of the scrutinee as written (`&o` gives `[o]`, a reference `a` gives `a`'s roots). With that change,
`return_check` rejects the early return with E0912. The same mapping feeds `origin_scope_close`, which closes a
`match` arm's value over the arm's scope (audit A12). There, the stripped reading had made the arm value
`.Some(&h.*.v)` over `match(&o, …)` carry no root. That was a regression on this branch before it merged: G-A's
`match-arm-composite` row was accepted, and the tail form above was too. `match-borrowed-binding-tail-return-over-local.yo`
guards it.
