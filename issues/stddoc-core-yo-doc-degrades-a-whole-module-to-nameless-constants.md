# `yo doc` silently degrades a whole std module to name-only `constants`, dropping every `///`

**Status:** OPEN
**Severity:** silent total doc loss for the affected module — `yo doc` reports
"N items documented" and exits 0 while emitting entries that carry a name, the
type `"(unknown)"`, and no `doc` key at all.
**Found:** 2026-09-11, during the `std/` `///` doc sweep, while verifying that
existing method docs in `std/sync/*` reach the generated site.

For some modules the builder cannot match its evaluated item information to the
module being documented. It does not fail: it falls back to a token-only view
in which

* the type's own `///` doc is dropped and its `kind` degrades (`atomic object`
  → `struct`), with **no fields and an empty `methods` list**, and
* the members that DO have a `///` reappear at module level under
  `constants` as `{"name": …, "type": "(unknown)"}` — **without their doc
  text** — while undocumented members vanish entirely.

## Reproducer

```
$ cd /path/to/repo
$ yo doc std/sync/cond.yo --format json -o /tmp/bad
  1 module, 2 items documented in 0.9s
$ yo doc ./std/sync/cond.yo --std-path ./std --format json -o /tmp/good
  1 module, 2 items documented in 1.6s
```

`/tmp/bad/doc.json` (module `cond`):

```json
"types":     [ { "name": "Cond", "kind": "struct", "methods": [], "traitImpls": ["Dispose"] } ],
"constants": [ { "name": "wait_timeout", "type": "(unknown)" } ]
```

`/tmp/good/doc.json`, same file, same compiler:

```json
"types": [ { "name": "Cond", "kind": "atomic object",
             "doc": "Reference-counted condition variable with automatic cleanup via `Dispose`. …",
             "methods": [ "new", "wait", "wait_timeout", "signal", "broadcast", "dispose" ] } ]
```

`Cond`'s 30-line `wait_timeout` doc comment — the timeout-is-per-wait trap, the
spurious-wake contract, the monotonic-clock note — is present in the source and
absent from BOTH outputs; the bad one merely also loses the type doc and every
method name.

## The matrix (deterministic, three runs each)

| invocation | result |
| --- | --- |
| `yo doc ./std/sync/cond.yo --std-path ./std` | correct (type doc + 6 methods) |
| `yo doc std/sync/cond.yo` | degraded |
| `yo doc std/sync/cond.yo --std-path ./std` | degraded |
| `yo doc ./std/sync/cond.yo` | degraded |
| `yo doc /abs/path/std/sync/cond.yo` | degraded |

So the association depends on the exact SPELLING of the path argument, which is
the shape of a textual path comparison rather than a canonicalised one.

`std/crypto/hmac.yo` is degraded under **every** spelling tried, including the
one that fixes `cond.yo`: its eight documented top-level functions all come out
as `constants` with `"(unknown)"` and no doc, and `types` is empty. So path
spelling is one trigger, not the only one.

A minimal hand-written file in a scratch directory (value struct, `ref` struct,
`atomic(ref(struct))`, generic type function, `extern` block, `pragma`, a
`*T` parameter, an import of `std/time/duration`) renders CORRECTLY in every
combination — none of those features is the trigger on its own, which is why
this reproduces only against the real tree.

## Root cause (analysis, not verified by a fix)

`src/doc/builder.yo` joins two sources: the token stream from
`src/doc/extractor.yo` and the evaluated module from `src/module_manager.yo`.
The join is by module path. A target reached under a different path spelling
than the one the module manager keyed the evaluated module under does not
match, and the builder then has only tokens: enough to see that a name is
defined, not enough to know it is a method of a type or to place its doc
comment. Canonicalising both sides to an absolute real path before the join —
and making a failed join a diagnostic instead of a silent fallback — is the
shape of the fix.

## Why it matters now

The 2026-09 `std/` doc sweep is adding several hundred `///` comments. For any
module in this state, all of them are invisible on the generated site while
`yo doc` still reports success, so the sweep cannot be validated by running
`yo doc`. `std/prelude.yo` is an extreme case already known to emit zero items.

Related: `issues/collection-method-docs-written-with-plain-slashes-are-dropped-by-yo-doc.md`,
`issues/stddoc-core-doc-comment-attached-by-bare-member-name.md`,
`issues/skip-prelude-doc-comment-false-positive.md`.
