# The explicit-copy migration lists a `match` through a borrow

**Severity:** S3

## What happened

`yo fix --migrate explicit-copy --dry-run` lists the scrutinee of a
`match(&place, …)` as an implicit copy, although the borrow marker makes the
match read the scrutinee IN PLACE (no copy is made or dropped; the bindings
borrow). The walker that records copy sites does not model the borrow marker
on a match scrutinee, so a site that has already been fixed by the borrow
restructure keeps being listed, in the listing's own words:

```text
fix: src/toml_edit.yo:376:8: `(kinds(i).kind)` is copied and `_LineKind` has no
  `Clone`, so `.clone()` cannot spell the copy; left as written (move it,
  borrow it, or give the type `Clone`)
```

`src/toml_edit.yo:376` is `match(&kinds(i).kind, .Header(path, array) => …)` —
already the borrow the reason text asks for. The same holds for the three
`match(&reqs(i).requirement, …)` scrutinees in `src/resolver.yo` (758, 877,
1208 on branch `vbd/b4-1a-cli-build-files`), which the run re-lists as
"returned from a `&` parameter" once the marker is present.

## Reproducer

```yo ignore
// _K :: enum(A(list : ArrayList(String)), B);
// xs := ArrayList(_K).new();
// xs.push(_K.B);
// match(&xs(usize(0)), .A(list) => list.len(), .B => usize(0));
```

as a module of its own, `yo fix <it> --migrate explicit-copy --dry-run` lists
the `xs(usize(0))` scrutinee copy; the evaluator emits no copy for it (the
`match(&x, …)` marker is a borrow, `src/expr.yo` "borrow marker each
`match(&x, …)` was written").

## Impact

Only the listing: 8 sites in `src/toml_edit.yo` and `src/resolver.yo` stay
listed after the B4-1a hand edits converted them to in-place match borrows
(branch `vbd/b4-1a-cli-build-files`). The code is correct; the completeness
gate ("the dry run lists only deferred sites") must carry them as
deferred-with-reason until the walker understands the marker.

## Fix (deferred)

Teach the copy-site recorder (the `match` scrutinee walk, `src/main.yo`
`_copy_when`/`record_copy_*`) that a scrutinee under the borrow marker is a
lend, not a copy — the same treatment `&`-marked closures and arguments
already get.
