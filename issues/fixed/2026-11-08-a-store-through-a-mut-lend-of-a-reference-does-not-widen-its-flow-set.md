# A store through a `&mut` lend of a reference does not widen the reference's flow set

**Severity:** S1 — unsound: a use-after-scope is accepted. Writing a shorter-lived reference through `rp := &mut r`
re-points `r`, and a read of `r` after that referent's block ends passes `yo check`.

Found 2026-11-08 by G-B (`scripts/origins-unsound.sh`) while landing P3 (`&&T`, `&mut &T`,
`plans/backlog/BORROW_CHECKER_COMPLETENESS.md` §7). P3 makes `&mut r` on a reference binding a `&mut &T`, so this store
is new with it.

## Reproducer

`tests/origins/unsound/p3-mut-ref-store-inner.yo` (and its positive twin `p3-mut-ref-store-inner-pos.yo`):

```yo
{ String } :: import("std/string");
{ println } :: import("std/fmt");
main :: (fn() -> unit)({
  outer := String.from("outer");
  mut(r) := &outer;
  {
    inner := String.from("0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz");
    rp := &mut r;
    ri := &inner;
    rp.* = ri;
  };
  println(`OUT: ${r.*.len().to_string()}`);
  ()
});
export(main);
```

Before the fix, `yo check` accepted it, and the binary read `inner` after its scope.

## Root cause

`rp.* = ri` on a reference binding `rp` is rewritten to a write of the place `rp` refers to, which is `r` itself. The
`=` join (`bind_join`) ran against `rp`, the variable the assignment names. So `r` kept its flow set `{outer}`, and nothing
checked `inner`'s scope against `r`'s last use.

A second gap hid the first one once the join was routed to `r`. `_lb_binding_site_of`, which finds a holder's `:=` to
recompute its live range, did not recognize a local borrow's declaration (`mut(r) := &outer` is `__yo_imm(r) := outer`
after the borrow-spelling rewrite). The range then ended at the store, so the §7 scope check never fired.

## Fix

- `_join_through_mut_self_lend` (`src/evaluator/exprs/assignment.yo`): when the assigned variable is a `&mut` local borrow
  whose one place is a whole reference binding `r`, and whose referent is that reference (`rp : &mut &T`), the store is
  `r = v`'s join, `bind_join` on `r`. It kills and gens, with the §7 scope check. A field or element write through `rp`
  stays `place_write_join`'s (O-3). Under the older reading (std, src), `&mut r` lends the referent, which the type
  guard excludes.
- `_lb_binding_site_of` recognizes a local-borrow mode-call declaration (`I(r)`, `I(r, T)`, `I(r, T, o)`) as `r`'s
  binding site.

## Test that pins it

G-B: `tests/origins/unsound/p3-mut-ref-store-inner.yo` (must be E0911) and `p3-mut-ref-store-inner-pos.yo` (accepted, runs
clean under ASan).
