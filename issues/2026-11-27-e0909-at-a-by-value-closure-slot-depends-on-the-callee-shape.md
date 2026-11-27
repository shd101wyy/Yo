# E0909 at a by-value closure slot depends on the callee's shape: a `{ cfg }` copy of a reference passes a slot whose result is a closure-decided generic

**Severity:** S2 — the decision 38 A wall ("a closure that holds a reference cannot be moved into a by-value parameter") holds at some by-value `Impl(FnOnce(...))` slots and not at others, so the accepted set has no rule a user (or the docs) can state; no unsound escape was found along five routes, but none was audited.

Filed 2026-11-27 by the `v81-s1` lane from VERDICTS-93 §2.3 and §6 finding 1 (Fable 5.2's probes `g1`, `h4`, `h1`, `h6a`–`h6d`, `h7`, `e1`–`e6`, run on the installed v0.2.80).

## Reproducer

`issues/repros/2026-11-27-e0909-at-a-by-value-closure-slot-depends-on-the-callee-shape.yo`: the slot's result type is a
generic `B` the closure decides, and the closure copies in a `&Config` parameter. It is accepted and prints `8`:

```yo
{ println } :: import("std/fmt");
run :: (fn(generic(B : Type), a : i32, f : Impl(FnOnce(a : i32) -> B)) -> B)(f(a));
Config :: struct(k : i32);
shift :: (fn(cfg : &Config, x : i32) -> i32)(
  run(x, { cfg }(a) => (a + cfg.k))
);
main :: (fn() -> unit)({
  c := Config(k : i32(3));
  println(`${shift(&c, i32(5))}`);
});
export(main);
```

The same closure at a non-generic slot, `run :: (fn(a : i32, f : Impl(FnOnce(a : i32) -> i32)) -> i32)(f(a));`, is:

```text
error[E0909]: This value borrows `cfg` (the capture `cfg : &cfg` at h4_ref_param_capture_user_slot_free_fn.yo:6:12), so it is second-class and cannot be moved into a by-value (`sink`) parameter: a borrow never outlives the scope that lends it.
```

With the S-1 std's combinators switched to a by-value `Impl(FnOnce(...))` slot, `{ self }` closures passed `map`, `map_err`
and `ok_or_else` (a generic result) and were E0909 at `and_then`, `map_or`, `is_some_and` and `unwrap_or_else`. A `{ &x }` or
`{ &mut x }` capture is rejected everywhere.

## Root cause

Not located. The wall is `reject_second_class_escape`, called from `consume_argument_for_parameter`
(`src/evaluator/calls/helper.yo`) for an owning parameter unless `second_class_slot`. `type_is_second_class` evidently does
not see the copied `&T` capture in the closure's type when the call's result type is still a type variable at that point
(the per-call `B` is solved from the closure's body). The returned, stored, spawned, wrapped and `Dyn`-boxed escapes
(`e1`–`e6`) are each rejected when the callee is instantiated, so the accepted cases look like the per-instantiation
check of `BORROW_CHECKER_COMPLETENESS.md` §7 P4-1 working in one corner.

## Fix

P4-1 (`BORROW_CHECKER_COMPLETENESS.md` §7) makes the accepted behaviour the rule: a closure fills a by-value slot, and E0909
fires only where the slot carries `Escapable` or `Send`. Until then, either apply the wall uniformly or audit the gap.
