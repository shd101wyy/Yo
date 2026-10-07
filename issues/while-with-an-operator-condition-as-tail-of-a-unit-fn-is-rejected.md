# `while(<comparison>, …)` as the tail expression of a `-> unit` fn is rejected with a bogus E0601

**Severity:** S3 — a valid program is rejected; the diagnostic points at the loop condition's operator, not the tail, and a trailing statement hides the bug

**Found**: 2026-10-04, while hoisting the M3 early-return drop walk
(`src/evaluator/exprs/begin.yo`,
issues/yo-self-compile-performance-rc-string-eq.md, "Negative result
2026-10-04" section) — the walk-under-test naturally ended in a `while` and
was rejected.

## Symptom

```rust
{ ArrayList } :: import("std/collections/array_list");

f :: (fn(ns : ArrayList(i32)) -> unit)({
  (ni : usize) = usize(0);
  while(ni < ns.len(), {
    ni = (ni + usize(1));
  })
});
```

```
error[E0601]: Cannot unify incompatible types: "bool" and "unit"
  --> tmp/fixme.yo:4:12
   |
4  |   while(ni < ns.len(), {
   |            ^
```

`yo check` rejects the file; the caret sits on the `<`. The loop is ordinary:
a `-> unit` fn whose body's last expression is a `while` (itself `unit`) —
nothing about the condition is incompatible with anything.

## What does and does not trigger it (measured, v0.2.49 tree binary)

| shape                                                                 | verdict |
| --------------------------------------------------------------------- | ------- |
| `while(ni < ns.len(), { … })` as the fn-body tail (the case above)     | E0601   |
| same loop with ANY statement after it (e.g. a trailing `();`)          | OK      |
| `while(flag, { … })` (bare `bool` param condition) as the tail         | OK      |
| `while(flag, { … })` as the tail, expression-form body                 | OK      |
| `while(ni < ns.len(), { … })` non-tail inside the same fn             | OK      |

So the false rejection needs BOTH the tail position and an infix operator in
the condition. `match(...)` as the fn-body tail is fine (the retired
`_attach_early_return_only_drop_to_returns` ended in one for years), so it is
specific to how the begin-tail typing meets a `while` whose condition is an
operator call — the "bool" side of the unification is the condition's type,
as if the condition were being unified with the fn's `unit` return.

## Workaround

End the body with a statement (the codebase's own loop-heavy fns all do —
`while` is essentially never a fn tail in `src/` or `std/`, which is why this
went unnoticed).

## Reproducer

`tmp/fixme.yo` shapes above, run `yo check tmp/fixme.yo` (any current binary;
also reproduces on the installed v0.2.49 seed). No fix yet — filed to keep the
discovery from being lost; the hoist that hit it works around it with a
trailing `()`.
