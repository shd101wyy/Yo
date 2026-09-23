# Twelve `context-*` cli goldens pinned the release version through the index key

**Status: FIXED.** Found 2026-09-23 by develop's battery on `43e55de33` (tier-1
gate 7, next to `issues/fixed/an-awaited-task-abort-is-reported-as-unhandled.md`).

## The behavior

The v0.2.40 bump (`src/version.yo`) turned every `context-*` case red with a
one-line stdout diff:

```
< Building the context index for <PROJ>/src (key 7d02a5fc7721)...
> Building the context index for <PROJ>/src (key <different 12 hex>)...
```

## Root cause

`context_tree_key` (`src/doc/context_index.yo`) hashes the corpus name,
`INDEX_FORMAT_VERSION` and the toolchain version. That is deliberate: a new
compiler must rebuild the index. So the key is release-specific in the same
way the version string is. `scripts/cli-diff-test.sh` already normalizes
`yo X.Y.Z` to `yo <VERSION>` for this reason (#859), but the derived key
slipped through. Its goldens were recorded on 0.2.39, and the first version
bump changed all twelve.

## The fix

`normalize_stream` rewrites the progress line's `(key <12 hex>)` form, and
only that form, to `(key <CONTEXT_KEY>)`. The twelve goldens carry the
placeholder. The key's other property, "the same tree gives the same key, and
a changed tree gives a new one", stays covered by
`tests/internal/context_index.test.yo`.
