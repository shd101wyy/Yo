# D10: an overriding `ToString.append_to` is not called for a later template part

**Severity:** S2 — `tests/fmt.test.yo`'s "D10: a later part uses the trait's
append_to, default or overridden" fails deterministically on plain develop
`cdcd14d3e` (2026-11-01, seed v0.2.73): the file reports 17/18, and the
whole-suite run fails the same single test. Reproduced on the B8 tip and on
the B11 flip tree (identically — the failure predates and is independent of
both branches' changes).

## The failing assertion

```yo
_D10Custom :: struct(n : i32);
impl(
  _D10Custom,
  ToString(
    to_string : (fn(self : &Self) -> String)(`to_string`),
    append_to : (fn(self : &Self, out : &mut String) -> unit)(out.push_str("append_to"))
  )
);
test("D10: a later part uses the trait's append_to, default or overridden", {
  assert(`x ${_D10Plain(n : i32(4))} y` == `x p4 y`, "the default append_to renders through to_string");
  assert(`x ${_D10Custom(n : i32(4))} y` == `x append_to y`, "an overriding append_to is the one a later part calls");  // FAILS
  ...
});
```

The batch binary run directly (`YO_TEST_INDEX=0`) prints:

    an overriding append_to is the one a later part calls (at std/assert.yo:39:17)

so `x ${_D10Custom(n : i32(4))} y` does not equal `x append_to y` — a later
part of a multi-part template does not reach the overridden `append_to`
(or renders through `to_string` instead). The neighbour tests pass: a
`String` part appended by borrow, spec'd later parts, nested templates, and
the FIRST-part cases (`${_D10Custom(n : i32(4))} y`).

## Repro

    yo test tests/fmt.test.yo --std-path ./std --parallel 1 \
      --test-name-pattern "append_to"

on a clean develop checkout fails; keep the batch with `YO_KEEP_BATCH=1` and
run it with `YO_TEST_INDEX=0` to see the assert.

## Ownership

develop's own state (D10 landed #1699; the neighbours #1700–#1712 may have
shifted the later-part lowering). The B11 flip does not change D10's
machinery (its std edits are mut-binding migrations in `std/fmt/format.yo` /
`spec.yo`, which this test does not reach before the assert). Fix-forward
on develop; whoever takes it should diff D10's template lowering between
#1699 and the tip.
