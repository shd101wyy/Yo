# `yo fix --migrate dyn-spelling` stops at the first site that is not a named closure

**Severity:** S3 — the migration rewrites one site per run and reports the file as not evaluating (rc 1) when a bare site is a closure literal, a `->` function literal or a named `fn` at a binding, field or result; rerunning it finishes the job one site at a time.

**Status:** FIXED 2026-10-13 (stacked on #1339, decision 44).
**Found:** 2026-10-13, reviewing #1339.

## Repro

```yo
Hold :: ref(struct(f : Dyn(Fn() -> i32)));
run :: (fn(d : Dyn(Fn() -> i32)) -> i32)(d());
make :: (fn() -> Dyn(Fn() -> i32))(() => i32(4));
main :: (fn() -> unit)({
  (d : Dyn(Fn() -> i32)) = (() => i32(1));
  h := Hold(f : (() => i32(2)));
  r := run(() => i32(3));
  _s := (d() + h.f() + r + make()());
});
export(main);
```

```
$ yo fix main.yo --migrate dyn-spelling
fix: main.yo does not evaluate; its values are migrated only as far as evaluation reached
fix: wrapped 1 bare callable(s) in dyn(...); 0 site(s) left as written (listed above); 1 file(s) did not evaluate
yo: error: fix: 1 file(s) do not evaluate — run `yo check` on them; their unevaluated values were not migrated
```

Four runs wrap the four literals one at a time, each exiting 1; the fifth is
clean. A named `fn` or a `->` literal at a binding, a field or a result does
the same (`(g : Dyn(Fn() -> i32)) = nine`).

## Root cause

Under the migration, `_bare_callable_into_dyn_fn` records a site instead of
raising E0618 and the value "flows on as before". That only holds for a named
closure: its type is a closure `Impl` SomeT, and the slot's compatibility
check unifies a SomeT with a `Dyn`. The other values never fit a `Dyn` slot
bare, so the check right after the recording threw (the load error, printed
with `YO_DEBUG_FIX=1`):

- A closure literal was typed from the bare `fn(...)` of the `Dyn`'s `Fn`
  trait (the `.DynT` arm of `evaluate_anonymous_function_implementation`), so
  it became a capture struct, which unifies with nothing: `Cannot unify
  incompatible types: Expected "dyn(Fn() -> i32)", Given
  "<struct:capture_...>"`, raised at the `=>`.
- A named `fn` or a `->` literal is a `fn(...)` code pointer: `Incompatible
  types: Expected dyn(Fn() -> i32), Given fn() -> i32` at a binding or field,
  E0604 at a function result. An argument happened to pass.

The first error ended the file's evaluation, so only the first site was
recorded.

## Fix

- A closure or function literal in a `Dyn(Fn(...))` slot is now evaluated, after
  the site is recorded, against the `Dyn`'s payload type variable
  (`t_dyn_payload_wrapper`, `src/types/creators.yo`), exactly as the rewrite's
  `dyn(<literal>)` evaluates it (`evaluate_dyn_value` now builds its inner
  type through the same function). A closure takes on that `Impl`-shaped type
  and flows on as a named closure does. Outside the migration the E0618 still
  fires first.
- `bare_callable_recorded_into_dyn_fn` (`src/evaluator/utils.yo`) says a site
  was recorded: the value stands for the rewrite's `dyn(value)`, which the
  slot takes, so the compatibility check that follows at a binding, a field
  (constructor and write), a function or closure result, a specialization's
  result and `return(f)` passes it.
- `YO_DEBUG_FIX=1` prints a file's load error in the migration's
  "does not evaluate" path.

`--migrate markers` does not share the flaw: its recorder
(`check_call_site_borrow_marker`, `src/evaluator/calls/helper.yo`) returns
without changing the argument's type, and a bare place passed to a `&T` or
`&mut T` parameter already type-checks; probes with only `&`, only `&mut`,
method-call, closure-call and field-place sites each finished in one run with
`0 file(s) did not evaluate`.

Tests: cli-cases `tests/cli-cases/fix-migrate-dyn-spelling-literals` (four
closure literals: binding, field, argument, result; one run, rc 0, then a clean
`check`) and `tests/cli-cases/fix-migrate-dyn-spelling` (now also a named `fn`
and a `->` literal at a binding: six sites in one run). Both exit 1 before the
fix.
