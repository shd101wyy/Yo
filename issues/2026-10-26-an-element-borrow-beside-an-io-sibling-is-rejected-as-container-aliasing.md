# An element borrow beside an `io` sibling is rejected as container aliasing

**Severity:** S2 — a valid program is rejected: `io.await(bump(&mut a.cells(usize(1)), io), io)`,
where `a` is a local struct with a fixed-size `Array(i32, 2)` field, is refused with
"A 'ref' argument ... but argument 2 of the same call could hold a handle to 'a'", though an
`Io` value cannot reach a user local. The intended diagnostics also regress: `tests/async_await.test.yo`'s
second batch fails to compile (85 of 285 tests "did not run"), because a `comptime_expect_error`
that awaits the E0909 shared-cell rejection now raises this aliasing error first.

**Found:** 2026-10-26, finishing VBD B4-3a (`src/evaluator/calls`). The develop tip `6b288e5e1`
binary and the B4-3a branch binary fail identically; `a27cd5f01` (#1615) is clean. The regression
window is #1616–#1621, and the only commit in it that touches the check is #1619
(`33d2c48bf`), which rewrote `src/types/flowability.yo`'s sibling-reachability walk
(`_type_may_reach_any_of`) — the same walk whose `String` false positive was fixed as
`issues/fixed/2026-10-24-an-element-borrow-rejects-a-sibling-argument-that-cannot-reach-the-container.md`.
`Io`'s representation answers "reaches" in the new DFS (a pointer/box or function-typed field
inside it), so every `(... , io : Io)` sibling of an element borrow is judged able to grow the
container.

## Reproducer

`issues/repros/2026-10-26-an-element-borrow-beside-an-io-sibling-is-rejected-as-container-aliasing.yo`
(rejected at `6b288e5e1`; the call itself is accepted at `a27cd5f01`):

```yo
{ assert } :: import("std/assert");
{ yield } :: import("std/async");
_Cells :: struct(cells : Array(i32, 2));
main :: (fn(io : Io) -> unit)({
  bump :: (fn(c : &mut i32, io : Io) -> Impl(Future(unit, Io)))(
    io.async({ &mut c }(io : Io) => {
      io.await(yield(io), io);
      c = (c + i32(1));
    })
  );
  mut(a) := _Cells(cells : Array(i32, 2)(i32(4), i32(5)));
  io.await(bump(&mut a.cells(usize(1)), io), io);
  assert(a.cells(usize(1)) == i32(5), "bumped");
});
export(main);
```

The variant with `xs := ArrayList(i32).new()` and `&mut xs(usize(0))` shows the diagnostic-order
half: `a27cd5f01` raises E0909 ("lives in a shared mutable cell" — what
`tests/async_await.test.yo` expects), `6b288e5e1` raises the aliasing error, so the
`comptime_expect_error` text no longer matches and the whole test batch fails to compile.

## Root cause

`_type_may_reach_any_of` (`src/types/flowability.yo`, #1619) walks `Io`'s representation and
answers yes — so `_reject_if_container_reachable`'s rule fires for the `io` argument before the
decision 38 D shared-cell check. The `Io` context value is the ubiquitous second argument of
every async fn taking a bundle, so the blast radius is every element-borrow lending beside an
`io` sibling, not just the test file.

## Fix direction (not in B4-3a)

B4-3a touches only `src/evaluator/calls/`; this belongs to develop's fix-forward of #1619's
walk (judge `Io` — or the concrete field chain inside it — as unable to reach user locals, or
run the decision 38 D cell check before the sibling-aliasing check so the intended diagnostic
wins). Both `tests/async_await.test.yo` batches must return to green on the fix.
