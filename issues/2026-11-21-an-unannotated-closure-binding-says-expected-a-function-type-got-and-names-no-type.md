# An unannotated closure binding says "Expected a function type, got:" and names no type

**Severity:** S3 — `mut(act) := ({ &mut ws }() => { ws.clear(); });` is rejected with `error: Expected a function type, got:` followed by the closure's source, with no code and no help: the message reads as if a type were missing from the text, and it never says that a closure literal needs an expected type (an annotation such as `(mut(act) : Impl(FnMut() -> unit)) = (…)`).

- Filed: 2026-11-21 by the v0.2.80 capture-list-loans lane, while probing the bound form of the capture-list loan hole (`issues/fixed/2026-11-21-a-closures-mut-capture-list-entry-is-not-checked-against-the-loans-of-the-calls-other-arguments.md`).
- Reproduces on the tree binary of `v0280/clusters` `5096d6dcc`.

## Reproducer

```yo
{ ArrayList } :: import("std/collections/array-list");
main :: (fn() -> unit)({
  mut(ws) := ArrayList(i32).new();
  mut(act) := ({ &mut ws }() => {
    ws.clear();
  });
  act();
});
export(main);
```

```text
error: Expected a function type, got:
_(__yo_mut(ws))() => begin((ws.clear)(), ())
  --> tmp/r8.yo:4:30
```

With the annotation, `(mut(act) : Impl(FnMut() -> unit)) = ({ &mut ws }() => { ws.clear(); });`, the program checks.

## Cause

`src/evaluator/values/anonymous-function.yo` types a closure literal from `ctx.expected_type`. When there is none, it throws `Expected a function type, got:\n<the literal>`. The rule is by design, but the message prints the desugared literal where a reader expects a type, and it carries no `E0xxx` code and no help line.

## Fix direction

Give the rejection a registered code and a message stating the rule, such as "a closure literal needs an expected function type: annotate the binding (`(f : Impl(Fn(…) -> T)) = …`) or pass the literal where a parameter's type gives one". Add a help line naming the annotation, and a `yo explain` entry. The test is a `comptime_expect_error` (or a cli-case) on the reproducer that matches the new message.
