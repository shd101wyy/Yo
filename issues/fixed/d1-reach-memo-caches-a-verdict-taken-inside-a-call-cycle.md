# Rule D1 memoizes a reach verdict taken inside a call cycle, so a thread closure reaches a non-Send global through it

**Severity:** S2 — an invalid program is accepted by `check` and `compile`: a spawned closure reaches a non-`Send` module global (a data race on a non-atomic refcount) when it calls into a call cycle whose other member was walked first

**Status:** FIXED 2026-10-01 on `fix/check-foreign-bodies`. Found while making `check` summarize
each module's function bodies (`issues/fixed/check-cannot-see-function-bodies-from-other-modules.md`),
which would have turned this from an ordering accident into the normal case. Regression tests:
`tests/cli-cases/check-send-closure-reaches-a-global-through-a-call-cycle-rejected` (one module,
the pre-existing shape) and `…-reaches-an-imported-global-through-a-call-cycle-rejected` (the shape
the summary produces).

## Symptom (measured with the compiler built from develop `5567a7796`, and the v0.2.47 seed)

```rust
{ Thread } :: import("std/thread");
{ ArrayList } :: import("std/collections/array_list");
g := ArrayList(i32).new();
f :: (fn(n : i32) -> unit)({
  if(n > i32(0), {
    h(n - i32(1));
  });
  g.push(n);
});
h :: (fn(n : i32) -> unit)({
  f(n);
});
run :: (fn(k : Impl(Fn() -> unit)) -> unit)(k());
main :: (fn() -> unit)({
  run(() => f(i32(1)));
  t := Thread(unit).spawn((io : Io) => {
    h(i32(1));
    ()
  });
  t.join();
});
export(main);
```

`yo check` → rc=0; `yo compile` → rc=0 and the binary runs. Without the `run(...)` line both reject
the spawn ("calls 'h', which calls 'f', which references the module-level global 'g' …").

## Root cause

`function_reaches_non_send_global` (`src/evaluator/effects/mutation_summary.yo`) memoizes each
function's verdict by func id and answers a call to a function whose walk is in progress with
"clean" (the cycle guard). `run`'s closure is walked where it is created (every closure is, for a
later type judgement): `f` → `h` → `f` (in progress, "clean"), so `h` came out clean and was
memoized, and then `f` found `g`. The spawned closure asked about `h` and got the memo.

A verdict taken under an in-progress edge is conditional on the in-progress function. The mask
analysis in the same file already refused to memoize those (its `touched` list); the D1 walk did not.

## Fix

Each walk records its depth on the walk stack; a hit on an in-progress function lowers `g_gr_low`
to that depth. A clean verdict whose subtree depended on an in-progress ANCESTOR is parked in
`g_gr_pending` with that ancestor's depth instead of being memoized. When the walk the cycle closes
at finishes clean with no ancestor of its own, everything parked under it is final (a reach found
anywhere under it returns up through it, so it would not be clean) and is memoized; when it
finishes with a reach, the parked verdicts are dropped and re-walked on demand. A parked function
hit again under the same walk answers with its parked verdict and its low, so a strongly connected
component is not re-walked exponentially.
