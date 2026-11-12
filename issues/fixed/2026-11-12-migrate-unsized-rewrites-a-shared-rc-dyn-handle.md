# `yo fix --migrate unsized` rewrites a shared `Rc(Dyn(T))` handle's `dyn(Rc.new(v))` to `Box`

**Severity:** S2 — `(h : Rc(Dyn(T))) = dyn(Rc.new(v))` is rewritten `dyn(Box.new(v))`, which changes what the program means after v0.2.78 (a shared handle becomes an owned box) and makes a second run list a site at `1:1`.

Found 2026-11-12 by the decision 49 S1g sweep with #1901's recorder. Both `tests/dyn_pointer_kinds.test.yo` handles, one `Rc(Dyn(Speak))` and one `Arc(Dyn(Speak, Send, Sync))`, were rewritten. On a second run the migration listed `tests/dyn_pointer_kinds.test.yo:1:1: \`Rc.new(...)\` under \`dyn\` builds an owned Dyn`, so it was not a no-op.

## Reproducer

`tests/cli-cases/fix-migrate-unsized/fixture/main.yo`'s

```yo ignore
(handle : Rc(Dyn(Speak))) = dyn(Rc.new(Cat(n : i32(12))));
```

was written `dyn(Box.new(Cat(n : i32(12))))` by the first run.

## Cause

The shared-handle arm of `evaluate_dyn_value` (`src/evaluator/values/dyn.yo`, VERDICTS-40 amendment 3) evaluates `dyn(Rc.new(v))` against an expected `Rc(Dyn(T))` as `Rc(Dyn(T)).new(dyn(Rc.new(v)))`. The synthesized inner `dyn` keeps the written callee token and is evaluated against the payload `Dyn(T)`. To the recorder (`_record_unsized_dyn_site`), that looks like a fresh `Rc.new` into an owning `Dyn`, which is rewrite (c), so it recorded one at the written `Rc` token.

## Fix

The shared-handle arm notes the synthesized node's id (`note_unsized_handle_dyn_node`, `src/expr_info.yo`), and the recorder skips that node. The `dyn` the user wrote builds the handle, so it stays as written.

Test: the `fix-migrate-unsized` cli case's `handle` binding stays `dyn(Rc.new(...))`, and its second run rewrites nothing.
