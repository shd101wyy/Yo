# `yo doc` published 790 compiler temporaries as documented API

**Status:** FIXED 2026-09-14. The predicate that recognises these already
existed — `is_any_temp_variable_name` in `src/utils.yo` — and `build_doc_module`
had hand-rolled its own prefix approximation beside it. **That is the lesson: a
predicate with two consumers, one of which approximates it, is an invitation to
fix the same bug twice.** The LSP's completion list had this exact bug and it
was fixed there (`issues/fixed/lsp-completion-lists-compiler-temporaries.md`);
the doc pipeline inherited it and kept it.

Found 2026-09-14, incidentally, while byte-comparing
`yo doc ./std` output across two compiler builds to confirm that switching
`markdown_to_html` from `*(Options)` to by-value changed no rendering.

**Not caused by that change** — pre-existing, and fixed separately because it
moves every page under `yo doc`.

## CORRECTION to this document's first draft

It was first written as a search-index leak. That understated it: of 5,530
occurrences in `module/prelude.html`, **3,950 are OUTSIDE the search index**,
rendering as visible sidebar links to `#const-__private_tmp_temp_…` anchors
that document nothing. It is a user-visible defect in published output, not
just noise in a JSON blob.

## Symptom

The generated `window.__SEARCH_INDEX` on every page carries entries like

```json
{"name":"__private_tmp_temp_10626258249951560750",
 "kind":"constant",
 "href":"prelude.html#const-__private_tmp_temp_10626258249951560750",
 "module":"prelude"}
```

790 distinct ones in `module/prelude.html` alone. They are compiler-generated
temporaries, not API — a reader searching the standard-library docs is offered
them as `constant` results, with anchors to sections that document nothing.

## Second-order effect: `yo doc` output is not reproducible across builds

The numeric suffixes are stable for a given compiler binary — the same binary
run twice produces byte-identical output — but they DIFFER between compiler
builds:

```
same binary, two runs      -> byte-identical
two builds of the compiler -> all 176 html files differ
```

and in every one of those 176 files, the ONLY difference is this line. So any
byte-comparison of documentation across two compilers reports a 100% change
rate that is entirely noise. That is what made this visible: the comparison it
was invented to answer ("did the by-value switch change rendering?") could not
be read until the temps were accounted for, and the honest answer — nothing
else differs, at all — is only reachable by looking past them.

Anyone gating documentation on byte-identity, or diffing the published site
between releases, gets the same wall of false positives.

## Root cause

`build_doc_module` (`src/doc/builder.yo`) already gated compiler-internal
module fields — as a PREFIX LIST:

```
if((field_name.len() == usize(0)) || field_name.starts_with("___") || field_name.starts_with("__yo_"), { skip })
```

`generate_new_temp_variable_name` (`src/utils.yo`) mints
`_<sanitized module path, <= 12 bytes>_temp_<digits>`, so a temp's prefix is
its MODULE PATH. `__private_tmp_temp_…` is only what the prelude's path
sanitizes to. **No literal prefix can catch them all** — a
`starts_with("__private_")` patch would have passed a test while leaving 175
other modules broken.

## Fix

The gate became a named, exported predicate `is_compiler_internal_field_name`
that defers to the canonical `is_any_temp_variable_name` for the third shape.
Only the module-field gate changed; the impl-member filters nearby check
`___` alone and were left, since temps are module-level bindings and do not
appear there.

## Verification — the corpus, not the unit test

The unit tests (`tests/internal/doc_builder.test.yo`) can only prove the
predicate. The oracle is the real corpus, diffed item-for-item:

```
distinct documented items   4,618  ->  3,843
items lost                    790
  of which compiler temps     790
  real API lost                 0
temp occurrences, all pages 5,530  ->      0
```

Nothing but temps was removed, and `yo doc ./std` still documents 921
functions and 627 constants.

## Second-order effect this also fixes: reproducible docs

The digit tail is a HASH of the mint site, so the names change whenever the
compiler's own source moves — the same binary run twice was byte-identical,
but two BUILDS of the compiler differed in all 176 generated pages, each by
this line alone. Any byte-comparison of documentation across compilers
reported a 100% change rate that was entirely noise. That is what made this
visible: the comparison it was invented to answer ("did the `Options`
by-value switch change rendering?") could not be read until the temps were
accounted for, and the honest answer — nothing else differed at all — was
only reachable by looking past them.

## Still open, found alongside and NOT fixed here

`DocConfig.include_private` is threaded from `--document-private` through
`src/main.yo` and `src/build_runner.yo` into `src/doc_command.yo:42` and then
**never read by anything**. The flag is documented in `yo doc --help` as
"Include underscore-private items" and does nothing. It did not cause this bug
(unexported helpers never reach the model at all), and deciding what
underscore-privacy should mean for documentation is its own change.
