# The E0003 help for a capture-list closure leads to "Expected a function type"

**Severity:** S3 — `f := { xs }() => …` is E0003, whose help says to wrap the right-hand side in parentheses; doing exactly that gives `error: Expected a function type, got: _(xs : xs)() => …`. A closure with a capture list cannot be bound with `:=`. `(f : T) = ({ xs }() => …)` and a tail position work.

- Filed: 2026-11-29. Found 2026-11-28 while probing capture-list closures for the audit of `plans/backlog/GENERATORS.md` (GitHub #2145).
- Status: open.
- Reproduces on the v0.2.80 seed and a stage 1 of develop `2381b8784`.
- No duplicate: no doc under `issues/` pairs E0003 with a capture list.

## Reproducer

Two files, each with a function taking `xs : &ArrayList(i32)`:

- `issues/repros/2026-11-29-the-e0003-help-for-a-capture-list-closure-leads-to-expected-a-function-type-noparens.yo`: `f := { xs }() => { xs.len(); };`
- `issues/repros/2026-11-29-the-e0003-help-for-a-capture-list-closure-leads-to-expected-a-function-type-parens.yo`: the same with the right-hand side in parentheses, which is what the first file's help asks for.

Expected: the first binds, or its help names a spelling that works. The typed form, `(f : Impl(Fn() -> unit)) = ({ xs }() => { xs.len(); });`, passes `yo check` on both compilers.

## Output

Identical on the seed and the stage 1. The first file:

```text
error[E0003]: Adjacent different operators need parentheses to clarify grouping (near :=). Wrap the right-hand side in parentheses: name := ({ xs }() => { xs.len(); }).
  --> …-noparens.yo:5:5
  |
5 |   f := { xs }() => {
  |     ^^
help: run `yo explain E0003` for more information
```

The second, following that help:

```text
error: Expected a function type, got:
_(xs : xs)() => begin((xs.len)(), ())
  --> …-parens.yo:5:18
  |
5 |   f := ({ xs }() => {
  |                  ^^
yo: error: check: 1 file(s) failed evaluator coverage
```

## Root cause (first pass)

Not located. The rendered node, `_(xs : xs)() => …`, reads as a function TYPE whose parameter list is the capture list with `xs` as both name and type: inside the parentheses the brace group is taken as a parameter list, not as a capture list. The typed binding, `(f : T) = (…)`, takes the same parenthesized literal as an expression.

## Test

The test lands with the fix: both files as a case in the parser or closure tests, the first binding and the second giving a diagnostic whose help works.
