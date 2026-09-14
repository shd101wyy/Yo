# The non-awaiting arm of an awaiting cond/match hands out a borrowed value without a dup — released twice

**Status: FIXED 2026-09-12** (`src/codegen/async/state_code_gen.yo`; the sync emitter's
`_arm_value_with_dups` moved to `src/codegen/exprs/drop_dup.yo` as the shared
`arm_value_with_dups`). Found by `tests/cli-cases/install-frozen-offline`: the SECOND
`yo install` of a project (lock present, cache populated) died with rc 133 and no output.

## Symptom

```
yo: error: ... (nothing)      # rc=133, xzone malloc's freelist check tripped
```

Under guard malloc the fault is in `fetch_package`'s state machine, dup'ing
`state.actual_hash`'s payload — already freed. `inspect_cached_dep` produced it:

```rust
sidecar_hash := e.io.await(read_sidecar_hash(cached_path, e.io, e.exn), e);
actual_hash := match(
  sidecar_hash,
  .Some(h) => h,                     // BORROWED payload as the arm value
  .None => { h := e.io.await(compute_content_hash(...), e); ...; h }
);
```

Minimal reproducer (returns `r=` — an empty string — instead of `r=abc`):

```rust
pick :: (fn(some : bool, io : Io, exn : Exception) -> Impl(Future(String, IoExn)))(
  io.async((e : IoExn) => {
    o := e.io.await(sidecar(some, e.io, e.exn), e);
    got := match(o, .Some(h) => h, .None => { fresh := e.io.await(compute(e.io, e.exn), e); fresh });
    got
  })
);
```

The same with a cond (`got := if(flag, x, { … await … })`, `x` a named local) loses `x`.

## Root cause

A match/cond whose other arm awaits is lowered by the async state machine
(`_generate_match_with_await_impl` / `generate_cond_with_await`), not by the sync
emitters. Its non-awaiting arm's value went through `_emit_match_case_value` /
`_emit_branch_value_inline` / `_emit_non_await_branch_async_completion`, which emitted
`sm->var_got = sm->var_h;` — the raw C of the value, ignoring the arm's
`deferred_dup_expressions`. The sync emitters apply those through
`_arm_value_with_dups` (match.yo), whose doc records exactly this class ("a borrowed
value leaving the arm"). So `got` and `o`'s payload shared one reference; the
completion drops released it once per owner, and the caller received a freed string.

## Fix

`arm_value_with_dups` is shared (exported from `drop_dup.yo`) and the three async
value emitters route any arm value that has a destination (a binding, an assignment
target, the future's result) through it.

## Seed gate

The compiler binary CI builds is emitted by the SEED release, whose emitter still has
the bug, so `src/`'s own async bodies must not use the shape until the seed carries the
fix: `inspect_cached_dep` (`src/fetch.yo`) reads the sidecar as `.Some(h) => h.clone()`
(an owned temp needs no dup), with a comment pointing here. Tests are unaffected — `yo
test` compiles them with the tree's compiler.

## Gates

- `tests/async_await.test.yo`: the match shape (String, `abc|3`), the cond shape
  (`abc|abc`), and a `Dispose`-counted handle released exactly once in both the bound
  and the tail shape — red-first on the pre-fix compiler (empty strings).
- `tests/cli-cases/install-frozen-offline` (a second `yo install` on a populated cache).
