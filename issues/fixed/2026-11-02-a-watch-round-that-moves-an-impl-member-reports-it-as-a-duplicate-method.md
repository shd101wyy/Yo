# A watch round that moves an impl member reports it as a duplicate method (E0612)

**Severity:** S2: `yo check --watch` (and the LSP, which uses the same
invalidation) rejects a valid program after an ordinary edit. Once an edit
moves an inherent impl member to another line, the round fails with E0612
"Method ... is already defined for this type" and keeps failing until the
watcher restarts. A cold `yo check` of the same file passes.

**Status:** FIXED 2026-11-02 (fix/watch-inherent-method-sites).

## Symptom

Seen while the B8/B9 probe loops kept one resident `yo check <file> --watch`
on `src/evaluator/effects/mutation_summary.yo`. After an edit that added a
line above the `impl(_MsP, ...)` block, the round reported:

```text
error[E0612]: Method "collect" is already defined for this type (first definition: src/evaluator/effects/mutation_summary.yo:2357:3). Duplicate inherent method impls are not allowed ...
  --> src/evaluator/effects/mutation_summary.yo:2358:3
```

The "first definition" is the member's own previous line. The develop binary
at b02a4c908 (#1727) reproduces it with this file:

```yo
P :: struct(_d : i32);
impl(
  P,
  a : (fn(x : i32) -> i32)({
    y := (x + i32(1));
    y
  }),
  b : (fn(x : i32) -> i32)({
    z := P.a(x);
    z
  })
);
main :: (fn() -> unit)({
  _x := P.b(i32(1));
});
export(main);
```

To reproduce:
1. Run `yo check m.yo --watch`.
2. Add one statement to `a`'s body, for example `w := i32(0);` before `y := ...`.
3. The round fails with E0612 on `b`: "first definition: m.yo:<old line>".

## Root cause

The duplicate-inherent-method gate (`src/evaluator/values/impl.yo`,
`note_inherent_method_site` in `type_trait_methods.yo`) records each
`(type id, method name)` pair's defining site in `_inherent_method_sites`. A
second registration from a different site is a duplicate, and a same-site
replay is the loader's idempotent re-evaluation.

`mm_invalidate_document` purges every per-owner registry of an invalidated
module before re-evaluating it: the methods, trait-impl sites, trait
defaults, generic impls and side tables. The inherent-method sites had no
owner log, so they were never purged. With stable type ids, the
re-evaluated impl produced the same key. A member at an unchanged line
replayed its own site and passed. A member that the edit had moved found
its old site and was rejected. A cold check starts empty, so it never sees
this.

## Fix

`src/evaluator/values/type_trait_methods.yo`:
- `note_inherent_method_site` records each new key in an `OwnedKeys` log
  (`_inherent_method_site_owned`), like the trait defaults' log.
- A new `purge_inherent_method_sites_owned_by(owner)` removes that owner's
  sites.
- `clear_type_trait_methods` resets the log.

`src/module_manager.yo`'s `mm_invalidate_document` calls the purge beside
`purge_trait_impl_sites_owned_by`.

## Test

`tests/internal/check_watch.test.yo`, "watch: an edit that moves an inherent
impl member to another line is not a duplicate method (E0612)":
- The test loads the fixture above.
- It rewrites the file with `a`'s body one line longer, runs a `watch_round`,
  and expects 0 failures. Before the fix this round failed with E0612 on `b`.
- It reverts the edit and expects 0 failures again.
- The number of recorded sites stays flat across the rounds.
