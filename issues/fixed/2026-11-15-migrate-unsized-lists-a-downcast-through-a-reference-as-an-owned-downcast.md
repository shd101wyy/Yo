# `yo fix --migrate unsized` lists a downcast through a reference as an owned downcast

**Severity:** S3 (a false hand-rewrite listing with a malformed suggestion; nothing is rewritten and no binary changes)

## What happened

The S2 sweep rehearsal (`vbd/d49-flip-swept`, `yo fix ./std ./src --migrate unsized`, 2026-11-15)
listed 14 `downcast` sites in src as "copies the payload out of an owned Dyn". Each one is a view
already:

- 6 sites already respelled `downcast(&err.*, V)`. Their suggestion doubles the lend:
  `write \`downcast(&&((err.(*))).*, ...)\``.
- 8 sites `downcast(err, V)` with `err : &AnyError`, a reference to the box.

```text
fix: src/evaluator/calls/function.yo:9411:5: `downcast(&((err.(*))), ...)` copies the payload out of an owned Dyn; v0.2.78's owning form is `Result(Box(V), Box(Dyn(...)))`: write `downcast(&&((err.(*))).*, ...)` where only the payload is read; left as written
fix: src/error.yo:524:5: `downcast(err, ...)` copies the payload out of an owned Dyn; ...
```

## Root cause

`evaluate_downcast` (`src/evaluator/builtins/downcast.yo`) returns early for a reference downcast
(`ref_mode` set) unless the target is a `ref` struct. A `ref` target keeps the retained `Option(V)`
form (a `ref` object has no place apart from its own pointer), so it falls through to the owned
path. The kind-6 recorder sat on that path and did not look at `ref_mode`. Every src site
downcasts to `YoError`, a `ref` struct.

## Fix

The recorder lists a site only when `ref_mode` is `.None`, that is when the operand is an owned
Dyn.

Test: `tests/cli-cases/fix-migrate-unsized-views` holds three reference downcasts in the v0.2.78
spelling: `&Dyn` to a `ref` target, `&Box(Dyn)` to a `ref` target, and `&b.*` to a value target.
Before the fix the run lists the first two (`main.yo:9:49`, `main.yo:10:58`). After it, the run lists
nothing.
