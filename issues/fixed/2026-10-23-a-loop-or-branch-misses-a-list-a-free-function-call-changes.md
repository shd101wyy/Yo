# Verifier: a loop or branch misses a list that a free-function call changes

**Severity:** S1 — `yo verify --strict` proves an `assert` that fails on a loop's second iteration (and an index that goes out of bounds), because the loop's havoc set misses a list a free-function mutator changes.

- **Status:** fixed (filed and fixed 2026-10-23, found while triaging
  `issues/fixed/2026-10-23-the-call-site-frame-misses-a-list-reached-through-a-refcell-global.md`).
- **Component:** `src/verifier/vc.yo`, `_scan_assigned` (the loop havoc set
  and the `cond` merge set).

## Reproducer

`tests/spec/fixtures/negative/loop_call_mutator_havoc.yo`:

```yo ignore
grow1 :: (fn(xs : ArrayList(i32), ensures(xs.len() == (old(xs.len()) + usize(1)))) -> unit)({
  xs.push(i32(7));
});
grow_in_loop :: (fn(n : i32, requires(n == i32(3)), ensures(true)) -> (r : i32))({
  ys := ArrayList(i32).new();
  (mut(i) : i32) = i32(0);
  while(i < n, {
    invariant((i >= i32(0)) && (i <= n));
    assert(ys.len() == usize(0));
    grow1(ys);
    i = (i + i32(1));
  });
  i
});
```

Before the fix the verifier reported every obligation proved; the binary
aborts on the assert in iteration 2. A twin with `acc = ys(usize(2));
shrink1(ys);` in the loop proved `index-in-bounds` and hit
`ArrayList: index out of bounds`. The branch twin `maybe_grow`
(`if(c, { grow1(ys); }); ys.len()` with `ensures(r == usize(1))`) proved
too: the arm's rebinding leaked past the merge into the path that never
called `grow1`.

## Root cause

The call itself rebinds `ys` (its callee's contract mentions `old(xs)`),
but the syntactic scan that collects the loop's havoc set and the `cond`
arms' merge set (`_scan_assigned`) knew only METHOD receivers whose
contract mentions `old(self)` (`_mutated_receiver_name`). A bare-name
argument to a free function was never added, so the loop head kept the
pre-loop list and the branch merge kept whichever binding the last arm
left.

## Fix

`_call_written_names` replaces `_mutated_receiver_name`: for any call it
adds each plain-name argument (the receiver first for a method) whose
parameter the contract relates with `old(...)` or that is written through
`&mut`, and a `#frame` mark when the callee's frame is open, which
`_scan_assigned_in` expands to every list in scope.

## Test

`tests/spec/fixtures/negative/loop_call_mutator_havoc.yo`: neither
`grow_in_loop` nor `maybe_grow` verifies; pinned in
`tests/internal/verifier_list_len.test.yo`.
